//go:build !windows && !headless

package desktop

import "github.com/egoist/mygo"

func popupTrayMenu(_ *mygo.Window, menu *mygo.Menu) {
	menu.Popup(nil)
}
