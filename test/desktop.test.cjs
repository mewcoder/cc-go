'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../web/desktop.js'), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

function desktopHarness({ mounted = false } = {}) {
  const attributes = new Map();
  const handlers = new Map();
  const events = new Map();
  const calls = [], errors = [], frames = [];
  const connection = {
    setAttribute: (key, value) => attributes.set(key, value),
    addEventListener: (key, fn) => handlers.set(key, fn),
    click() { handlers.get('click')?.(); },
  };
  const state = { views: [], workspaces: [], archivedSessions: [], logsOpen: false, sidebarWidth: 248, sidebarCollapsed: false };
  let failLogs = false, blockLogs, failDrafts = false;
  const window = {
    __goDesktopConfig: { platform: 'linux', token: 'fixture' },
    addEventListener: (key, fn) => events.set(key, fn),
    goHUD: { gap: 4, height: 20, create: () => ({ render() {}, layout() {}, setDraft() {} }) },
  };
  vm.runInNewContext(source, {
    window, document: {
      body: mounted ? { append: frame => frames.push(frame) } : null,
      createElement: () => ({ dataset: {}, style: {}, contentWindow: {}, setAttribute() {}, remove() {} }),
      getElementById: () => connection,
    },
    URL, innerWidth: 1200, innerHeight: 820,
    setTimeout: () => 1, clearTimeout() {},
    console: { error: (...args) => errors.push(args) },
    fetch: async (url, options) => {
      const body = options.body && JSON.parse(options.body);
      calls.push({ url, body, options });
      if (url === '/api/view-draft' && failDrafts) return { ok: false, text: async () => JSON.stringify({ error: 'draft sync failed' }) };
      if (body?.key === 'logs') {
        if (blockLogs) await blockLogs;
        if (failLogs) return { ok: false, text: async () => JSON.stringify({ error: 'fixture failed' }) };
        state.logsOpen = body.open;
      }
      return { ok: true, text: async () => JSON.stringify(url === '/api/state' ? state : { ok: true }) };
    },
  });
  return {
    window, connection, attributes, handlers, calls, state, errors,
    async load() { events.get('DOMContentLoaded')(); await settle(); },
    set failLogs(value) { failLogs = value; },
    set blockLogs(value) { blockLogs = value; },
    set failDrafts(value) { failDrafts = value; },
    composer(index, hasDraft, origin = 'http://127.0.0.1:23457') {
      events.get('message')({ source: frames[index].contentWindow, origin,
        data: { type: 'claude-host:composer', rect: null, hasDraft, viewport: { width: 948, height: 820 } } });
    },
    logCalls: () => calls.filter(call => call.body?.key === 'logs'),
  };
}

test('archiving and renaming send independent metadata patches', async () => {
  const h = desktopHarness();
  await h.window.desktop.archiveSession('/workspace', 'session', true);
  await h.window.desktop.renameSession('/workspace', 'session', 'New name');
  await h.window.desktop.archiveSession('/workspace', 'session', false);
  assert.deepEqual(h.calls.filter(call => call.url === '/api/session-meta').map(call => call.body), [
    { workspace: '/workspace', id: 'session', archived: true },
    { workspace: '/workspace', id: 'session', title: 'New name' },
    { workspace: '/workspace', id: 'session', archived: false },
  ]);
});

test('native-menu click opens and closes logs through the Go adapter', async () => {
  const h = desktopHarness();
  await h.load();
  assert.equal(h.attributes.get('role'), 'button');
  assert.equal(h.attributes.get('aria-controls'), 'log-panel');
  assert.equal(h.attributes.get('aria-expanded'), 'false');
  h.connection.click();
  await settle();
  assert.equal(h.state.logsOpen, true);
  assert.equal(h.attributes.get('aria-expanded'), 'true');
  h.connection.click();
  await settle();
  assert.equal(h.state.logsOpen, false);
  assert.deepEqual(h.logCalls().map(call => call.body.open), [true, false]);
  assert.equal(h.logCalls()[0].options.headers['X-Claude-Desktop-Token'], 'fixture');
  const menu = fs.readFileSync(path.join(__dirname, '../internal/desktop/desktop.go'), 'utf8');
  assert.match(menu, /VSIX Output.*CmdOrCtrl\+Shift\+U.*getElementById\('connection-status'\)\?\.click\(\)/);
});

test('logs toggle supports Enter and Space, ignoring other keys', async () => {
  const h = desktopHarness();
  await h.load();
  let prevented = 0;
  for (const key of ['Enter', ' ', 'Escape']) {
    h.handlers.get('keydown')({ key, preventDefault() { prevented++; } });
    await settle();
  }
  assert.equal(prevented, 2);
  assert.deepEqual(h.logCalls().map(call => call.body.open), [true, false]);
});

test('logs toggle deduplicates pending clicks and recovers from errors', async () => {
  const h = desktopHarness();
  await h.load();
  let release;
  h.blockLogs = new Promise(resolve => { release = resolve; });
  h.connection.click();
  h.connection.click();
  assert.equal(h.logCalls().length, 1);
  release();
  await settle();
  h.blockLogs = undefined;
  h.failLogs = true;
  h.connection.click();
  await settle();
  assert.equal(h.errors.length, 1);
  assert.equal(h.state.logsOpen, true);
  h.failLogs = false;
  h.connection.click();
  await settle();
  assert.equal(h.state.logsOpen, false);
});

test('setup menu and explicit Start behavior are preserved', async () => {
  const h = desktopHarness();
  h.window.__goDesktopAction('open-setup');
  await settle();
  await h.window.desktop.startUsing();
  assert.deepEqual(h.calls.filter(call => call.url !== '/api/state').map(call => [call.url, call.body]), [
    ['/api/ui', { key: 'setup', open: true }], ['/api/start', {}],
  ]);
});

test('Plugin Updates replaces repeat initialization in the View menu', () => {
  const native = fs.readFileSync(path.join(__dirname, '../internal/desktop/desktop.go'), 'utf8');
  assert.match(native, /action\("Plugin Updates", "", .*open-setup/);
  assert.match(native, /view := &mygo\.MenuItem\{Label: "View", Submenu:[\s\S]*?open-setup/);
});

test('a slow background snapshot cannot restore an older conversation after an action refresh', async () => {
  const replies = [], seen = [];
  const window = {
    __goDesktopConfig: { platform: 'linux', token: 'fixture' },
    addEventListener() {},
  };
  vm.runInNewContext(source, {
    window, document: { body: null, getElementById: () => null },
    fetch: () => new Promise(resolve => replies.push(value => resolve({ ok: true, text: async () => JSON.stringify(value) }))),
  });
  window.desktop.onState(state => seen.push(state.workspace));
  const poll = window.desktop.getState();
  const action = window.desktop.getState();
  replies[1]({ workspace: '/new', views: [] });
  await action;
  replies[0]({ workspace: '/old', views: [] });
  const stale = await poll;
  assert.equal(stale.workspace, '/new');
  assert.deepEqual(seen, ['/new']);
});

test('host-changing actions flush draft flags from active and hidden views without sending their text', async () => {
  const h = desktopHarness({ mounted: true });
  h.state.views = ['background', 'active'].map((id, index) => ({ id, active: index === 1, ready: true, revision: 1,
    url: `http://127.0.0.1:23457/view/${id}/token/index.html` }));
  await h.load();
  h.composer(0, true);
  h.composer(1, false);
  await h.window.desktop.newSession('/other');
  const writes = h.calls.filter(call => call.url !== '/api/state');
  assert.deepEqual(writes.slice(-3).map(call => [call.url, call.body]), [
    ['/api/view-draft', { id: 'background', draft: true }],
    ['/api/view-draft', { id: 'active', draft: false }],
    ['/api/new', { workspace: '/other' }],
  ]);
  for (const call of writes.filter(call => call.url === '/api/view-draft')) {
    assert.deepEqual(Object.keys(call.body).sort(), ['draft', 'id']);
  }
});

test('failed draft synchronization prevents destructive actions and is retried on the next action', async () => {
  const h = desktopHarness({ mounted: true });
  h.state.views = [{ id: 'view', active: true, ready: true, revision: 1, url: 'http://127.0.0.1:23457/view/view/token/index.html' }];
  await h.load();
  h.composer(0, true, 'https://untrusted.invalid');
  await settle();
  assert.equal(h.calls.some(call => call.url === '/api/view-draft'), false);
  h.failDrafts = true;
  await assert.rejects(h.window.desktop.newSession('/other'), /draft sync failed/);
  assert.equal(h.calls.some(call => call.url === '/api/new'), false);
  h.failDrafts = false;
  await h.window.desktop.newSession('/other');
  assert.equal(h.calls.filter(call => call.url === '/api/new').length, 1);
  assert.deepEqual(h.calls.find(call => call.url === '/api/view-draft').body, { id: 'view', draft: true });
});

test('explicit plugin updates flush every view draft before replacing the host', async () => {
  const h = desktopHarness({ mounted: true });
  h.state.views = [{ id: 'view', active: true, ready: true, revision: 1, url: 'http://127.0.0.1:23457/view/view/token/index.html' }];
  await h.load();
  h.composer(0, true);
  await h.window.desktop.reloadPlugin();
  const writes = h.calls.filter(call => call.url !== '/api/state');
  assert.deepEqual(writes.slice(-2).map(call => [call.url, call.body]), [
    ['/api/view-draft', { id: 'view', draft: true }], ['/api/update-plugin', {}],
  ]);
});
