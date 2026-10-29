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
  assert.match(tray, /mygo\.NewTray\(mygo\.TrayOptions\{ID: "cc-go", Icon: assets\.Icon, ToolTip: "CC Go"\}\)/);
  assert.match(tray, /Label: "Show CC Go".*show\(\)/);
  assert.match(tray, /Label: "Quit CC Go".*app\.Quit\(\)/);
  assert.match(tray, /tray\.OnClick\(show\)/);
  assert.match(tray, /tray\.OnRightClick\(func\(\) \{ menu\.Popup\(nil\) \}\)/);
  assert.doesNotMatch(tray, /tray\.SetMenu|Menu: menu/);
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
  assert.doesNotMatch(desktop, /mygo\.Bind|PreloadAllFrames: true|TrustedOrigins:.*"\*"/);
  assert.match(desktop, /OnWillNavigate[\s\S]*?sameOrigin[\s\S]*?PreventDefault/);
  assert.match(desktop, /SetWindowOpenHandler.*return nil/);
  assert.match(read('web/host.css'), /\.window-drag \{ --app-region: drag; \}/);
  assert.match(read('web/host.css'), /\.window-drag button \{ --app-region: no-drag; \}/);
  assert.doesNotMatch(read('go.mod'), /wailsapp/);
  assert.doesNotMatch(read('scripts/run.cjs'), /gtk3/);
  assert.ok(!fs.existsSync(path.join(__dirname, '../internal/desktop/chrome_darwin.m')));
});
