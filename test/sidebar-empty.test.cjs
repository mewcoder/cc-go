'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function harness() {
  class Element {
    constructor() { this.children = []; this.hidden = false; }
    append(child) { this.insertBefore(child, null); }
    insertBefore(child, reference) {
      child.remove();
      const index = reference ? this.children.indexOf(reference) : this.children.length;
      this.children.splice(index, 0, child);
      child.parent = this;
    }
    remove() {
      if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
      this.parent = null;
    }
    querySelector(selector) { return this.children.find(child => child.className === selector.slice(1)) || null; }
    get lastElementChild() { return this.children.at(-1); }
    addEventListener() {}
    setAttribute() {}
  }
  const source = fs.readFileSync(path.join(__dirname, '../web/shell.js'), 'utf8');
  const renderSource = source.slice(source.indexOf('  function renderSessions('), source.indexOf('  function renderArchive('));
  const collapsed = new Set();
  const render = vm.runInNewContext(`${renderSource}\nrenderSessions;`, {
    document: { createElement: () => new Element() },
    collapsedWorkspaces: collapsed,
    createSessionRow: () => new Element(),
    updateSessionRow(row, session) { row.session = session; },
  });
  const entry = { sessions: new Map(), sessionList: new Element(), label: { textContent: 'Project' } };
  return { entry, collapsed, render: sessions => render(entry, '/project', sessions, 'active') };
}

test('an empty expanded project has one quiet placeholder across repeated refreshes', () => {
  const h = harness();
  h.render([]);
  const placeholder = h.entry.sessionList.children[0];
  assert.equal(placeholder.className, 'session-empty');
  assert.equal(placeholder.textContent, 'No chats yet');
  assert.equal(h.entry.sessionList.hidden, false);
  h.render([]);
  assert.equal(h.entry.sessionList.children.filter(child => !child.hidden).length, 1);
  assert.equal(h.entry.sessionList.children[0], placeholder);
});

test('adding chats removes the placeholder and removing the final chat restores it', () => {
  const h = harness();
  h.render([]);
  h.render([{ id: 'one' }, { id: 'two' }]);
  assert.equal(h.entry.sessionList.querySelector('.session-empty'), null);
  assert.deepEqual(h.entry.sessionList.children.filter(row => row.session).map(row => row.session.id), ['one', 'two']);
  h.render([{ id: 'two' }, { id: 'one' }]);
  assert.deepEqual(h.entry.sessionList.children.filter(row => row.session).map(row => row.session.id), ['two', 'one']);
  h.render([]);
  assert.equal(h.entry.sessions.size, 0);
  assert.equal(h.entry.sessionList.children.filter(child => !child.hidden).length, 1);
  assert.equal(h.entry.sessionList.children[0].textContent, 'No chats yet');
});

test('collapsing a project hides its empty state together with its session list', () => {
  const h = harness();
  h.collapsed.add('/project');
  h.render([]);
  assert.equal(h.entry.sessionList.hidden, true);
  h.collapsed.delete('/project');
  h.render([]);
  assert.equal(h.entry.sessionList.hidden, false);
  assert.equal(h.entry.sessionList.children.filter(child => !child.hidden).length, 1);
});
