//go:build !headless

package desktop

import (
	"reflect"
	"testing"

	"github.com/egoist/mygo"
)

func TestWindowOptionsTrustOnlyShellAndPreservePlatformChrome(t *testing.T) {
	const shell = "http://127.0.0.1:12345"
	for _, platform := range []string{"darwin", "windows", "linux"} {
		t.Run(platform, func(t *testing.T) {
			opts := windowOptions(shell, platform)
			if opts.URL != shell || opts.Title != "CC Go" || opts.Width != 1200 || opts.Height != 820 || opts.MinWidth != 780 || opts.MinHeight != 520 {
				t.Fatalf("unexpected window options: %+v", opts)
			}
			if !reflect.DeepEqual(opts.Page.TrustedOrigins, []string{shell}) || opts.Page.DevTools != mygo.DevToolsDisabled || opts.Page.PreloadAllFrames {
				t.Fatalf("unexpected trust options: %+v", opts.Page)
			}
			if platform == "darwin" {
				if opts.TitleBarStyle != mygo.TitleBarHidden || opts.TrafficLightPosition == nil || *opts.TrafficLightPosition != (mygo.Point{X: 14, Y: 9}) {
					t.Fatalf("unexpected macOS chrome: %+v", opts)
				}
			} else if opts.TitleBarStyle != "" || opts.TrafficLightPosition != nil {
				t.Fatal("macOS chrome leaked into another platform")
			}
		})
	}
}

func TestShellNavigationRejectsOtherOriginsAndCredentials(t *testing.T) {
	const shell = "http://127.0.0.1:12345"
	for _, raw := range []string{shell, shell + "/", shell + "/?setup=1#view"} {
		if !sameOrigin(raw, shell) {
			t.Error("rejected shell:", raw)
		}
	}
	for _, raw := range []string{"http://127.0.0.1:12346/", "http://localhost:12345", "https://127.0.0.1:12345", "http://user@127.0.0.1:12345", "http://127.0.0.1:12345.evil.test", "file:///tmp/plugin.html", "about:blank", "javascript:alert(1)", "//127.0.0.1:12345", "%"} {
		if sameOrigin(raw, shell) {
			t.Error("accepted foreign navigation:", raw)
		}
	}
}

func TestConfirmationsAlwaysDefaultToCancelAndDoNotMutateChoices(t *testing.T) {
	for _, choices := range [][]string{nil, {"Allow"}, {"Allow", "Deny"}} {
		original := append([]string(nil), choices...)
		for kind, messageType := range map[string]mygo.MessageType{"info": mygo.MessageQuestion, "warning": mygo.MessageWarning, "error": mygo.MessageError} {
			opts := confirmationOptions(kind, "Confirm?", choices)
			if opts.Type != messageType || opts.DefaultButton != len(choices) || opts.CancelButton != len(choices) || opts.Buttons[len(choices)] != "Cancel" {
				t.Fatalf("unsafe confirmation: %+v", opts)
			}
			opts.Buttons[0] = "changed"
			if !reflect.DeepEqual(choices, original) {
				t.Fatal("choices were mutated")
			}
		}
	}
}

func TestDesktopMenusKeepActionsAndPlatformQuit(t *testing.T) {
	for _, platform := range []string{"darwin", "windows", "linux"} {
		menu := desktopMenu(nil, platform)
		items := menu.Items()
		if len(items) != 4 || items[0].Role != mygo.RoleAppMenu || items[2].Role != mygo.RoleEditMenu {
			t.Fatal("missing native menu roles")
		}
		file, view := items[1], items[3]
		for i, label := range []string{"New Conversation", "Add Workspace...", "Settings..."} {
			if file.Submenu[i].Label != label || file.Submenu[i].Click == nil || file.Submenu[i].Accelerator == "" {
				t.Fatal("missing File action:", label)
			}
		}
		for i, label := range []string{"Toggle Sidebar", "VSIX Output", "Initialization"} {
			if view.Submenu[i].Label != label || view.Submenu[i].Click == nil {
				t.Fatal("missing View action:", label)
			}
		}
		if platform == "darwin" {
			if len(file.Submenu) != 3 {
				t.Fatal("macOS quit belongs in the application menu")
			}
		} else if quit := file.Submenu[len(file.Submenu)-1]; quit.Role != mygo.RoleQuit || quit.Accelerator != "Ctrl+Q" {
			t.Fatal("missing explicit quit")
		}
	}
}

type fakeWindow struct {
	minimized bool
	calls     []string
}

func (w *fakeWindow) Show()             { w.calls = append(w.calls, "show") }
func (w *fakeWindow) IsMinimized() bool { return w.minimized }
func (w *fakeWindow) Restore()          { w.calls = append(w.calls, "restore"); w.minimized = false }
func (w *fakeWindow) Focus()            { w.calls = append(w.calls, "focus") }

func TestRestoreOnlyUnminimizesWhenNecessary(t *testing.T) {
	for _, minimized := range []bool{false, true} {
		window := &fakeWindow{minimized: minimized}
		showMainWindow(window)
		want := []string{"show", "focus"}
		if minimized {
			want = []string{"show", "restore", "focus"}
		}
		if !reflect.DeepEqual(window.calls, want) || window.minimized {
			t.Fatalf("restore calls: %v", window.calls)
		}
	}
}
