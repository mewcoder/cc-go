'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const sidebar = require('../web/sidebar-list.js');
const chat = (workspace, id, updatedAt) => ({ workspace, id, updatedAt, title: id });

test('sidebar defaults to grouped/latest and ordering never mutates the source', () => {
  assert.deepEqual(sidebar.options({}), { display: 'grouped', sort: 'updated', order: [], projectOrder: [] });
  const source = [chat('/one', 'a', 1), chat('/one', 'b', 3), chat('/two', 'a', 2)];
  const ordered = sidebar.sortSessions(source, sidebar.options({}));
  assert.deepEqual(ordered.map(sidebar.key), ['["/one","b"]', '["/two","a"]', '["/one","a"]']);
  assert.equal(source[0].id, 'a');
  const manual = { sort: 'manual', order: [sidebar.key(source[0]), sidebar.key(source[2])] };
  assert.deepEqual(sidebar.sortSessions(source, manual), [source[0], source[2], source[1]]);
  source[2].updatedAt = 100;
  assert.equal(sidebar.sortSessions(source, manual)[0], source[0]);
});

test('grouped and merged orders preserve workspace identity, including duplicate session IDs', () => {
  const state = { workspaces: [
    { path: '/one', sessions: [chat('/one', 'a', 1), chat('/one', 'b', 3)] },
    { path: '/two', sessions: [chat('/two', 'a', 2)] },
  ] };
  assert.deepEqual(sidebar.currentOrder(state), ['["/one","b"]', '["/one","a"]', '["/two","a"]']);
  state.sidebarOptions = { display: 'merged' };
  assert.deepEqual(sidebar.currentOrder(state), ['["/one","b"]', '["/two","a"]', '["/one","a"]']);
  const old = sidebar.currentOrder(state);
  assert.deepEqual(sidebar.movedOrder(old, old[0], old[2], true), [old[1], old[2], old[0]]);
  assert.equal(sidebar.movedOrder(old, 'missing', old[0]), null);
  assert.equal(sidebar.movedOrder(old, old[0], old[0]), null);
  assert.deepEqual(sidebar.currentOrder(state), old);
});

test('creation sorting uses newest creation first in grouped and merged lists despite later activity', () => {
  const older = { ...chat('/one', 'older', 100), createdAt: 1 };
  const newer = { ...chat('/one', 'newer', 10), createdAt: 3 };
  const other = { ...chat('/two', 'other', 50), createdAt: 2 };
  const legacy = chat('/one', 'legacy', 200);
  const state = { sidebarOptions: { sort: 'created' }, workspaces: [
    { path: '/one', sessions: [older, newer, legacy] },
    { path: '/two', sessions: [other] },
  ] };
  assert.equal(sidebar.options(state).sort, 'created');
  assert.deepEqual(sidebar.currentOrder(state), [newer, older, legacy, other].map(sidebar.key));
  state.sidebarOptions.display = 'merged';
  assert.deepEqual(sidebar.currentOrder(state), [newer, other, older, legacy].map(sidebar.key));
  older.updatedAt = 1000;
  assert.deepEqual(sidebar.currentOrder(state), [newer, other, older, legacy].map(sidebar.key));
});

function harness(count = 12) {
  const elements = [];
  function make(tag = 'div') {
    const classes = new Set();
    const node = { tag, children: [], dataset: {}, attributes: {}, handlers: {}, hidden: false,
      className: '', classList: { add: name => classes.add(name), remove: name => classes.delete(name) },
      append(...children) { for (const child of children) { child.remove(); child.parent = this; this.children.push(child); } },
      insertBefore(child, reference) {
        child.remove(); child.parent = this;
        const index = this.children.indexOf(reference);
        this.children.splice(index < 0 ? this.children.length : index, 0, child);
      },
      remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; },
      setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute(name) { delete this.attributes[name]; },
      addEventListener(name, fn) { this.handlers[name] = fn; },
      contains(other) { return this === other || this.children.some(child => child.contains(other)); },
      matches(selector) {
        if (selector === '[hidden]') return this.hidden;
        return selector.startsWith('.') && (this.className.split(' ').includes(selector.slice(1)) || classes.has(selector.slice(1)));
      },
      closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector); },
      querySelectorAll(selector) {
        return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
      },
      querySelector(selector) { return this.querySelectorAll(selector)[0]; },
      getBoundingClientRect() { return { top: 0, height: 28 }; },
      focus() { this.focused = true; },
    };
    elements.push(node);
    return node;
  }
  const list = make(), calls = [];
  let failure;
  const state = { phase: 'active', sidebarOptions: { display: 'merged', sort: 'updated', order: [] }, workspaces: [
    { path: '/one', sessions: Array.from({ length: count }, (_, i) => chat('/one', String(i), i)) },
    { path: '/two', sessions: [chat('/two', '0', count + 1)] },
  ] };
  let controller;
  const render = () => { controller.prepare(state); controller.renderMerged('active'); };
  controller = sidebar.create({ createElement: make }, {
    async setSidebarOptions(value) { if (failure) throw failure; calls.push(value); state.sidebarOptions = { ...state.sidebarOptions, ...value }; render(); },
  }, { list, render, formatPath: value => value,
    createRow(workspace, id) {
      const row = make(); row.className = 'session-row'; row.dataset = { workspacePath: workspace, sessionId: id };
      const open = make('button'); open.className = 'session-item';
      const time = make('span'); open.append(time); row.append(open); row.parts = { open, time };
      return row;
    },
    updateRow(row, session) { row.session = session; },
  });
  render();
  return { list, state, calls, controller, render, make,
    get rows() { return list.querySelectorAll('.session-row'); },
    more: elements.find(node => node.className === 'session-load-more'),
    error: elements.find(node => node.className === 'sidebar-list-error'),
    set failure(value) { failure = value; },
  };
}

test('merged rendering omits project labels, keeps path tooltips and paginates without stale rows', () => {
  const h = harness();
  assert.equal(h.rows.length, 10);
  assert.equal(h.rows[0].dataset.workspacePath, '/two');
  assert.equal(h.list.querySelectorAll('.session-project').length, 0);
  assert.equal(h.rows[0].parts.open.title, '0\n/two');
  assert.equal(h.rows[0].draggable, false);
  h.more.handlers.click();
  assert.equal(h.rows.length, 13);
  assert.equal(h.more.hidden, true);
  h.state.workspaces.pop();
  h.render();
  assert.equal(h.rows.length, 12);
  h.state.sidebarOptions.display = 'grouped';
  h.render();
  assert.equal(h.controller.merged, false);
  assert.equal(h.rows.length, 0);
  h.state.sidebarOptions.display = 'merged';
  h.render();
  assert.equal(h.rows.length, 10);
});

test('projects preserve addition order by default and support independent manual reordering', async () => {
  const h = harness(2);
  h.state.sidebarOptions = { display: 'grouped', sort: 'updated', order: ['kept-chat-order'] };
  const rows = ['/one', '/two'].map(path => {
    const row = h.make(); row.className = 'workspace-row';
    const open = h.make('button'); open.className = 'workspace-open'; open.dataset.path = path;
    row.append(open); h.list.append(row);
    return row;
  });
  h.render();
  assert.deepEqual(h.controller.prepare(h.state).map(project => project.path), ['/one', '/two']);
  assert.ok(rows.every(row => row.draggable));
  const dataTransfer = { setData() {} };
  h.list.handlers.dragstart({ target: rows[0].children[0], dataTransfer });
  h.list.handlers.drop({ target: rows[1], clientY: 25, preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.state.sidebarOptions.projectOrder, ['/two', '/one']);
  assert.equal(h.state.sidebarOptions.sort, 'updated');
  assert.deepEqual(h.state.sidebarOptions.order, ['kept-chat-order']);
  assert.deepEqual(h.controller.prepare(h.state).map(project => project.path), ['/two', '/one']);
  h.state.workspaces.push({ path: '/three', sessions: [] });
  assert.deepEqual(h.controller.prepare(h.state).map(project => project.path), ['/two', '/one', '/three']);
  h.list.handlers.keydown({ target: rows[1].children[0], altKey: true, key: 'ArrowDown', preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.state.sidebarOptions.projectOrder, ['/one', '/two', '/three']);
  assert.equal(rows[1].children[0].focused, true);
  h.failure = Error('Disk full');
  h.list.handlers.keydown({ target: rows[0].children[0], altKey: true, key: 'ArrowDown', preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.state.sidebarOptions.projectOrder, ['/one', '/two', '/three']);
  assert.equal(h.error.textContent, 'Disk full');
});

test('manual ordering supports keyboard reordering and reports failed saves without reordering', async () => {
  const h = harness(2);
  h.state.sidebarOptions.sort = 'manual';
  h.render();
  assert.ok(h.rows.every(row => row.draggable));
  const source = h.rows[0], original = h.rows.map(row => sidebar.key(row.session));
  let prevented = false;
  h.list.handlers.keydown({ target: source.parts.open, altKey: true, key: 'ArrowDown', preventDefault() { prevented = true; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(prevented, true);
  assert.equal(h.calls.length, 1);
  assert.equal(source.parts.open.focused, true);
  assert.deepEqual(h.rows.map(row => sidebar.key(row.session)), [original[1], original[0], original[2]]);
  h.failure = Error('Disk full');
  const before = h.rows.map(row => sidebar.key(row.session));
  h.list.handlers.keydown({ target: h.rows[0].parts.open, altKey: true, key: 'ArrowDown', preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.rows.map(row => sidebar.key(row.session)), before);
  assert.equal(h.error.hidden, false);
  assert.equal(h.error.textContent, 'Disk full');
});

test('manual drag drop reorders only app-owned rows and is disabled in recent sorting', async () => {
  const h = harness(2);
  let prevented = false;
  h.list.handlers.dragstart({ target: h.rows[0], preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  h.state.sidebarOptions.sort = 'manual';
  h.render();
  const order = h.rows.map(row => sidebar.key(row.session));
  const dataTransfer = { setData() {} };
  h.list.handlers.dragstart({ target: h.rows[0], dataTransfer });
  h.list.handlers.drop({ target: h.rows[1], clientY: 25, preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.rows.map(row => sidebar.key(row.session)), [order[1], order[0], order[2]]);
  assert.equal(h.calls.length, 1);
  h.list.handlers.drop({ target: h.rows[0], clientY: 25, preventDefault() {} });
  assert.equal(h.calls.length, 1);
});

test('queued option saves merge with the latest snapshot and recover after an error', async () => {
  const source = fs.readFileSync(require.resolve('../web/desktop.js'), 'utf8');
  const start = source.indexOf('    setSidebarOptions: patch => {');
  const end = source.indexOf('    setTheme:', start);
  const calls = [];
  let finish, fail = false;
  const context = { sidebarOptionsSave: Promise.resolve(), latest: { sidebarOptions: { display: 'grouped', sort: 'manual' } },
    async invoke(method, args) {
      calls.push(args.value);
      if (calls.length === 1) await new Promise(resolve => { finish = resolve; });
      if (fail) throw Error('Disk full');
      context.latest.sidebarOptions = args.value;
    },
  };
  const api = vm.runInNewContext(`({${source.slice(start, end)}})`, context);
  const a = api.setSidebarOptions({ order: ['chat-b', 'chat-a'] });
  const b = api.setSidebarOptions({ display: 'merged' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1);
  finish();
  await Promise.all([a, b]);
  assert.equal(calls[1].display, 'merged');
  assert.deepEqual(Array.from(calls[1].order), ['chat-b', 'chat-a']);
  fail = true;
  await assert.rejects(api.setSidebarOptions({ display: 'grouped' }), /Disk full/);
  fail = false;
  await api.setSidebarOptions({ sort: 'updated' });
  assert.equal(context.latest.sidebarOptions.display, 'merged');
  assert.equal(context.latest.sidebarOptions.sort, 'updated');
});
