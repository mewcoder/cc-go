'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupView } = require('../web/setup.js');
const state = pluginSetup => ({ phase: 'setup', pluginSetup });
const node = { nodeVersion: 'v22.0.0' };
const plugin = { ...node, readyVersion: '2.1.312' };

test('shared setup checks Node, platform VSIX and bundled Claude, not a system CLI', () => {
  const view = setupView(state({ status: 'detecting-node', step: 0 }));
  assert.deepEqual(view.cards.map(card => card.kind), ['busy', 'waiting', 'waiting']);
  assert.equal(view.busy, true);
  assert.equal('cliReady' in view, false);
});

test('system and Node share the environment step on macOS, Windows and Linux', () => {
  for (const [platform, system] of [['darwin-arm64', 'macOS · arm64'], ['win32-x64', 'Windows · x64'], ['linux-x64', 'Linux · x64']]) {
    const checking = setupView(state({ platform, status: 'detecting-node', step: 0 }));
    assert.equal(checking.cards[0].description, `${system} · 需要 Node.js 22 或更高版本。`);
    const ready = setupView(state({ ...node, platform, status: 'extracting', step: 1 }));
    assert.equal(ready.cards[0].description, system);
    assert.equal(ready.cards[0].version, 'Node.js v22.0.0');
    assert.equal(ready.cards.length, 3);
  }
});

test('waiting state does not invent a system, runtime or version', () => {
  const view = setupView(state({}));
  assert.equal(view.cards[0].description, '需要 Node.js 22 或更高版本。');
  assert.equal(view.cards[0].version, '');
  assert.deepEqual(view.cards.map(card => card.kind), ['waiting', 'waiting', 'waiting']);
});

test('missing or old Node stops before downloading the extension', () => {
  for (const error of ['Node.js not found', 'Node.js 20 is too old']) {
    const view = setupView(state({ status: 'needs-node', step: 0, nodeError: error }));
    assert.deepEqual(view.cards.map(card => card.kind), ['error', 'waiting', 'waiting']);
    assert.equal(view.nodeReady, false);
    assert.equal(view.cards[0].label, '请安装');
  }
});

test('download, extraction and VSIX failures occupy the second step', () => {
  for (const status of ['downloading', 'extracting']) {
    const view = setupView(state({ ...node, status, step: 1 }));
    assert.deepEqual(view.cards.map(card => card.kind), ['ready', 'busy', 'waiting']);
  }
  const failed = setupView(state({ ...node, status: 'error', step: 1, error: 'Invalid VSIX' }));
  assert.deepEqual(failed.cards.map(card => card.kind), ['ready', 'error', 'waiting']);
  assert.equal(failed.cards[1].error, 'Invalid VSIX');
});

test('bundled runtime checks and failures preserve the verified extension', () => {
  const checking = setupView(state({ ...plugin, status: 'checking-runtime', step: 2 }));
  assert.deepEqual(checking.cards.map(card => card.kind), ['ready', 'ready', 'busy']);
  const failed = setupView(state({ ...plugin, status: 'error', step: 2, error: 'Bundled Claude missing' }));
  assert.deepEqual(failed.cards.map(card => card.kind), ['ready', 'ready', 'error']);
  assert.equal(failed.cards[2].error, 'Bundled Claude missing');
});

test('ready runtime enables all steps, and update-check errors are non-blocking', () => {
  const ready = setupView(state({ ...plugin, runtimeReady: true, status: 'ready', step: 2, updateError: 'Offline' }));
  assert.deepEqual(ready.cards.map(card => card.kind), ['ready', 'ready', 'ready']);
  assert.equal(ready.cards[1].version, '2.1.312');
  assert.equal(ready.error, '');
  assert.equal(ready.busy, false);
});
