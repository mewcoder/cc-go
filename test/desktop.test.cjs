'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../web/desktop.js'), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

function desktopHarness({ mounted = false, nativeExternalLinks, platform = 'linux', native = false } = {}) {
  const attributes = new Map();
  const handlers = new Map();
  const events = new Map();
  const calls = [], errors = [], frames = [], panels = [], timers = new Map();
  let timerID = 0;
  const connection = {
    setAttribute: (key, value) => attributes.set(key, value),
    addEventListener: (key, fn) => handlers.set(key, fn),
    click() { handlers.get('click')?.(); },
  };
  const state = { views: [], workspaces: [], archivedSessions: [], logsOpen: false, sidebarWidth: 248, sidebarCollapsed: false };
  let failLogs = false, blockLogs, failDrafts = false;
  const window = {
    __goDesktopConfig: { platform, token: 'fixture', nativeExternalLinks },
    mygo: native ? {} : undefined,
    addEventListener: (key, fn) => events.set(key, fn),
    goHUD: { gap: 4, height: 20, create: () => ({ render() {}, layout() {}, setDraft() {} }) },
  };
  vm.runInNewContext(source, {
    window, document: {
      documentElement: { style: { setProperty() {} } },
      body: mounted ? { append: element => (element.tag === 'iframe' ? frames : panels).push(element) } : null,
      createElement: tag => ({ tag, dataset: {}, style: {}, handlers: {}, children: [], append(...children) { this.children.push(...children); }, addEventListener(type, callback) { this.handlers[type] = callback; }, contentWindow: { messages: [], postMessage(message, origin) { this.messages.push({ message, origin }); } }, setAttribute() {}, remove() { this.removed = true; } }),
      getElementById: () => connection,
    },
    URL, innerWidth: 1200, innerHeight: 820,
    setTimeout(callback, delay) { timers.set(++timerID, { callback, delay }); return timerID; },
    clearTimeout(id) { timers.delete(id); },
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
    window, connection, attributes, handlers, calls, state, errors, frames, panels, timers,
    async load() { events.get('DOMContentLoaded')(); await settle(); },
    set failLogs(value) { failLogs = value; },
    set blockLogs(value) { blockLogs = value; },
    set failDrafts(value) { failDrafts = value; },
    composer(index, hasDraft, origin = 'http://127.0.0.1:23457', rect = null, loading = false, loadingRect = null, geometry = {}) {
      events.get('message')({ source: frames[index].contentWindow, origin,
        data: { type: 'claude-host:composer', rect, hasDraft, loading, loadingRect, viewport: { width: 952, height: 820 }, ...geometry } });
    },
    transport(index, sequence, connected, origin = 'http://127.0.0.1:23457') {
      events.get('message')({ source: frames[index].contentWindow, origin,
        data: { type: 'claude-host:transport', sequence, connected } });
    },
    logCalls: () => calls.filter(call => call.body?.key === 'logs'),
  };
}

test('native titlebar handles follow the plugin header without covering settings or stale layouts', async () => {
  const h = desktopHarness({ mounted: true, native: true, platform: 'darwin' });
  Object.assign(h.state, { phase: 'active', views: [{ id: 'one', active: true, ready: true, revision: 1,
    url: 'http://127.0.0.1:23457/view/one/token/index.html' }] });
  await h.load();
  const handles = () => h.panels.filter(panel => panel.className === 'go-titlebar-drag' && !panel.removed);
  const region = { left: 120, top: 0, width: 700, height: 32 };
  const report = geometry => h.composer(0, false, undefined, null, false, null, geometry);
  report({ dragRegions: [region] });
  assert.equal(handles().length, 1);
  assert.deepEqual({ ...handles()[0].style }, { left: '368px', top: '0px', width: '700px', height: '32px' });
  report({ dragRegions: [{ ...region, top: 200 }] });
  assert.equal(handles().length, 0, 'A view cannot turn message content into a native drag surface');
  report({ dragRegions: [region] });
  h.state.sidebarWidth = 300;
  await h.window.desktop.getState();
  assert.equal(handles().length, 0, 'Resize must discard geometry measured for the old viewport');
  report({ dragRegions: [region], viewport: { width: 900, height: 820 } });
  assert.equal(handles()[0].style.left, '420px');
  h.state.settingsOpen = true;
  await h.window.desktop.getState();
  assert.equal(handles().length, 0);
  h.state.settingsOpen = false;
  await h.window.desktop.getState();
  assert.equal(handles().length, 1);
  report({ dragRegions: [] });
  assert.equal(handles().length, 0, 'An open plugin menu must immediately uncover its header');
});

test('browser mode does not intercept the plugin header', async () => {
  const h = desktopHarness({ mounted: true, platform: 'darwin' });
  Object.assign(h.state, { phase: 'active', views: [{ id: 'one', active: true, ready: true, revision: 1,
    url: 'http://127.0.0.1:23457/view/one/token/index.html' }] });
  await h.load();
  h.composer(0, false, undefined, null, false, null, { dragRegions: [{ left: 120, top: 0, width: 700, height: 32 }] });
  assert.equal(h.panels.filter(panel => panel.className === 'go-titlebar-drag').length, 0);
});

test('Windows path display uppercases only drive letters without changing API paths', async () => {
  const cases = [
    ['c:\\Users\\mew\\MyProject', 'C:\\Users\\mew\\MyProject'],
    ['d:/Code/myProject', 'D:/Code/myProject'],
    ['c:\\', 'C:\\'], ['d:', 'D:'], ['D:\\Code', 'D:\\Code'],
    ['\\\\server\\share\\case', '\\\\server\\share\\case'],
    ['/code/case', '/code/case'], ['myProject', 'myProject'],
  ];
  for (const platform of ['win32', 'darwin', 'linux']) {
    const h = desktopHarness({ platform });
    for (const [raw, displayed] of cases) {
      assert.equal(h.window.desktop.formatPath(raw), platform === 'win32' ? displayed : raw);
    }
    const raw = 'c:\\Code\\MyProject';
    await h.window.desktop.importProjects([raw]);
    assert.deepEqual(h.calls.find(call => call.url === '/api/import-projects').body.paths, [raw]);
  }
});

test('external-link support is advertised only when the host supplies its native bridge', () => {
  for (const value of [undefined, false, true]) {
    const h = desktopHarness({ nativeExternalLinks: value });
    assert.equal(h.window.desktop.nativeExternalLinks, value === true);
  }
});

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
    window, document: { body: null, documentElement: { style: { setProperty() {} } }, getElementById: () => null },
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
  h.state.views = ['background', 'active'].map((id, index) => ({ id, active: index === 0, ready: true, revision: 1,
    url: `http://127.0.0.1:23457/view/${id}/token/index.html` }));
  await h.load();
  h.composer(0, true);
  h.state.views[0].active = false;
  h.state.views[1].active = true;
  await h.window.desktop.getState();
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

test('unopened idle views do not mount pages; active and background working views do', async () => {
  const h = desktopHarness({ mounted: true });
  h.state.phase = 'active';
  h.state.views = Array.from({ length: 12 }, (_, index) => ({ id: String(index), active: index === 0,
    busy: index === 1, ready: true, sequence: 0, revision: 1, url: `http://127.0.0.1:23457/view/${index}/token/index.html` }));
  await h.load();
  assert.equal(h.frames.length, 2);
  h.state.views[0].active = false;
  h.state.views[2].active = true;
  await h.window.desktop.getState();
  assert.equal(h.frames.length, 3);
  assert.equal(h.frames[0].hidden, false, 'keep the previous chat until the target has content');
  h.composer(2, false, undefined, { left: 10, top: 700, width: 680, height: 80 });
  assert.equal(h.frames[0].hidden, true);
  assert.equal(h.frames[2].hidden, false);
});

test('silent plugin updates retain the chat through download and activation until its replacement is ready', async () => {
  const h = desktopHarness({ mounted: true });
  h.state.phase = 'active';
  const view = id => ({ id, active: true, ready: true, revision: 1,
    url: `http://127.0.0.1:23457/view/${id}/token/index.html` });
  h.state.views = [view('old')];
  await h.load();
  const oldFrame = h.frames[0];
  let removed = false;
  oldFrame.remove = () => { removed = true; };
  for (const phase of ['active', 'setup', 'activating']) {
    h.state.pluginUpdating = true;
    h.state.phase = phase;
    if (phase !== 'active') h.state.views = [];
    const state = await h.window.desktop.getState();
    assert.equal(state.pluginUpdating, true);
    assert.equal(oldFrame.hidden, false);
    assert.equal(oldFrame.inert, true, 'cannot add a draft to the host being replaced');
    assert.equal(removed, false);
  }
  h.state.pluginUpdating = false;
  h.state.phase = 'active';
  h.state.viewLoading = true;
  assert.equal((await h.window.desktop.getState()).pluginUpdating, true);
  assert.equal(removed, false, 'retain the chat until the new view has HTML');
  h.state.viewLoading = false;
  h.state.views = [view('new')];
  await h.window.desktop.getState();
  assert.equal(removed, true);
  assert.equal(h.frames[1].hidden, false);
  assert.equal(h.frames[1].inert, false);
});

test('rapid chat switches retain old pixels and reveal only the latest ready target', async () => {
  const h = desktopHarness({ mounted: true });
  h.state.phase = 'active';
  h.state.views = ['one', 'two', 'three'].map((id, index) => ({ id, active: index === 0, ready: true, revision: 1,
    url: `http://127.0.0.1:23457/view/${id}/token/index.html` }));
  await h.load();
  const ready = index => h.composer(index, false, undefined, { left: 10, top: 700, width: 680, height: 80 });
  ready(0);
  const firstSource = h.frames[0].src;
  async function select(index) {
    h.state.views.forEach((view, i) => { view.active = i === index; });
    await h.window.desktop.getState();
  }
  await select(1);
  assert.equal(h.frames[0].hidden, false);
  assert.equal(h.frames[0].inert, true, 'old pixels cannot accept input for the new selection');
  assert.equal(h.frames[1].hidden, true);
  await select(2);
  ready(1);
  assert.equal(h.frames[0].hidden, false, 'late readiness cannot reveal an obsolete selection');
  assert.equal(h.frames[1].hidden, true);
  ready(2);
  assert.equal(h.frames[0].hidden, true);
  assert.equal(h.frames[2].hidden, false);
  assert.equal(h.frames[2].inert, false);
  await select(0);
  assert.equal(h.frames[0].hidden, false, 'cached chats switch immediately');
  assert.equal(h.frames[0].src, firstSource, 'switching back must not reload the document');
  assert.equal(h.frames[2].hidden, true);
  h.state.settingsOpen = true;
  await h.window.desktop.getState();
  assert.ok(h.frames.every(frame => frame.hidden && frame.inert));
});

test('a stalled target replaces old pixels with an error and can retry without opening a new session', async () => {
  const h = desktopHarness({ mounted: true });
  h.state.phase = 'active';
  h.state.views = [{ id: 'old', active: true, ready: true, revision: 1,
    url: 'http://127.0.0.1:23457/view/old/token/index.html' }];
  await h.load();
  h.state.views[0].active = false;
  h.state.views.push({ id: 'error', active: true, ready: true, revision: 1,
    url: 'http://127.0.0.1:23457/view/error/token/index.html' });
  await h.window.desktop.getState();
  assert.equal(h.frames[0].hidden, false);
  h.timers.get(h.frames[1].loadingTimer).callback();
  assert.equal(h.panels[0].children[0].children[0].textContent, 'Loading...');
  assert.equal(h.panels[0].children[0].children[1].hidden, true, 'loading has no extra explanation');
  h.timers.get(h.frames[1].revealTimer).callback();
  assert.equal(h.frames[0].hidden, true);
  assert.equal(h.frames[1].hidden, true);
  const [title, detail, retry, logs] = h.panels[0].children[0].children;
  assert.equal(title.textContent, 'Could not load this chat');
  assert.match(detail.textContent, /saved conversation is unchanged/);
  assert.equal(retry.hidden, false);
  assert.equal(logs.hidden, false);
  retry.onclick();
  assert.match(h.frames[1].src, /view\/error\/token\/index.html\?revision=1&retry=/);
  assert.equal(h.frames.length, 2);
  assert.equal(title.textContent, 'Loading...');
  assert.equal(h.panels[0].hidden, false);
  h.composer(1, false, undefined, { left: 10, top: 700, width: 680, height: 80 });
  assert.equal(h.frames[1].hidden, false);
  assert.equal(h.panels[0].hidden, true);
  assert.equal(h.calls.some(call => call.url === '/api/open-session'), false);
});

test('slow switches use a matching host placeholder while the target stays hidden and the timeout stays armed', async () => {
  const h = desktopHarness({ mounted: true });
  h.state.phase = 'active';
  h.state.views = ['old', 'next'].map((id, i) => ({ id, active: i === 0, ready: true, revision: 1,
    url: `http://127.0.0.1:23457/view/${id}/token/index.html` }));
  await h.load();
  h.composer(0, false, undefined, { left: 10, top: 700, width: 680, height: 80 });
  h.state.views[0].active = false; h.state.views[1].active = true;
  await h.window.desktop.getState();
  h.composer(1, false, undefined, null, true, { left: 0, top: 41, width: 952, height: 779 });
  assert.equal(h.frames[0].hidden, false, 'brief loads retain old pixels');
  h.timers.get(h.frames[1].loadingTimer).callback();
  assert.equal(h.frames[1].hidden, true, 'the loading placeholder is owned by the host');
  assert.equal(h.panels[0].children[0].children[0].textContent, 'Loading...');
  assert.equal(h.panels[0].children[0].children[1].hidden, true);
  assert.equal(h.panels[0].dataset.state, 'loading');
  assert.equal(h.panels[0].style.top, '41px', 'match the plugin chat area, excluding its header');
  assert.equal(h.panels[0].style.height, '779px');
  assert.ok(h.timers.has(h.frames[1].revealTimer), 'the plugin spinner must not suppress failure handling');
  h.composer(1, false, undefined, { left: 10, top: 700, width: 680, height: 80 });
  assert.equal(h.timers.has(h.frames[1].revealTimer), false);
});

test('late errors from abandoned targets do not cover the active conversation', async () => {
  const h = desktopHarness({ mounted: true });
  h.state.phase = 'active';
  h.state.views = ['one', 'two'].map((id, i) => ({ id, active: i === 0, ready: true, revision: 1,
    url: `http://127.0.0.1:23457/view/${id}/token/index.html` }));
  await h.load();
  h.composer(0, false, undefined, { left: 10, top: 700, width: 680, height: 80 });
  h.state.views[0].active = false; h.state.views[1].active = true;
  await h.window.desktop.getState();
  h.state.views[0].active = true; h.state.views[1].active = false;
  await h.window.desktop.getState();
  h.timers.get(h.frames[1].revealTimer).callback();
  assert.equal(h.frames[0].hidden, false);
  assert.equal(h.panels.length, 0);
});

test('failed silent updates release the retained chat and fatal errors release the loading UI', async () => {
  for (const phase of ['active', 'error']) {
    const h = desktopHarness({ mounted: true });
    h.state.phase = 'active';
    h.state.views = [{ id: 'old', active: true, ready: true, revision: 1,
      url: 'http://127.0.0.1:23457/view/old/token/index.html' }];
    await h.load();
    h.state.pluginUpdating = true;
    await h.window.desktop.getState();
    h.state.pluginUpdating = false;
    h.state.phase = phase;
    const state = await h.window.desktop.getState();
    assert.equal(state.pluginUpdating, false);
    assert.equal(h.frames[0].inert, phase !== 'active');
    assert.equal(h.frames[0].hidden, phase !== 'active');
  }
});

test('hidden idle transports suspend, queued messages wake them and running sessions stay connected', async () => {
  const h = desktopHarness({ mounted: true });
  h.state.phase = 'active';
  h.state.views = [{ id: 'view', active: true, busy: false, ready: true, sequence: 4, revision: 1,
    url: 'http://127.0.0.1:23457/view/view/token/index.html' }];
  await h.load();
  h.transport(0, 0, true, 'http://attacker.invalid');
  assert.equal(h.frames[0].contentWindow.messages.length, 0);
  h.transport(0, 0, true);
  const commands = h.frames[0].contentWindow.messages;
  assert.equal(commands.at(-1).message.keepAlive, true);
  assert.equal(commands.at(-1).origin, 'http://127.0.0.1:23457');
  h.state.views[0].active = false;
  await h.window.desktop.getState();
  assert.equal(commands.at(-1).message.keepAlive, false);
  h.transport(0, 4, false);
  assert.equal(commands.at(-1).message.keepAlive, false);
  h.state.views[0].sequence = 5;
  await h.window.desktop.getState();
  assert.equal(commands.at(-1).message.keepAlive, true);
  h.transport(0, 4, true);
  assert.equal(commands.at(-1).message.keepAlive, false);
  h.state.views[0].busy = true;
  await h.window.desktop.getState();
  assert.equal(commands.at(-1).message.keepAlive, true);
  h.state.windowVisible = false;
  await h.window.desktop.getState();
  assert.equal(commands.at(-1).message.keepAlive, true, 'hiding the app must not suspend running work');
  h.state.views[0].busy = false;
  await h.window.desktop.getState();
  assert.equal(commands.at(-1).message.keepAlive, false);
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
