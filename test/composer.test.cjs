'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { observeComposer } = require('../web/composer.js');

function fixture() {
  const events = new Map(), documentEvents = new Map(), frames = new Map(), reports = [], observers = [];
  let next = 0, visible = true;
  let bounds = { left: 100, top: 660, width: 680, height: 124 };
  const attributes = new Map();
  const anchor = { setAttribute: (name, value) => attributes.set(name, value), removeAttribute: name => attributes.delete(name) };
  const composer = { getBoundingClientRect: () => bounds, parentElement: { closest: () => anchor } };
  const input = { textContent: '', getClientRects: () => visible ? [bounds] : [],
    closest: selector => { assert.equal(selector, '[class*="inputContainer_"]'); return composer; } };
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
    addEventListener(name, callback) { events.set(name, callback); },
    removeEventListener(name) { events.delete(name); },
  };
  const document = { readyState: 'complete', documentElement: {},
    querySelectorAll: selector => { assert.equal(selector, '[role="textbox"][aria-label="Message input"]'); return [input]; },
    addEventListener(name, callback) { documentEvents.set(name, callback); },
    removeEventListener(name) { documentEvents.delete(name); },
  };
  return { window, document, reports, observers, events, frames, attributes, input,
    setBounds: value => { bounds = value; }, hide: () => { visible = false; },
    flush: () => { for (const [id, callback] of [...frames]) { frames.delete(id); callback(); } },
  };
}

test('composer reporter sends only geometry and only when geometry changes', () => {
  const h = fixture(), stop = observeComposer(h.window, h.document);
  h.flush();
  assert.equal(h.attributes.has('data-claude-host-composer-anchor'), true);
  assert.deepEqual(h.reports, [{ origin: '*', value: { type: 'claude-host:composer', hasDraft: false,
    rect: { left: 100, top: 660, width: 680, height: 124 }, viewport: { width: 948, height: 800 } } }]);
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
