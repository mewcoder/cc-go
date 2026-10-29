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

test('only the overall Workspace heading has a disclosure arrow', () => {
  const css = fs.readFileSync(path.join(__dirname, '../web/host.css'), 'utf8');
  assert.match(css, /#toggle-workspaces::after \{[^}]*rotate\(-45deg\)/);
  assert.match(css, /#toggle-workspaces\[aria-expanded="true"\]::after \{[^}]*rotate\(45deg\)/);
  assert.doesNotMatch(css, /\.workspace-open::after/);
  assert.match(css, /\.workspace-list\[hidden\] \+ \.archive-section \{ margin-top: auto;/);
});

test('overall Workspace toggle changes only the saved section preference', () => {
  let click, saved;
  const state = { workspaceListCollapsed: false };
  const start = source.indexOf("  ui.toggleWorkspaces.addEventListener('click'");
  const end = source.indexOf("  ui.addWorkspace.addEventListener", start);
  vm.runInNewContext(source.slice(start, end), {
    ui: { toggleWorkspaces: { addEventListener(type, fn) { click = fn; } } }, state,
    desktop: { setWorkspaceListCollapsed(value) { saved = value; } },
    runCommand(key, fn) { assert.equal(key, 'workspace-list'); return fn(); },
  });
  click();
  assert.equal(saved, true);
  state.workspaceListCollapsed = true;
  click();
  assert.equal(saved, false);
  const html = fs.readFileSync(path.join(__dirname, '../web/shell.html'), 'utf8');
  assert.match(html, /id="toggle-workspaces"[^>]*type="button"[^>]*aria-controls="workspace-list"/);
});

test('overall collapse hides only the list and preserves individual project state', () => {
  const start = source.indexOf('    const listCollapsed = Boolean(state.workspaceListCollapsed);');
  const end = source.indexOf('    const items = ', start);
  const state = { workspaceListCollapsed: true };
  const attributes = {};
  const ui = { workspaceList: {}, toggleWorkspaces: { setAttribute(key, value) { attributes[key] = value; } } };
  const apply = () => vm.runInNewContext(source.slice(start, end), { state, ui, desktop: {}, pending: new Set() });
  apply();
  assert.equal(ui.workspaceList.hidden, true);
  assert.equal(attributes['aria-expanded'], 'false');
  state.workspaceListCollapsed = false;
  apply();
  assert.equal(ui.workspaceList.hidden, false);
  assert.equal(attributes['aria-expanded'], 'true');
});
