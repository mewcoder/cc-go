//go:build !headless

package desktop

import (
	"runtime"

	"cc-go/assets"

	"github.com/egoist/mygo"
)

type restorableWindow interface {
	Show()
	IsMinimized() bool
	Restore()
	Focus()
}

func showMainWindow(window restorableWindow) {
	window.Show()
	if window.IsMinimized() {
		window.Restore()
	}
	window.Focus()
}

func configureWindowLifecycle(app *mygo.Application, window *mygo.Window) error {
	// Linux desktops do not always provide a tray, so keep close-to-quit.
	if runtime.GOOS != "darwin" && runtime.GOOS != "windows" {
		app.OnWindowAllClosed(app.Quit)
		return nil
	}

	show := func() { showMainWindow(window) }
	menu := mygo.NewMenu([]*mygo.MenuItem{
		{Label: "Show CC Go", Click: func(*mygo.MenuItem, *mygo.Window) { show() }},
		mygo.Separator(),
		{Label: "Quit CC Go", Click: func(*mygo.MenuItem, *mygo.Window) { app.Quit() }},
	})
	// Attaching a Menu to a MyGo tray consumes left clicks on macOS. Keep
	// left-click restore and show the menu only for right/Control-click.
	tray, err := mygo.NewTray(mygo.TrayOptions{ID: "cc-go", Icon: assets.Icon, ToolTip: "CC Go"})
	if err != nil {
		return err
	}
	tray.OnClick(show)
	tray.OnRightClick(func() { menu.Popup(nil) })
	app.OnQuit(tray.Destroy)

	// Quit also emits OnClose. Let explicit quit destroy the window rather
	// than cancelling it with the ordinary close-to-hide behavior.
	quitting := false
	app.OnBeforeQuit(func(*mygo.QuitEvent) { quitting = true })
	window.OnClose(func(event *mygo.CloseEvent) {
		if !quitting {
			event.PreventDefault()
			window.Hide()
		}
	})
	if runtime.GOOS == "darwin" {
		app.OnActivate(func(bool) { show() })
	}
	return nil
}
