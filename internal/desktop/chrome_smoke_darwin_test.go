//go:build darwin && chrome_smoke && !headless

package desktop

import (
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"sync/atomic"
	"time"

	webfiles "cc-go/web"
	"github.com/egoist/mygo"
)

// Opt in with CLAUDE_VSIX_CHROME_SMOKE=1 on a logged-in Mac. This tests the
// native titlebar insets and DOM layout, not a visual screenshot comparison.
func init() {
	if os.Getenv("CLAUDE_VSIX_CHROME_SMOKE") != "1" {
		return
	}
	fixture := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/shell.css", "/host.css":
			w.Header().Set("Content-Type", "text/css")
			b, _ := webfiles.Files.ReadFile(r.URL.Path[1:])
			_, _ = w.Write(b)
		default:
			w.Header().Set("Content-Type", "text/html")
			fmt.Fprint(w, `<!doctype html><html data-platform="darwin"><head><link rel="stylesheet" href="/shell.css"><link rel="stylesheet" href="/host.css"></head><body data-theme="dark"><div class="window-drag"><button id="toggle-sidebar" class="window-toggle"><svg class="icon" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/></svg></button></div></body></html>`)
		}
	}))
	defer fixture.Close()
	app := mygo.App
	app.SetName("CC Go chrome regression")
	app.SetActivationPolicy(mygo.ActivationPolicyAccessory)
	var passed atomic.Bool
	app.WhenReady(func() {
		opts := windowOptions(fixture.URL, "darwin")
		opts.Hidden = true
		window := mygo.NewWindow(opts)
		ready := make(chan struct{}, 1)
		window.Page().OnDidFinishLoad(func() {
			select {
			case ready <- struct{}{}:
			default:
			}
		})
		go func() {
			defer app.Quit()
			select {
			case <-ready:
			case <-time.After(12 * time.Second):
				fmt.Println("FAIL: native page did not load")
				return
			}
			check := func(label string) bool {
				values, err := mygo.EvalAs[[]float64](window.Page(), `(()=>{const b=document.getElementById('toggle-sidebar').getBoundingClientRect(),i=document.querySelector('.window-toggle .icon').getBoundingClientRect(),s=getComputedStyle(document.documentElement);return[b.top+b.height/2,i.top+i.height/2,parseFloat(s.getPropertyValue('--mygo-titlebar-height')),parseFloat(s.getPropertyValue('--mygo-titlebar-inset-left'))]})()`)
				if err != nil || len(values) != 4 {
					fmt.Println("FAIL: no titlebar measurement", err)
					return false
				}
				if math.Abs(values[0]-values[1]) > .5 || math.Abs(values[1]-18) > .5 || values[2] < 30 || values[2] > 34 || values[3] < 65 || values[3] > 100 {
					fmt.Println("FAIL:", label, values)
					return false
				}
				fmt.Printf("PASS %s: button/icon center y=%.1f/%.1f; native titlebar height=%.1f left inset=%.1f\n", label, values[0], values[1], values[2], values[3])
				return true
			}
			if !check("initial") {
				return
			}
			_, _ = window.Page().Eval(`document.body.classList.add('sidebar-collapsed')`)
			if !check("collapsed") {
				return
			}
			_, _ = window.Page().Eval(`document.body.classList.remove('sidebar-collapsed')`)
			window.SetSize(980, 640)
			time.Sleep(200 * time.Millisecond)
			if !check("resized") {
				return
			}
			window.SetSize(1200, 820)
			time.Sleep(200 * time.Millisecond)
			passed.Store(check("restored"))
		}()
	})
	go func() { time.Sleep(30 * time.Second); fmt.Println("FAIL: chrome regression timed out"); os.Exit(1) }()
	if err := app.Run(); err != nil {
		fmt.Println("FAIL:", err)
		os.Exit(1)
	}
	if passed.Load() {
		os.Exit(0)
	}
	os.Exit(1)
}
