'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { create, renderPatch } = require('../web/git-review.js');
const settle = () => new Promise(resolve => setImmediate(resolve));
const patchText = body => '--- a/file\n+++ b/file\n' + body;

function fixture(request) {
  const document = { activeElement: null };
  const make = tag => ({ tagName: tag.toUpperCase(), children: [], dataset: {}, attributes: {}, handlers: {}, style: {}, textContent: '', value: '', open: false,
    append(...items) { this.children.push(...items); items.forEach(item => { item.isConnected = true; }); },
    replaceChildren(...items) { this.markup = ''; this.children = []; this.append(...items); },
    get innerHTML() { return this.markup || ''; },
    set innerHTML(value) { this.markup = value; this.children = []; },
    contains(item) { return this.children.some(child => child === item || child.contains?.(item)); },
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(key, fn) { this.handlers[key] = fn; },
    showModal() { this.open = true; }, close() { this.open = false; },
    focus() { document.activeElement = this; },
  });
  document.createElement = make;
  document.createElementNS = (_, tag) => make(tag);
  document.body = make('body');
  const calls = [];
  const viewer = create(document, { request: async (method, args) => { calls.push({ method, args }); return request(method, args); } });
  const find = className => {
    const walk = node => node.className === className ? node : node.children.map(walk).find(Boolean);
    return walk(document.body);
  };
  const state = { phase: 'active', workspace: '/work/project', views: [{ id: 'view', active: true }] };
  const anchor = make('span');
  anchor.isConnected = true;
  return { document, viewer, state, anchor, calls, find,
    async open() { viewer.open(state, anchor); await settle(); },
    get dialog() { return find('git-review-dialog'); }, get files() { return find('git-review-files'); },
    get patch() { return find('git-review-patch'); }, get message() { return find('git-review-message'); },
  };
}

const entries = [
  { path: 'one.txt', status: ' M', added: 1, deleted: 1 },
  { path: '<script>.txt', originalPath: 'old.txt', status: 'R ', added: 0, deleted: 0 },
];

test('the embedded renderer retains line numbers, escapes code and highlights changed words', () => {
  const rendered = renderPatch(patchText('@@ -4,2 +4,3 @@\n old\n-const x = 1;\n+const x = 2;\n+<script>alert(1)</script>\n\\ No newline at end of file\n'));
  assert.match(rendered.html, /class="line-num1">4</);
  assert.match(rendered.html, /class="line-num2">6</);
  assert.match(rendered.html, /<del>1<\/del>/);
  assert.match(rendered.html, /<ins>2<\/ins>/);
  assert.match(rendered.html, /&lt;script&gt;alert\(1\)&lt;&#x2F;script&gt;/);
  assert.doesNotMatch(rendered.html, /<script>/);
  assert.match(renderPatch('--- /dev/null\n+++ b/new\n@@ -0,0 +1,1 @@\n+new\n').html, /class="line-num2">1</);
  assert.match(renderPatch(patchText('@@ -0,0 +1 @@\n+++ content\n')).html, /\+\+ content/);
  assert.doesNotMatch(renderPatch('').html, /<table/);
  const hostilePath = renderPatch('--- /dev/null\n+++ b/<img src=x onerror=alert(1)>.txt\n@@ -0,0 +1 @@\n+safe\n').html;
  assert.match(hostilePath, /&lt;img/);
  assert.doesNotMatch(hostilePath, /<img/);
});

test('the Changes dialog opens files and diffs without mutating the chat or refreshing instead', async () => {
  const h = fixture((method, args) => method === 'git-changes' ? { root: '/work/project', files: entries }
    : { patch: patchText('@@ -1 +1 @@\n-before\n+<script>alert(1)</script>\n'), path: args.path });
  await h.open();
  assert.equal(h.dialog.open, true);
  assert.equal(h.files.children.length, 2);
  assert.deepEqual(h.calls.map(call => call.method), ['git-changes', 'git-diff']);
  assert.equal(h.files.children[1].children[1].textContent, '<script>.txt');
  assert.match(h.patch.innerHTML, /&lt;script&gt;alert\(1\)&lt;&#x2F;script&gt;/);
  assert.equal(h.files.children[0].attributes['aria-pressed'], 'true');
  assert.ok(h.calls.every(call => call.args.workspace === h.state.workspace));
  const source = fs.readFileSync(require.resolve('../web/desktop.js'), 'utf8');
  assert.match(source, /changes: field => gitReview\?\.open\(latest, field\)/);
  assert.match(source, /action === 'refresh-git'/);
});

test('late diff replies cannot replace a newer file or reopen a closed dialog', async () => {
  const pending = new Map();
  const h = fixture((method, args) => method === 'git-changes' ? { files: entries }
    : new Promise(resolve => pending.set(args.path, resolve)));
  await h.open();
  h.files.children[1].focus();
  h.files.children[1].handlers.click();
  assert.equal(h.document.activeElement.dataset.path, '<script>.txt');
  pending.get('<script>.txt')({ path: '<script>.txt', message: 'Newer file', patch: '' });
  await settle();
  pending.get('one.txt')({ path: 'one.txt', message: 'Stale file', patch: '' });
  await settle();
  assert.equal(h.message.textContent, 'Newer file');
  h.find('git-review-close').handlers.click();
  assert.equal(h.dialog.open, false);
  assert.equal(h.document.activeElement, h.anchor);
});

test('loading can be dismissed and project, view or settings changes close stale previews', async () => {
  let resolve;
  const h = fixture(() => new Promise(done => { resolve = done; }));
  h.viewer.open(h.state, h.anchor);
  h.dialog.handlers.cancel({ preventDefault() {} });
  resolve({ files: entries });
  await settle();
  assert.equal(h.dialog.open, false);
  assert.equal(h.calls.length, 1);
  for (const change of [{ workspace: '/other' }, { settingsOpen: true }, { views: [{ id: 'other', active: true }] }]) {
    h.viewer.open(h.state, h.anchor);
    h.viewer.sync({ ...h.state, ...change });
    assert.equal(h.dialog.open, false);
  }
});

test('file filtering, keyboard focus, binary messages, refresh errors and retry stay usable', async () => {
  let fail = false;
  const h = fixture(method => {
    if (method === 'git-changes') {
      if (fail) throw Error('Git failed');
      return { files: entries };
    }
    return { patch: '', message: 'Binary file.' };
  });
  await h.open();
  assert.equal(h.message.textContent, 'Binary file.');
  h.find('git-review-filter').value = 'old';
  h.find('git-review-filter').handlers.input();
  assert.equal(h.files.children.length, 1);
  assert.equal(h.files.children[0].title, 'old.txt \u2192 <script>.txt');
  h.files.handlers.keydown({ key: 'End', preventDefault() {} });
  assert.equal(h.document.activeElement, h.files.children[0]);
  fail = true;
  h.find('git-review-refresh').handlers.click();
  await settle();
  assert.equal(h.find('git-review-status').textContent, 'Git failed');
  assert.equal(h.find('git-review-refresh').disabled, false);
  fail = false;
  h.find('git-review-refresh').handlers.click();
  await settle();
  assert.equal(h.find('git-review-status').hidden, true);
});

test('large previews cap rendered rows and report truncation', async () => {
  const h = fixture(method => method === 'git-changes' ? { files: entries }
    : { patch: patchText('@@ -0,0 +1,9000 @@\n' + '+line\n'.repeat(9000)) });
  await h.open();
  assert.ok((h.patch.innerHTML.match(/<tr>/g) || []).length <= 6000);
  assert.match(h.message.textContent, /truncated/);
});

test('refresh retains the selected file, filter and preview until replacement is ready', async () => {
  let refreshing = false, resolveList, resolveDiff;
  const h = fixture((method, args) => {
    if (refreshing) return new Promise(resolve => { if (method === 'git-changes') resolveList = resolve; else resolveDiff = resolve; });
    return method === 'git-changes' ? { files: entries } : { path: args.path, patch: patchText('@@ -1 +1 @@\n-before\n+after\n') };
  });
  await h.open();
  h.files.children[1].handlers.click();
  await settle();
  const filter = h.find('git-review-filter'), refresh = h.find('git-review-refresh');
  filter.value = 'old';
  filter.handlers.input();
  h.patch.scrollTop = 70;
  h.patch.scrollLeft = 12;
  const oldPreview = h.patch.innerHTML;
  refreshing = true;
  refresh.handlers.click();
  const requests = h.calls.length;
  refresh.handlers.click();
  assert.equal(h.calls.length, requests);
  assert.equal(refresh.attributes['aria-busy'], 'true');
  assert.equal(h.patch.innerHTML, oldPreview);
  assert.equal(h.files.children.length, 1);
  resolveList({ files: entries });
  await settle();
  assert.equal(h.patch.innerHTML, oldPreview, 'retain the preview while the replacement diff is loading');
  assert.equal(h.calls.at(-1).args.path, '<script>.txt');
  resolveDiff({ patch: patchText('@@ -1 +1 @@\n-before\n+updated\n') });
  await settle();
  assert.equal(refresh.disabled, false);
  assert.equal(refresh.attributes['aria-busy'], 'false');
  assert.equal(filter.value, 'old');
  assert.equal(h.files.children[0].attributes['aria-pressed'], 'true');
  assert.equal(h.patch.scrollTop, 70);
  assert.equal(h.patch.scrollLeft, 12);
  assert.match(h.patch.innerHTML, /updated/);
});
