//go:build (darwin || windows) && tray_smoke && !headless

package desktop

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"time"

	"github.com/egoist/mygo"
)

// Opt in on a logged-in desktop with CC_GO_TRAY_SMOKE=1 and -tags=tray_smoke.
// This fixture never starts the backend, loads a VSIX or touches application data.
func init() {
	if os.Getenv("CC_GO_TRAY_SMOKE") != "1" {
		return
	}
	var shutdowns atomic.Int32
	var passed atomic.Bool
	fixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		fmt.Fprint(w, `<!doctype html><html><body>CC Go tray regression<script>window.probeCount=0</script></body></html>`)
	}))
	defer fixture.Close()
	app := mygo.App
	app.SetName("CC Go tray regression")
	app.OnQuit(func() { shutdowns.Add(1) })
	app.WhenReady(func() {
		opts := windowOptions(fixture.URL, "darwin")
		opts.Title = "CC Go tray regression"
		opts.Width, opts.Height = 800, 520
		window := mygo.NewWindow(opts)
		if err := configureWindowLifecycle(app, window); err != nil {
			fmt.Println("FAIL: tray:", err)
			app.Quit()
			return
		}
		ready := make(chan struct{}, 1)
		window.Page().OnDidFinishLoad(func() {
			select {
			case ready <- struct{}{}:
			default:
			}
		})
		go func() {
			defer app.Quit()
			wait := func(label string, check func() bool) bool {
				deadline := time.Now().Add(5 * time.Second)
				for time.Now().Before(deadline) {
					if check() {
						return true
					}
					time.Sleep(25 * time.Millisecond)
				}
				fmt.Println("FAIL:", label)
				return false
			}
			select {
			case <-ready:
			case <-time.After(10 * time.Second):
				fmt.Println("FAIL: webview did not become ready")
				return
			}
			native := window.NativeHandle()
			for i := 1; i <= 3; i++ {
				n, err := mygo.EvalAs[int](window.Page(), `++window.probeCount`)
				if err != nil || n != i {
					fmt.Println("FAIL: webview state reset", n, "want", i, err)
					return
				}
				window.Close()
				if !wait("close did not hide window", func() bool { return !window.IsVisible() }) {
					return
				}
				if native == 0 || window.NativeHandle() != native || len(mygo.Windows()) != 1 || shutdowns.Load() != 0 {
					fmt.Println("FAIL: close destroyed the window or shut down the host")
					return
				}
				showMainWindow(window)
				if !wait("restore did not show window", window.IsVisible) {
					return
				}
			}
			fmt.Println("PASS: three close/restore cycles preserve the native window and JavaScript state")
			window.Minimize()
			if !wait("window did not minimize", window.IsMinimized) {
				return
			}
			showMainWindow(window)
			if !wait("restore did not unminimize", func() bool { return window.IsVisible() && !window.IsMinimized() }) {
				return
			}
			fmt.Println("PASS: restore also unminimizes the window")
			window.Close()
			if !wait("final close did not hide window", func() bool { return !window.IsVisible() }) {
				return
			}
			passed.Store(true)
		}()
	})
	go func() {
		time.Sleep(30 * time.Second)
		fmt.Println("FAIL: tray regression timed out")
		os.Exit(1)
	}()
	if err := app.Run(); err != nil {
		fmt.Println("FAIL:", err)
		os.Exit(1)
	}
	if passed.Load() && shutdowns.Load() == 1 {
		fmt.Println("PASS: explicit quit while hidden runs shutdown exactly once")
		os.Exit(0)
	}
	fmt.Println("FAIL: tray lifecycle or shutdown check failed")
	os.Exit(1)
}
