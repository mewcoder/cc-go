//go:build shell_smoke && !headless

package desktop

import (
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"

	"cc-go/internal/server"
	"github.com/egoist/mygo"
)

// Opt-in integration of the real shell without installing an extension, reading
// user projects, starting Node, or making a model request.
func init() {
	if os.Getenv("CC_GO_SHELL_SMOKE") != "1" {
		return
	}
	dir, err := os.MkdirTemp("", "cc-go-shell-smoke-")
	if err != nil {
		panic(err)
	}
	defer os.RemoveAll(dir)
	backend, err := server.New(server.Config{DataDir: dir, Workspace: dir, ProjectsDir: filepath.Join(dir, "projects"), Node: filepath.Join(dir, "missing-node")})
	if err != nil {
		panic(err)
	}
	defer backend.Close()
	if err := backend.Start(); err != nil {
		panic(err)
	}
	var passed atomic.Bool
	mygo.App.OnWindowCreated(func(window *mygo.Window) {
		window.Page().OnDidFinishLoad(func() {
			go func() {
				defer mygo.App.Quit()
				for i := 0; i < 40; i++ {
					value, err := mygo.EvalAs[map[string]any](window.Page(), `({url:location.href,desktop:typeof window.desktop,bridge:typeof window.mygo,setup:!document.getElementById('plugin-setup')?.hidden,text:document.body.innerText})`)
					if err != nil {
						fmt.Println("FAIL: shell evaluation:", err)
						return
					}
					if value["desktop"] == "object" && value["bridge"] == "object" && value["setup"] == true {
						fmt.Println("PASS: real shell initialized with native bridge and visible setup; missing Node prevents extension startup")
						passed.Store(true)
						return
					}
					if i == 39 {
						fmt.Println("FAIL: shell state:", value)
					}
					time.Sleep(100 * time.Millisecond)
				}
			}()
		})
	})
	go func() { time.Sleep(20 * time.Second); fmt.Println("FAIL: real shell timed out"); os.Exit(1) }()
	if err := Run(backend); err != nil {
		fmt.Println("FAIL:", err)
		backend.Close()
		_ = os.RemoveAll(dir)
		os.Exit(1)
	}
	backend.Close()
	_ = os.RemoveAll(dir)
	if passed.Load() {
		os.Exit(0)
	}
	os.Exit(1)
}
