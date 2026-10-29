'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../web/workspace-menu.js');

function fixture(platform = 'darwin', action = async () => {}, removeAction = async () => {}) {
  const make = tag => ({ tag, children: [], attributes: {}, style: {}, handlers: {}, dataset: {}, open: false,
    append(...children) { this.children.push(...children); },
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(key, callback) { this.handlers[key] = callback; },
    focus() { document.activeElement = this; },
    showModal() { this.open = true; }, close() { this.open = false; },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 200, bottom: 40, width: 200, height: 40 }),
  });
  const document = { body: make('body'), documentElement: { clientWidth: 400, clientHeight: 300 },
    createElement: make, getElementById: () => addWorkspace, handlers: {},
    addEventListener(key, callback) { this.handlers[key] = callback; } };
  const calls = [];
  const removed = [], addWorkspace = make('button');
  let onState;
  create(document, { platform, onState(callback) { onState = callback; },
    async openWorkspaceFolder(path) { calls.push(path); return action(path); },
    async removeWorkspace(path) { removed.push(path); await removeAction(path); onState({ workspaces: [{ path: '/code/current' }] }); } });
  const dialog = document.body.children[0], [item, remove, error] = dialog.children;
  const projects = ['/code/current', '/code/other project'];
  const openButton = make('button');
  openButton.dataset.path = projects[1];
  const row = make('div');
  row.querySelector = () => openButton;
  row.getBoundingClientRect = () => ({ left: 8, bottom: 80 });
  const target = { closest: selector => selector === '.workspace-row' ? row : null };
  const state = { workspaces: projects.map(path => ({ path })) };
  onState(state);
  const open = (extra = {}) => {
    let prevented = false;
    const event = { target, clientX: 390, clientY: 290, preventDefault() { prevented = true; }, ...extra };
    document.handlers.contextmenu(event);
    return prevented;
  };
  return { document, dialog, item, remove, error, open, target, openButton, calls, removed, addWorkspace, state, onState };
}

test('project right-click opens a compact, viewport-clamped folder action for that project', async () => {
  const h = fixture();
  assert.equal(h.open(), true);
  assert.equal(h.dialog.open, true);
  assert.equal(h.item.textContent, 'Open in Finder');
  assert.equal(h.item.children.length, 0, 'Context menu has no icons');
  assert.equal(h.remove.textContent, 'Remove');
  assert.equal(h.remove.children.length, 0);
  assert.equal(h.dialog.style.left, '192px');
  assert.equal(h.dialog.style.top, '252px');
  assert.equal(h.document.activeElement, h.item);
  await h.item.handlers.click();
  assert.deepEqual(h.calls, ['/code/other project'], 'Use the right-clicked project, not the active project');
  assert.equal(h.dialog.open, false);
  assert.equal(h.document.activeElement, h.openButton);
});

test('project menu labels match the platform and ignore unrelated or stale rows', () => {
  for (const [platform, label] of [['win32', 'Open in File Explorer'], ['linux', 'Open in File Manager']]) {
    const h = fixture(platform);
    assert.equal(h.item.textContent, label);
    assert.equal(h.open({ target: { closest: () => null } }), false);
    assert.equal(h.dialog.open, false);
    h.openButton.dataset.path = '/not-registered';
    assert.equal(h.open(), false);
    assert.equal(h.dialog.open, false);
  }
});

test('keyboard context menu, Escape and outside click dismiss without opening a folder', () => {
  const h = fixture();
  h.document.handlers.keydown({ key: 'F10', shiftKey: true, target: h.target, preventDefault() {} });
  assert.equal(h.dialog.open, true);
  assert.equal(h.dialog.style.top, '80px');
  h.dialog.handlers.keydown({ key: 'Escape', preventDefault() {} });
  assert.equal(h.dialog.open, false);
  h.open();
  h.dialog.handlers.click({ target: h.dialog, clientX: 300, clientY: 200 });
  assert.equal(h.dialog.open, false);
  assert.deepEqual(h.calls, []);
});

test('a missing project or opening settings closes stale menus', () => {
  const h = fixture();
  h.open();
  h.onState({ workspaces: [] });
  assert.equal(h.dialog.open, false);
  h.onState(h.state);
  h.open();
  h.onState({ ...h.state, settingsOpen: true });
  assert.equal(h.dialog.open, false);
});

test('folder errors remain visible and repeated clicks cannot open duplicate windows', async () => {
  let fail;
  const h = fixture('darwin', () => new Promise((_, reject) => { fail = reject; }));
  h.open();
  const pending = h.item.handlers.click();
  assert.equal(h.item.disabled, true);
  assert.equal(h.remove.disabled, true);
  await h.item.handlers.click();
  assert.equal(h.calls.length, 1);
  fail(Error('Folder is no longer available'));
  await pending;
  assert.equal(h.error.hidden, false);
  assert.equal(h.error.textContent, 'Folder is no longer available');
  assert.equal(h.dialog.open, true);
  assert.equal(h.item.disabled, false);
  assert.equal(h.remove.disabled, false);
});

test('Remove uses the selected project, updates the sidebar and focuses Add Workspace', async () => {
  const h = fixture();
  h.open();
  h.dialog.handlers.keydown({ key: 'ArrowDown', preventDefault() {} });
  assert.equal(h.document.activeElement, h.remove);
  h.dialog.handlers.keydown({ key: 'ArrowDown', preventDefault() {} });
  assert.equal(h.document.activeElement, h.item);
  await h.remove.handlers.click();
  assert.deepEqual(h.removed, ['/code/other project']);
  assert.deepEqual(h.calls, [], 'Remove must not open or switch projects');
  assert.equal(h.dialog.open, false);
  assert.equal(h.document.activeElement, h.addWorkspace);
});

test('failed Remove keeps the project and displays an inline error', async () => {
  const h = fixture('darwin', undefined, async () => { throw Error('Cannot save sidebar'); });
  h.open();
  await h.remove.handlers.click();
  assert.equal(h.dialog.open, true);
  assert.equal(h.error.textContent, 'Cannot save sidebar');
  assert.equal(h.remove.disabled, false);
});
