'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../web/notifications.js');
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture(request = async () => {}) {
  const document = { activeElement: null };
  const make = tag => ({ tag, children: [], attributes: {}, dataset: {}, handlers: {},
    append(...items) { items.forEach(item => { item.parent = this; this.children.push(item); }); },
    remove() { this.parent.children = this.parent.children.filter(item => item !== this); },
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(key, callback) { this.handlers[key] = callback; },
    focus() { document.activeElement = this; },
  });
  document.createElement = make;
  document.body = make('body');
  const calls = [];
  const ui = create(document, { request: async (method, args) => { calls.push({ method, args }); return request(method, args); } });
  const root = document.body.children[0];
  const find = (node, className) => node.className === className ? node : node.children.map(child => find(child, className)).find(Boolean);
  return { document, ui, root, calls, find: className => find(root, className) };
}

const notice = { id: 'one', type: 'info', message: '<script>message</script>', actions: ['View'] };

test('ordinary plugin messages render without stealing focus, preserve buttons, and dismiss safely', async () => {
  const h = fixture();
  const editor = {};
  h.document.activeElement = editor;
  h.ui.render([notice]);
  assert.equal(h.document.activeElement, editor);
  assert.equal(h.find('host-notification-message').textContent, notice.message);
  assert.equal(h.root.hidden, false);
  const button = h.find('host-notification-action');
  h.ui.render([notice]);
  assert.equal(h.find('host-notification-action'), button, 'Polling must preserve the focused button');
  button.handlers.click();
  button.handlers.click();
  await settle();
  assert.deepEqual(h.calls, [{ method: 'notification-action', args: { id: 'one', action: 0 } }]);
  assert.equal(h.root.hidden, true);
  h.ui.render([notice]);
  assert.equal(h.root.hidden, true, 'An older poll cannot restore an answered message');
  h.ui.render([]);
  h.ui.render([{ ...notice, id: 'two', type: 'error', actions: [] }]);
  assert.equal(h.find('host-notification').attributes.role, 'alert');
  h.find('host-notification-close').handlers.click();
  await settle();
  assert.equal(h.calls.at(-1).args.action, -1);
  assert.equal(h.root.hidden, true);
});

test('failed notification actions remain visible and can be retried', async () => {
  let fail = true;
  const h = fixture(async () => { if (fail) throw new Error('Connection lost'); });
  h.ui.render([notice]);
  const button = h.find('host-notification-action');
  button.handlers.click();
  await settle();
  assert.equal(h.find('host-notification-error').textContent, 'Connection lost');
  assert.equal(button.disabled, false);
  assert.equal(h.root.hidden, false);
  fail = false;
  button.handlers.click();
  await settle();
  assert.equal(h.root.hidden, true);
  h.ui.render([notice]);
  h.ui.render([]);
  assert.equal(h.root.children.length, 0);
});
