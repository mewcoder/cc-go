'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function bridgeFixture(transcriptWidth) {
  const styles = new Map(), listeners = new Map(), delivered = [];
  let stream;
  const window = {
    addEventListener: (type, listener) => listeners.set(type, listener),
    dispatchEvent: event => delivered.push(event),
  };
  const document = {
    documentElement: { style: { setProperty: (key, value) => styles.set(key, value) } },
    addEventListener() {},
  };
  const context = {
    window, document, console, queueMicrotask,
    __claudeBridge: { base: '/view/test/', theme: 'dark', state: null, transcriptWidth },
    EventSource: class { constructor() { stream = this; } close() {} },
    MessageEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    location: { origin: 'http://127.0.0.1', href: 'http://127.0.0.1/view/test/' },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/bridge.js'), 'utf8'), context);
  window.addEventListener('message', () => {});
  return { styles, delivered, send: message => stream.onmessage({ data: JSON.stringify(message) }) };
}

test('each transcript preset initializes before plugin rendering and updates without reload', () => {
  for (const [preset, pixels] of [['narrow', 680], ['medium', 860], ['wide', 1040], [undefined, 680], ['invalid', 680]]) {
    const h = bridgeFixture(preset);
    assert.equal(h.styles.get('--claude-host-transcript-width'), `${pixels}px`);
    h.send({ _claudeHostTranscriptWidth: 'wide' });
    assert.equal(h.styles.get('--claude-host-transcript-width'), '1040px');
    h.send({ _claudeHostTranscriptWidth: 'narrow' });
    assert.equal(h.styles.get('--claude-host-transcript-width'), '680px');
    assert.equal(h.delivered.length, 0, 'Desktop appearance messages must not reach the plugin');
    h.send({ type: 'plugin-message' });
    assert.equal(h.delivered[0].data.type, 'plugin-message');
  }
});

test('settings use Claude Desktop copy and keep the host preference out of plugin configuration', () => {
  const shell = fs.readFileSync(require.resolve('../web/shell.js'), 'utf8');
  assert.match(shell, /title: 'Transcript Width'/);
  assert.match(shell, /description: 'Maximum width of the transcript and composer columns\.'/);
  assert.match(shell, /enumItemLabels: \['Narrow', 'Medium', 'Wide'\]/);
  assert.match(shell, /if \(key === 'desktop\.transcriptWidth'\) \{\s+control = window\.goWidthControl\.create\(document, \{ value: current, status, save: value => desktop\.setTranscriptWidth\(value\) \}\)/);
  const saveSetting = shell.slice(shell.indexOf('  async function saveSetting('), shell.indexOf('  function createSettingControl('));
  assert.doesNotMatch(saveSetting, /transcriptWidth|setTranscriptWidth/);
  const css = fs.readFileSync(require.resolve('../web/composer.css'), 'utf8');
  assert.match(css, /:root \[data-claude-host-composer-anchor\]/);
  assert.match(css, /:root \[class\*="inputWrapper_"\]/);
  assert.match(css, /:root \[class\*="messagesContainer_"\] > \*/);
  assert.equal((css.match(/max-width: var\(--claude-host-transcript-width, 680px\)/g) ?? []).length, 2);
});
