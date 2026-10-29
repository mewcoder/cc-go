'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

test('HUD polling and branch selection use the same background Git launcher', () => {
  for (const name of ['internal/server/project.go', 'internal/server/selection.go']) {
    const source = read(name);
    assert.match(source, /cmd := gitCommand\(ctx, directory, args\.\.\.\)/);
    assert.doesNotMatch(source, /exec\.Command(?:Context)?\(/);
  }
  assert.match(read('internal/server/git.go'), /configureBackgroundProcess\(cmd\)/);
});

test('Windows background Git suppresses console creation and display', () => {
  const source = read('internal/server/process_windows.go');
  assert.match(source, /const createNoWindow = 0x08000000/);
  assert.match(source, /HideWindow: true, CreationFlags: createNoWindow/);
  assert.match(read('internal/server/process_other.go'), /^\/\/go:build !windows/m);
});
