//go:build windows && !headless

package desktop

import (
	"syscall"
	"unsafe"

	"github.com/egoist/mygo"
)

var (
	trayUser32              = syscall.NewLazyDLL("user32.dll")
	trayCreatePopupMenu     = trayUser32.NewProc("CreatePopupMenu")
	trayAppendMenu          = trayUser32.NewProc("AppendMenuW")
	trayDestroyMenu         = trayUser32.NewProc("DestroyMenu")
	trayGetCursorPos        = trayUser32.NewProc("GetCursorPos")
	traySetForegroundWindow = trayUser32.NewProc("SetForegroundWindow")
	trayTrackPopupMenu      = trayUser32.NewProc("TrackPopupMenuEx")
	trayPostMessage         = trayUser32.NewProc("PostMessageW")
)

func popupTrayMenu(window *mygo.Window, menu *mygo.Menu) {
	items := menu.Items()
	labels := make([]string, len(items))
	for i, item := range items {
		labels[i] = item.Label
	}
	if selected := nativeTrayMenu(window.NativeHandle(), labels); selected > 0 && selected <= len(items) {
		if item := items[selected-1]; item.Click != nil {
			item.Click(item, window)
		}
	}
}

// Use system text measurement instead of MyGo's Windows 11 owner-drawn
// items, whose narrow tray menu can clip the right edge of "Show".
func nativeTrayMenu(owner uintptr, labels []string) int {
	if owner == 0 {
		return 0
	}
	menu, _, _ := trayCreatePopupMenu.Call()
	if menu == 0 {
		return 0
	}
	defer trayDestroyMenu.Call(menu)
	for i, label := range labels {
		text, err := syscall.UTF16PtrFromString(label)
		if err != nil {
			return 0
		}
		// MF_STRING leaves both measurement and drawing to Windows.
		if ok, _, _ := trayAppendMenu.Call(menu, 0, uintptr(i+1), uintptr(unsafe.Pointer(text))); ok == 0 {
			return 0
		}
	}
	var point struct{ X, Y int32 }
	if ok, _, _ := trayGetCursorPos.Call(uintptr(unsafe.Pointer(&point))); ok == 0 {
		return 0
	}
	// A foreground owner and WM_NULL let notification-area menus dismiss
	// normally on an outside click, including repeated openings.
	traySetForegroundWindow.Call(owner)
	const tpmReturnCmd, tpmRightButton = 0x0100, 0x0002
	selected, _, _ := trayTrackPopupMenu.Call(menu, tpmReturnCmd|tpmRightButton,
		uintptr(point.X), uintptr(point.Y), owner, 0)
	trayPostMessage.Call(owner, 0, 0, 0)
	return int(selected)
}
