package server

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func blockDesktopSave(t *testing.T, a *App) string {
	t.Helper()
	file := filepath.Join(a.cfg.DataDir, "desktop.json")
	if err := os.Remove(file); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	if err := os.Mkdir(file, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(file, "blocker"), []byte("block atomic replacement"), 0600); err != nil {
		t.Fatal(err)
	}
	return file
}

func TestActivationSurvivesSetupCompletionSaveFailure(t *testing.T) {
	a := testApp(t)
	prepareChatFixture(t, a)
	blockDesktopSave(t, a)
	if w := postAPI(a, "/api/start", map[string]any{}); w.Code != 200 {
		t.Fatalf("successful activation was reported as a failure: %d %s", w.Code, w.Body.String())
	}
	a.mu.Lock()
	peer, active, complete := a.peer, a.active, a.state.SetupComplete
	a.mu.Unlock()
	if peer == nil || active == "" || !complete || a.snapshot()["phase"] != "active" {
		t.Fatal("a persistence failure tore down the running host or view")
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	if _, err := peer.Call(ctx, "settings.get", map[string]any{}); err != nil {
		t.Fatal("host no longer responds after saving failed:", err)
	}
	a.mu.Lock()
	logs := strings.Join(a.logs, "\n")
	a.mu.Unlock()
	if !strings.Contains(logs, "setup completion could not be saved") {
		t.Fatal("persistence failure was silently discarded")
	}
}

func TestActivationFailureCanPrepareAndStartAgainOffline(t *testing.T) {
	for _, completed := range []bool{false, true} {
		t.Run(map[bool]string{false: "first-run", true: "returning-user"}[completed], func(t *testing.T) {
			a := testApp(t)
			useTestNode(t, a)
			a.cfg.ModulesDir, _ = filepath.Abs("../../node_modules")
			marker := filepath.Join(t.TempDir(), "allow-activation")
			archive := activationRecoveryArchive(t, marker)
			if err := a.prepare(t.Context(), archive); err != nil {
				t.Fatal(err)
			}
			a.state.SetupComplete = completed
			a.cfg.VSIX = a.state.Archive
			transport := http.DefaultTransport
			http.DefaultTransport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
				return nil, errors.New("offline: unexpected request to " + r.URL.String())
			})
			defer func() { http.DefaultTransport = transport }()
			if w := postAPI(a, "/api/start", map[string]any{}); w.Code != 400 {
				t.Fatalf("activation failure was not surfaced: %d %s", w.Code, w.Body.String())
			}
			setup := a.snapshot()["pluginSetup"].(map[string]any)
			if setup["status"] != "error" || setup["runtimeReady"] != true || a.peer != nil {
				t.Fatal("failed activation did not retain the prepared runtime for recovery")
			}
			if err := os.WriteFile(marker, []byte("ready"), 0600); err != nil {
				t.Fatal(err)
			}
			if w := postAPI(a, "/api/retry", map[string]any{}); w.Code != 200 || a.setupStatus != "ready" {
				t.Fatalf("offline retry failed: %d %s", w.Code, w.Body.String())
			}
			if w := postAPI(a, "/api/start", map[string]any{}); w.Code != 200 || a.phase != "active" || a.peer == nil {
				t.Fatalf("start after retry failed: %d %s", w.Code, w.Body.String())
			}
		})
	}
}

func activationRecoveryArchive(t *testing.T, marker string) string {
	t.Helper()
	reader, err := zip.OpenReader(fixtureArchive(t))
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	file := filepath.Join(t.TempDir(), "recovery.vsix")
	output, err := os.Create(file)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(output)
	encoded, _ := json.Marshal(marker)
	for _, entry := range reader.File {
		r, err := entry.Open()
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(r)
		r.Close()
		if err != nil {
			t.Fatal(err)
		}
		if entry.Name == "extension/extension.cjs" {
			data = append([]byte("if (!require('node:fs').existsSync("+string(encoded)+")) throw new Error('fixture activation failed');\n"), data...)
		}
		w, err := writer.CreateHeader(&entry.FileHeader)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := output.Close(); err != nil {
		t.Fatal(err)
	}
	return file
}

func TestFinalPrepareSaveFailureCanRetryCachedVSIXOffline(t *testing.T) {
	a := testApp(t)
	useTestNode(t, a)
	archive := fixtureArchive(t)
	blocked := blockDesktopSave(t, a)
	if err := a.prepare(t.Context(), archive); err == nil {
		t.Fatal("fixture did not fail its final prepare save")
	} else {
		a.fail(err)
	}
	setup := a.snapshot()["pluginSetup"].(map[string]any)
	if setup["runtimeReady"] != true || setup["status"] != "error" || a.snapshot()["setupCanStart"] != false {
		t.Fatal("expected a prepared runtime blocked only by a failed save")
	}
	if err := os.RemoveAll(blocked); err != nil {
		t.Fatal(err)
	}
	transport := http.DefaultTransport
	http.DefaultTransport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return nil, errors.New("offline: unexpected request to " + r.URL.String())
	})
	defer func() { http.DefaultTransport = transport }()
	if w := postAPI(a, "/api/retry", map[string]any{}); w.Code != 200 || a.setupStatus != "ready" || a.state.Archive != archive {
		t.Fatalf("cached retry after failed save: %d %s", w.Code, w.Body.String())
	}
}

func TestCloseCancelsAPIOperationsWithoutWaitingForRequestTimeout(t *testing.T) {
	for _, scenario := range []struct {
		endpoint string
		body     bool
	}{
		{"/api/retry", false}, {"/api/update-plugin", false}, {"/api/update-check", false},
		{"/api/retry", true}, {"/api/update-plugin", true},
	} {
		name := scenario.endpoint + map[bool]string{false: "/metadata", true: "/download-body"}[scenario.body]
		t.Run(name, func(t *testing.T) {
			endpoint := scenario.endpoint
			a := testApp(t)
			useTestNode(t, a)
			if endpoint != "/api/retry" {
				if err := a.prepare(t.Context(), fixtureArchive(t)); err != nil {
					t.Fatal(err)
				}
			}
			started := make(chan struct{})
			if scenario.body {
				fixtureRegistry(t, "1.2.4")
			}
			transport := http.DefaultTransport
			http.DefaultTransport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
				if scenario.body {
					res, err := transport.RoundTrip(r)
					if err == nil && r.URL.Path == "/plugin.vsix" {
						res.Body = &stalledDownload{ReadCloser: res.Body, ctx: r.Context(), started: started}
					}
					return res, err
				}
				close(started)
				<-r.Context().Done()
				return nil, r.Context().Err()
			})
			defer func() { http.DefaultTransport = transport }()
			// The request itself is deliberately kept alive, as with a desktop webview.
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			request := httptest.NewRequest("POST", a.ShellURL+endpoint, bytes.NewBufferString("{}")).WithContext(ctx)
			request.Header.Set("X-Claude-Desktop-Token", a.token)
			done := make(chan struct{})
			go func() {
				defer close(done)
				a.Handler().ServeHTTP(httptest.NewRecorder(), request)
			}()
			select {
			case <-started:
			case <-time.After(5 * time.Second):
				cancel()
				t.Fatal("operation did not reach the blocked transport")
			}
			closed := make(chan struct{})
			go func() { a.Close(); close(closed) }()
			select {
			case <-closed:
			case <-time.After(5 * time.Second):
				cancel()
				t.Fatal("Close waited for the request's long timeout instead of cancelling it")
			}
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("handler outlived shutdown")
			}
		})
	}
}

func TestExternalLinkCapabilityTracksTheActualNativeBridge(t *testing.T) {
	a := testApp(t)
	for _, native := range []bool{false, true} {
		if native {
			a.SetNative(Native{OpenURL: func(string) error { return nil }})
		}
		w := httptest.NewRecorder()
		a.Handler().ServeHTTP(w, httptest.NewRequest("GET", a.ShellURL+"/host-config.js", nil))
		want := `"nativeExternalLinks":false`
		if native {
			want = `"nativeExternalLinks":true`
		}
		if w.Code != 200 || !strings.Contains(w.Body.String(), want) {
			t.Fatalf("incorrect native capability: %d %s", w.Code, w.Body.String())
		}
	}
}
