package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"cc-go/internal/host"
	"cc-go/internal/plugin"
	"cc-go/internal/sessions"
)

const regressionSessionID = "12345678-1234-1234-1234-123456789abc"

func postAPI(a *App, endpoint string, args any) *httptest.ResponseRecorder {
	b, _ := json.Marshal(args)
	r := httptest.NewRequest("POST", a.ShellURL+endpoint, bytes.NewReader(b))
	r.Header.Set("X-Claude-Desktop-Token", a.token)
	w := httptest.NewRecorder()
	a.Handler().ServeHTTP(w, r)
	return w
}

func snapshotSession(a *App) map[string]any {
	return a.snapshot()["workspaces"].([]map[string]any)[0]["sessions"].([]map[string]any)[0]
}

func TestCompletionUnreadMatchesShellContract(t *testing.T) {
	for _, tt := range []struct {
		name, status string
		readAt       int64
		active, want bool
	}{
		{"unread completion", "completed", 0, false, true},
		{"already read", "completed", 100, false, false},
		{"active session", "completed", 0, true, false},
		{"working", "working", 0, false, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			a := testApp(t)
			workspace := a.state.Workspace
			key := sessions.Key(workspace, regressionSessionID)
			a.sessionCache[workspace] = sessionSnapshot{At: time.Now(), Items: []sessions.Session{{ID: regressionSessionID, Title: "Chat"}}}
			a.liveSessions[key] = LiveSession{Status: tt.status, CompletedAt: 100}
			a.state.Metadata[key] = sessions.Metadata{ReadAt: tt.readAt}
			if tt.active {
				a.activeSessionID = regressionSessionID
			}
			item := snapshotSession(a)
			if got, ok := item["completionUnread"].(bool); !ok || got != tt.want {
				t.Fatalf("wrong shell completion contract: %+v", item)
			}
			if _, ok := item["unread"]; ok {
				t.Fatal("obsolete unread field returned")
			}
		})
	}
}

func TestViewLoadingFollowsActiveViewReadiness(t *testing.T) {
	a := testApp(t)
	assertLoading := func(want bool) {
		t.Helper()
		if got := a.snapshot()["viewLoading"]; got != want {
			t.Fatalf("viewLoading = %v, want %v", got, want)
		}
	}
	assertLoading(false)
	a.phase = "active"
	assertLoading(true)
	a.hostEvent(a.hostGeneration, "webview.create", json.RawMessage(`{"id":"chat","resourceToken":"test"}`))
	assertLoading(true)
	a.hostEvent(a.hostGeneration, "webview.html", json.RawMessage(`{"id":"chat","html":"<html></html>"}`))
	assertLoading(false)
	a.stopHost()
	assertLoading(true)
	a.phase = "setup"
	assertLoading(false)
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func persistedState(t *testing.T, a *App) DesktopState {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(a.cfg.DataDir, "desktop.json"))
	if err != nil {
		t.Fatal(err)
	}
	var state DesktopState
	if err := json.Unmarshal(b, &state); err != nil {
		t.Fatal(err)
	}
	return state
}

func useTestNode(t *testing.T, a *App) {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node.js is not installed")
	}
	a.cfg.Node = node
}

func TestCachedAndImportedVSIXDoNotDependOnSystemCLIOrNetwork(t *testing.T) {
	for _, explicit := range []bool{false, true} {
		t.Run(map[bool]string{false: "remembered", true: "explicit"}[explicit], func(t *testing.T) {
			a := testApp(t)
			useTestNode(t, a)
			archive := fixtureArchive(t)
			a.state.Archive = archive
			if explicit {
				a.cfg.VSIX = archive
			}
			original := http.DefaultTransport
			http.DefaultTransport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
				t.Fatalf("cached/imported VSIX must work offline: %s", r.URL)
				return nil, errors.New("unexpected request")
			})
			t.Cleanup(func() { http.DefaultTransport = original })
			if w := postAPI(a, "/api/retry", map[string]any{}); w.Code != 200 {
				t.Fatalf("cached setup failed: %d %s", w.Code, w.Body.String())
			}
			if a.version != "1.2.3" || a.runtimePath == "" || a.peer != nil || a.setupStatus != "ready" {
				t.Fatalf("wrong prepared state: %s %s", a.version, a.setupStatus)
			}
			if persistedState(t, a).Archive != archive {
				t.Fatal("working archive changed")
			}
		})
	}
}

func fixtureRegistry(t *testing.T, version string, archiveVersion ...string) *int {
	t.Helper()
	packagedVersion := version
	if len(archiveVersion) > 0 {
		packagedVersion = archiveVersion[0]
	}
	archive, err := os.ReadFile(fixtureArchiveVersion(t, packagedVersion))
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(archive)
	requests := new(int)
	original := http.DefaultTransport
	http.DefaultTransport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		*requests++
		var body []byte
		switch r.URL.String() {
		case "https://open-vsx.org/api/Anthropic/claude-code/" + plugin.Platform() + "/latest":
			body, _ = json.Marshal(map[string]any{"namespace": "Anthropic", "name": "claude-code", "version": version, "targetPlatform": plugin.Platform(), "files": map[string]string{"download": "https://fixture.invalid/plugin.vsix", "sha256": "https://fixture.invalid/sha256"}})
		case "https://fixture.invalid/sha256":
			body = []byte(hex.EncodeToString(digest[:]))
		case "https://fixture.invalid/plugin.vsix":
			body = archive
		default:
			t.Fatalf("unexpected request: %s", r.URL)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(body)), Header: make(http.Header)}, nil
	})
	t.Cleanup(func() { http.DefaultTransport = original })
	return requests
}

func TestFirstSetupDownloadsLatestStableWithoutSystemCLI(t *testing.T) {
	a := testApp(t)
	useTestNode(t, a)
	requests := fixtureRegistry(t, "1.2.4")
	if w := postAPI(a, "/api/retry", map[string]any{}); w.Code != 200 {
		t.Fatalf("latest setup failed: %s", w.Body.String())
	}
	if a.version != "1.2.4" || a.runtimePath == "" || *requests != 3 {
		t.Fatalf("wrong latest setup: version=%s requests=%d", a.version, *requests)
	}
}

func TestMissingRememberedArchiveDownloadsLatestButExplicitMissingArchiveFails(t *testing.T) {
	a := testApp(t)
	useTestNode(t, a)
	a.state.Archive = filepath.Join(t.TempDir(), "missing.vsix")
	requests := fixtureRegistry(t, "1.2.4")
	if err := a.prepare(context.Background(), ""); err != nil || a.version != "1.2.4" || *requests != 3 {
		t.Fatalf("missing remembered archive did not recover: %v", err)
	}
	if err := a.prepare(context.Background(), filepath.Join(t.TempDir(), "explicit-missing.vsix")); err == nil || *requests != 3 {
		t.Fatal("explicit missing archive must not silently download a replacement")
	}
}

func TestLatestDownloadMustMatchTheResolvedVersion(t *testing.T) {
	a := testApp(t)
	useTestNode(t, a)
	fixtureRegistry(t, "1.2.4", "1.2.3")
	if err := a.prepare(context.Background(), ""); !errors.Is(err, plugin.ErrVersionMismatch) {
		t.Fatalf("wrong version accepted: %v", err)
	}
	if a.prepared != nil || a.state.Archive != "" {
		t.Fatal("wrong package became the active cache")
	}
}

func TestPluginUpdateRefusesDraftsAndRunningConversationsBeforeDownloading(t *testing.T) {
	for _, mode := range []string{"draft", "pending", "working"} {
		t.Run(mode, func(t *testing.T) {
			a := testApp(t)
			view := newView("view", "Chat", "token")
			a.views[view.ID] = view
			view.HasDraft, view.PendingInput = mode == "draft", mode == "pending"
			if mode == "working" {
				a.liveSessions["session"] = LiveSession{Status: "working"}
			}
			requests := fixtureRegistry(t, "1.2.4")
			if err := a.updatePlugin(context.Background()); err == nil || *requests != 0 || a.stopping {
				t.Fatal("unsafe update was not rejected before changing the host")
			}
		})
	}
}

func TestUpdateCheckOnlyFetchesMetadataAndDoesNotReplaceCache(t *testing.T) {
	a := testApp(t)
	useTestNode(t, a)
	archive := fixtureArchive(t)
	if err := a.prepare(context.Background(), archive); err != nil {
		t.Fatal(err)
	}
	requests := fixtureRegistry(t, "1.2.4")
	if w := postAPI(a, "/api/update-check", map[string]any{}); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if *requests != 1 || a.latestVersion != "1.2.4" || a.version != "1.2.3" || a.state.Archive != archive {
		t.Fatal("update check must not install or reload")
	}
	if !a.snapshot()["pluginSetup"].(map[string]any)["updateAvailable"].(bool) {
		t.Fatal("update not exposed")
	}
	if w := postAPI(a, "/api/update-plugin", map[string]any{}); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if a.version != "1.2.4" || a.setupStatus != "ready" || a.peer != nil || a.state.Archive == archive {
		t.Fatal("explicit update did not prepare the latest version")
	}
}

func TestOfflineUpdateCheckKeepsPreparedRuntimeUsable(t *testing.T) {
	a := testApp(t)
	useTestNode(t, a)
	archive := fixtureArchive(t)
	if err := a.prepare(context.Background(), archive); err != nil {
		t.Fatal(err)
	}
	prepared := a.prepared
	original := http.DefaultTransport
	http.DefaultTransport = roundTripFunc(func(*http.Request) (*http.Response, error) { return nil, errors.New("offline fixture") })
	t.Cleanup(func() { http.DefaultTransport = original })
	if err := a.checkPluginUpdate(context.Background()); err == nil {
		t.Fatal("expected offline check failure")
	}
	if a.prepared != prepared || a.state.Archive != archive || a.setupStatus != "ready" || a.errorText != "" || a.updateError == "" {
		t.Fatal("offline update check broke the working runtime")
	}
	if err := a.updatePlugin(context.Background()); err == nil {
		t.Fatal("expected offline update failure")
	}
	if a.prepared != prepared || a.state.Archive != archive || a.setupStatus != "ready" || a.stopping {
		t.Fatal("failed replacement broke the working runtime")
	}
}

func TestArchiveDoesNotRenameSession(t *testing.T) {
	a := testApp(t)
	workspace := a.state.Workspace
	dir := filepath.Join(a.cfg.ProjectsDir, sessions.ProjectDirectory(workspace))
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	filename := filepath.Join(dir, regressionSessionID+".jsonl")
	if err := os.WriteFile(filename, []byte("{}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if got := snapshotSession(a)["title"]; got != "Chat 12345678" {
		t.Fatal("expected fallback title:", got)
	}
	w := postAPI(a, "/api/session-meta", map[string]any{"workspace": workspace, "id": regressionSessionID, "archived": true})
	if w.Code != 200 || persistedState(t, a).Metadata[sessions.Key(workspace, regressionSessionID)].Title != "" {
		t.Fatal("archiving created a title override:", w.Body.String())
	}
	if err := os.WriteFile(filename, []byte("{\"type\":\"custom-title\",\"customTitle\":\"Later real title\"}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	w = postAPI(a, "/api/session-meta", map[string]any{"workspace": workspace, "id": regressionSessionID, "archived": false})
	if w.Code != 200 || snapshotSession(a)["title"] != "Later real title" {
		t.Fatal("transcript title did not update after unarchiving:", w.Body.String())
	}
	key := sessions.Key(workspace, regressionSessionID)
	a.state.Metadata[key] = sessions.Metadata{Title: "Custom", Archived: true, ReadAt: 123}
	w = postAPI(a, "/api/session-meta", map[string]any{"workspace": workspace, "id": regressionSessionID, "archived": false})
	if w.Code != 200 || a.state.Metadata[key].Title != "Custom" || a.state.Metadata[key].ReadAt != 123 {
		t.Fatal("archive action changed unrelated metadata")
	}
	w = postAPI(a, "/api/session-meta", map[string]any{"workspace": workspace, "id": regressionSessionID, "archived": true})
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	w = postAPI(a, "/api/session-meta", map[string]any{"workspace": workspace, "id": regressionSessionID, "title": " Renamed "})
	if w.Code != 200 || a.state.Metadata[key].Title != "Renamed" || !a.state.Metadata[key].Archived {
		t.Fatal("rename changed archive status")
	}
}

func TestRenameLengthMatchesHTMLMaxlength(t *testing.T) {
	a := testApp(t)
	for _, tt := range []struct {
		title string
		code  int
	}{
		{strings.Repeat("x", 161), 200},
		{strings.Repeat("x", 200), 200},
		{strings.Repeat("x", 201), 400},
		{strings.Repeat("\U0001f600", 100), 200},
		{strings.Repeat("\U0001f600", 101), 400},
		{"", 200},
	} {
		w := postAPI(a, "/api/session-meta", map[string]any{"workspace": a.state.Workspace, "id": regressionSessionID, "title": tt.title})
		if w.Code != tt.code {
			t.Fatalf("title length %d bytes: got %d want %d", len(tt.title), w.Code, tt.code)
		}
	}
}

type streamingRecorder struct {
	*httptest.ResponseRecorder
	flushed chan struct{}
	once    sync.Once
}

func (w *streamingRecorder) Flush() {
	w.ResponseRecorder.Flush()
	w.once.Do(func() { close(w.flushed) })
}

func TestHostExitCleansViewsAndEndsSSE(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node.js is not installed")
	}
	a := testApp(t)
	dir := t.TempDir()
	script := filepath.Join(dir, "exit.cjs")
	if err := os.WriteFile(script, []byte(`process.stdout.write(JSON.stringify({kind:'event',method:'host.ready'})+'\n');
require('node:readline').createInterface({input:process.stdin}).on('line',()=>process.exit(7));`), 0600); err != nil {
		t.Fatal(err)
	}
	generation := a.hostGeneration
	exited := make(chan struct{})
	p, err := host.Start(node, script, dir, os.Environ(), nil, func(method string, args json.RawMessage) {
		a.hostEvent(generation, method, args)
		if method == "host.exit" {
			close(exited)
		}
	}, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := p.Ready(ctx); err != nil {
		p.Close()
		t.Fatal(err)
	}
	v := newView("chat", "Chat", "token")
	a.mu.Lock()
	a.peer, a.phase, a.prepared = p, "active", &plugin.Prepared{}
	a.views[v.ID], a.active, a.activeSessionID = v, v.ID, regressionSessionID
	a.pluginSetupOpen, a.settingsOpen = false, true
	for _, status := range []string{"working", "needs_input", "completed"} {
		a.liveSessions[status] = LiveSession{Status: status, CompletedAt: 100}
	}
	a.mu.Unlock()
	w := &streamingRecorder{ResponseRecorder: httptest.NewRecorder(), flushed: make(chan struct{})}
	streamDone := make(chan struct{})
	go func() {
		a.viewEvents(w, httptest.NewRequest("GET", a.ViewURL+"/events", nil).WithContext(ctx), v)
		close(streamDone)
	}()
	select {
	case <-w.flushed:
	case <-ctx.Done():
		t.Fatal("SSE did not connect")
	}
	if err := p.Notify("exit", nil); err != nil {
		t.Fatal(err)
	}
	select {
	case <-exited:
	case <-ctx.Done():
		t.Fatal("host exit callback did not finish")
	}
	select {
	case <-streamDone:
	case <-time.After(time.Second):
		t.Fatal("host exit left SSE hanging")
	}
	select {
	case <-v.done:
	default:
		t.Fatal("host exit did not close the view")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.peer != nil || len(a.views) != 0 || a.active != "" || a.activeSessionID != "" {
		t.Fatal("host exit retained peer/view state")
	}
	if a.phase != "error" || !a.pluginSetupOpen || a.settingsOpen || a.setupStatus != "error" {
		t.Fatal("host exit did not expose setup recovery")
	}
	for _, status := range []string{"working", "needs_input"} {
		if a.liveSessions[status].Status != "interrupted" {
			t.Fatal("live run was not interrupted:", status)
		}
	}
	if a.liveSessions["completed"].Status != "completed" {
		t.Fatal("completed session changed after host exit")
	}
}

func TestOldHostEventsCannotAffectReplacement(t *testing.T) {
	a := testApp(t)
	a.phase, a.pluginSetupOpen = "active", false
	oldGeneration := a.hostGeneration
	a.stopHost()
	a.mu.Lock()
	a.stopping = false
	a.hostGeneration++
	v := newView("new", "New", "token")
	a.views[v.ID], a.active = v, v.ID
	a.mu.Unlock()
	a.hostEvent(oldGeneration, "host.exit", json.RawMessage(`{"message":"late exit"}`))
	a.hostEvent(oldGeneration, "webview.create", json.RawMessage(`{"id":"old"}`))
	if a.phase != "active" || a.pluginSetupOpen || len(a.views) != 1 || a.active != v.ID {
		t.Fatal("late old-host event corrupted replacement state")
	}
	select {
	case <-v.done:
		t.Fatal("late exit closed the replacement view")
	default:
	}
}

func TestStartupSetupClosePreservesSetupAndClosesWindow(t *testing.T) {
	for _, phase := range []string{"starting", "preparing", "setup", "activating", "error"} {
		t.Run(phase, func(t *testing.T) {
			a := testApp(t)
			a.phase, a.pluginSetupOpen = phase, true
			a.prepared, a.setupStatus = &plugin.Prepared{}, "ready"
			prepared := a.prepared
			closed := 0
			a.SetNative(Native{CloseWindow: func() {
				closed++
				// The callback must run outside the state lock and retain a usable reopen state.
				if a.snapshot()["pluginSetupOpen"] != true {
					t.Error("closing the startup window dismissed setup")
				}
			}})
			w := postAPI(a, "/api/ui", map[string]any{"key": "setup", "open": false})
			if w.Code != http.StatusOK || closed != 1 {
				t.Fatalf("startup close did not close the native window: %d %s", w.Code, w.Body.String())
			}
			if !a.pluginSetupOpen || a.phase != phase || a.prepared != prepared || a.peer != nil {
				t.Fatal("startup close changed setup or started the extension host")
			}
		})
	}
}

func TestBrowserStartupCloseDoesNotExposeAnEmptyShell(t *testing.T) {
	a := testApp(t)
	a.phase, a.pluginSetupOpen = "setup", true
	w := postAPI(a, "/api/ui", map[string]any{"key": "setup", "open": false})
	if w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "close this browser tab") {
		t.Fatalf("browser startup close must explain how to exit: %d %s", w.Code, w.Body.String())
	}
	if !a.pluginSetupOpen || a.peer != nil {
		t.Fatal("browser startup close exposed an empty shell or started the host")
	}
}

func TestActiveSetupCloseReturnsToChatWithoutClosingWindow(t *testing.T) {
	a := testApp(t)
	a.phase, a.pluginSetupOpen = "active", true
	v := newView("chat", "Chat", "token")
	a.views[v.ID], a.active = v, v.ID
	closed := false
	a.SetNative(Native{CloseWindow: func() { closed = true }})
	w := postAPI(a, "/api/ui", map[string]any{"key": "setup", "open": false})
	if w.Code != http.StatusOK || closed || a.pluginSetupOpen || a.phase != "active" || a.views[v.ID] != v || a.active != v.ID {
		t.Fatalf("closing setup must return to the existing chat: %d %s", w.Code, w.Body.String())
	}
}

func TestActivationFailureCleansUpAndOpensSetup(t *testing.T) {
	a := testApp(t)
	a.cfg.Node = filepath.Join(t.TempDir(), "missing-node")
	a.prepared, a.setupStatus = &plugin.Prepared{}, "ready"
	a.pluginSetupOpen, a.settingsOpen = false, true
	v := newView("old", "Old", "token")
	a.views[v.ID] = v
	w := postAPI(a, "/api/start", map[string]any{})
	if w.Code != 400 || a.peer != nil || len(a.views) != 0 || !a.pluginSetupOpen || a.settingsOpen {
		t.Fatalf("activation failure did not clean up and expose setup: %d %s", w.Code, w.Body.String())
	}
	select {
	case <-v.done:
	default:
		t.Fatal("activation failure did not close old view")
	}
}
