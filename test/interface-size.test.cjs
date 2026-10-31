'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { create } = require('../web/settings-interface-size.js');

function fixture(value, save = async () => {}) {
  const make = tag => ({ tag, children: [], attributes: {}, handlers: {},
    append(...children) { this.children.push(...children); },
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(key, fn) { this.handlers[key] = fn; },
  });
  const errors = new Set(), calls = [];
  const status = { textContent: '', classList: { add: key => errors.add(key), remove: key => errors.delete(key) } };
  const group = create({ createElement: make }, { value, status, schedule() {}, save: async next => { calls.push(next); await save(next); } });
  const inputs = group.children.map(label => label.children[0]);
  const choose = async index => {
    inputs.forEach((input, i) => { input.checked = i === index; });
    return inputs[index].handlers.change();
  };
  return { group, inputs, status, calls, errors, choose };
}

test('interface size uses a labelled native radio group with three presets and the saved selection', () => {
  const h = fixture('medium');
  assert.equal(h.group.attributes.role, 'radiogroup');
  assert.equal(h.group.attributes['aria-label'], 'Interface Size');
  assert.deepEqual(h.inputs.map(input => input.type), ['radio', 'radio', 'radio']);
  assert.equal(new Set(h.inputs.map(input => input.name)).size, 1);
  assert.deepEqual(h.inputs.map(input => input.checked), [false, true, false]);
  assert.deepEqual(h.group.children.map(label => label.children[1].textContent), ['Small', 'Medium', 'Large']);
  assert.equal(fixture('invalid').inputs[0].checked, true);
  assert.equal(fixture(undefined).inputs[0].checked, true);
});

test('interface size saves only a changed selection and restores controls after success', async () => {
  const h = fixture('small');
  await h.choose(0);
  assert.deepEqual(h.calls, []);
  await h.choose(2);
  assert.deepEqual(h.calls, ['large']);
  assert.deepEqual(h.inputs.map(input => input.checked), [false, false, true]);
  assert.ok(h.inputs.every(input => !input.disabled));
  assert.equal(h.status.textContent, 'Saved');
});

test('a failed interface size save restores the original radio rather than falsely displaying the new value', async () => {
  const h = fixture('medium', async () => { throw Error('Could not save'); });
  await h.choose(2);
  assert.deepEqual(h.inputs.map(input => input.checked), [false, true, false]);
  assert.equal(h.status.textContent, 'Could not save');
  assert.equal(h.errors.has('error'), true);
  assert.ok(h.inputs.every(input => !input.disabled));
});

test('interface size rejects concurrent changes while the first save is pending', async () => {
  let finish;
  const h = fixture('small', () => new Promise(resolve => { finish = resolve; }));
  const pending = h.choose(1);
  assert.ok(h.inputs.every(input => input.disabled));
  await h.choose(2);
  assert.deepEqual(h.calls, ['medium']);
  finish();
  await pending;
  assert.deepEqual(h.inputs.map(input => input.checked), [false, true, false]);
});

test('plugin bridge applies interface size before render and consumes live updates without plugin RPCs', () => {
  for (const [value, expected] of [[undefined, 12], [null, 12], ['invalid', 12], [18, 12], ['small', 12], ['medium', 14], ['large', 16]]) {
    const styles = new Map(), delivered = [];
    let socket;
    const window = { addEventListener() {}, dispatchEvent: event => delivered.push(event) };
    vm.runInNewContext(fs.readFileSync(require.resolve('../web/bridge.js'), 'utf8'), {
      window, console, URL, queueMicrotask, setTimeout, clearTimeout,
      document: { documentElement: { style: { setProperty: (key, value) => styles.set(key, value) } }, addEventListener() {} },
      __claudeBridge: { base: '/view/test/', theme: 'dark', state: null, interfaceSize: value },
      WebSocket: class { constructor() { socket = this; } },
      location: { origin: 'http://127.0.0.1', href: 'http://127.0.0.1/view/test/' },
    });
    const variables = ['--vscode-chat-font-size', '--vscode-font-size', '--vscode-editor-font-size'];
    for (const variable of variables) assert.equal(styles.get(variable), `${expected}px`);
    window.addEventListener('message', () => {});
    socket.onmessage({ data: JSON.stringify({ sequence: 1, data: { _claudeHostInterfaceSize: 'large' } }) });
    for (const variable of variables) assert.equal(styles.get(variable), '16px');
    assert.deepEqual(delivered, []);
  }
});

test('interface size is wired as a desktop-only setting with a labelled control', () => {
  const shell = fs.readFileSync(require.resolve('../web/shell.js'), 'utf8');
  assert.match(shell, /title: 'Interface Size'/);
  assert.match(shell, /goInterfaceSizeControl\.create\(document, \{ value: current, status, save: value => desktop\.setInterfaceSize\(value\) \}\)/);
  assert.match(shell, /control\.id = `setting-\$\{key\}`/);
  assert.match(shell, /label\.htmlFor = `setting-\$\{key\}`/);
  const saveSetting = shell.slice(shell.indexOf('  async function saveSetting('), shell.indexOf('  function createSettingControl('));
  assert.doesNotMatch(saveSetting, /interfaceSize|setInterfaceSize/);
  assert.match(shell, /type: 'string', default: 'small'/);
});

test('shell and plugin use 12/14/16px presets without zooming the layout', async () => {
  const desktop = fs.readFileSync(require.resolve('../web/desktop.js'), 'utf8');
  const source = desktop.slice(desktop.indexOf('  async function refresh()'), desktop.indexOf('  async function invoke('));
  for (const [preset, pixels] of [[undefined, 12], ['small', 12], ['medium', 14], ['large', 16]]) {
    const styles = new Map();
    const context = {
      refreshStarted: 0, refreshApplied: 0, stateListeners: [],
      request: async () => ({ interfaceSize: preset }),
      document: { documentElement: { style: { setProperty: (key, value) => styles.set(key, value) } }, getElementById: () => null },
      mountViews() {}, refreshProject() {}, latest: undefined,
    };
    vm.runInNewContext(source, context);
    await context.refresh();
    assert.equal(styles.get('--host-font-scale'), String(pixels / 13));
    assert.equal(styles.get('--shell-sidebar-icon-size'), `${({ small: 14, medium: 15, large: 16 }[preset] ?? 14)}px`);
    for (const variable of ['--vscode-chat-font-size', '--vscode-font-size', '--vscode-editor-font-size']) {
      assert.equal(styles.get(variable), `${pixels}px`);
    }
    assert.deepEqual([...styles.keys()].filter(key => /zoom|width|height/.test(key)), []);
  }
  for (const filename of ['shell.css', 'host.css']) {
    const css = fs.readFileSync(require.resolve(`../web/${filename}`), 'utf8');
    assert.match(css, /font-size: calc\(12px \* var\(--host-font-scale, 1\)\)/);
    assert.doesNotMatch(css, /zoom:/);
  }
});
