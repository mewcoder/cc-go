//go:build (darwin || windows) && view_transport_smoke && !headless

package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"github.com/egoist/mygo"
)

// Opt in on a logged-in desktop. No VSIX, Claude process or user data is loaded.
func init() {
	if os.Getenv("CC_GO_VIEW_TRANSPORT_SMOKE") != "1" {
		return
	}
	os.Exit(runViewTransportSmoke())
}

func runViewTransportSmoke() int {
	directory, err := os.MkdirTemp("", "cc-go-view-transport-")
	if err != nil {
		panic(err)
	}
	defer os.RemoveAll(directory)
	backend, err := New(Config{DataDir: directory, Workspace: directory, ProjectsDir: directory, VSCodeExtensionsDirs: []string{}})
	if err != nil {
		panic(err)
	}
	defer backend.Close()
	var activeSockets atomic.Int32
	views := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/socket") {
			activeSockets.Add(1)
			defer activeSockets.Add(-1)
		}
		backend.ViewHandler().ServeHTTP(w, r)
	}))
	defer views.Close()
	backend.ViewURL = views.URL
	asset := filepath.Join(directory, "fixture.js")
	if err := os.WriteFile(asset, []byte(`acquireVsCodeApi();
window.addEventListener('message', event => {
  if (event.data?.type === 'fixture') {
    document.body.textContent = 'Loaded ' + event.data.index;
    parent.postMessage({index:event.data.index, round:event.data.round || 1}, '*');
  }
});`), 0600); err != nil {
		panic(err)
	}
	var frames strings.Builder
	for index := range 12 {
		id := fmt.Sprint(index)
		view := newView(id, "Fixture", "fixture-token")
		view.Roots = []string{directory}
		resourcePath := filepath.ToSlash(asset)
		if !strings.HasPrefix(resourcePath, "/") {
			resourcePath = "/" + resourcePath
		}
		view.HTML = fmt.Sprintf(`<html><body><script type="module" src="%s/resource/%s/fixture-token%s"></script></body></html>`, views.URL, id, resourcePath)
		backend.views[id] = view
		// These official VSIX notifications carry IDs but never receive responses.
		for _, kind := range []string{"update_state", "session_states_update"} {
			notification, _ := json.Marshal(map[string]any{
				"type": "request", "channelId": "", "requestId": id + "-" + kind,
				"request": map[string]any{"type": kind},
			})
			if err := view.post(notification); err != nil {
				panic(err)
			}
		}
		message, _ := json.Marshal(map[string]any{"type": "fixture", "index": index})
		if err := view.post(message); err != nil {
			panic(err)
		}
		fmt.Fprintf(&frames, `<iframe src="%s/view/%s/fixture-token/index.html"></iframe>`, views.URL, id)
	}
	shell := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<html><body><script>
window.loadedViews=new Set();window.pausedViews=new Set();window.rounds={};window.received={};
window.addEventListener('message', e => {
  const index = [...document.querySelectorAll('iframe')].findIndex(frame => frame.contentWindow === e.source);
  if (index < 0) return;
  if (Number.isInteger(e.data?.index)) {
    window.loadedViews.add(e.data.index);
    window.rounds[e.data.index] = e.data.round;
    window.received[e.data.index] = (window.received[e.data.index] || 0) + 1;
  }
  if (e.data?.type === 'claude-host:transport') {
    if (e.data.connected) {
      window.pausedViews.delete(index);
      e.source.postMessage({type:'claude-host:transport',keepAlive:false}, e.origin);
    } else window.pausedViews.add(index);
  }
});
</script>`+frames.String()+`</body></html>`)
	}))
	defer shell.Close()
	backend.ShellURL = shell.URL
	var passed atomic.Bool
	app := mygo.App
	app.SetName("CC Go transport regression")
	app.WhenReady(func() {
		window := mygo.NewWindow(mygo.WindowOptions{Title: "CC Go transport regression", URL: shell.URL, Width: 900, Height: 650})
		go func() {
			defer app.Quit()
			deadline := time.Now().Add(20 * time.Second)
			loaded := 0
			resumed := false
			for time.Now().Before(deadline) {
				count, err := mygo.EvalAs[int](window.Page(), `window.loadedViews?.size ?? 0`)
				loaded = count
				if err == nil && count == 12 {
					paused, _ := mygo.EvalAs[int](window.Page(), `window.pausedViews?.size ?? 0`)
					if paused == 12 && activeSockets.Load() == 0 && !resumed {
						fmt.Println("PASS: 12 native-webview conversations load scripts and messages, then release all idle sockets")
						if err := backend.views["0"].post(json.RawMessage(`{"type":"fixture","index":0,"round":2}`)); err != nil {
							fmt.Println("FAIL:", err)
							return
						}
						if _, err := window.Page().Eval(`document.querySelector('iframe').contentWindow.postMessage({type:'claude-host:transport',keepAlive:true}, ` + fmt.Sprintf("%q", views.URL) + `)`); err != nil {
							fmt.Println("FAIL:", err)
							return
						}
						resumed = true
					}
					if resumed {
						round, _ := mygo.EvalAs[int](window.Page(), `window.rounds?.[0] ?? 0`)
						count, _ := mygo.EvalAs[int](window.Page(), `window.received?.[0] ?? 0`)
						if round == 2 && count == 2 {
							fmt.Println("PASS: a suspended conversation reconnects and receives its queued message")
							passed.Store(true)
							return
						}
					}
				}
				time.Sleep(100 * time.Millisecond)
			}
			fmt.Printf("FAIL: %d/12 views loaded; suspension/resume completed: %v\n", loaded, passed.Load())
		}()
	})
	if err := app.Run(); err != nil {
		fmt.Println("FAIL:", err)
	}
	if !passed.Load() {
		return 1
	}
	return 0
}
