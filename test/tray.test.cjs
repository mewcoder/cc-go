'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const tray = read('internal/desktop/tray.go');
const desktop = read('internal/desktop/desktop.go');

test('macOS and Windows keep the window alive with a cancellable close hook', () => {
  assert.match(desktop, /configureWindowLifecycle\(app, window\)/);
  assert.match(tray, /runtime\.GOOS != "darwin" && runtime\.GOOS != "windows"/);
  assert.match(tray, /app\.OnWindowAllClosed\(app\.Quit\)/);
  assert.match(tray, /window\.OnClose\([\s\S]*?if !quitting \{\s*event\.PreventDefault\(\)\s*window\.Hide\(\)/);
  assert.doesNotMatch(tray, /backend\.Close|LoadURL|Eval\(/);
});

test('tray restores on left click and exposes its menu only on right click', () => {
  assert.match(tray, /mygo\.NewTray\(mygo\.TrayOptions\{ID: "cc-go", Icon: assets\.TrayIcon, IconIsTemplate: true, ToolTip: "CC Go"\}\)/);
  assert.match(tray, /Label: "Show".*show\(\)/);
  assert.match(tray, /Label: "Exit".*app\.Quit\(\)/);
  assert.match(tray, /tray\.OnClick\(show\)/);
  assert.match(tray, /tray\.OnRightClick\(func\(\) \{ popupTrayMenu\(window, menu\) \}\)/);
  assert.doesNotMatch(tray, /tray\.SetMenu|Menu: menu/);
});

test('only Windows tray menus bypass owner drawing and keep native sizing', () => {
  const windows = read('internal/desktop/tray_menu_windows.go');
  const other = read('internal/desktop/tray_menu_other.go');
  assert.match(windows, /^\/\/go:build windows && !headless/m);
  assert.match(other, /^\/\/go:build !windows && !headless/m);
  assert.match(other, /menu\.Popup\(nil\)/);
  for (const api of ['CreatePopupMenu', 'AppendMenuW', 'DestroyMenu', 'GetCursorPos', 'TrackPopupMenuEx']) {
    assert.ok(windows.includes(`NewProc("${api}")`), api);
  }
  assert.match(windows, /trayAppendMenu\.Call\(menu, 0, uintptr\(i\+1\)/);
  assert.match(windows, /defer trayDestroyMenu\.Call\(menu\)/);
  assert.match(windows, /selected > 0 && selected <= len\(items\)/);
  assert.match(windows, /item\.Click\(item, window\)/);
  assert.doesNotMatch(windows, /menu\.Popup|MFT_OWNERDRAW|SetWindowPos|\.Show\(|\.Restore\(/);
});

test('tray menu contains only Show and Exit', () => {
  const menu = tray.match(/menu := mygo\.NewMenu\(\[\]\*mygo\.MenuItem\{([\s\S]*?)\n\t\}\)/)?.[1];
  assert.ok(menu, 'tray menu is present');
  assert.deepEqual([...menu.matchAll(/Label: "([^"]+)"/g)].map(match => match[1]), ['Show', 'Exit']);
  assert.doesNotMatch(menu, /Separator|Submenu/);
});

test('tray has a dedicated template while window and Dock keep the application icon', () => {
  assert.match(tray, /Icon: assets\.TrayIcon, IconIsTemplate: true/);
  assert.doesNotMatch(tray, /Icon: assets\.Icon[,}]/);
  assert.match(desktop, /window\.SetIcon\(assets\.Icon\)/);
  assert.match(desktop, /app\.Dock\.SetIcon\(assets\.Icon\)/);
  assert.match(read('assets/embed.go'), /go:embed tray\.png/);
});

test('restore only unminimizes when necessary and Dock activation restores', () => {
  assert.match(tray, /window\.Show\(\)\s*if window\.IsMinimized\(\) \{\s*window\.Restore\(\)\s*\}\s*window\.Focus\(\)/);
  assert.doesNotMatch(tray, /Unmaximize|SetFullScreen/);
  assert.match(tray, /app\.OnActivate\(func\(bool\) \{ show\(\) \}\)/);
});

test('explicit quit bypasses hide and shuts down the backend', () => {
  assert.match(desktop, /app\.OnQuit\(backend\.Close\)/);
  assert.match(tray, /app\.OnBeforeQuit\(func\(\*mygo\.QuitEvent\) \{ quitting = true \}\)/);
  assert.match(desktop, /Role: mygo\.RoleAppMenu/);
  assert.match(desktop, /platform != "darwin"[\s\S]*Role: mygo\.RoleQuit, Label: "Quit CC Go", Accelerator: "Ctrl\+Q"/);
});

test('startup setup closes through the same native window lifecycle as the titlebar', () => {
  assert.match(desktop, /CloseWindow:\s+window\.Close/);
});

test('MyGo migration keeps HTTP APIs and does not expose services to extension frames', () => {
  assert.match(desktop, /TrustedOrigins: \[\]string\{shellURL\}/);
  assert.match(desktop, /mygo\.Bind\(&ViewBridge\{backend: backend\}\)/);
  assert.doesNotMatch(desktop, /mygo\.Bind\(backend\)|PreloadAllFrames: true|TrustedOrigins:.*"\*"/);
  assert.match(desktop, /OnWillNavigate[\s\S]*?sameOrigin[\s\S]*?PreventDefault/);
  assert.match(desktop, /SetWindowOpenHandler.*return nil/);
  assert.match(read('web/host.css'), /\.window-drag \{ --app-region: drag; \}/);
  assert.match(read('web/host.css'), /\.window-drag button \{ --app-region: no-drag; \}/);
  assert.doesNotMatch(read('go.mod'), /wailsapp/);
  assert.doesNotMatch(read('scripts/run.cjs'), /gtk3/);
  assert.ok(!fs.existsSync(path.join(__dirname, '../internal/desktop/chrome_darwin.m')));
});
