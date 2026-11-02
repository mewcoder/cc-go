'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sections, sectionFor, create } = require('../web/settings-navigation.js');

function fixture() {
  const element = (dataset = {}) => ({
    dataset, hidden: false, attributes: {}, handlers: {},
    setAttribute(key, value) { this.attributes[key] = value; },
    removeAttribute(key) { delete this.attributes[key]; },
    addEventListener(name, fn) { this.handlers[name] = fn; },
  });
  const buttons = ['general', 'extension'].map(category => element({ category }));
  const search = { ...element(), value: '' };
  const rows = [
    { key: 'desktop.theme', text: 'Theme Colors across the sidebar' },
    { key: 'desktop.transcriptWidth', text: 'Transcript Width Maximum width' },
    { key: 'claudeCode.focusView', text: 'Focus View Hide extra details' },
    { key: 'claudeCode.initialPermissionMode', text: 'Initial Permission Mode' },
    { key: 'claudeCode.environmentVariables', text: 'Environment Variables' },
    { key: 'claudeCode.newSetting', text: 'New Setting' },
  ].map(item => ({ ...element({ search: `${item.key} ${item.text}`.toLowerCase() }), key: item.key, value: '' }));
  const children = sections.map(section => ({
    ...element({ category: section.category }),
    querySelectorAll: () => rows.filter(row => sectionFor(row.key) === section.id),
  }));
  const content = { scrollTop: 0 }, empty = element(), classes = new Set();
  const list = { children, classList: { toggle: (key, on) => on ? classes.add(key) : classes.delete(key) } };
  const controller = create({ search, navigation: { querySelectorAll: () => buttons }, content, list, empty });
  controller.refresh();
  return {
    rows, children, buttons, content, search, empty, classes, controller,
    visible: () => rows.filter(row => !row.hidden).map(row => row.key),
    select: category => buttons.find(button => button.dataset.category === category).handlers.click(),
    filter(value) { search.value = value; search.handlers.input(); },
  };
}

test('General contains desktop appearance; every built-in plugin setting stays in Extension', () => {
  const h = fixture();
  assert.deepEqual(h.visible(), ['desktop.theme', 'desktop.transcriptWidth']);
  assert.equal(h.buttons[0].attributes['aria-current'], 'page');
  h.select('extension');
  assert.deepEqual(h.visible(), [
    'claudeCode.focusView', 'claudeCode.initialPermissionMode',
    'claudeCode.environmentVariables', 'claudeCode.newSetting',
  ]);
  assert.equal(h.buttons[0].attributes['aria-current'], undefined);
  assert.equal(h.buttons[1].attributes['aria-current'], 'page');
  assert.equal(sectionFor('claudeCode.futureSetting'), 'advanced');
});

test('search finds titles, descriptions and configuration keys across categories', () => {
  const h = fixture();
  h.filter('  PERMISSION  ');
  assert.deepEqual(h.visible(), ['claudeCode.initialPermissionMode']);
  assert.equal(h.classes.has('is-searching'), true);
  assert.ok(h.buttons.every(button => button.attributes['aria-current'] === undefined));
  h.filter('sidebar');
  assert.deepEqual(h.visible(), ['desktop.theme']);
  h.filter('claudeCode.environmentVariables');
  assert.deepEqual(h.visible(), ['claudeCode.environmentVariables']);
  h.filter('no such setting');
  assert.equal(h.empty.hidden, false);
  assert.ok(h.children.every(section => section.hidden));
  h.filter('');
  assert.equal(h.empty.hidden, true);
  assert.deepEqual(h.visible(), ['desktop.theme', 'desktop.transcriptWidth']);
});

test('navigation preserves unsaved input and scroll position, and can leave an empty search', () => {
  const h = fixture();
  h.content.scrollTop = 80;
  h.select('extension');
  h.rows[4].value = '{"unfinished":';
  h.content.scrollTop = 240;
  h.select('general');
  assert.equal(h.content.scrollTop, 80);
  h.select('extension');
  assert.equal(h.content.scrollTop, 240);
  h.filter('nothing matches');
  h.select('extension');
  assert.equal(h.search.value, '');
  assert.equal(h.content.scrollTop, 240);
  assert.equal(h.rows[4].value, '{"unfinished":');
  assert.equal(h.empty.hidden, true);
  h.controller.reset();
  assert.equal(h.content.scrollTop, 0);
  assert.equal(h.buttons[1].attributes['aria-current'], 'page');
});
