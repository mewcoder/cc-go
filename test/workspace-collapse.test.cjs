'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../web/shell.js'), 'utf8');

function fixture(collapsed = false) {
  const make = tag => ({ tag, children: [], attributes: {}, dataset: {}, handlers: {},
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(key, fn) { this.handlers[key] = fn; },
  });
  const workspaceElements = new Map();
  const collapsedWorkspaces = new Set(collapsed ? ['/project'] : []);
  const saved = [];
  const context = { document: { createElement: make }, workspaceElements, collapsedWorkspaces,
    icon: name => ({ name }), saveCollapsed: () => saved.push([...collapsedWorkspaces]),
    runCommand() { throw new Error('Collapsing must not start or switch conversations'); }, desktop: {} };
  const start = source.indexOf('  function createWorkspaceNode(path) {');
  const end = source.indexOf('\n  function createSessionRow', start);
  vm.runInNewContext(source.slice(start, end) + '\nresult = createWorkspaceNode("/project");', context);
  context.result.label.textContent = 'Project';
  return { entry: context.result, saved, collapsedWorkspaces };
}

test('workspace collapse toggles only sessions, preserves New Chat and saves state', () => {
  const { entry, saved, collapsedWorkspaces } = fixture();
  entry.open.handlers.click();
  assert.equal(entry.sessionList.hidden, true);
  assert.equal(entry.open.attributes['aria-expanded'], 'false');
  assert.equal(entry.open.attributes['aria-label'], 'Expand Project');
  assert.equal(entry.folderIcon.children[0].name, 'folder');
  assert.ok(entry.row.children.includes(entry.newSession));
  assert.equal(entry.newSession.hidden, undefined);
  assert.ok(collapsedWorkspaces.has('/project'));
  entry.open.handlers.click();
  assert.equal(entry.sessionList.hidden, false);
  assert.equal(entry.open.attributes['aria-expanded'], 'true');
  assert.equal(entry.open.attributes['aria-label'], 'Collapse Project');
  assert.equal(entry.folderIcon.children[0].name, 'folder-open');
  assert.deepEqual(saved, [['/project'], []]);
});

test('workspace restores its saved collapsed icon and expands on click', () => {
  const { entry } = fixture(true);
  assert.equal(entry.expanded, false);
  assert.equal(entry.folderIcon.children[0].name, 'folder');
  entry.open.handlers.click();
  assert.equal(entry.sessionList.hidden, false);
  assert.equal(entry.expanded, true);
  assert.match(source, /localStorage\.getItem\('collapsedWorkspaces'\)/);
  assert.match(source, /localStorage\.setItem\('collapsedWorkspaces', JSON\.stringify\(\[\.\.\.collapsedWorkspaces\]\)\)/);
});

test('overall Workspace stays a static heading and does not hide the list', () => {
  const html = fs.readFileSync(path.join(__dirname, '../web/shell.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../web/host.css'), 'utf8');
  const bridge = fs.readFileSync(path.join(__dirname, '../web/desktop.js'), 'utf8');
  assert.match(html, /<h2>Workspace<\/h2>/);
  assert.doesNotMatch(html, /id="workspace-list"[^>]*hidden/);
  assert.doesNotMatch(source, /toggleWorkspaces|workspaceListCollapsed|workspaceList\.hidden/);
  assert.doesNotMatch(bridge, /setWorkspaceListCollapsed/);
  assert.doesNotMatch(css, /toggle-workspaces|\.workspace-open::after/);
  assert.match(css, /sidebar-header \{ flex-basis: 36px;/);
  assert.match(css, /sidebar-header h2 \{ font-size: 11px;/);
});
