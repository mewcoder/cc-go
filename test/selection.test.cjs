'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../web/selection.js');

function fixture(extra = {}) {
  const make = tag => ({ tag, children: [], style: {}, attributes: {}, handlers: {}, value: '', open: false,
    classList: { add() {} },
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items; },
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(name, callback) { this.handlers[name] = callback; },
    showModal() { this.open = true; }, close() { this.open = false; }, focus() { document.activeElement = this; },
  });
  const document = { body: make('body'), documentElement: { clientWidth: 1200, clientHeight: 800 },
    createElement: make, createElementNS: (_, tag) => make(tag) };
  const calls = [];
  const picker = create(document, { request: async () => ({ current: 'main', branches: ['main', 'feature/test'], dirty: false }),
    invoke: async (...args) => calls.push(args), ...extra });
  const dialog = document.body.children[0], [filter, group, list, footer, status] = dialog.children;
  const state = { canSelectProject: true, views: [{ id: 'view', active: true }], workspace: '/code/one',
    workspaces: [{ name: 'one', path: '/code/one' }, { name: '<two>', path: '/code/two' }] };
  const anchor = { getBoundingClientRect: () => ({ left: 300, top: 780 }) };
  return { picker, dialog, document, filter, group, status, list, footer, state, anchor, calls,
    open: kind => picker.open(kind, state, anchor) };
}

test('project picker lists current projects safely, filters them and selects into a new conversation', async () => {
  const h = fixture();
  await h.open('project');
  assert.equal(h.dialog.open, true);
  assert.equal(h.dialog.attributes['aria-label'], 'Choose project');
  assert.equal(h.filter.placeholder, 'Search folders\u2026');
  assert.equal(h.document.activeElement, h.filter);
  assert.equal(h.list.children.length, 2);
  assert.equal(h.list.children[0].attributes['aria-current'], 'true');
  assert.equal(h.list.children[0].children[1].tag, 'svg');
  assert.equal(h.list.children[1].children[0].textContent, '<two>');
  assert.equal(h.list.children[1].title, '/code/two');
  assert.equal(h.list.children[1].children.length, 1, 'Paths stay in tooltips, not extra rows');
  h.filter.value = '/code/two';
  h.filter.handlers.input();
  assert.equal(h.list.children.length, 1);
  assert.equal(h.footer.children[0].children[0].textContent, 'Open folder\u2026');
  await h.list.children[0].handlers.click();
  assert.deepEqual(h.calls, [['select-project', { id: 'view', workspace: '/code/one', path: '/code/two' }]]);
  assert.equal(h.dialog.open, false);
});

test('branch picker keeps dirty warning compact and disables unsafe switches', async () => {
  const h = fixture({ request: async () => ({ current: 'main', branches: ['main', 'feature/test'], dirty: true, files: 95, untracked: 95 }) });
  await h.open('branch');
  assert.equal(h.group.hidden, true);
  assert.equal(h.footer.hidden, true);
  assert.equal(h.status.textContent, '95 untracked files');
  assert.match(h.status.title, /Nothing will be discarded/);
  assert.equal(h.list.children[0].disabled, false);
  assert.equal(h.list.children[1].disabled, true);
  await h.list.children[1].handlers.click();
  assert.equal(h.calls.length, 0);
  assert.equal(h.dialog.open, true);
  await h.list.children[0].handlers.click();
  assert.equal(h.dialog.open, false);
});

test('branch warning distinguishes tracked and untracked file counts', async () => {
  for (const [counts, expected] of [
    [{ files: 1, untracked: 1 }, '1 untracked file'],
    [{ files: 1, untracked: 0 }, '1 changed file'],
    [{ files: 4, untracked: 0 }, '4 changed files'],
    [{ files: 5, untracked: 3 }, '2 changed \u00b7 3 untracked files'],
    [{}, 'Working tree has changes'],
  ]) {
    const h = fixture({ request: async () => ({ current: 'main', branches: ['main'], dirty: true, ...counts }) });
    await h.open('branch');
    assert.equal(h.status.textContent, expected);
  }
});

test('branch selection uses the selected local name and displays backend errors without losing the picker', async () => {
  const calls = [];
  const h = fixture({ invoke: async (...args) => { calls.push(args); throw Error('Branch is checked out in another worktree'); } });
  await h.open('branch');
  await h.list.children[1].handlers.click();
  assert.deepEqual(calls, [['select-branch', { id: 'view', workspace: '/code/one', branch: 'feature/test' }]]);
  assert.equal(h.dialog.open, true);
  assert.match(h.status.textContent, /another worktree/);
  assert.equal(h.list.children.length, 0);
  h.picker.sync({ ...h.state, views: [{ id: 'reopened-view', active: true }] });
  assert.equal(h.dialog.open, true, 'Keep a failed checkout visible until the user dismisses it');
  h.dialog.handlers.cancel({ preventDefault() {} });
  assert.equal(h.dialog.open, false);
});

test('folder picker, no-repository errors, stale selection and historical conversations are handled', async () => {
  const h = fixture({ request: async () => { throw Error('Not a Git repository'); } });
  await h.open('project');
  await h.footer.children[0].handlers.click();
  assert.equal(h.calls[0][1].path, '');
  await h.open('branch');
  assert.match(h.status.textContent, /Not a Git repository/);
  h.dialog.handlers.cancel({ preventDefault() {} });
  assert.equal(h.dialog.open, false);
  await h.open('project');
  h.picker.sync({ ...h.state, workspace: '/code/changed' });
  assert.equal(h.dialog.open, false);
  h.state.canSelectProject = false;
  await h.open('project');
  assert.equal(h.dialog.open, false);
});

test('arrow navigation includes the folder action and preserves search editing keys', async () => {
  const h = fixture();
  await h.open('project');
  const key = (value, target = h.document.activeElement) => h.dialog.handlers.keydown({
    key: value, target, preventDefault() {},
  });
  key('Home');
  assert.equal(h.document.activeElement, h.filter);
  key('ArrowDown');
  assert.equal(h.document.activeElement, h.list.children[0]);
  key('End');
  assert.equal(h.document.activeElement, h.footer.children[0]);
  key('ArrowDown');
  assert.equal(h.document.activeElement, h.list.children[0]);
  key('ArrowUp');
  assert.equal(h.document.activeElement, h.footer.children[0]);
  h.filter.value = 'search';
  key('Escape', h.filter);
  assert.equal(h.dialog.open, false, 'Escape closes even when the search field has text');
});

test('opening another menu clears old dirty warnings', async () => {
  const h = fixture({ request: async () => ({ current: 'main', branches: ['main'], dirty: true }) });
  await h.open('branch');
  h.dialog.handlers.cancel({ preventDefault() {} });
  await h.open('project');
  assert.equal(h.status.hidden, true);
  assert.equal(h.status.title, '');
});
