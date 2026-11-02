'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../web/shell.js'), 'utf8');

function fixture() {
  const flags = new Map();
  let subscriber;
  const context = {
    state: { phase: 'active', version: '2.1.316', extension: { id: 'Anthropic.claude-code' }, logs: [] },
    ui: {
      connectionLabel: {},
      connectionStatus: { classList: { toggle: (key, value) => flags.set(key, value) }, setAttribute() {} },
      logOutput: { textContent: '', scrollTop: 0, scrollHeight: 0, clientHeight: 0 },
    },
    pending: new Set(), revision: 0,
    desktop: { onAction() {}, onState(fn) { subscriber = fn; }, getState: async () => { throw new Error('Failed to fetch'); } },
  };
  const declarations = source.slice(source.indexOf('  const actionLogs = [];'), source.indexOf('  function createWorkspaceNode('));
  const formatting = source.slice(source.indexOf('  function formatOutputLog('), source.indexOf('  function refreshSessionTimes('));
  const status = source.slice(source.indexOf('    const connection = phase'), source.indexOf('\n  async function setLogsOpen('));
  const initialize = source.slice(source.indexOf('  async function initialize()'), source.indexOf('\n  const timeRefresh ='));
  vm.runInNewContext(declarations + formatting + `
    function render() {
      const { phase, version, error = '', label = '' } = state;
      const extensionId = state.extension?.id || 'Anthropic.claude-code';
      ${status}
    function acceptState(next) { state = next; render(); }
    ${initialize}
  `, context);
  context.render();
  return { context, flags, receive(state) { subscriber(state); } };
}

test('a failed action preserves the connected version and records its exact error in Output', async () => {
  const { context, flags } = fixture();
  await context.runCommand('plugin', async () => { throw new Error('send or clear unsent drafts'); });
  assert.equal(context.ui.connectionLabel.textContent, '2.1.316');
  assert.equal(flags.get('has-error'), false);
  assert.equal(context.ui.connectionStatus.title, 'Anthropic.claude-code · 2.1.316');
  assert.match(context.ui.logOutput.textContent, /\[error\] plugin: send or clear unsent drafts/);
  await context.runCommand('theme', async () => {});
  assert.match(context.ui.logOutput.textContent, /unsent drafts/);
});

test('a recovered startup request does not leave the sidebar in an action failure state', async () => {
  const h = fixture();
  await h.context.initialize();
  assert.equal(h.context.ui.connectionLabel.textContent, 'Connection failed');
  h.receive({ phase: 'active', version: '2.1.316', logs: [] });
  assert.equal(h.context.ui.connectionLabel.textContent, '2.1.316');
  assert.equal(h.flags.get('has-error'), false);
  assert.match(h.context.ui.logOutput.textContent, /\[error\] startup: Failed to fetch/);
});

test('client action errors remain bounded and merge with host logs in time order', async () => {
  const { context } = fixture();
  for (let index = 0; index < 55; index++) {
    await context.runCommand('test', async () => { throw new Error(`failure-${index}.`); });
  }
  context.state.logs = ['2000-01-01T00:00:00Z [info] earlier', '2099-01-01T00:00:00Z [info] later'];
  context.render();
  const output = context.ui.logOutput.textContent;
  assert.equal((output.match(/\[error\]/g) || []).length, 50);
  assert.doesNotMatch(output, /failure-0\./);
  assert.match(output, /failure-54\./);
  assert.ok(output.indexOf('earlier') < output.indexOf('failure-5.'));
  assert.ok(output.indexOf('later') > output.indexOf('failure-54.'));
});
