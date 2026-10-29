'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('expanded sidebar toggle follows the right edge without moving the collapsed toggle', () => {
  const css = fs.readFileSync(path.join(__dirname, '../web/host.css'), 'utf8');
  assert.match(css, /:root:is\(\[data-platform="darwin"\], \[data-platform="win32"\]\) body:not\(\.sidebar-collapsed\) > \.window-drag\s*\{\s*padding-left: calc\(var\(--shell-sidebar-width\) - 34px\);\s*\}/);
  assert.match(css, /:root:not\(\[data-platform="darwin"\]\):not\(\[data-platform="win32"\]\) body:not\(\.sidebar-collapsed\) \.sidebar-header > \.window-drag\s*\{\s*order: 1;\s*\}/);
});

test('macOS sidebar toggle has the same optical offset in both sidebar states', () => {
  const css = fs.readFileSync(path.join(__dirname, '../web/host.css'), 'utf8');
  assert.match(css, /:root\[data-platform="darwin"\] \.window-toggle \{ top: 3px; \}/);
});

test('archive has a quiet theme-aware background without changing its layout or expansion states', () => {
  const css = fs.readFileSync(path.join(__dirname, '../web/host.css'), 'utf8');
  assert.match(css, /:root\s*\{[^}]*--shell-archive-background: #1c1c1c;/);
  assert.match(css, /body\[data-theme="light"\]\s*\{\s*--shell-archive-background: #e8e8e6;\s*\}/);
  assert.match(css, /(?:^|\n)\.archive-section \{ background: var\(--shell-archive-background\); \}/);
});
