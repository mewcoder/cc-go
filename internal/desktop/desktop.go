//go:build !headless

package desktop

import (
	"fmt"
	"log"
	"net/url"
	"runtime"

	"cc-go/assets"
	"cc-go/internal/server"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/transfer"
)

func Run(backend *server.App) error {
	backend.EnableNativeViews()
	mygo.Bind(&ViewBridge{backend: backend})
	app := mygo.App
	app.SetName("CC Go")
	app.OnQuit(backend.Close)
	var startupErr error
	app.WhenReady(func() {
		window := mygo.NewWindow(windowOptions(backend.ShellURL, runtime.GOOS))
		if err := window.SetIcon(assets.Icon); err != nil {
			log.Printf("Window icon: %v", err)
		}
		if runtime.GOOS == "darwin" {
			if err := app.Dock.SetIcon(assets.Icon); err != nil {
				log.Printf("Dock icon: %v", err)
			}
		}
		menu := desktopMenu(window, runtime.GOOS)
		app.SetMenu(menu)
		native := nativeServices(window)
		native.ShowMenu = func() { menu.PopupAt(window, 8, 30) }
		backend.SetNative(native)
		window.OnHide(func() { backend.SetWindowVisible(false) })
		window.OnMinimize(func() { backend.SetWindowVisible(false) })
		window.OnShow(func() { backend.SetWindowVisible(!window.IsMinimized()) })
		window.OnRestore(func() { backend.SetWindowVisible(window.IsVisible()) })
		window.Page().OnDidFailLoad(func(err *mygo.LoadError) {
			log.Printf("Desktop page failed to load: %v", err)
		})
		// Only the shell gets the narrow native relay; extension HTML stays
		// isolated on its separate loopback origin without a MyGo preload.
		window.Page().OnWillNavigate(func(event *mygo.NavigateEvent) {
			if !sameOrigin(event.URL, backend.ShellURL) {
				event.PreventDefault()
			}
		})
		window.Page().SetWindowOpenHandler(func(mygo.WindowOpenRequest) *mygo.WindowOptions { return nil })
		if err := configureWindowLifecycle(app, window); err != nil {
			startupErr = fmt.Errorf("initialize system tray: %w", err)
			app.Quit()
		}
	})
	if err := app.Run(); err != nil {
		return err
	}
	return startupErr
}

func windowOptions(shellURL, platform string) mygo.WindowOptions {
	opts := mygo.WindowOptions{
		Title: "CC Go", URL: shellURL,
		Width: 1200, Height: 820, MinWidth: 780, MinHeight: 520,
		BackgroundColor: "#1e1e1e",
		Page:            mygo.PageOptions{TrustedOrigins: []string{shellURL}, DevTools: mygo.DevToolsDisabled},
	}
	if platform == "darwin" {
		opts.TitleBarStyle = mygo.TitleBarHidden
		opts.TrafficLightPosition = &mygo.Point{X: 14, Y: 9}
	} else if platform == "windows" {
		opts.TitleBarStyle = mygo.TitleBarHidden
		opts.TitleBarHeight = 30
		opts.AutoHideMenuBar = true
	}
	return opts
}

func sameOrigin(raw, origin string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.User != nil {
		return false
	}
	base, err := url.Parse(origin)
	return err == nil && u.Scheme == base.Scheme && u.Host == base.Host
}

func nativeServices(window *mygo.Window) server.Native {
	selectFile := func(opts mygo.OpenDialogOptions) (string, error) {
		opts.Parent = window
		paths, err := mygo.Dialog.Open(opts)
		if err != nil || len(paths) == 0 {
			return "", err
		}
		return paths[0], nil
	}
	return server.Native{
		SetTheme:         func(theme string) { window.SetWindowButtonsTheme(mygo.ThemeSource(theme)) },
		CloseWindow:      window.Close,
		OpenURL:          mygo.Shell.OpenExternal,
		OpenPath:         mygo.Shell.OpenPath,
		ShowItemInFolder: mygo.Shell.ShowItemInFolder,
		ReadClipboard:    func() (string, error) { return mygo.Clipboard.ReadText(), nil },
		Copy:             func(text string) error { return mygo.Clipboard.Write(transfer.TextData(text)) },
		SelectFolder: func() (string, error) {
			return selectFile(mygo.OpenDialogOptions{Title: "Choose a workspace", Directory: true})
		},
		SelectVSIX: func() (string, error) {
			return selectFile(mygo.OpenDialogOptions{
				Title:   "Import Claude Code VS Code extension (.vsix)",
				Filters: []mygo.FileFilter{{Name: "Claude Code VS Code extension (.vsix)", Extensions: []string{"vsix"}}},
			})
		},
		SelectNode: func() (string, error) {
			return selectFile(mygo.OpenDialogOptions{Title: "Select Node.js executable (22 or newer)"})
		},
		Message: func(kind, message string, choices []string) (int, error) {
			opts := confirmationOptions(kind, message, choices)
			opts.Parent = window
			result, err := mygo.Dialog.Message(opts)
			if err != nil || result.Button < 0 || result.Button >= len(choices) {
				return -1, err
			}
			return result.Button, nil
		},
	}
}

func confirmationOptions(kind, message string, choices []string) mygo.MessageOptions {
	messageType := mygo.MessageQuestion
	switch kind {
	case "error":
		messageType = mygo.MessageError
	case "warning":
		messageType = mygo.MessageWarning
	}
	return mygo.MessageOptions{
		Type: messageType, Title: "Claude Code", Message: message,
		Buttons:       append(append([]string(nil), choices...), "Cancel"),
		DefaultButton: len(choices), CancelButton: len(choices),
	}
}

func desktopMenu(window *mygo.Window, platform string) *mygo.Menu {
	action := func(label, shortcut, script string) *mygo.MenuItem {
		return &mygo.MenuItem{Label: label, Accelerator: shortcut, Click: func(*mygo.MenuItem, *mygo.Window) {
			if _, err := window.Page().Eval(script); err != nil {
				log.Printf("%s: %v", label, err)
			}
		}}
	}
	file := &mygo.MenuItem{Label: "File", Submenu: []*mygo.MenuItem{
		action("New Conversation", "CmdOrCtrl+N", "window.__goDesktopAction?.('new-session')"),
		action("Add Workspace...", "CmdOrCtrl+O", "document.getElementById('add-workspace')?.click()"),
		action("Settings...", "CmdOrCtrl+,", "window.__goDesktopAction?.('open-settings')"),
	}}
	if platform != "darwin" {
		file.Submenu = append(file.Submenu, mygo.Separator(), &mygo.MenuItem{Role: mygo.RoleQuit, Label: "Quit CC Go", Accelerator: "Ctrl+Q"})
	}
	view := &mygo.MenuItem{Label: "View", Submenu: []*mygo.MenuItem{
		action("Toggle Sidebar", "CmdOrCtrl+B", "window.__goDesktopAction?.('toggle-sidebar')"),
		action("VSIX Output", "CmdOrCtrl+Shift+U", "document.getElementById('connection-status')?.click()"),
		action("Plugin Updates", "", "window.__goDesktopAction?.('open-setup')"),
		action("Refresh Git", "CmdOrCtrl+Shift+R", "window.__goDesktopAction?.('refresh-git')"),
	}}
	return mygo.NewMenu([]*mygo.MenuItem{{Role: mygo.RoleAppMenu}, file, {Role: mygo.RoleEditMenu}, view})
}
