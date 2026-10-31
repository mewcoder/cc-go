'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { observeComposer, titlebarRegions } = require('../web/composer.js');

function fixture() {
  const events = new Map(), eventOptions = new Map(), documentEvents = new Map(), frames = new Map(), reports = [], observers = [];
  let next = 0, visible = true, loading = false;
  let bounds = { left: 100, top: 660, width: 680, height: 124 };
  const attributes = new Map();
  const anchor = { setAttribute: (name, value) => attributes.set(name, value), removeAttribute: name => attributes.delete(name) };
  const composer = { getBoundingClientRect: () => bounds, parentElement: { closest: () => anchor } };
  const input = { textContent: '', getClientRects: () => visible ? [bounds] : [],
    closest: selector => {
      if (selector === '[role="textbox"][aria-label="Message input"]') return input;
      assert.equal(selector, '[class*="inputContainer_"]'); return composer;
    } };
  class Observer {
    constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); }
    observe(target) { this.targets.add(target); }
    unobserve(target) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
  }
  const window = { innerWidth: 948, innerHeight: 800, ResizeObserver: Observer, MutationObserver: Observer,
    getComputedStyle: () => ({ position: 'absolute' }),
    parent: { postMessage: (value, origin) => reports.push({ value, origin }) },
    requestAnimationFrame(callback) { frames.set(++next, callback); return next; },
    cancelAnimationFrame(id) { frames.delete(id); },
    addEventListener(name, callback, options) { events.set(name, callback); eventOptions.set(name, options); },
    removeEventListener(name) { events.delete(name); },
  };
  const document = { readyState: 'complete', documentElement: {},
    querySelector: () => loading ? {} : null,
    querySelectorAll: selector => selector === '[role="textbox"][aria-label="Message input"]' ? [input] : [],
    addEventListener(name, callback) { documentEvents.set(name, callback); },
    removeEventListener(name) { documentEvents.delete(name); },
  };
  return { window, document, reports, observers, events, eventOptions, frames, attributes, input,
    setBounds: value => { bounds = value; }, hide: () => { visible = false; },
    setLoading: value => { loading = value; },
    flush: () => { for (const [id, callback] of [...frames]) { frames.delete(id); callback(); } },
  };
}

function titlebarFixture() {
  const item = (left, right, hidden = false) => ({
    getBoundingClientRect: () => ({ left, right, top: 4, bottom: 28 }),
    getClientRects: () => hidden ? [] : [{}],
  });
  let controls = [item(8, 100), item(820, 844), item(850, 874), item(880, 904, true)];
  let expanded = [], popups = [], top = 0;
  const header = {
    getBoundingClientRect: () => ({ left: 0, right: 948, width: 948, top, bottom: top + 32, height: 32 }),
    querySelectorAll: selector => selector === '[aria-expanded="true"]' ? expanded : controls,
  };
  return {
    window: { innerWidth: 948 },
    document: { querySelectorAll: selector => selector === '[class*="header_"]' ? [header] : popups },
    item, set controls(value) { controls = value; }, set expanded(value) { expanded = value; },
    set popups(value) { popups = value; }, set top(value) { top = value; },
  };
}

test('titlebar handles cover only blank header space and leave controls and their edges clickable', () => {
  const h = titlebarFixture();
  assert.deepEqual(titlebarRegions(h.window, h.document), [
    { left: 0, top: 0, width: 6, height: 32 },
    { left: 102, top: 0, width: 716, height: 32 },
    { left: 876, top: 0, width: 70, height: 32 },
  ]);
  // Overlapping labels, nested controls and hidden buttons must not create holes.
  h.controls = [h.item(0, 130), h.item(8, 100), h.item(120, 150), h.item(151, 155)];
  assert.deepEqual(titlebarRegions(h.window, h.document), [{ left: 157, top: 0, width: 789, height: 32 }]);
});

test('dialogs, open menus and expanded header controls suspend the titlebar handles', () => {
  const h = titlebarFixture();
  h.popups = [h.item(0, 100)];
  assert.deepEqual(titlebarRegions(h.window, h.document), []);
  h.popups = [h.item(0, 100, true)];
  assert.ok(titlebarRegions(h.window, h.document).length > 0);
  h.expanded = [h.item(0, 100)];
  assert.deepEqual(titlebarRegions(h.window, h.document), []);
  h.expanded = [];
  h.top = 200;
  assert.deepEqual(titlebarRegions(h.window, h.document), [], 'Message and tool headers cannot become window handles');
});

test('composer reporter sends only geometry and status when those values change', () => {
  const h = fixture(), stop = observeComposer(h.window, h.document);
  h.flush();
  assert.equal(h.attributes.has('data-claude-host-composer-anchor'), true);
  assert.deepEqual(h.reports, [{ origin: '*', value: { type: 'claude-host:composer', hasDraft: false, loadError: false, loading: false, loadingRect: null,
    rect: { left: 100, top: 660, width: 680, height: 124 }, dragRegions: [], viewport: { width: 948, height: 800 } } }]);
  for (const observer of h.observers) observer.callback();
  assert.equal(h.frames.size, 1, 'Batch mutation and resize notifications in one animation frame');
  h.flush();
  assert.equal(h.reports.length, 1, 'Streaming text must not cause redundant messages');
  h.setBounds({ left: 100, top: 620, width: 680, height: 164 });
  h.observers[0].callback();
  h.flush();
  assert.equal(h.reports[1].value.rect.height, 164);
  h.window.innerWidth = 1200;
  h.events.get('resize')();
  h.flush();
  assert.equal(h.reports[2].value.viewport.width, 1200);
  h.hide();
  h.observers[1].callback();
  h.flush();
  assert.equal(h.reports[3].value.rect, null);
  assert.equal(h.attributes.has('data-claude-host-composer-anchor'), false);
  stop();
  assert.ok(h.observers.every(observer => observer.targets.size === 0));
  assert.equal(h.events.size, 0);
});

test('plugin loading state is reported without forwarding text or duplicating its UI', () => {
  const h = fixture(), stop = observeComposer(h.window, h.document);
  h.setLoading(true);
  h.flush();
  assert.equal(h.reports.at(-1).value.loading, true);
  h.setLoading(false);
  h.observers[1].callback();
  h.flush();
  assert.equal(h.reports.at(-1).value.loading, false);
  stop();
});

test('hiding a conversation does not report its unsent draft as empty', () => {
  const h = fixture(), stop = observeComposer(h.window, h.document);
  h.input.textContent = 'Draft kept in a background conversation';
  h.flush();
  assert.equal(h.reports.at(-1).value.hasDraft, true);
  h.hide();
  h.observers[1].callback();
  h.flush();
  assert.equal(h.reports.at(-1).value.hasDraft, true);
  assert.equal(h.reports.at(-1).value.rect, null);
  assert.equal(JSON.stringify(h.reports).includes(h.input.textContent), false);
  stop();
});

test('draft presence disables switching without disclosing draft contents', () => {
  const h = fixture(), stop = observeComposer(h.window, h.document);
  h.flush();
  h.input.textContent = 'private draft content';
  h.observers[1].callback();
  h.flush();
  assert.equal(h.reports.at(-1).value.hasDraft, true);
  assert.equal(JSON.stringify(h.reports).includes(h.input.textContent), false);
  stop();
});

test('page unload cancels geometry work before it can access the parent', () => {
  const h = fixture();
  observeComposer(h.window, h.document);
  assert.equal(h.frames.size, 1);
  h.events.get('pagehide')();
  h.flush();
  assert.equal(h.reports.length, 0);
});

function keydown(h, overrides = {}) {
  const event = { target: h.input, key: 'Enter', keyCode: 13, isComposing: false,
    stopped: false, defaultPrevented: false,
    stopImmediatePropagation() { this.stopped = true; },
    preventDefault() { this.defaultPrevented = true; }, ...overrides };
  h.events.get('keydown')(event);
  return event;
}

test('IME confirmation stays native and cannot reach plugin send shortcuts', () => {
  const h = fixture(), stop = observeComposer(h.window, h.document);
  assert.equal(h.eventOptions.get('keydown'), true, 'Guard must run before plugin capture and bubble handlers');
  h.events.get('compositionstart')({ target: h.input });
  for (const overrides of [{}, { isComposing: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) {
    const event = keydown(h, overrides);
    assert.equal(event.stopped, true);
    assert.equal(event.defaultPrevented, false, 'IME must still commit the selected text');
  }
  h.events.get('compositionend')({ target: h.input });
  assert.equal(keydown(h).stopped, false, 'Next ordinary Enter must send without an artificial delay');
  stop();
});

test('WebKit compositionend before Enter is covered by IME keyCode 229', () => {
  const h = fixture(), stop = observeComposer(h.window, h.document);
  h.events.get('compositionstart')({ target: h.input });
  h.events.get('compositionend')({ target: h.input });
  const event = keydown(h, { keyCode: 229, isComposing: false });
  assert.equal(event.stopped, true);
  assert.equal(event.defaultPrevented, false);
  assert.equal(keydown(h).stopped, false);
  stop();
});

test('native composition flags protect nested input targets even without compositionstart', () => {
  const h = fixture(), stop = observeComposer(h.window, h.document);
  const target = { closest: selector => h.input.closest(selector) };
  assert.equal(keydown(h, { target, isComposing: true }).stopped, true);
  assert.equal(keydown(h, { target, keyCode: 229 }).stopped, true);
  stop();
});

test('normal send, newline, other keys and other fields retain their keyboard events', () => {
  const h = fixture(), stop = observeComposer(h.window, h.document);
  for (const overrides of [{}, { shiftKey: true }, { ctrlKey: true }, { metaKey: true }]) {
    assert.equal(keydown(h, overrides).stopped, false);
  }
  h.events.get('compositionstart')({ target: h.input });
  for (const key of ['a', 'ArrowDown', 'Escape', 'Tab', ' ']) {
    assert.equal(keydown(h, { key, isComposing: true, keyCode: 229 }).stopped, false);
  }
  assert.equal(keydown(h, { target: { closest: () => null }, isComposing: true }).stopped, false);
  stop();
});

test('focus loss clears composition state when the webview misses compositionend', () => {
  const h = fixture(), stop = observeComposer(h.window, h.document);
  for (const event of ['focusout', 'blur']) {
    h.events.get('compositionstart')({ target: h.input });
    assert.equal(keydown(h).stopped, true);
    h.events.get(event)();
    assert.equal(keydown(h).stopped, false);
  }
  stop();
  assert.equal(h.events.size, 0, 'Dispose all input guards with the composer observer');
});
