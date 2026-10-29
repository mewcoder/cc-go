'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('all sidebar icons use the compact shared 14px size', () => {
  const css = fs.readFileSync(path.join(__dirname, '../web/host.css'), 'utf8');
  assert.match(css, /:root \{ --shell-sidebar-icon-size: 14px; \}/);
  const rule = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/([^{}]+)\{\s*width: var\(--shell-sidebar-icon-size\);\s*height: var\(--shell-sidebar-icon-size\);\s*stroke-width: 1\.5;\s*\}/);
  assert.ok(rule, 'sidebar icons must share dimensions and stroke');
  assert.deepEqual(rule[1].trim().split(/,\s*/), [
    '.window-toggle .icon',
    '.sidebar .icon',
    '.sidebar .sidebar-actions .icon-button .icon',
  ]);
  assert.match(css, /#add-workspace \{ display: grid; place-items: center; \}/);
});

test('sidebar icon overrides do not resize the button hit areas', () => {
  const host = fs.readFileSync(path.join(__dirname, '../web/host.css'), 'utf8');
  const iconRule = host.match(/\.window-toggle \.icon,[\s\S]*?\}/)?.[0];
  assert.ok(iconRule);
  assert.doesNotMatch(iconRule, /padding|margin|min-height|min-width/);
});

test('add-workspace uses an SVG instead of a font-dependent plus glyph', () => {
  const js = fs.readFileSync(path.join(__dirname, '../web/shell.js'), 'utf8');
  assert.match(js, /plus: \['M12 5v14', 'M5 12h14'\]/);
  assert.match(js, /ui\.addWorkspace\.replaceChildren\(icon\('plus'\)\)/);
});

test('history import uses a folder-input SVG rather than a download icon', () => {
  const js = fs.readFileSync(path.join(__dirname, '../web/history.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../web/host.css'), 'utf8');
  assert.match(js, /button\('import-history', 'icon-button'\)/);
  assert.match(js, /svg\.setAttribute\('class', 'icon'\)/);
  assert.ok(js.includes("'M2 13h10', 'm9 10 3 3-3 3'"));
  assert.doesNotMatch(js, /'M12 3v12', 'm7 10 5 5 5-5'/);
  assert.match(js, /addWorkspace\.before\(opener\)/);
  assert.match(css, /#import-history \{ display: grid; place-items: center; \}/);
  assert.match(css, /#import-history \+ #add-workspace \{ margin-left: -6px; \}/);
});

test('only the sidebar plugin replacement entry uses the upgrade icon beside the version', () => {
  const js = fs.readFileSync(path.join(__dirname, '../web/shell.js'), 'utf8');
  const setup = fs.readFileSync(path.join(__dirname, '../web/setup.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../web/host.css'), 'utf8');
  assert.match(js, /ui\.pluginUpdate\.append\(icon\('upgrade'\)\)/);
  assert.match(js, /ui\.pluginUpdate\.hidden = phase !== 'active' \|\| !\['downloading', 'extracting', 'ready', 'error', 'reloading'\]\.includes\(status\)/);
  assert.match(setup, /text\(retry, .*'重新检测'\)/);
  assert.doesNotMatch(setup, /upgradeIcon|refreshIcon|setup-version-action/);
  assert.match(css, /\.sidebar-footer \{ justify-content: flex-start; gap: 6px; \}/);
  assert.match(css, /\.sidebar-footer > \.sidebar-actions \{ margin-left: auto; \}/);
});
