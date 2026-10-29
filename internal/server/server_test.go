package server

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"cc-go/internal/plugin"
	webfiles "cc-go/web"
)

func TestMissingNodeStopsBeforeCLIOrVSIX(t *testing.T) {
	a := testApp(t)
	a.cfg.Node = filepath.Join(t.TempDir(), "missing-node")
	a.cfg.Claude = filepath.Join(t.TempDir(), "missing-claude")
	err := a.prepare(context.Background(), filepath.Join(t.TempDir(), "missing.vsix"))
	if err == nil || !strings.Contains(err.Error(), "Node.js") {
		t.Fatal("Node must be the first failing check:", err)
	}
	a.fail(err)
	setup := a.snapshot()["pluginSetup"].(map[string]any)
	if setup["step"] != 0 || setup["status"] != "needs-node" || setup["nodeError"] == "" {
		t.Fatalf("wrong setup state: %+v", setup)
	}
	for _, name := range []string{"vsix", "extensions"} {
		if _, err := os.Stat(filepath.Join(a.cfg.DataDir, name)); !os.IsNotExist(err) {
			t.Fatal("Node failure must not prepare/download a VSIX:", name)
		}
	}
}

func TestNodeIsProbedBeforeClaude(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix executable fixture")
	}
	a := testApp(t)
	directory := t.TempDir()
	order := filepath.Join(directory, "order")
	for name, version := range map[string]string{"node": "v24.14.0", "claude": "1.2.3 (Claude Code)"} {
		filename := filepath.Join(directory, name)
		contents := "#!/bin/sh\nprintf '" + name + "\\n' >> '" + order + "'\nprintf '%s\\n' '" + version + "'\n"
		if err := os.WriteFile(filename, []byte(contents), 0700); err != nil {
			t.Fatal(err)
		}
	}
	a.cfg.Node, a.cfg.Claude = filepath.Join(directory, "node"), filepath.Join(directory, "claude")
	if err := a.prepare(context.Background(), filepath.Join(directory, "missing.vsix")); err == nil {
		t.Fatal("missing VSIX should fail after both probes")
	}
	b, err := os.ReadFile(order)
	if err != nil || string(b) != "node\nclaude\n" {
		t.Fatalf("wrong probe order: %q %v", b, err)
	}
	setup := a.snapshot()["pluginSetup"].(map[string]any)
	if setup["step"] != 2 || setup["nodeVersion"] != "v24.14.0" || setup["cliVersion"] != "1.2.3" {
		t.Fatalf("missing successful prerequisites: %+v", setup)
	}
}

func testApp(t *testing.T) *App {
	t.Helper()
	a, err := New(Config{DataDir: t.TempDir(), Workspace: t.TempDir(), ProjectsDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	a.ShellURL, a.ViewURL = "http://127.0.0.1:23456", "http://127.0.0.1:23457"
	t.Cleanup(a.Close)
	return a
}

func TestControlAPIGuards(t *testing.T) {
	a := testApp(t)
	for _, test := range []struct {
		name, host, token string
		want              int
	}{
		{"missing token", "127.0.0.1:23456", "", 403},
		{"bad token", "127.0.0.1:23456", "bad", 403},
		{"DNS rebinding", "attacker.example", a.token, 403},
		{"loopback", "127.0.0.1:23456", a.token, 200},
		{"former native host", "wails.localhost", a.token, 403},
		{"bare localhost", "localhost", a.token, 403},
	} {
		t.Run(test.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "http://"+test.host+"/api/state", nil)
			r.Header.Set("X-Claude-Desktop-Token", test.token)
			w := httptest.NewRecorder()
			a.Handler().ServeHTTP(w, r)
			if w.Code != test.want {
				t.Fatalf("got %d: %s", w.Code, w.Body.String())
			}
		})
	}
	r := httptest.NewRequest("GET", a.ViewURL+"/api/state", nil)
	r.Header.Set("X-Claude-Desktop-Token", a.token)
	w := httptest.NewRecorder()
	a.ViewHandler().ServeHTTP(w, r)
	if w.Code != 404 {
		t.Fatalf("plugin origin exposed desktop API: %d", w.Code)
	}
}

func TestStartRejectsIncompleteSetup(t *testing.T) {
	a := testApp(t)
	r := httptest.NewRequest("POST", a.ShellURL+"/api/start", strings.NewReader(`{}`))
	r.Header.Set("X-Claude-Desktop-Token", a.token)
	w := httptest.NewRecorder()
	a.Handler().ServeHTTP(w, r)
	if w.Code != http.StatusBadRequest || a.peer != nil {
		t.Fatalf("incomplete setup must not start: %d %s", w.Code, w.Body.String())
	}
}

func TestShellDoesNotLoadFrameworkRuntimeFromHTTP(t *testing.T) {
	a := testApp(t)
	page := func() string {
		w := httptest.NewRecorder()
		a.Handler().ServeHTTP(w, httptest.NewRequest("GET", a.ShellURL+"/", nil))
		if w.Code != 200 {
			t.Fatal(w.Code)
		}
		return w.Body.String()
	}
	if strings.Contains(page(), "/wails/runtime.js") {
		t.Fatal("browser shell must not load the native runtime")
	}
	a.SetNative(Native{SelectFolder: func() (string, error) { return "", nil }})
	html := page()
	if strings.Contains(html, "/wails/runtime.js") || strings.Contains(html, "mygo-runtime") {
		t.Fatal("MyGo injects its bridge into the top-level native page, not HTTP responses")
	}
	if !strings.Contains(html, `class="window-drag"`) || !strings.Contains(html, `href="shell.css"`) {
		t.Fatal("the original shell markup or styles were replaced")
	}
}

func TestWorkspaceHistoryModuleIsServedAndLoaded(t *testing.T) {
	a := testApp(t)
	page := httptest.NewRecorder()
	a.Handler().ServeHTTP(page, httptest.NewRequest("GET", a.ShellURL+"/", nil))
	if page.Code != http.StatusOK || !strings.Contains(page.Body.String(), `<script src="history.js" defer></script>`) {
		t.Fatal("workspace history module must load with the shell")
	}
	script := httptest.NewRecorder()
	a.Handler().ServeHTTP(script, httptest.NewRequest("GET", a.ShellURL+"/history.js", nil))
	if script.Code != http.StatusOK || !strings.Contains(script.Header().Get("Content-Type"), "javascript") {
		t.Fatal("workspace history module must be served as JavaScript")
	}
	if !strings.Contains(script.Body.String(), "'import-history'") {
		t.Fatal("served history module does not include the Workspace entry point")
	}
}

func TestResourceWhitelistIncludesSymlinkResolution(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	file := filepath.Join(root, "allowed.txt")
	_ = os.WriteFile(file, []byte("okay"), 0600)
	if _, err := allowedResource([]string{root}, filepath.ToSlash(file)); err != nil {
		t.Fatal(err)
	}
	secret := filepath.Join(outside, "secret")
	_ = os.WriteFile(secret, []byte("secret"), 0600)
	if _, err := allowedResource([]string{root}, filepath.ToSlash(secret)); err == nil {
		t.Fatal("accepted resource outside roots")
	}
	link := filepath.Join(root, "escape")
	if err := os.Symlink(secret, link); err == nil {
		if _, err := allowedResource([]string{root}, filepath.ToSlash(link)); err == nil {
			t.Fatal("accepted symlink escape")
		}
	}
	if _, err := allowedResource([]string{root}, filepath.ToSlash(root)); err == nil {
		t.Fatal("allowed a directory listing")
	}
}

func TestShellAndPluginShareScrollbarStyles(t *testing.T) {
	a := testApp(t)
	css, err := webfiles.Files.ReadFile("scrollbars.css")
	if err != nil {
		t.Fatal(err)
	}
	w := httptest.NewRecorder()
	a.Handler().ServeHTTP(w, httptest.NewRequest("GET", a.ShellURL+"/", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `href="scrollbars.css"`) {
		t.Fatal("shell must load the shared scrollbar stylesheet")
	}
	w = httptest.NewRecorder()
	a.Handler().ServeHTTP(w, httptest.NewRequest("GET", a.ShellURL+"/scrollbars.css", nil))
	if w.Code != 200 || !bytes.Equal(w.Body.Bytes(), css) || !strings.Contains(w.Header().Get("Content-Type"), "text/css") {
		t.Fatal("shared scrollbar asset is missing or has the wrong content type")
	}
	v := newView("scrollbars", "Test", randomToken())
	a.views[v.ID] = v
	for _, theme := range []string{"light", "dark"} {
		a.state.Theme = theme
		w = httptest.NewRecorder()
		a.ViewHandler().ServeHTTP(w, httptest.NewRequest("GET", a.ViewURL+"/view/"+v.ID+"/"+v.Token+"/theme.css", nil))
		if w.Code != 200 || !bytes.HasSuffix(w.Body.Bytes(), css) {
			t.Fatal("plugin theme must include the same scrollbar stylesheet:", theme)
		}
	}
}

func TestBridgePreservesCSPAndLoadsBeforePlugin(t *testing.T) {
	html := `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-abc'; img-src data:;"></head><body><script nonce="abc" src="plugin.js"></script></body></html>`
	result := injectBridge(html, "http://127.0.0.1:23457/view/id/token/")
	for _, want := range []string{"default-src 'none'", "img-src data:", "connect-src http://127.0.0.1:23457/view/id/token/", `nonce="abc" src="http://`, `nonce="abc" src="http://127.0.0.1:23457/view/id/token/composer.js"`} {
		if !strings.Contains(result, want) {
			t.Fatal("lost CSP or bridge contract:", want)
		}
	}
	if strings.Index(result, "bridge.js") > strings.Index(result, "plugin.js") || strings.Index(result, "bridge.js") < strings.Index(result, "Content-Security-Policy") {
		t.Fatal("bridge must load after CSP and before plugin")
	}
	if strings.Index(result, "composer.js") > strings.Index(result, "plugin.js") {
		t.Fatal("composer observer must load before the plugin")
	}
}

func TestViewCapabilitiesAndOrigin(t *testing.T) {
	a := testApp(t)
	v := newView("id", "Test", randomToken())
	v.HTML = "<html><head></head><body>Test</body></html>"
	a.views[v.ID] = v
	base := a.ViewURL + "/view/id/" + v.Token + "/"
	for _, item := range []struct {
		method, path, origin string
		want                 int
	}{
		{"GET", base + "index.html", "", 200},
		{"GET", base + "composer.js", "", 200},
		{"GET", a.ViewURL + "/view/id/wrong/composer.js", "", 404},
		{"POST", base + "composer.js", "", 405},
		{"GET", a.ViewURL + "/view/id/wrong/index.html", "", 404},
		{"POST", base + "state", "https://attacker.example", 403},
		{"POST", base + "state", a.ViewURL, 204},
		{"GET", base + "message", "", 403},
	} {
		r := httptest.NewRequest(item.method, item.path, strings.NewReader(`{"test":true}`))
		r.Header.Set("Origin", item.origin)
		w := httptest.NewRecorder()
		a.ViewHandler().ServeHTTP(w, r)
		if w.Code != item.want {
			t.Fatalf("%s %s: got %d want %d", item.method, item.path, w.Code, item.want)
		}
	}
}

func fixtureArchive(t *testing.T) string {
	t.Helper()
	return fixtureArchiveVersion(t, "1.2.3")
}

func fixtureArchiveVersion(t *testing.T, version string) string {
	t.Helper()
	filename := filepath.Join(t.TempDir(), "fixture.vsix")
	f, err := os.Create(filename)
	if err != nil {
		t.Fatal(err)
	}
	z := zip.NewWriter(f)
	for name, contents := range map[string]string{
		"extension/package.json": `{"publisher":"Anthropic","name":"claude-code","version":"` + version + `","main":"extension.cjs","contributes":{"configuration":{"properties":{"claudeCode.test":{"type":"boolean","default":true}}}}}`,
		"extension.vsixmanifest": `<PackageManifest><Metadata><Identity TargetPlatform="` + plugin.Platform() + `"/></Metadata></PackageManifest>`,
		"extension/extension.cjs": `const vscode = require('vscode');
exports.activate = context => {
  context.subscriptions.push(vscode.commands.registerCommand('claude-vscode.editor.open', () => {
    const panel = vscode.window.createWebviewPanel('claude', 'Fixture', 1, {enableScripts:true});
    panel.webview.html = '<html><head></head><body>Fixture</body></html>';
    panel.webview.onDidReceiveMessage(message => panel.webview.postMessage({echo:message}));
  }));
};`,
	} {
		w, err := z.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = io.WriteString(w, contents)
	}
	_ = z.Close()
	_ = f.Close()
	return filename
}

func TestRealNodeHostActivationAndMessageRoundTrip(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node.js is not installed")
	}
	modules, _ := filepath.Abs("../../node_modules")
	if _, err := os.Stat(filepath.Join(modules, "vscode-uri")); err != nil {
		t.Fatal("run npm ci before integration tests")
	}
	a, err := New(Config{DataDir: t.TempDir(), Workspace: t.TempDir(), ProjectsDir: t.TempDir(), VSIX: fixtureArchive(t), Node: node, ModulesDir: modules, Claude: filepath.Join(t.TempDir(), "missing-claude")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.Close)
	if err := a.Start(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-a.startDone:
	case <-time.After(15 * time.Second):
		t.Fatal("setup timed out")
	}
	a.mu.Lock()
	phaseBeforeStart, statusBeforeStart := a.phase, a.setupStatus
	peerBeforeStart, viewsBeforeStart := a.peer, len(a.views)
	a.mu.Unlock()
	if phaseBeforeStart != "setup" || statusBeforeStart != "ready" || peerBeforeStart != nil || viewsBeforeStart != 0 {
		t.Fatalf("setup must wait for Start: phase=%s status=%s peer=%v views=%d", phaseBeforeStart, statusBeforeStart, peerBeforeStart, viewsBeforeStart)
	}
	if _, err := os.Stat(filepath.Join(a.cfg.DataDir, "runtime")); !os.IsNotExist(err) {
		t.Fatal("setup must not launch or materialize the Node host before Start")
	}
	startRequest, _ := http.NewRequest("POST", a.ShellURL+"/api/start", strings.NewReader(`{}`))
	startRequest.Header.Set("X-Claude-Desktop-Token", a.token)
	startResponse, err := http.DefaultClient.Do(startRequest)
	if err != nil {
		t.Fatal(err)
	}
	startResponse.Body.Close()
	if startResponse.StatusCode != http.StatusOK {
		t.Fatal("Start failed:", startResponse.Status)
	}
	a.mu.Lock()
	phase, reason := a.phase, a.errorText
	var view *View
	for _, v := range a.views {
		view = v
	}
	a.mu.Unlock()
	if phase != "active" || view == nil {
		t.Fatalf("activation failed: %s %s", phase, reason)
	}
	base := a.ViewURL + "/view/" + view.ID + "/" + view.Token + "/"
	request, _ := http.NewRequest("POST", base+"message", strings.NewReader(`{"type":"test","value":42}`))
	request.Header.Set("Origin", a.ViewURL)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 204 {
		t.Fatal("message was rejected:", response.Status)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		view.mu.Lock()
		messages := append([]viewMessage(nil), view.messages...)
		view.mu.Unlock()
		if len(messages) > 0 {
			if !bytes.Contains(messages[0].Data, []byte(`"echo":{"type":"test","value":42}`)) {
				t.Fatalf("unexpected reply: %s", messages[0].Data)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("Node -> Go message timed out")
		}
		time.Sleep(10 * time.Millisecond)
	}
	request, _ = http.NewRequest("POST", a.ShellURL+"/api/settings", strings.NewReader(`{}`))
	request.Header.Set("X-Claude-Desktop-Token", a.token)
	response, err = http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var settings map[string]any
	if err := json.NewDecoder(response.Body).Decode(&settings); err != nil || settings["properties"] == nil {
		t.Fatal("settings RPC did not return manifest properties", err)
	}
	peerBeforeReopen, viewBeforeReopen := a.peer, a.active
	for _, action := range []struct{ path, body string }{
		{"/api/ui", `{"key":"setup","open":true}`},
		{"/api/start", `{}`},
	} {
		r := httptest.NewRequest("POST", a.ShellURL+action.path, strings.NewReader(action.body))
		r.Header.Set("X-Claude-Desktop-Token", a.token)
		w := httptest.NewRecorder()
		a.Handler().ServeHTTP(w, r)
		if w.Code != http.StatusOK || a.peer != peerBeforeReopen || a.active != viewBeforeReopen {
			t.Fatalf("reopening setup must preserve the active host/view: %d %s", w.Code, w.Body.String())
		}
		if action.path == "/api/ui" && !a.pluginSetupOpen {
			t.Fatal("menu entry must open setup")
		}
	}
	if a.pluginSetupOpen {
		t.Fatal("returning from setup must close it")
	}

	// A cached, already-prepared installation must also wait for Start next launch.
	cfg := a.cfg
	cfg.VSIX = ""
	a.Close()
	cached, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(cached.Close)
	if err := cached.Start(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-cached.startDone:
	case <-time.After(15 * time.Second):
		t.Fatal("cached setup timed out")
	}
	cached.mu.Lock()
	defer cached.mu.Unlock()
	if cached.phase != "setup" || cached.setupStatus != "ready" || cached.peer != nil || !cached.pluginSetupOpen {
		t.Fatal("cached setup skipped the Start screen")
	}
}
