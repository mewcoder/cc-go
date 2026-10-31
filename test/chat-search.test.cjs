'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { search, create } = require('../web/chat-search.js');
const settle = () => new Promise(resolve => setImmediate(resolve));
const session = (id, title, updatedAt) => ({ id, title, updatedAt });
const state = () => ({
  phase: 'active', workspace: '/code/one',
  workspaces: [
    { path: '/code/one', name: 'One', sessions: [session('same', 'Fix INPUT styling', 30), session('older', 'Older chat', 5)] },
    { path: '/code/two', name: 'Two', sessions: [session('same', 'Fix input events', 20)] },
  ],
  archivedSessions: [
    { ...session('archived', 'Old input bug', 10), workspace: '/code/two' },
    { ...session('removed', 'Removed project', 100), workspace: '/code/removed' },
  ],
});

test('search matches titles and registered projects, preserves distinct identities and excludes archived chats in every scope', () => {
  const input = state(), before = JSON.stringify(input);
  const all = search(input, '');
  assert.deepEqual(all.map(item => [item.workspace, item.id]), [
    ['/code/one', 'same'], ['/code/two', 'same'], ['/code/one', 'older'],
  ]);
  assert.deepEqual(search(input, '   input   TWO ').map(item => item.id), ['same']);
  assert.deepEqual(search(input, '/CODE/ONE').map(item => item.id), ['same', 'older']);
  assert.deepEqual(search(input, 'input', '/code/one').map(item => item.title), ['Fix INPUT styling']);
  assert.equal(search(input, 'not present').length, 0);
  assert.equal(search(input, 'Old input bug').length, 0);
  assert.equal(search(input, 'Old input bug', '/code/two').length, 0);
  assert.equal(JSON.stringify(input), before);
  input.workspace = '/code/two';
  assert.deepEqual(search(input, '', '/code/two').map(item => item.id), ['same']);
  input.workspaces[0].sessions.push({ ...session('inline-archive', 'Archived input', 50), archived: true });
  assert.equal(search(input, 'Archived input').length, 0);
  input.workspaces[0].sessions.push(session('zh', '修复输入法', 40));
  assert.equal(search(input, '输入法')[0].id, 'zh');
});

function fixture() {
  const document = { activeElement: null };
  const make = tag => ({
    tagName: tag, children: [], dataset: {}, attributes: {}, handlers: {}, eventOptions: {}, value: '', open: false,
    append(...nodes) { nodes.forEach(node => { node.parent = this; this.children.push(node); }); },
    after(node) { node.parent = this.parent; this.parent.children.splice(this.parent.children.indexOf(this) + 1, 0, node); },
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, fn, options) { this.handlers[name] = fn; this.eventOptions[name] = options; },
    showModal() { this.open = true; },
    close() { this.open = false; },
    focus() { if (!this.disabled) { document.activeElement = this; this.handlers.focus?.(); } },
    getBoundingClientRect() { return { left: 10, top: 10, right: 500, bottom: 400 }; },
  });
  document.createElement = make;
  document.createElementNS = (_, tag) => make(tag);
  document.body = make('body');
  const heading = make('div'), anchor = make('button');
  anchor.id = 'toggle-sidebar';
  heading.append(anchor);
  document.body.append(heading);
  const find = predicate => {
    const walk = node => predicate(node) ? node : node.children.map(walk).find(Boolean);
    return walk(document.body);
  };
  document.getElementById = id => find(node => node.id === id);
  const calls = [];
  let onState, open = async () => {};
  const controller = create(document, {
    formatPath: value => value,
    onState(fn) { onState = fn; },
    async openSession(...args) { calls.push(args); return open(); },
  });
  const latest = state();
  onState(latest);
  const keydown = (target, key, overrides = {}) => {
    const event = { target, key, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...overrides };
    controller.dialog.handlers.keydown(event);
    return event;
  };
  return { ...controller, document, calls, latest, keydown,
    findClass: name => find(node => node.className === name),
    change() { controller.input.handlers.input(); },
    emit(patch = {}) { Object.assign(latest, patch); onState(latest); },
    set open(fn) { open = fn; },
  };
}

test('dialog searches every chat beyond sidebar pagination, limits rendered rows, and scopes without stale results', () => {
  const h = fixture();
  h.latest.workspaces[0].sessions = Array.from({ length: 122 }, (_, i) => session(String(i), `Chat ${i}`, 1000 - i));
  h.latest.workspaces[0].sessions[121].title = '<img src=x onerror=alert(1)>';
  h.emit();
  h.opener.handlers.click();
  assert.equal(h.dialog.open, true);
  assert.equal(h.document.activeElement, h.input);
  assert.equal(h.results.children.length, 50);
  assert.equal(h.more.hidden, false);
  h.more.handlers.click();
  assert.equal(h.results.children.length, 100);
  assert.equal(h.document.activeElement, h.results.children[50]);
  h.more.handlers.click();
  assert.equal(h.results.children.length, 123);
  assert.equal(h.more.hidden, true);
  h.input.value = '<img';
  h.change();
  assert.equal(h.results.children.length, 1);
  assert.equal(h.results.children[0].children[0].textContent, '<img src=x onerror=alert(1)>');
  h.input.value = 'input';
  h.change();
  assert.equal(h.results.children.length, 1);
  assert.equal(h.results.children[0].children[1].textContent, 'Two');
  h.scope.value = '/code/one';
  h.scope.handlers.change();
  assert.equal(h.results.children.length, 0);
  assert.equal(h.findClass('chat-search-status').textContent, 'No matching chats');
  h.scope.value = 'all';
  h.scope.handlers.change();
  h.emit({ workspaces: h.latest.workspaces.slice(0, 1) });
  assert.equal(h.results.children.length, 0, 'Removed projects cannot leak into search via archives');
});

test('project scopes follow sidebar order, retain any selected project on refresh, and reset to All when removed or reopened', () => {
  const h = fixture();
  const choices = () => h.scope.children.map(option => [option.value, option.textContent]);
  assert.deepEqual(choices(), [['all', 'All projects'], ['/code/one', 'One'], ['/code/two', 'Two']]);
  h.emit({ sidebarOptions: { projectOrder: ['/code/two', '/code/one'] } });
  assert.deepEqual(choices(), [['all', 'All projects'], ['/code/two', 'Two'], ['/code/one', 'One']]);
  h.opener.handlers.click();
  assert.equal(h.scope.value, 'all');
  h.scope.value = '/code/two';
  h.scope.handlers.change();
  assert.equal(h.results.children.length, 1);
  assert.ok(h.results.children.every(row => row.children[1].textContent.startsWith('Two')));
  const options = [...h.scope.children];
  h.emit({ workspace: '/code/one' });
  assert.deepEqual(h.scope.children, options, 'Unchanged options keep their native menu nodes across state polling');
  assert.equal(h.scope.value, '/code/two');
  h.emit({ workspaces: h.latest.workspaces.slice(0, 1) });
  assert.equal(h.scope.value, 'all');
  assert.equal(h.results.children.length, 2);
  h.scope.value = '/code/one';
  h.scope.handlers.change();
  h.dialog.handlers.cancel({ preventDefault() {} });
  h.opener.handlers.click();
  assert.equal(h.scope.value, 'all');
});

test('archiving removes a matching result on refresh and unarchiving makes it searchable again', () => {
  const h = fixture();
  h.opener.handlers.click();
  h.input.value = 'styling';
  h.change();
  assert.equal(h.results.children.length, 1);
  const archived = { ...h.latest.workspaces[0].sessions.shift(), workspace: '/code/one', archived: true };
  h.emit({ archivedSessions: [...h.latest.archivedSessions, archived] });
  assert.equal(h.results.children.length, 0);
  assert.equal(h.findClass('chat-search-status').textContent, 'No matching chats');
  assert.equal(h.more.hidden, true);
  h.latest.workspaces[0].sessions.push({ ...archived, archived: false });
  h.emit({ archivedSessions: h.latest.archivedSessions.filter(item => item !== archived) });
  assert.equal(h.results.children.length, 1);
  assert.equal(h.results.children[0].children[0].textContent, 'Fix INPUT styling');
});

test('keyboard selects and opens the correct project, preserves focus on refresh and ignores IME Enter', async () => {
  const h = fixture();
  h.opener.handlers.click();
  h.keydown(h.input, 'ArrowDown');
  assert.equal(h.document.activeElement, h.results.children[0]);
  h.keydown(h.document.activeElement, 'ArrowDown');
  assert.equal(h.document.activeElement, h.results.children[1]);
  h.emit();
  assert.equal(h.document.activeElement, h.results.children[1], 'Refresh retains focus by project and ID');
  h.input.focus();
  assert.equal(h.keydown(h.input, 'Enter', { isComposing: true }).prevented, undefined);
  assert.equal(h.calls.length, 0);
  assert.equal(h.keydown(h.input, 'Enter').prevented, true);
  await settle();
  assert.deepEqual(h.calls, [['/code/two', 'same']]);
  assert.equal(h.dialog.open, false);
});

test('Escape closes from every search control before native search clearing and leaves IME cancellation alone', () => {
  const h = fixture();
  assert.equal(h.dialog.eventOptions.keydown, true, 'Capture Escape before native search-input handling');
  for (const query of ['', 'input']) {
    for (const control of ['input', 'scope', 'result']) {
      h.opener.handlers.click();
      h.input.value = query;
      h.change();
      const target = control === 'result' ? h.results.children[0] : h[control];
      target.focus();
      const event = h.keydown(target, 'Escape');
      assert.equal(h.dialog.open, false);
      assert.equal(h.input.value, query, 'Escape closes instead of merely clearing the search field');
      assert.equal(event.prevented, true);
      assert.equal(event.stopped, true);
      assert.equal(h.document.activeElement, h.opener);
    }
  }
  h.opener.handlers.click();
  for (const flags of [{ isComposing: true }, { keyCode: 229 }]) {
    const event = h.keydown(h.input, 'Escape', flags);
    assert.equal(h.dialog.open, true);
    assert.equal(event.prevented, undefined);
  }
  assert.equal(h.calls.length, 0);
});

test('opening guards duplicate clicks, keeps failures visible and supports retry, escape and state changes', async () => {
  const h = fixture();
  let reject;
  h.open = () => new Promise((_, fail) => { reject = fail; });
  h.opener.handlers.click();
  h.results.children[0].handlers.click();
  h.results.children[0].handlers.click();
  assert.equal(h.calls.length, 1);
  assert.equal(h.input.disabled, true);
  reject(Error('Save the current draft first'));
  await settle();
  assert.equal(h.dialog.open, true);
  assert.equal(h.findClass('history-error').hidden, false);
  assert.equal(h.findClass('history-error').textContent, 'Save the current draft first');
  assert.equal(h.input.disabled, false);
  h.open = async () => {};
  h.results.children[0].handlers.click();
  await settle();
  assert.equal(h.dialog.open, false);
  assert.equal(h.calls.length, 2);
  h.opener.handlers.click();
  h.dialog.handlers.cancel({ preventDefault() {} });
  assert.equal(h.dialog.open, false);
  assert.equal(h.document.activeElement, h.opener);
  h.opener.handlers.click();
  h.emit({ settingsOpen: true });
  assert.equal(h.dialog.open, false);
  assert.equal(h.opener.disabled, true);
  h.emit({ settingsOpen: false, phase: 'setup' });
  assert.equal(h.opener.disabled, true);
});
