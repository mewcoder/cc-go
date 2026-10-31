'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { convert, create } = require('../web/code-themes.js');
const { create: createControl } = require('../web/settings-theme.js');
const directory = path.join(__dirname, '../runtime/code-themes');
const catalog = JSON.parse(fs.readFileSync(path.join(directory, 'catalog.json')));
const load = id => JSON.parse(fs.readFileSync(path.join(directory, id + '.json')));

function documentFixture() {
  const listeners = {}, classes = new Set();
  const make = tag => ({
    tag, children: [], attributes: {}, handlers: {}, style: {}, classList: {
      add() {}, remove() {},
    },
    append(...items) { this.children.push(...items); items.forEach(item => { item.isConnected = true; }); },
    replaceChildren(...items) { this.children = items; },
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(key, fn) { this.handlers[key] = fn; },
  });
  return {
    createElement: make, head: make('head'), listeners,
    addEventListener(key, fn) { listeners[key] = fn; },
    body: { classList: { toggle(name) { classes.has(name) ? classes.delete(name) : classes.add(name); } } },
  };
}

test('every family has exactly one bundled light and dark palette, including standard One', () => {
  assert.deepEqual(catalog.map(item => item.id), ['github', 'pierre', 'vscode', 'one', 'vitesse', 'catppuccin', 'solarized', 'min', 'rose-pine']);
  const names = [];
  for (const family of catalog) {
    for (const kind of ['light', 'dark']) {
      const theme = load(family[kind]);
      assert.equal(theme.type, kind, family.id);
      assert.equal(theme.name, family[kind]);
      assert.ok(theme.tokenColors.length);
      const result = convert(theme);
      assert.match(result.colors['editor.background'], /^#[\da-f]{6}$/i);
      assert.ok(result.rules.some(rule => rule.token === 'keyword' && rule.foreground));
      assert.ok(result.rules.some(rule => rule.token === 'string' && rule.foreground));
      assert.ok(result.rules.every(rule => !rule.foreground || /^[\da-f]{6}$/i.test(rule.foreground)), family.id);
      assert.match(result.colors['diffEditor.insertedLineBackground'], /^#[\da-f]+$/i);
      assert.match(result.colors['diffEditor.removedLineBackground'], /^#[\da-f]+$/i);
      names.push(family[kind] + '.json');
    }
  }
  assert.equal(new Set(names).size, 18);
  assert.deepEqual(fs.readdirSync(directory).filter(name => name.endsWith('.json') && name !== 'catalog.json').sort(), names.sort());
  assert.equal(catalog.find(item => item.id === 'one').dark, 'one-dark');
  assert.ok(!names.some(name => name.includes('pro')));
});

test('Monarch translation respects scope specificity and explicit font-style resets', () => {
  const data = convert({ type: 'dark', colors: {}, tokenColors: [
    { scope: 'keyword', settings: { foreground: '#111111', fontStyle: 'italic' } },
    { scope: ['keyword.control'], settings: { foreground: '#222222', fontStyle: '' } },
    { scope: 'source.js keyword.control', settings: { foreground: '#999999' } },
    { scope: 'string', settings: { foreground: '#abcdef' } },
  ] });
  assert.equal(data.rules.find(rule => rule.token === 'keyword.control').foreground, '222222');
  assert.equal(data.rules.find(rule => rule.token === 'keyword.control').fontStyle, '');
  assert.equal(data.rules.find(rule => rule.token === 'string').foreground, 'abcdef');
});

test('diff fallbacks use palette change colors while preserving upstream diff colors', () => {
  const solarized = convert(load('solarized-dark')).colors;
  assert.equal(solarized['diffEditor.insertedLineBackground'], '#85990022');
  assert.equal(solarized['diffEditor.removedTextBackground'], '#DC322F44');
  const one = load('one-dark'), resolved = convert(one).colors;
  assert.equal(resolved['diffEditor.insertedTextBackground'], one.colors['diffEditor.insertedTextBackground']);
  assert.equal(resolved['diffEditor.removedLineBackground'], '#E06C7522');
});

test('live adapter resolves paired palettes, retains high contrast, and restores defaults', async () => {
  const document = documentFixture(), defined = new Map(), requested = [];
  const controller = create({ document, value: catalog[0], load: async id => { requested.push(id); return load(id); } });
  await controller.ready;
  assert.equal(controller.resolve('vs'), 'vs');
  const setTheme = () => {};
  assert.equal(controller.attach({ defineTheme: (id, data) => defined.set(id, data), setTheme }), setTheme);
  assert.equal(controller.resolve('vs'), 'cc-code-github-light');
  assert.equal(controller.resolve('vs-dark'), 'cc-code-github-dark');
  assert.equal(controller.resolve('hc-black'), 'hc-black');
  assert.equal(controller.resolve('hc-light'), 'hc-light');
  assert.ok(defined.has('cc-code-github-light'));
  await controller.update(catalog.find(item => item.id === 'catppuccin'));
  assert.equal(controller.resolve('vs'), 'cc-code-catppuccin-latte');
  assert.equal(controller.resolve('vs-dark'), 'cc-code-catppuccin-mocha');
  assert.match(document.head.children[0].textContent, /body.vscode-light/);
  assert.match(document.head.children[0].textContent, /body.vscode-dark/);
  await controller.update({ id: 'default', light: 'default', dark: 'default' });
  assert.equal(controller.resolve('vs'), 'vs');
  assert.equal(controller.resolve('vs-dark'), 'vs-dark');
  assert.equal(document.head.children[0].textContent, '');
  await controller.update(catalog[0]);
  assert.equal(requested.filter(id => id === 'github-light').length, 1);
});

test('a slower palette load cannot overwrite a newer selection', async () => {
  const document = documentFixture();
  const pending = new Map();
  const controller = create({ document, load: id => new Promise(resolve => pending.set(id, resolve)) });
  await controller.ready;
  controller.attach({ defineTheme() {}, setTheme() {} });
  const first = controller.update(catalog[0]);
  await Promise.resolve();
  const latest = controller.update({ id: 'default', light: 'default', dark: 'default' });
  await latest;
  for (const [id, resolve] of pending) resolve(load(id));
  await first;
  assert.equal(controller.resolve('vs-dark'), 'vs-dark');
});

test('one theme selector saves a family once and rolls back a failed save', async () => {
  const document = documentFixture(), calls = [];
  const errors = new Set();
  const status = { classList: { add: name => errors.add(name), remove: name => errors.delete(name) } };
  const control = createControl(document, {
    value: 'pierre', status, convert, catalog: async () => catalog, load: async id => load(id), schedule() {},
    save: async value => { calls.push(value); if (value === 'github') throw Error('Save failed'); },
  });
  await control.ready;
  const select = control;
  assert.equal(select.children.length, catalog.length + 1);
  select.value = 'catppuccin';
  const saving = select.handlers.change();
  assert.equal(select.disabled, true);
  select.value = 'github';
  await select.handlers.change();
  await saving;
  assert.deepEqual(calls, ['catppuccin']);
  select.value = 'github';
  await select.handlers.change();
  assert.deepEqual(calls, ['catppuccin', 'github']);
  assert.equal(select.value, 'catppuccin');
  assert.equal(status.textContent, 'Save failed');
  assert.ok(errors.has('error'));
  control.syncTheme('default');
  assert.equal(select.value, 'default');
});
