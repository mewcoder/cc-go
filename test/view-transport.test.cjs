'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture() {
  const sockets = [], listeners = new Map(), delivered = [], timers = new Map(), reports = [], calls = [];
  const parent = { postMessage: message => reports.push(message) };
  const window = {
    parent,
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
    dispatchEvent(event) { delivered.push(event.data); },
  };
  let timerID = 0;
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/bridge.js'), 'utf8'), {
    window, console, URL, queueMicrotask,
    document: { documentElement: { style: { setProperty() {} } }, addEventListener() {} },
    location: { origin: 'http://127.0.0.1:1234', href: 'http://127.0.0.1:1234/view/id/token/index.html' },
    __claudeBridge: { base: 'http://127.0.0.1:1234/view/id/token/', theme: 'light', shellOrigin: 'http://127.0.0.1:4321' },
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: true }; },
    WebSocket: class {
      constructor(url) { this.url = url; sockets.push(this); }
      close() { this.closed = true; this.onclose?.(); }
    },
    MessageEvent: class { constructor(_, options) { Object.assign(this, options); } },
    setTimeout(fn, delay) { timers.set(++timerID, { fn, delay }); return timerID; },
    clearTimeout(id) { timers.delete(id); },
  });
  const emit = (type, event = {}) => { for (const listener of listeners.get(type) ?? []) listener(event); };
  return { window, sockets, delivered, timers, reports, calls, emit,
    control(keepAlive, origin = 'http://127.0.0.1:4321', source = parent) {
      emit('message', { source, origin, data: { type: 'claude-host:transport', keepAlive }, stopImmediatePropagation() {} });
    },
    send(sequence, data, socket = sockets.at(-1)) { socket.onmessage({ data: JSON.stringify({ sequence, data }) }); },
    retry() { const [id, timer] = timers.entries().next().value; timers.delete(id); timer.fn(); },
  };
}

test('context dialog opens only from the shell and uses the latest native callback', () => {
  const h = fixture();
  const open = (origin = 'http://127.0.0.1:4321', source = h.window.parent) => h.emit('message', {
    source, origin, data: { type: 'claude-host:open-context' }, stopImmediatePropagation() {},
  });
  let first = 0, second = 0;
  const callback = () => first++;
  assert.equal(h.window.__goContext.attach(callback), callback);
  assert.equal(h.reports.at(-1).type, 'claude-host:context-ready');
  open('https://foreign.example');
  open(undefined, {});
  assert.equal(first, 0);
  open();
  assert.equal(first, 1);
  h.window.__goContext.attach(() => second++);
  open();
  assert.equal(first, 1);
  assert.equal(second, 1);
  assert.equal(h.calls.length, 0, 'Opening the dialog must not send a chat message or change a draft');
});

test('view transport uses an upgraded socket and queues initialization until the plugin listens', async () => {
  const h = fixture();
  assert.equal(h.sockets[0].url, 'ws://127.0.0.1:1234/view/id/token/socket?since=0');
  h.send(1, { type: 'initial' });
  assert.equal(h.delivered.length, 0);
  h.window.addEventListener('message', () => {});
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(h.delivered[0].type, 'initial');
  h.send(2, { type: 'next' });
  h.send(2, { type: 'duplicate' });
  assert.deepEqual(h.delivered.map(message => message.type), ['initial', 'next']);
});

test('reconnections resume after the last message with bounded exponential backoff', () => {
  const h = fixture();
  h.send(7, { type: 'latest' });
  for (const delay of [250, 500, 1000, 2000, 4000, 8000, 10000, 10000]) {
    h.sockets.at(-1).onclose();
    assert.equal([...h.timers.values()][0].delay, delay);
    h.retry();
    assert.match(h.sockets.at(-1).url, /\?since=7$/);
  }
  h.sockets.at(-1).onopen();
  h.sockets.at(-1).onclose();
  assert.equal([...h.timers.values()][0].delay, 250);
});

test('heartbeats never reach the plugin and page unload cancels reconnection', () => {
  const h = fixture();
  h.window.addEventListener('message', () => {});
  h.sockets[0].onmessage({ data: JSON.stringify({ ping: true }) });
  assert.equal(h.delivered.length, 0);
  h.sockets[0].onclose();
  assert.equal(h.timers.size, 1);
  h.emit('pagehide');
  assert.equal(h.timers.size, 0);
  assert.equal(h.sockets.length, 1);
});

test('hidden idle views close after a grace period and resume from the last received message', () => {
  const h = fixture();
  h.sockets[0].onopen();
  h.send(4, { type: 'notification' });
  h.control(false);
  assert.equal([...h.timers.values()][0].delay, 5000);
  h.retry();
  assert.equal(h.sockets[0].closed, true);
  assert.equal(h.timers.size, 0);
  assert.equal(h.reports.at(-1).sequence, 4);
  assert.equal(h.reports.at(-1).connected, false);
  h.control(true);
  assert.equal(h.sockets.length, 2);
  assert.match(h.sockets[1].url, /since=4$/);
  // An old connection closing late must not reconnect or stop the new socket.
  h.sockets[0].onclose();
  assert.equal(h.timers.size, 0);
});

test('pending plugin and host RPCs keep hidden views connected until answered or cancelled', async () => {
  for (const type of ['outgoing', 'tool_permission_request', 'user_dialog_request', 'engine_prompt_ask']) {
    const incoming = type !== 'outgoing';
    const h = fixture();
    const api = h.window.acquireVsCodeApi();
    const request = { type: 'request', channelId: 'channel', requestId: 'pending', request: { type } };
    if (incoming) h.send(1, request);
    else api.postMessage(request);
    await new Promise(resolve => setImmediate(resolve));
    h.control(false);
    assert.equal(h.timers.size, 0, 'an unanswered RPC must not be suspended');
    if (incoming) api.postMessage({ type: 'response', requestId: 'pending' });
    else h.send(2, { type: 'response', requestId: 'pending' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal([...h.timers.values()][0].delay, 5000);
  }
  const h = fixture();
  const api = h.window.acquireVsCodeApi();
  api.postMessage({ type: 'request', requestId: 'cancelled' });
  h.control(false);
  api.postMessage({ type: 'cancel_request', targetRequestId: 'cancelled' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal([...h.timers.values()][0].delay, 5000);
});

test('official one-way request envelopes do not pin hidden idle connections', () => {
  const h = fixture();
  h.window.addEventListener('message', () => {});
  const types = ['update_state', 'session_states_update', 'session_store_changed', 'session_archive_changed',
    'visibility_changed', 'font_configuration_changed', 'auth_url', 'engine_surface_state', 'future_notification'];
  types.forEach((type, index) => h.send(index + 1, {
    type: 'request', channelId: '', requestId: `notification-${index}`, request: { type },
  }));
  h.control(false);
  assert.equal(h.delivered.length, types.length, 'notifications must still reach the plugin');
  assert.equal([...h.timers.values()][0]?.delay, 5000);
  h.retry();
  assert.equal(h.sockets[0].closed, true);
  assert.equal(h.reports.at(-1).sequence, types.length);
  h.control(true);
  assert.match(h.sockets[1].url, new RegExp(`since=${types.length}$`));
});

test('one-way notifications do not release a genuine outstanding request', async () => {
  const h = fixture();
  h.window.acquireVsCodeApi().postMessage({ type: 'request', requestId: 'get-config', request: { type: 'get_claude_config' } });
  await new Promise(resolve => setImmediate(resolve));
  h.send(1, { type: 'request', requestId: 'state-update', request: { type: 'update_state', state: {} } });
  h.control(false);
  assert.equal(h.timers.size, 0);
  h.send(2, { type: 'response', requestId: 'get-config', response: { type: 'get_claude_config_response' } });
  assert.equal([...h.timers.values()][0]?.delay, 5000);
});

test('cancelling a host permission request releases the hidden transport', () => {
  const h = fixture();
  h.send(1, { type: 'request', requestId: 'permission', request: { type: 'tool_permission_request' } });
  h.control(false);
  assert.equal(h.timers.size, 0);
  h.send(2, { type: 'cancel_request', targetRequestId: 'permission' });
  assert.equal([...h.timers.values()][0]?.delay, 5000);
});

test('new plugin requests wake a suspended view without waiting for the shell poll', async () => {
  const h = fixture();
  h.control(false);
  h.retry();
  h.window.acquireVsCodeApi().postMessage({ type: 'request', requestId: 'new' });
  assert.equal(h.sockets.length, 2);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.length, 1);
  assert.equal(h.timers.size, 0);
});

test('lifecycle commands require the exact shell origin and parent window', () => {
  const h = fixture();
  h.control(false, 'http://attacker.invalid');
  h.control(false, 'http://127.0.0.1:4321', {});
  assert.equal(h.timers.size, 0);
  h.control(false);
  assert.equal(h.timers.size, 1);
});

test('rapid switches cancel suspension and restoring a cached page reconnects', () => {
  const h = fixture();
  h.control(false);
  h.control(true);
  assert.equal(h.timers.size, 0);
  assert.equal(h.sockets[0].closed, undefined);
  h.emit('pagehide');
  h.emit('pageshow', { persisted: true });
  assert.equal(h.sockets.length, 2);
});

test('a cached idle page reports suspension so the shell can wake it for queued messages', () => {
  const h = fixture();
  h.control(false);
  h.emit('pagehide');
  h.emit('pageshow', { persisted: true });
  assert.equal(h.reports.at(-1).connected, false);
  assert.equal(h.sockets.length, 1);
  h.control(true);
  assert.equal(h.sockets.length, 2);
});

test('hiding an idle disconnected page cancels its pending reconnection', () => {
  const h = fixture();
  h.sockets[0].onclose();
  assert.equal(h.timers.size, 1);
  h.control(false);
  assert.equal(h.timers.size, 0);
  h.control(true);
  assert.equal(h.sockets.length, 2);
});
