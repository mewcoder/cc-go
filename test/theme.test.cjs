'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { create } = require('../web/settings-theme.js');

function fixture(value, save = async () => {}) {
  const make = tag => ({
    tag, children: [], attributes: {}, handlers: {},
    append(...children) { this.children.push(...children); },
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(key, fn) { this.handlers[key] = fn; },
  });
  const errors = new Set(), calls = [];
  const status = { textContent: '', classList: { add: key => errors.add(key), remove: key => errors.delete(key) } };
  const control = create({ createElement: make }, {
    value, status, schedule() {}, catalog: async () => [{ id: 'one', label: 'One', light: 'one-light', dark: 'one-dark' }],
    save: async next => { calls.push(next); await save(next); },
  });
  return { control, status, calls, errors,
    choose(next) { control.value = next; return control.handlers.change(); },
  };
}

test('theme restores the selected family across light and dark palettes', async () => {
  const h = fixture('one-dark');
  await h.control.ready;
  assert.deepEqual(h.control.children.map(option => [option.value, option.textContent]), [
    ['default', 'Default'], ['one', 'One'],
  ]);
  assert.equal(h.control.value, 'one');
  for (const value of ['light', 'dark', undefined, 'invalid']) {
    const item = fixture(value);
    await item.control.ready;
    assert.equal(item.control.value, 'default');
  }
});

test('theme saves changes and reflects the existing light/dark shortcut', async () => {
  const h = fixture('dark');
  await h.control.ready;
  await h.choose('default');
  assert.deepEqual(h.calls, []);
  await h.choose('one');
  assert.deepEqual(h.calls, ['one']);
  assert.equal(h.control.value, 'one');
  assert.equal(h.status.textContent, 'Saved');
  assert.equal(h.control.disabled, false);
  h.control.syncTheme('one-light');
  assert.equal(h.control.value, 'one');
  h.control.syncTheme('one-dark');
  assert.equal(h.control.value, 'one');
});

test('a failed theme save restores the selected theme and reports the error', async () => {
  const h = fixture('one-dark', async () => { throw Error('Could not save'); });
  await h.control.ready;
  await h.choose('default');
  assert.equal(h.control.value, 'one');
  assert.equal(h.status.textContent, 'Could not save');
  assert.ok(h.errors.has('error'));
  assert.equal(h.control.disabled, false);
});

test('theme disables the control and rejects concurrent changes while saving', async () => {
  let finish;
  const h = fixture('dark', () => new Promise(resolve => { finish = resolve; }));
  await h.control.ready;
  const pending = h.choose('one');
  assert.equal(h.control.disabled, true);
  await h.control.ready;
  await h.choose('default');
  h.control.syncTheme('light');
  assert.deepEqual(h.calls, ['one']);
  finish();
  await pending;
  assert.equal(h.control.value, 'one');
});

test('plugin theme updates preserve VS Code theme kinds and do not reach plugin RPCs', () => {
  const listeners = new Map(), classes = new Set(), delivered = [];
  const link = {};
  let socket;
  const window = {
    addEventListener: (type, fn) => listeners.set(type, fn),
    dispatchEvent: event => delivered.push(event),
  };
  const document = {
    body: { dataset: {}, classList: {
      remove(...names) { names.forEach(name => classes.delete(name)); },
      add(name) { classes.add(name); },
    } },
    documentElement: { style: { setProperty() {} } },
    getElementById: () => link,
    addEventListener() {},
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/bridge.js'), 'utf8'), {
    window, document, console, URL, queueMicrotask, setTimeout, clearTimeout,
    __claudeBridge: { base: '/view/test/', theme: 'one-dark', state: { draft: 'unsent' } },
    WebSocket: class { constructor() { socket = this; } },
    location: { origin: 'http://127.0.0.1', href: 'http://127.0.0.1/view/test/' },
  });
  listeners.get('DOMContentLoaded')();
  assert.equal(document.body.dataset.colorTheme, 'one-dark');
  assert.equal(document.body.dataset.vscodeThemeKind, 'vscode-dark');
  assert.deepEqual([...classes], ['vscode-dark']);
  assert.equal(link.href, '/view/test/theme.css?theme=one-dark');
  window.addEventListener('message', () => {});
  let sequence = 0;
  for (const theme of ['light', 'dark', 'one-dark']) {
    socket.onmessage({ data: JSON.stringify({ sequence: ++sequence, data: { _claudeHostTheme: theme } }) });
    assert.equal(document.body.dataset.colorTheme, theme);
    assert.equal(document.body.dataset.vscodeThemeKind, theme === 'light' ? 'vscode-light' : 'vscode-dark');
    assert.equal(link.href, '/view/test/theme.css?theme=' + theme);
    assert.equal(classes.size, 1);
  }
  assert.equal(delivered.length, 0);
  assert.equal(window.acquireVsCodeApi().getState().draft, 'unsent');
});
