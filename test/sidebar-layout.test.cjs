'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('sidebar toggle uses panel-left in both states while its accessible action updates', () => {
  const source = fs.readFileSync(path.join(__dirname, '../web/shell.js'), 'utf8');
  const start = source.indexOf('  function applySidebar()');
  const end = source.indexOf('\n  function endSidebarDrag(', start);
  for (const collapsed of [false, true]) {
    const attributes = {}, icons = [];
    const toggle = { replaceChildren: value => icons.push(value), setAttribute: (key, value) => { attributes[key] = value; } };
    const context = { sidebarWidth: 248, sidebarCollapsed: collapsed, integratedTitlebar: true,
      document: { documentElement: { style: { setProperty() {} } }, body: { classList: { toggle() {} } } },
      ui: { resizer: { setAttribute() {} }, toggleSidebar: toggle }, icon: name => name,
    };
    vm.runInNewContext(source.slice(start, end) + '\napplySidebar();', context);
    assert.deepEqual(icons, ['panel-left']);
    assert.equal(toggle.title, collapsed ? 'Show Sidebar' : 'Hide Sidebar');
    assert.equal(attributes['aria-label'], toggle.title);
  }
  assert.doesNotMatch(source, /panel-left-open|panel-left-close/);
});

test('expanded sidebar controls reserve room for search on the right without moving collapsed controls', () => {
  const css = fs.readFileSync(path.join(__dirname, '../web/host.css'), 'utf8');
  assert.match(css, /:root:is\(\[data-platform="darwin"\], \[data-platform="win32"\]\) body:not\(\.sidebar-collapsed\) > \.window-drag\s*\{\s*padding-left: calc\(var\(--shell-sidebar-width\) - 60px\);\s*\}/);
  assert.match(css, /:root:not\(\[data-platform="darwin"\]\):not\(\[data-platform="win32"\]\) body:not\(\.sidebar-collapsed\) \.sidebar-header > \.window-drag\s*\{\s*order: 1;\s*\}/);
});

test('macOS sidebar toggle has the same optical offset in both sidebar states', () => {
  const css = fs.readFileSync(path.join(__dirname, '../web/host.css'), 'utf8');
  assert.match(css, /:root\[data-platform="darwin"\] \.window-toggle \{ top: 3px; \}/);
});

test('archive list fills the sidebar in place of the project list', () => {
  const css = fs.readFileSync(path.join(__dirname, '../web/host.css'), 'utf8');
  const shell = fs.readFileSync(path.join(__dirname, '../web/shell.css'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '../web/shell.html'), 'utf8');
  assert.match(shell, /\.archive-list \{ flex: 1 1 auto; min-height: 0; overflow-y: auto;/);
  assert.match(css, /\.workspace-list, \.archive-list \{ padding-inline: 0; overflow-y: scroll; scrollbar-gutter: stable both-edges; \}/);
  assert.match(html, /id="archive-back"[^>]*hidden/);
  assert.match(html, /<nav id="archive-list"[^>]*hidden><\/nav>/);
  assert.doesNotMatch(html, /archive-section|toggle-archive/);
});
