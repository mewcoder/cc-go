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
  const mac = read('scripts/build.sh');
  assert.match(mac, /APP="\$ROOT\/build\/CC Go\.app"/);
  for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
    assert.ok(mac.includes(`<key>${key}</key><string>CC Go</string>`));
  }
  assert.ok(mac.includes('<key>CFBundleIdentifier</key><string>local.claude-vsix-go</string>'));
  assert.match(read('scripts/build.ps1'), /--product-name 'CC Go'/);
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

test('platform executable, launcher and archive names use cc-go', () => {
  const macLinux = read('scripts/build.sh');
  assert.ok(macLinux.includes('-o "$APP/Contents/MacOS/cc-go" ./cmd/cc-go'));
  assert.ok(macLinux.includes('<key>CFBundleExecutable</key><string>cc-go</string>'));
  assert.ok(macLinux.includes('release/cc-go-$VERSION-darwin-$ARCH.zip'));
  assert.ok(macLinux.includes('PACKAGE="cc-go-$VERSION-linux-$ARCH"'));
  assert.ok(macLinux.includes('exec "$HERE/bin/cc-go" "$@"'));
  assert.ok(macLinux.includes('cp assets/cc-go.desktop'));
  assert.ok(macLinux.includes('apps/cc-go.png'));
  const windows = read('scripts/build.ps1');
  assert.ok(windows.includes('$Name = "cc-go-$Version-windows-$Arch"'));
  assert.ok(windows.includes("--original-filename 'cc-go.exe'"));
  assert.ok(windows.includes('-o "$Stage/cc-go.exe" ./cmd/cc-go'));
  assert.match(read('assets/cc-go.desktop'), /^Icon=cc-go$/m);
  assert.match(read('assets/cc-go.desktop'), /^StartupWMClass=cc-go$/m);
  assert.ok(macLinux.includes('github.com/egoist/mygo.packageIdentifier=local.claude-vsix-go'));
  assert.ok(read('.github/workflows/build.yml').includes('name: cc-go-${{ runner.os }}-${{ runner.arch }}'));
});

test('branding preserves existing user data, keychain service and URI scheme', () => {
  assert.match(read('cmd/cc-go/main.go'), /filepath\.Join\(home, "\.cc-go"\)/);
  const server = read('internal/server/app.go');
  for (const operation of ['Get', 'Set', 'Delete']) {
    assert.ok(server.includes(`keyring.${operation}("claude-vsix-go",`));
  }
  assert.match(read('runtime/vscode-api.cjs'), /appName: 'CC Go'.*uriScheme: 'claude-vsix'/);
});
