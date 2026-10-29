'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

test('application, window and page titles use CC Go', () => {
  const desktop = read('internal/desktop/desktop.go');
  assert.match(desktop, /app\.SetName\("CC Go"\)/);
  assert.match(desktop, /Title: "CC Go", URL: shellURL/);
  assert.match(read('web/shell.html'), /<title>CC Go<\/title>/);
  assert.match(read('web/setup.js'), /欢迎使用 CC Go/);
  assert.match(read('cmd/cc-go/main.go'), /fmt\.Println\("CC Go:", app\.ShellURL\)/);
});

test('platform packaging uses CC Go without changing compatibility identifiers', () => {
  const mac = read('scripts/build.cjs');
  assert.ok(mac.includes("path.join(work, 'CC Go.app')"));
  for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
    assert.ok(mac.includes(`<key>${key}</key><string>CC Go</string>`));
  }
  assert.ok(mac.includes('<key>CFBundleIdentifier</key><string>local.claude-vsix-go</string>'));
  assert.ok(mac.includes("'--product-name', 'CC Go'"));
  assert.match(read('assets/cc-go.desktop'), /^Name=CC Go$/m);
  assert.match(read('assets/cc-go.desktop'), /^Exec=cc-go$/m);
});

test('package metadata and development entry point use cc-go', () => {
  assert.equal(JSON.parse(read('package.json')).name, 'cc-go');
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(lock.name, 'cc-go');
  assert.equal(lock.packages[''].name, 'cc-go');
  assert.match(read('go.mod'), /^module cc-go$/m);
  assert.match(read('scripts/run.cjs'), /'\.\/cmd\/cc-go'/);
  assert.ok(fs.existsSync(path.join(__dirname, '../cmd/cc-go/main.go')));
});

test('platform executable and installer names use cc-go', () => {
  const macLinux = read('scripts/build.cjs');
  assert.ok(macLinux.includes("path.join(contents, 'MacOS', 'cc-go')"));
  assert.ok(macLinux.includes('<key>CFBundleExecutable</key><string>cc-go</string>'));
  assert.ok(macLinux.includes('`cc-go-${version}-${platform}-${arch}`'));
  assert.ok(macLinux.includes("name + '.dmg'"));
  assert.doesNotMatch(macLinux, /ditto|\.tar\.gz|\.zip/);
  const windows = macLinux;
  assert.ok(windows.includes("name + '.exe'"));
  assert.ok(windows.includes("'--original-filename', 'cc-go.exe'"));
  assert.ok(windows.includes("path.join(root, 'release', path.basename(artifact))"));
  assert.ok(windows.includes("'-o', artifact, './cmd/cc-go'"));
  assert.doesNotMatch(windows, /Compress-Archive|Copy-Item.*node_modules/);
  assert.match(read('assets/cc-go.desktop'), /^Icon=cc-go$/m);
  assert.match(read('assets/cc-go.desktop'), /^StartupWMClass=cc-go$/m);
  assert.ok(read('.github/workflows/build.yml').includes('name: cc-go-${{ matrix.platform }}-${{ matrix.arch }}'));
});

test('branding preserves existing user data, keychain service and URI scheme', () => {
  assert.match(read('cmd/cc-go/main.go'), /filepath\.Join\(home, "\.cc-go"\)/);
  const server = read('internal/server/app.go');
  for (const operation of ['Get', 'Set', 'Delete']) {
    assert.ok(server.includes(`keyring.${operation}("claude-vsix-go",`));
  }
  assert.match(read('runtime/vscode-api.cjs'), /appName: 'CC Go'.*uriScheme: 'claude-vsix'/);
});
