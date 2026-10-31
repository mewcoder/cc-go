'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../web/shell.js'), 'utf8');

function harness() {
  let focused;
  const make = () => ({ children: [], dataset: {}, handlers: {}, attributes: {}, hidden: false, value: '',
    classList: { toggle() {} },
    append(...children) { for (const child of children) { child.remove(); child.parent = this; this.children.push(child); } },
    insertBefore(child, reference) {
      child.remove(); child.parent = this;
      const index = this.children.indexOf(reference);
      this.children.splice(index < 0 ? this.children.length : index, 0, child);
    },
    remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; },
    querySelector(selector) { return this.children.find(child => `.${child.className}` === selector); },
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(type, handler) { this.handlers[type] = handler; },
    focus() { focused = this; }, select() {},
  });
  const ui = Object.fromEntries(['sidebarHeader', 'archiveBack', 'archiveSearch', 'archiveCount', 'archiveList', 'workspaceList', 'addWorkspace'].map(key => [key, make()]));
  const heading = make();
  ui.sidebarHeader.querySelector = () => heading;
  const more = make(), calls = [], archiveElements = new Map();
  ui.workspaceList.scrollTop = 120;
  const state = { phase: 'active', archivedSessions: [
    { id: 'same', title: 'First chat', workspace: '/code/one', workspaceName: 'One' },
    { id: 'same', title: 'Second chat', workspace: '/code/two', workspaceName: 'Two' },
  ] };
  const context = { ui, state, archiveElements, archiveExpanded: false, window: {},
    document: { createElement: make }, element: () => more, icon: make,
    formatPath: value => value, relativeTime: () => '2m', pending: new Set(),
    sessionStatusDisplay: { idle: 'Idle' }, runCommand: async (_, action) => action(),
    desktop: {
      openSession: async (...args) => calls.push(['open', ...args]),
      archiveSession: async (...args) => calls.push(['archive', ...args]),
      renameSession: async (...args) => calls.push(['rename', ...args]),
    },
  };
  vm.createContext(context);
  for (const [start, end] of [
    ['  function createSessionRow(', '\n  function renderSessions('],
    ['  function setArchiveView(', '\n  function renderWorkspaces('],
    ['  window.__goShowArchive =', '\n  ui.theme.addEventListener('],
  ]) vm.runInContext(source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))), context);
  context.renderArchive('active');
  return { ui, state, heading, more, calls, archiveElements,
    open: context.window.__goShowArchive, refresh: () => context.renderArchive('active'),
    get focused() { return focused; }, get rows() { return ui.archiveList.children.filter(child => child.className === 'session-row'); },
  };
}

test('archive replaces the project list, survives refresh and restores the original list and focus on Back', () => {
  const h = harness();
  assert.equal(h.ui.archiveList.hidden, true);
  assert.equal(h.ui.archiveSearch.hidden, true);
  assert.equal(h.ui.workspaceList.hidden, false);
  h.open();
  assert.equal(h.heading.textContent, 'Archived Chats');
  assert.equal(h.ui.workspaceList.hidden, true);
  assert.equal(h.ui.archiveList.hidden, false);
  assert.equal(h.ui.archiveSearch.hidden, false);
  assert.equal(h.ui.addWorkspace.hidden, true);
  assert.equal(h.more.hidden, true);
  assert.equal(h.ui.archiveCount.textContent, '2');
  assert.equal(h.ui.archiveCount.hidden, false);
  assert.equal(h.focused, h.ui.archiveBack);
  const first = h.rows[0];
  h.refresh();
  assert.equal(h.rows[0], first);
  assert.equal(h.ui.workspaceList.hidden, true);
  h.ui.archiveBack.handlers.click();
  assert.equal(h.heading.textContent, 'Project');
  assert.equal(h.ui.workspaceList.hidden, false);
  assert.equal(h.ui.workspaceList.scrollTop, 120);
  assert.equal(h.ui.archiveList.hidden, true);
  assert.equal(h.ui.archiveSearch.hidden, true);
  assert.equal(h.ui.archiveBack.hidden, true);
  assert.equal(h.ui.archiveCount.hidden, true);
  assert.equal(h.ui.addWorkspace.hidden, false);
  assert.equal(h.more.hidden, false);
  assert.equal(h.focused, h.more);
});

test('archive search matches titles and projects, survives refresh and clears when leaving the archive view', () => {
  const h = harness();
  h.state.archivedSessions.push({ id: 'zh', title: '修复输入法', workspace: '/code/one', workspaceName: 'One' });
  h.open();
  const filter = value => { h.ui.archiveSearch.value = value; h.ui.archiveSearch.handlers.input(); };
  h.ui.archiveList.scrollTop = 100;
  filter('  SECOND   two ');
  assert.deepEqual(h.rows.map(row => row.session.title), ['Second chat']);
  assert.equal(h.ui.archiveCount.textContent, '1 / 3');
  assert.equal(h.ui.archiveList.scrollTop, 0);
  h.refresh();
  assert.equal(h.ui.archiveSearch.value, '  SECOND   two ');
  assert.equal(h.rows.length, 1);
  h.rows[0].parts.open.handlers.click();
  h.rows[0].parts.archive.handlers.click();
  assert.deepEqual(h.calls, [['open', '/code/two', 'same'], ['archive', '/code/two', 'same', false]]);
  filter('输入法');
  assert.deepEqual(h.rows.map(row => row.session.id), ['zh']);
  filter('/CODE/ONE');
  assert.equal(h.rows.length, 2);
  filter('missing');
  assert.equal(h.rows.length, 0);
  assert.equal(h.ui.archiveCount.textContent, '0 / 3');
  assert.equal(h.ui.archiveList.querySelector('.archive-empty').textContent, 'No matching archived chats');
  h.state.archivedSessions = [];
  filter('');
  assert.equal(h.ui.archiveList.querySelector('.archive-empty').textContent, 'No archived chats');
  filter('missing');
  h.ui.archiveBack.handlers.click();
  assert.equal(h.ui.archiveSearch.value, '');
  assert.equal(h.ui.archiveSearch.hidden, true);
  h.open();
  assert.equal(h.ui.archiveSearch.value, '');
});

test('archived chats keep project names and actions across projects, and removals update count and empty state', () => {
  const h = harness();
  h.open();
  assert.deepEqual(h.rows.map(row => row.parts.time.textContent), ['One', 'Two']);
  assert.equal(h.rows[1].parts.time.title, '/code/two');
  assert.equal(h.rows[1].parts.status.hidden, true);
  const row = h.rows[1];
  row.parts.open.handlers.click();
  row.parts.archive.handlers.click();
  row.parts.rename.handlers.click();
  row.parts.input.value = 'New name';
  row.parts.input.handlers.keydown({ key: 'Enter', preventDefault() {} });
  assert.deepEqual(h.calls, [['open', '/code/two', 'same'], ['archive', '/code/two', 'same', false], ['rename', '/code/two', 'same', 'New name']]);
  assert.equal(h.ui.archiveList.hidden, false);
  h.state.archivedSessions.pop();
  h.refresh();
  assert.equal(h.rows.length, 1);
  assert.equal(h.ui.archiveCount.textContent, '1');
  h.state.archivedSessions = [];
  h.refresh();
  h.refresh();
  assert.equal(h.archiveElements.size, 0);
  assert.equal(h.ui.archiveCount.textContent, '0');
  assert.equal(h.ui.archiveList.children.length, 1);
  assert.equal(h.ui.archiveList.children[0].textContent, 'No archived chats');
});
