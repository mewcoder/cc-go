'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../web/shell.js'), 'utf8');

function fixture(count = 12) {
  let focused;
  const make = tag => ({ tag, children: [], attributes: {}, handlers: {}, hidden: false,
    append(child) { child.remove(); child.parent = this; this.children.push(child); },
    insertBefore(child, reference) {
      child.remove();
      child.parent = this;
      const index = this.children.indexOf(reference);
      this.children.splice(index < 0 ? this.children.length : index, 0, child);
    },
    remove() {
      if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
      this.parent = null;
    },
    get lastElementChild() { return this.children.at(-1); },
    querySelector(selector) {
      if (selector === '.session-empty') return this.children.find(child => child.className === 'session-empty');
      if (selector === '.session-row:last-of-type .session-item') return this.children.filter(child => child.tag === 'row').at(-1);
      throw new Error('Unexpected selector: ' + selector);
    },
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(key, fn) { this.handlers[key] = fn; },
    focus() { focused = this; },
  });
  const entries = new Map();
  const lists = new Map();
  const collapsedWorkspaces = new Set();
  const context = { document: { createElement: make }, collapsedWorkspaces,
    createSessionRow(workspace, id) { return Object.assign(make('row'), { id }); },
    updateSessionRow(row, session) { row.title = session.title; },
    render() {
      for (const [workspace, entry] of entries) context.renderSessions(entry, workspace, lists.get(workspace), 'active');
    },
  };
  const start = source.indexOf('  function renderSessions(');
  const end = source.indexOf('\n  function renderArchive(', start);
  vm.runInNewContext(source.slice(start, end), context);
  function add(workspace, total) {
    const entry = { sessionList: make('div'), sessions: new Map(), label: { textContent: workspace } };
    entries.set(workspace, entry);
    lists.set(workspace, Array.from({ length: total }, (_, i) => ({ id: String(i), title: `Chat ${i}` })));
    context.render();
    return entry;
  }
  const entry = add('/project', count);
  return { entry, add, lists, collapsedWorkspaces, render: context.render, focused: () => focused,
    ids: (target = entry) => target.sessionList.children.filter(child => child.tag === 'row').map(child => child.id) };
}

test('each workspace shows five chats then adds five per click without duplicate rows', () => {
  const h = fixture();
  assert.deepEqual(h.ids(), ['0', '1', '2', '3', '4']);
  assert.equal(h.entry.sessions.size, 5);
  assert.equal(h.entry.loadMore.hidden, false);
  assert.equal(h.entry.loadMore.textContent, 'Show More');
  assert.equal(h.entry.loadMore.attributes['aria-label'], 'Show more chats in /project');
  const second = h.add('/other', 8);
  const firstRow = h.entry.sessions.get('0');
  h.entry.loadMore.handlers.click();
  assert.equal(h.ids().length, 10);
  assert.equal(h.ids(second).length, 5);
  assert.equal(h.entry.sessions.get('0'), firstRow);
  assert.equal(h.entry.sessionList.lastElementChild, h.entry.loadMore);
  h.render();
  assert.equal(h.ids().length, 10);
  h.entry.loadMore.handlers.click();
  assert.equal(h.ids().length, 12);
  assert.equal(h.entry.loadMore.hidden, true);
  assert.equal(h.focused().id, '11');
});

test('zero to five chats never offer Show More and empty workspaces keep their hint', () => {
  for (const count of [0, 1, 5]) {
    const h = fixture(count);
    assert.equal(h.ids().length, count);
    assert.equal(h.entry.loadMore.hidden, true);
    assert.equal(Boolean(h.entry.sessionList.querySelector('.session-empty')), count === 0);
  }
});

test('new chats, archives and collapse preserve pagination without stale rows', () => {
  const h = fixture();
  h.entry.loadMore.handlers.click();
  h.collapsedWorkspaces.add('/project');
  h.render();
  assert.equal(h.entry.sessionList.hidden, true);
  h.collapsedWorkspaces.clear();
  h.lists.get('/project').unshift({ id: 'new', title: 'New chat' });
  h.render();
  assert.equal(h.entry.sessionList.hidden, false);
  assert.equal(h.ids().length, 10);
  assert.equal(h.ids()[0], 'new');
  assert.equal(h.entry.sessions.has('9'), false);
  h.lists.set('/project', [{ id: 'remaining', title: 'Remaining' }]);
  h.render();
  assert.deepEqual(h.ids(), ['remaining']);
  assert.equal(h.entry.loadMore.hidden, true);
  h.lists.set('/project', []);
  h.render();
  assert.equal(h.entry.sessionList.querySelector('.session-empty').textContent, 'No chats yet');
  h.lists.set('/project', [{ id: 'restored', title: 'Restored' }]);
  h.render();
  assert.equal(h.entry.sessionList.querySelector('.session-empty'), undefined);
  assert.deepEqual(h.ids(), ['restored']);
});
