'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupView } = require('../web/setup.js');

function state(pluginSetup, phase = 'setup') {
  return { phase, pluginSetup };
}
const node = { nodeVersion: 'v22.0.0' };
const cli = { ...node, cliVersion: '2.1.312' };

test('setup always shows all three prerequisite steps and checks Node first', () => {
  const view = setupView(state({ status: 'detecting-node', step: 0 }));
  assert.deepEqual(view.cards.map(card => card.kind), ['busy', 'waiting', 'waiting']);
  assert.equal(view.busy, true);
});

test('system and Node are shown together in the environment step', () => {
  for (const [platform, system] of [['darwin-arm64', 'macOS · arm64'], ['win32-x64', 'Windows · x64'], ['linux-x64', 'Linux · x64']]) {
    const checking = setupView(state({ platform, status: 'detecting-node', step: 0 }));
    assert.equal(checking.cards[0].description, `${system} · 需要 Node.js 22 或更高版本。`);
    const ready = setupView(state({ ...node, platform, status: 'detecting', step: 1 }));
    assert.equal(ready.cards[0].description, system);
    assert.equal(ready.cards[0].version, 'Node.js v22.0.0');
    assert.equal(ready.cards.length, 3);
    const failed = setupView(state({ platform, status: 'needs-node', step: 0, nodeError: 'Node.js not found' }));
    assert.equal(failed.cards[0].description, checking.cards[0].description);
    assert.equal(failed.cards[0].kind, 'error');
  }
});

test('environment does not invent a system or Node version while waiting for state', () => {
  const view = setupView(state({}));
  assert.equal(view.cards[0].description, '需要 Node.js 22 或更高版本。');
  assert.equal(view.cards[0].version, '');
});

test('missing or old Node does not imply that Claude Code or VSIX was checked', () => {
  for (const error of ['Node.js not found', 'Node.js 20 is too old']) {
    const view = setupView(state({ status: 'needs-node', step: 0, nodeError: error }));
    assert.deepEqual(view.cards.map(card => card.kind), ['error', 'waiting', 'waiting']);
    assert.equal(view.nodeReady, false);
    assert.equal(view.cards[0].label, '请安装');
    assert.deepEqual(view.cards.map(card => card.error || ''), [error, '', '']);
  }
});

test('Claude detection and failures stay on the second step', () => {
  const checking = setupView(state({ ...node, status: 'detecting', step: 1 }));
  assert.deepEqual(checking.cards.map(card => card.kind), ['ready', 'busy', 'waiting']);
  const failed = setupView(state({ ...node, status: 'error', step: 1, error: 'Claude not found' }));
  assert.deepEqual(failed.cards.map(card => card.kind), ['ready', 'error', 'waiting']);
  assert.equal(failed.cards[1].label, '请安装');
  assert.deepEqual(failed.cards.map(card => card.error || ''), ['', 'Claude not found', '']);
});

test('download, extraction and activation retain completed prerequisites', () => {
  for (const status of ['downloading', 'extracting', 'reloading']) {
    const view = setupView(state({ ...cli, status, step: 2 }));
    assert.deepEqual(view.cards.map(card => card.kind), ['ready', 'ready', 'busy']);
  }
  assert.equal(setupView(state({ ...cli, step: 2 }, 'activating')).busy, true);
});

test('VSIX errors do not reset ready steps', () => {
  const view = setupView(state({ ...cli, status: 'error', step: 2, error: 'Invalid VSIX' }));
  assert.deepEqual(view.cards.map(card => card.kind), ['ready', 'ready', 'error']);
  assert.deepEqual(view.cards.map(card => card.error || ''), ['', '', 'Invalid VSIX']);
});

test('ready and active states finish the plugin step without hiding other steps', () => {
  const ready = setupView(state({ ...cli, status: 'ready', step: 2, readyVersion: '2.1.312' }));
  assert.deepEqual(ready.cards.map(card => card.kind), ['ready', 'ready', 'ready']);
  assert.equal(ready.cards[2].version, '2.1.312');
  const active = setupView({ phase: 'active', pluginSetup: cli, extension: { version: '2.1.312' } });
  assert.equal(active.cards[2].version, '2.1.312');
  const updating = setupView(state({ ...cli, status: 'downloading', step: 2 }, 'active'));
  assert.equal(updating.cards[2].kind, 'busy');
});
