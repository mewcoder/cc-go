'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { MessageChannel } = require('node:worker_threads');

const source = name => fs.readFileSync(require.resolve('../web/' + name), 'utf8');
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

function fixture(t) {
  const channels = [], calls = [], errors = [], cleanups = [];
  const shell = {
    addEventListener() {},
    mygo: {
      channel() {
        const channel = { close() { this.closed = true; } };
        channels.push(channel);
        return channel;
      },
      call(method, ...args) {
        calls.push({ method, args });
        if (method === 'ViewBridge.Stream') return new Promise(() => {});
        return Promise.resolve();
      },
    },
  };
  vm.runInNewContext(source('native-relay.js'), { window: shell, URL, console: { error: (...args) => errors.push(args) } });
  const frames = [];
  function view(index) {
    const events = new Map(), delivered = [], reports = [], http = [], sockets = [];
    const frame = { dataset: { url: `http://127.0.0.1:1234/view/${index}/token${index}/index.html` } };
    const parent = { postMessage(data, origin, ports) {
      reports.push({ data, origin, ports });
      if (data.type === 'claude-host:native-ready') {
        shell.goViewRelay.attach(frame, { source: window, origin: 'http://127.0.0.1:1234', ports });
      }
    } };
    const window = { parent,
      addEventListener(type, handler) {
        if (!events.has(type)) events.set(type, []);
        events.get(type).push(handler);
      },
      dispatchEvent(event) { delivered.push(event.data); },
    };
    frame.contentWindow = window;
    frames.push(frame);
    vm.runInNewContext(source('bridge.js'), {
      window, URL, MessageChannel, queueMicrotask,
      console: { error: (...args) => errors.push(args) },
      document: { documentElement: { style: { setProperty() {} } }, addEventListener() {} },
      location: { origin: 'http://127.0.0.1:1234', href: frame.dataset.url },
      __claudeBridge: { native: true, base: new URL('.', frame.dataset.url).href, shellOrigin: 'http://127.0.0.1:4321' },
      fetch: (...args) => { http.push(args); throw Error('HTTP forbidden'); },
      WebSocket: class { constructor() { sockets.push(this); throw Error('WS forbidden'); } },
      MessageEvent: class { constructor(_, options) { Object.assign(this, options); } },
      setTimeout, clearTimeout,
    });
    const emit = type => { for (const handler of events.get(type) ?? []) handler({ persisted: true }); };
    cleanups.push(() => { emit('pagehide'); shell.goViewRelay.close(frame); });
    return { window, delivered, http, sockets, frame, reports, emit };
  }
  t.after(() => { for (const cleanup of cleanups) cleanup(); });
  return { shell, view, channels, calls, errors };
}

test('12 isolated native views deliver ordered large messages without HTTP or WS', async t => {
  const h = fixture(t);
  const views = Array.from({ length: 12 }, (_, i) => h.view(i));
  for (let i = 0; i < 12; i++) {
    h.channels[i].onmessage({ index: i, sequence: 0 });
  }
  await settle();
  for (const view of views) {
    assert.equal(view.delivered.length, 0, 'initial messages wait for the plugin listener');
    view.window.addEventListener('message', () => {});
    assert.equal(view.window.mygo, undefined);
  }
  for (let sequence = 1; sequence <= 128; sequence++) {
    for (let index = 0; index < 12; index++) {
      h.channels[index].onmessage({ index, sequence, text: sequence === 1 ? 'x'.repeat(2 << 20) : 'small' });
    }
  }
  await settle();
  for (let index = 0; index < 12; index++) {
    const view = views[index];
    assert.deepEqual(view.delivered.map(m => m.sequence), Array.from({ length: 129 }, (_, i) => i));
    assert.ok(view.delivered.every(m => m.index === index), 'no cross-session delivery');
    assert.equal(view.http.length + view.sockets.length, 0);
  }
  assert.equal(h.errors.length, 0);
});

test('native postMessage/state/external preserve the original API and send order', async t => {
  const h = fixture(t), view = h.view(0), api = view.window.acquireVsCodeApi();
  assert.throws(() => view.window.acquireVsCodeApi(), /already been acquired/);
  api.postMessage({ type: 'initialize' });
  api.setState({ draft: 'unsent' });
  api.postMessage({ type: 'next' });
  assert.equal(api.getState().draft, 'unsent');
  assert.equal(view.window.open('https://example.com'), null);
  await settle();
  const posts = h.calls.filter(call => call.method === 'ViewBridge.Post');
  assert.deepEqual(posts.map(call => call.args.slice(0, 3)), [
    ['0', 'token0', 'message'], ['0', 'token0', 'state'], ['0', 'token0', 'message'], ['0', 'token0', 'external'],
  ]);
  assert.equal(posts[3].args[3], 'https://example.com/');
  assert.equal(view.http.length + view.sockets.length, 0);
});

test('shell relay rejects foreign origin/source and requires a transferred port', t => {
  const h = fixture(t), view = h.view(0);
  const channel = new MessageChannel();
  t.after(() => { channel.port1.close(); channel.port2.close(); });
  for (const overrides of [{ origin: 'http://attacker.invalid' }, { source: {} }, { ports: [] }]) {
    h.shell.goViewRelay.attach(view.frame, { source: view.window, origin: 'http://127.0.0.1:1234', ports: [channel.port1], ...overrides });
  }
  assert.equal(h.channels.length, 1);
  assert.equal(h.channels[0].closed, undefined);
});

test('reload and page removal close the old native channel without disturbing other views', async t => {
  const h = fixture(t), first = h.view(0), second = h.view(1);
  first.emit('pagehide');
  await settle();
  assert.equal(h.channels[0].closed, true);
  assert.equal(h.channels[1].closed, undefined);
  first.emit('pageshow');
  assert.equal(h.channels.length, 3);
  first.window.addEventListener('message', () => {});
  h.channels[0].onmessage({ stale: true });
  h.channels[2].onmessage({ current: true });
  await settle();
  assert.deepEqual(first.delivered.map(m => Object.keys(m)[0]), ['current']);
  h.shell.goViewRelay.close(second.frame);
  assert.equal(h.channels[1].closed, true);
});

test('a rejected outgoing operation does not disconnect a working conversation', async t => {
  const h = fixture(t), view = h.view(0), api = view.window.acquireVsCodeApi();
  const call = h.shell.mygo.call;
  h.shell.mygo.call = (method, ...args) => args[2] === 'external'
    ? Promise.reject(Error('invalid external URL')) : call(method, ...args);
  view.window.open('file:///not-an-external-link');
  api.postMessage({ type: 'still-working' });
  view.window.addEventListener('message', () => {});
  h.channels[0].onmessage({ reply: true });
  await settle();
  assert.equal(h.channels[0].closed, undefined);
  assert.equal(h.calls.at(-1).args[3].type, 'still-working');
  assert.equal(view.delivered.at(-1).reply, true);
});
