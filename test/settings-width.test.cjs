'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../web/settings-width.js');

function fixture(value, save = async () => {}) {
  const make = tag => ({ tag, children: [], attributes: {}, handlers: {},
    append(...children) { this.children.push(...children); },
    setAttribute(key, value) { this.attributes[key] = value; },
    addEventListener(key, fn) { this.handlers[key] = fn; },
  });
  const errors = new Set(), calls = [];
  const status = { textContent: '', classList: { add: key => errors.add(key), remove: key => errors.delete(key) } };
  const group = create({ createElement: make }, { value, status, schedule() {}, save: async next => { calls.push(next); await save(next); } });
  const inputs = group.children.map(label => label.children[0]);
  const choose = async index => {
    inputs.forEach((input, i) => { input.checked = i === index; });
    return inputs[index].handlers.change();
  };
  return { group, inputs, status, calls, errors, choose };
}

test('width uses a labelled native radio group with three presets and the saved selection', () => {
  const h = fixture('medium');
  assert.equal(h.group.attributes.role, 'radiogroup');
  assert.equal(h.group.attributes['aria-label'], 'Transcript Width');
  assert.deepEqual(h.inputs.map(input => input.type), ['radio', 'radio', 'radio']);
  assert.equal(new Set(h.inputs.map(input => input.name)).size, 1);
  assert.deepEqual(h.inputs.map(input => input.checked), [false, true, false]);
  assert.deepEqual(h.group.children.map(label => label.children[1].textContent), ['Narrow', 'Medium', 'Wide']);
  assert.equal(fixture('invalid').inputs[0].checked, true);
});

test('width saves only a changed selection and restores controls after success', async () => {
  const h = fixture('narrow');
  await h.choose(0);
  assert.deepEqual(h.calls, []);
  await h.choose(2);
  assert.deepEqual(h.calls, ['wide']);
  assert.deepEqual(h.inputs.map(input => input.checked), [false, false, true]);
  assert.ok(h.inputs.every(input => !input.disabled));
  assert.equal(h.status.textContent, 'Saved');
});

test('a failed width save restores the original radio rather than falsely displaying the new value', async () => {
  const h = fixture('medium', async () => { throw Error('Could not save'); });
  await h.choose(2);
  assert.deepEqual(h.inputs.map(input => input.checked), [false, true, false]);
  assert.equal(h.status.textContent, 'Could not save');
  assert.equal(h.errors.has('error'), true);
  assert.ok(h.inputs.every(input => !input.disabled));
});

test('width rejects concurrent changes while the first save is pending', async () => {
  let finish;
  const h = fixture('narrow', () => new Promise(resolve => { finish = resolve; }));
  const pending = h.choose(1);
  assert.ok(h.inputs.every(input => input.disabled));
  await h.choose(2);
  assert.deepEqual(h.calls, ['medium']);
  finish();
  await pending;
  assert.deepEqual(h.inputs.map(input => input.checked), [false, true, false]);
});
