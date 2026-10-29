'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('setup and shell explain the VS Code plugin format instead of bare VSIX', () => {
  for (const file of ['web/setup.js', 'web/shell.html', 'web/shell.js']) {
    const source = read(file);
    assert.doesNotMatch(source.replaceAll('VSIX Output', ''), /\bVSIX\b/);
    assert.match(source, /VS Code (?:插件|extension|Extension) \(\.vsix\)/);
  }
});

test('plugin terminology does not rename compatibility identifiers or file formats', () => {
  assert.match(read('internal/desktop/desktop.go'), /SelectVSIX:/);
  assert.match(read('cmd/cc-go/main.go'), /&cfg\.VSIX, "vsix"/);
  assert.match(read('runtime/vscode-api.cjs'), /appName: 'CC Go'.*uriScheme: 'claude-vsix'/);
  assert.match(read('internal/plugin/plugin.go'), /extension\.vsixmanifest/);
});
