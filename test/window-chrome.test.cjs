'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../web/desktop.js'), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

async function fixture(platform, nativeMenu = true) {
  const nodes = [], events = new Map(), calls = [];
  let blocked;
  function node(id) {
    const value = { id, children: [], attributes: {}, handlers: {}, disabled: false,
      append(...children) { this.children.push(...children); },
      prepend(child) { this.children.unshift(child); },
      setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener(name, fn) { this.handlers[name] = fn; },
    };
    nodes.push(value);
    return value;
  }
  node('window-controls'); node('connection-status');
  const window = { __goDesktopConfig: { platform, native: false, token: 'fixture' },
    addEventListener: (key, fn) => events.set(key, fn) };
  vm.runInNewContext(source, { window, document: { body: null,
    getElementById: id => nodes.find(node => node.id === id),
    createElement: () => node(), createElementNS: () => node(),
  }, setTimeout: () => 1, clearTimeout() {}, console,
  fetch: async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/native' && blocked) await blocked;
    return { ok: true, text: async () => JSON.stringify(url === '/api/state' ? { phase: 'setup', views: [], nativeMenu } : {}) };
  } });
  events.get('DOMContentLoaded')();
  await settle();
  return { menu: nodes.find(node => node.id === 'application-menu'), calls, set blocked(value) { blocked = value; } };
}

test('Windows integrated menu remains discoverable even when host-config races native setup', async () => {
  const h = await fixture('win32');
  assert.ok(h.menu);
  assert.equal(h.menu.hidden, false);
  assert.equal(h.menu.attributes['aria-haspopup'], 'menu');
  let release;
  h.blocked = new Promise(resolve => { release = resolve; });
  const pending = h.menu.handlers.click();
  await h.menu.handlers.click();
  assert.equal(h.calls.filter(call => call.url === '/api/native').length, 1);
  release(); await pending;
  assert.equal(h.menu.disabled, false);
  const call = h.calls.find(call => call.url === '/api/native');
  assert.deepEqual(JSON.parse(call.options.body), { key: 'menu' });
  assert.equal(call.options.headers['X-Claude-Desktop-Token'], 'fixture');
});

test('macOS keeps its system menu and Windows browser-only mode hides unavailable native controls', async () => {
  assert.equal((await fixture('darwin')).menu, undefined);
  assert.equal((await fixture('win32', false)).menu.hidden, true);
});
