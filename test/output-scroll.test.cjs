'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../web/shell.js'), 'utf8');

function fixture() {
  const panel = { hidden: true };
  let text = '', scrollTop = 0;
  const output = {
    get textContent() { return text; },
    set textContent(value) { text = value; },
    get scrollHeight() { return panel.hidden ? 0 : text.split('\n').length * 20; },
    get clientHeight() { return panel.hidden ? 0 : 100; },
    get scrollTop() { return scrollTop; },
    set scrollTop(value) { scrollTop = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); },
  };
  const context = { ui: { logPanel: panel, logOutput: output }, sidebarInitialized: true, logsOpen: false, state: {} };
  // Exercise the real log update and state acceptance blocks without the rest of the shell DOM.
  const logStart = source.indexOf('    const logs = Array.isArray(state.logs)');
  const logEnd = source.indexOf('\n  async function setLogsOpen(', logStart);
  const acceptStart = source.indexOf('  function acceptState(');
  const acceptEnd = source.indexOf('\n  ui.addWorkspace.addEventListener(', acceptStart);
  const formatterStart = source.indexOf('  function formatOutputLog(');
  const formatterEnd = source.indexOf('\n  function refreshSessionTimes(', formatterStart);
  vm.runInNewContext(source.slice(formatterStart, formatterEnd), context);
  vm.runInNewContext('function render() { ui.logPanel.hidden = !logsOpen;\n'
    + source.slice(logStart, logEnd) + source.slice(acceptStart, acceptEnd), context);
  const logs = Array.from({ length: 30 }, (_, index) => `Log ${index}`);
  return { panel, output, logs,
    update(open, values = logs) { context.acceptState({ logsOpen: open, logs: values }); },
    atBottom() { return output.scrollTop === output.scrollHeight - output.clientHeight; },
  };
}

test('VSIX Output opens at the bottom even when its unchanged logs arrived while hidden', () => {
  const h = fixture();
  h.update(false);
  assert.equal(h.output.scrollTop, 0);
  h.update(true);
  assert.equal(h.panel.hidden, false);
  assert.equal(h.atBottom(), true);
});

test('VSIX Output starts at the bottom when the initial snapshot already has it open', () => {
  const h = fixture();
  h.update(true);
  assert.equal(h.atBottom(), true);
});

test('reopening Output returns to the bottom without changing its contents', () => {
  const h = fixture();
  h.update(true);
  h.output.scrollTop = 0;
  h.update(false);
  h.update(true);
  assert.equal(h.atBottom(), true);
  assert.equal(h.output.textContent, h.logs.join('\n'));
});

test('new output follows the bottom but does not interrupt reading earlier logs', () => {
  const h = fixture();
  h.update(true);
  h.update(true, [...h.logs, 'Next log']);
  assert.equal(h.atBottom(), true);
  h.output.scrollTop = 100;
  h.update(true, [...h.logs, 'Next log', 'Another log']);
  assert.equal(h.output.scrollTop, 100);
  h.update(true);
  assert.equal(h.output.scrollTop, 100);
});
