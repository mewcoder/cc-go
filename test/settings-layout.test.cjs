'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('settings widen to 760px while preserving narrow-window margins', () => {
  const css = fs.readFileSync(path.join(__dirname, '../web/host.css'), 'utf8');
  assert.match(css, /\.settings-panel \{ width: min\(760px, calc\(100vw - 32px\)\); \}/);
  assert.match(css, /@media \(max-width: 680px\)\s*\{\s*\.settings-panel \{ width: calc\(100vw - 24px\); \}\s*\}/);
});
