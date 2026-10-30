'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setupHarness(phase = 'setup', nativeExternalLinks = true, formatPath = value => value) {
  const elements = [];
  let focused;
  class Element {
    constructor(tag) {
      this.tagName = tag;
      this.children = [];
      this.attributes = {};
      this.dataset = {};
      this.textContent = '';
      this.hidden = false;
      this.disabled = false;
      this.checked = false;
      this.handlers = {};
      this.classList = { add() {}, toggle() {} };
      elements.push(this);
    }
    append(...children) {
      for (const child of children) {
        if (child.parent) child.parent.children = child.parent.children.filter(item => item !== child);
        child.parent = this;
        this.children.push(child);
      }
    }
    replaceChildren(...children) {
      for (const child of this.children) child.parent = null;
      this.children = [];
      this.append(...children);
    }
    insertBefore(child, reference) {
      this.append(child);
      this.children.pop();
      this.children.splice(this.children.indexOf(reference), 0, child);
    }
    before(child) { this.parent.insertBefore(child, this); }
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
      this.parent = null;
    }
    querySelector(selector) {
      for (const child of this.children) {
        if (selector.startsWith('.') ? child.className === selector.slice(1) : child.tagName === selector) return child;
        const found = child.querySelector(selector);
        if (found) return found;
      }
      return null;
    }
    get nextElementSibling() { return this.parent.children[this.parent.children.indexOf(this) + 1]; }
    get parentElement() { return this.parent; }
    setAttribute(key, value) { this.attributes[key] = value; }
    removeAttribute(key) { delete this.attributes[key]; }
    addEventListener(type, callback) { this.handlers[type] = callback; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    focus() { focused = this; }
  }
  const make = (tag, id, parent) => {
    const element = new Element(tag);
    element.id = id;
    parent?.append(element);
    return element;
  };
  const body = make('body');
  const sidebarHeader = make('div', 'sidebar-header', body);
  make('h2', '', sidebarHeader);
  make('button', 'add-workspace', sidebarHeader);
  const root = make('section', 'plugin-setup', body);
  const heading = make('div', '', root);
  heading.className = 'setup-heading';
  make('h1', 'setup-title', heading);
  make('ol', 'setup-steps', root);
  for (const id of ['setup-retry', 'setup-select-cli', 'setup-import', 'setup-copy-install', 'setup-back', 'setup-open-download']) {
    make('button', id, root);
  }
  const install = make('div', 'setup-install', root);
  make('p', '', install);
  const offline = make('details', '', root);
  offline.className = 'setup-offline';
  make('summary', '', offline);
  make('p', '', offline);
  make('progress', 'setup-progress', root);
  const calls = [];
  let projects = [{ path: '/projects/one' }, { path: '/projects/two' }, { path: '/projects/added' }];
  let failure, discovery, importing, onState;
  const state = {
    phase, pluginSetupOpen: phase === 'setup', setupCanStart: true,
    pluginSetup: { nodeVersion: 'v22.0.0', readyVersion: '2.1.312', runtimeReady: true, status: 'ready', step: 2 },
    workspaces: [{ path: '/projects/added' }],
  };
  const window = { desktop: {
    formatPath,
    nativeExternalLinks,
    onState(callback) { onState = callback; },
    checkPlugin: async () => calls.push('check'),
    checkPluginUpdates: async () => calls.push('check-update'),
    reloadPlugin: async () => calls.push('update-plugin'),
    cancelPluginDownload: async () => calls.push('cancel-download'),
    openPluginDownload: async () => calls.push('open-download'),
    historyProjects: async () => { if (discovery) return discovery; if (failure) throw failure; return projects; },
    importProjects: async paths => {
      if (failure) throw failure;
      calls.push(paths);
      if (importing) await importing;
      state.workspaces.push(...paths.map(path => ({ path })));
      onState(state);
      window.__goRenderSetup(state);
    },
    startUsing: async () => calls.push('start'),
  } };
  const byID = id => elements.find(element => element.id === id);
  const context = {
    window,
    document: { body, getElementById: byID, createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag) },
  };
  for (const file of ['history.js', 'setup.js']) {
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../web', file), 'utf8'), context);
  }
  onState(state);
  window.__goRenderSetup(state);
  return {
    byID, calls, state, window,
    render() { onState(state); window.__goRenderSetup(state); },
    get inputs() { return byID('history-project-list').children.map(label => label.children[0]); },
    get importButton() { return byID('history-import'); },
    get cancelButton() { return byID('history-cancel'); },
    get focused() { return focused; },
    set failure(value) { failure = value; },
    set projects(value) { projects = value; },
    set discovery(value) { discovery = value; },
    set importing(value) { importing = value; },
  };
}

test('setup only has short English labels without product copy or a manual-install explainer', () => {
  const h = setupHarness();
  const root = h.byID('plugin-setup');
  assert.equal(root.querySelector('.setup-product'), null);
  assert.equal(root.querySelector('.setup-subtitle'), null);
  assert.equal(h.byID('setup-title').textContent, 'Setup');
  assert.equal(h.byID('setup-start').textContent, 'Start');
  assert.equal(root.querySelector('.setup-offline').hidden, true);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../web/setup.js'), 'utf8'), /\p{Script=Han}/u);
});

test('history import moves to an accessible Workspace icon outside initialization', async () => {
  const h = setupHarness();
  assert.equal(h.byID('setup-steps').children.length, 2);
  assert.equal(h.byID('plugin-setup').querySelector('.history-dialog'), null);
  const opener = h.byID('import-history');
  assert.equal(opener.nextElementSibling.id, 'add-workspace');
  assert.equal(opener.attributes['aria-label'], 'Import Claude Code CLI sessions');
  assert.equal(opener.attributes['aria-haspopup'], 'dialog');
  assert.equal(opener.children[0].tagName, 'svg');
  assert.equal(opener.disabled, true);
  assert.equal(h.byID('setup-start').disabled, false);
  await h.byID('setup-start').onclick();
  assert.deepEqual(h.calls, ['start']);
  h.state.phase = 'active';
  h.state.pluginSetupOpen = false;
  h.render();
  assert.equal(opener.disabled, false);
});

test('environment card keeps system information visible after Node is ready', () => {
  const h = setupHarness();
  h.state.pluginSetup.platform = 'darwin-arm64';
  h.window.__goRenderSetup(h.state);
  const environment = h.byID('setup-steps').children[0];
  assert.equal(environment.querySelector('h2').textContent, 'Node.js');
  assert.equal(environment.querySelector('.setup-card-version').textContent, 'v22.0.0');
  const description = environment.querySelector('.setup-card-description');
  assert.equal(description.textContent, 'macOS · arm64');
  assert.equal(description.hidden, false);
});

test('ready plugins hide import while missing or invalid plugins allow manual recovery', () => {
  const h = setupHarness();
  assert.equal(h.byID('setup-select-cli').hidden, true);
  assert.equal(h.byID('setup-import').hidden, true);
  assert.equal(h.byID('setup-retry').hidden, true);

  h.state.pluginSetup = {
    nodeVersion: 'v22.0.0', readyVersion: '2.1.312', runtimeReady: true,
    status: 'error', step: 2, runtimeReady: false, error: 'Bundled runtime missing',
  };
  h.window.__goRenderSetup(h.state);
  assert.equal(h.byID('setup-select-cli').hidden, true);
  assert.equal(h.byID('setup-import').hidden, false);

  h.state.pluginSetup = { nodeVersion: 'v22.0.0', status: 'error', step: 1, error: 'Claude Code not found' };
  h.window.__goRenderSetup(h.state);
  assert.equal(h.byID('setup-select-cli').hidden, true);
  assert.equal(h.byID('setup-import').hidden, false);

  h.state.pluginSetup = { nodeVersion: 'v22.0.0', readyVersion: '2.1.312', runtimeReady: true, status: 'ready', step: 2 };
  h.window.__goRenderSetup(h.state);
  assert.equal(h.byID('setup-select-cli').hidden, true);
  assert.equal(h.byID('setup-import').hidden, true);
  for (const status of ['idle', 'cancelled']) {
    h.state.pluginSetup.status = status;
    h.render();
    assert.equal(h.byID('setup-import').hidden, true);
  }
});

test('every setup step has independent title, status and action cells', () => {
  const h = setupHarness();
  const steps = h.byID('setup-steps').children;
  assert.equal(steps.length, 2);
  assert.equal(steps[1].querySelector('h2').textContent, 'VSCode Plugin(.vsix)');
  assert.equal(steps[1].querySelector('h2').children.length, 0);
  assert.equal(steps[1].querySelector('.setup-card-description').textContent, '');
  assert.equal(steps[1].querySelector('.setup-card-description').hidden, true);
  for (const step of steps) {
    const body = step.querySelector('.setup-card-body');
    const header = body.querySelector('.setup-card-header');
    const status = body.querySelector('.setup-card-status');
    const actions = body.querySelector('.setup-actions');
    assert.equal(header.parent, body);
    assert.equal(status.parent, actions);
    assert.equal(actions.parent, body);
    assert.equal(header.children.length, step === steps[1] ? 2 : 1);
    assert.equal(header.children[0].tagName, 'h2');
  }
  for (const step of steps.slice(0, 3)) {
    const details = step.querySelector('.setup-card-details');
    assert.equal(step.querySelector('.setup-card-version').parent, details);
    assert.equal(step.querySelector('.setup-card-description').parent, details);
  }
});

test('plugin title stays plain text beside an accessible external-link icon', async () => {
  const h = setupHarness();
  const link = h.byID('setup-steps').children[1].querySelector('.setup-plugin-link');
  assert.equal(link.tagName, 'a');
  assert.equal(link.textContent, '');
  assert.equal(link.attributes['aria-label'], 'Open in Open VSX');
  assert.equal(link.parent, h.byID('setup-steps').children[1].querySelector('.setup-card-header'));
  assert.equal(link.querySelector('svg').attributes['aria-hidden'], 'true');
  assert.ok(link.querySelector('svg').querySelector('path'));
  assert.equal(link.href, 'https://open-vsx.org/extension/Anthropic/claude-code');
  assert.equal(link.target, undefined);
  assert.equal(link.rel, 'noopener noreferrer');
  let prevented = false;
  link.onclick({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(h.calls, ['open-download']);
});

test('browser preview follows the external link without invoking a missing native bridge', () => {
  const h = setupHarness('setup', false);
  const link = h.byID('setup-steps').children[1].querySelector('.setup-plugin-link');
  let prevented = false;
  link.onclick({ preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(link.href, 'https://open-vsx.org/extension/Anthropic/claude-code');
  assert.equal(link.target, '_blank');
  assert.deepEqual(h.calls, []);
});

test('native middle-click uses the external bridge, while right-click keeps its context menu', () => {
  const h = setupHarness();
  const link = h.byID('setup-steps').children[1].querySelector('.setup-plugin-link');
  let prevented = 0;
  link.handlers.auxclick({ type: 'auxclick', button: 1, preventDefault() { prevented++; } });
  link.handlers.auxclick({ type: 'auxclick', button: 2, preventDefault() { prevented++; } });
  assert.equal(prevented, 1);
  assert.deepEqual(h.calls, ['open-download']);
  const browser = setupHarness('setup', false);
  browser.byID('setup-steps').children[1].querySelector('.setup-plugin-link').handlers.auxclick({ type: 'auxclick', button: 1, preventDefault() { throw new Error('browser middle-click must follow href'); } });
});

test('native Cmd/Ctrl click opens the system browser once instead of navigating the shell', () => {
  for (const modifier of ['metaKey', 'ctrlKey']) {
    const h = setupHarness();
    const link = h.byID('setup-steps').children[1].querySelector('.setup-plugin-link');
    let prevented = false;
    link.onclick({ [modifier]: true, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.deepEqual(h.calls, ['open-download']);
  }
});

test('native link failures survive state polling until a new operation starts', async () => {
  const h = setupHarness();
  h.window.desktop.openPluginDownload = async () => { throw new Error('Unable to open browser'); };
  const card = h.byID('setup-steps').children[1];
  card.querySelector('.setup-plugin-link').onclick({ preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  h.render();
  assert.equal(card.querySelector('.setup-step-error').textContent, 'Unable to open browser');
  assert.equal(card.querySelector('.setup-step-error').hidden, false);
  h.state.pluginSetup.status = 'downloading';
  h.render();
  assert.equal(card.querySelector('.setup-step-error').hidden, true);
});

test('retry controls remain text buttons in the right-side actions, not version icons', async () => {
  const h = setupHarness();
  h.state.setupComplete = true;
  h.render();
  const steps = h.byID('setup-steps').children;
  for (const [index, step] of steps.entries()) {
    const actions = step.querySelector('.setup-actions');
    const button = actions.children.at(-1);
    assert.equal(button.textContent, index === 1 ? 'Check for Updates' : 'Retry');
    assert.equal(button.children.length, 0);
    assert.ok(button.attributes['aria-label']);
    assert.equal(actions.hidden, false);
    if (index > 0) await button.onclick();
  }
  assert.deepEqual(h.calls, ['check-update']);
  // Legacy retry text is normalized to the same label on subsequent shell renders.
  h.byID('setup-retry').textContent = 'Reload';
  h.render();
  assert.equal(h.byID('setup-retry').textContent, 'Retry');
  assert.equal(h.byID('setup-retry').hidden, true);
});

test('local reuse shows its source beside the version and hides the download link', () => {
  const h = setupHarness();
  h.state.pluginSetup.source = 'vscode';
  h.window.__goRenderSetup(h.state);
  const card = h.byID('setup-steps').children[1];
  const hint = card.querySelector('.setup-card-description');
  const link = card.querySelector('.setup-plugin-link');
  assert.equal(hint.textContent, 'From VS Code');
  assert.equal(hint.hidden, false);
  assert.equal(link.hidden, true);
  assert.equal(card.querySelector('.setup-card-version').textContent, '2.1.312');
  h.state.pluginSetup.source = '';
  h.window.__goRenderSetup(h.state);
  assert.equal(hint.hidden, true);
  assert.equal(link.hidden, false);
});

test('failed local reuse restores the download link even with a saved VS Code source', () => {
  const h = setupHarness();
  Object.assign(h.state.pluginSetup, { source: 'vscode', status: 'error', readyVersion: '', runtimeReady: false, error: 'Invalid VSIX' });
  h.render();
  const card = h.byID('setup-steps').children[1];
  assert.equal(card.querySelector('.setup-plugin-link').hidden, false);
  assert.equal(card.querySelector('.setup-card-description').hidden, true);
  assert.equal(h.byID('setup-import').hidden, false);
  assert.equal(card.querySelector('.setup-step-error').textContent, 'Invalid VSIX');
});

test('local import stays busy without a cancel button or concurrent actions', () => {
  const h = setupHarness();
  Object.assign(h.state.pluginSetup, { status: 'checking-installed', readyVersion: '', runtimeReady: false, step: 1, canCancel: false });
  h.render();
  const actions = h.byID('setup-steps').children[1].querySelector('.setup-actions');
  const cancel = actions.children.find(child => child.textContent === 'Cancel');
  const update = actions.children.at(-1);
  assert.equal(cancel.hidden, true);
  assert.equal(update.textContent, 'Checking VS Code…');
  assert.equal(update.disabled, true);
  assert.equal(h.byID('setup-import').hidden, true);
  assert.deepEqual(h.calls, []);
});

test('initial setup shows ready status instead of update controls or update messages', () => {
  const h = setupHarness();
  Object.assign(h.state.pluginSetup, { latestVersion: '2.1.312' });
  h.render();
  const card = h.byID('setup-steps').children[1];
  assert.equal(card.querySelector('.setup-actions').children.at(-1).hidden, true);
  assert.equal(card.querySelector('.setup-update-status').hidden, true);
  assert.equal(card.querySelector('.setup-card-status').textContent, 'Ready');
  assert.equal(card.querySelector('.setup-card-status').hidden, false);
  assert.equal(h.byID('setup-import').hidden, true);
  assert.equal(h.byID('setup-start').disabled, false);
});

test('download progress and phases remain visible in the plugin card and clear after completion', () => {
  const h = setupHarness();
  const card = h.byID('setup-steps').children[1];
  const progress = h.byID('setup-progress');
  const status = card.querySelector('.setup-download-status');
  h.state.setupCanStart = false;
  h.state.pluginSetup = { nodeVersion: 'v22.0.0', status: 'downloading', step: 1 };
  h.render();
  assert.equal(progress.parent, card.querySelector('.setup-card-body'));
  assert.equal(progress.hidden, false);
  assert.equal(status.hidden, true);
  assert.equal(h.byID('setup-start').disabled, true);
  const action = card.querySelector('.setup-actions').children.at(-1);
  assert.equal(action.textContent, 'Checking…');
  assert.equal(action.disabled, true);
  Object.assign(h.state.pluginSetup, { targetVersion: '2.1.312', received: 5 << 20, total: 10 << 20 });
  h.render();
  assert.equal(progress.max, 10 << 20);
  assert.equal(progress.value, 5 << 20);
  assert.match(status.textContent, /50%/);
  assert.equal(action.textContent, 'Downloading…');
  h.state.pluginSetup.total = 0;
  h.render();
  assert.match(status.textContent, /5\.0 MB/);
  for (const [setupStatus, expected] of [['extracting', 'Extracting…'], ['checking-runtime', 'Checking…']]) {
    h.state.pluginSetup.status = setupStatus;
    h.render();
    assert.equal(progress.hidden, true);
    assert.equal(status.hidden, true);
    assert.equal(action.textContent, expected);
  }
  Object.assign(h.state.pluginSetup, { status: 'ready', readyVersion: '2.1.312', runtimeReady: true });
  h.state.setupCanStart = true;
  h.render();
  assert.equal(status.hidden, true);
  assert.equal(progress.hidden, true);
  assert.equal(h.byID('setup-start').disabled, false);
  assert.equal(h.byID('setup-import').hidden, true);
  assert.equal(card.querySelector('.setup-actions').children.at(-1).hidden, true);
});

test('setup has no close button and Escape cannot dismiss prerequisites', () => {
  const h = setupHarness();
  const dialog = h.byID('plugin-setup').parent;
  assert.equal(dialog.querySelector('.setup-close'), null);
  assert.ok(dialog.querySelector('.setup-drag'));
  let prevented = false;
  dialog.handlers.cancel({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(dialog.open, true);
});

test('download can be cancelled and retried; import is only offered when idle', async () => {
  const h = setupHarness();
  const actions = h.byID('setup-steps').children[1].querySelector('.setup-actions');
  const cancel = actions.children.at(-2);
  const download = actions.children.at(-1);
  h.state.pluginSetup = { nodeVersion: 'v22.0.0', status: 'downloading', step: 1, canCancel: true };
  h.render();
  assert.equal(h.byID('setup-import').hidden, true);
  assert.equal(cancel.hidden, false);
  assert.equal(download.disabled, true);
  await cancel.onclick();
  assert.deepEqual(h.calls, ['cancel-download']);
  Object.assign(h.state.pluginSetup, { status: 'cancelled', canCancel: false });
  h.render();
  assert.equal(cancel.hidden, true);
  assert.equal(download.textContent, 'Retry');
  assert.equal(download.disabled, false);
  assert.equal(h.byID('setup-import').hidden, false);
  await download.onclick();
  assert.deepEqual(h.calls, ['cancel-download', 'check']);
});

test('after first setup the panel only shows plugin updates, not environment onboarding', () => {
  const h = setupHarness('active');
  h.state.pluginSetupOpen = true;
  h.state.setupComplete = true;
  h.render();
  assert.equal(h.byID('setup-title').textContent, 'Updates');
  assert.equal(h.byID('setup-steps').children[0].hidden, true);
  assert.equal(h.byID('plugin-setup').querySelector('.setup-product'), null);
  assert.equal(h.byID('setup-import').hidden, true);
  assert.equal(h.byID('setup-steps').children[1].querySelector('.setup-actions').children.at(-1).hidden, false);
  assert.equal(h.byID('setup-start').textContent, 'Close');
});

test('updates use explicit check, available, latest and apply states without duplicate version prose', async () => {
  const h = setupHarness('active');
  h.state.pluginSetupOpen = true;
  h.state.setupComplete = true;
  const card = h.byID('setup-steps').children[1];
  const action = card.querySelector('.setup-actions').children.at(-1);
  const status = card.querySelector('.setup-update-status');
  Object.assign(h.state.pluginSetup, { latestVersion: '2.1.312' });
  h.render();
  assert.equal(action.textContent, 'Check for Updates');
  assert.equal(action.attributes['aria-label'], 'Check for Updates');
  assert.equal(status.textContent, 'Latest');
  assert.equal(status.parent, card.querySelector('.setup-card-details'));
  h.state.pluginSetup.checkingUpdate = true;
  h.render();
  assert.equal(action.textContent, 'Checking for Updates…');
  assert.equal(action.disabled, true);
  h.state.pluginSetup.checkingUpdate = false;
  Object.assign(h.state.pluginSetup, { latestVersion: '2.1.313', updateAvailable: true });
  h.render();
  assert.equal(action.textContent, 'Update');
  assert.equal(status.textContent, '2.1.313 available');
  await action.onclick();
  assert.deepEqual(h.calls, ['update-plugin']);
  h.state.phase = 'setup';
  Object.assign(h.state.pluginSetup, { readyVersion: '2.1.313', updateAvailable: false });
  h.render();
  assert.equal(h.byID('setup-start').textContent, 'Apply');
  h.state.pluginSetup.updateError = 'Network unavailable';
  h.render();
  assert.equal(status.textContent, 'Failed: Network unavailable');
  assert.equal(status.attributes.role, 'alert');
});

test('a failed first download keeps its error visible even without a version', () => {
  const h = setupHarness();
  h.state.pluginSetup = { nodeVersion: 'v22.0.0', status: 'cancelled', step: 1, updateError: 'Network unavailable' };
  h.render();
  const card = h.byID('setup-steps').children[1];
  assert.equal(card.querySelector('.setup-card-details').hidden, false);
  assert.equal(card.querySelector('.setup-update-status').hidden, false);
  assert.equal(card.querySelector('.setup-update-status').textContent, 'Failed: Network unavailable');
});

test('plugin install can retry a failed first download without a separate runtime action', async () => {
  const h = setupHarness();
  h.state.pluginSetup = { nodeVersion: 'v22.0.0', status: 'error', step: 1, error: 'Network unavailable' };
  h.render();
  const card = h.byID('setup-steps').children[1];
  const action = card.querySelector('.setup-actions').children.at(-1);
  assert.equal(action.textContent, 'Retry');
  assert.equal(action.disabled, false);
  await action.onclick();
  assert.deepEqual(h.calls, ['check']);
});

test('failed activation and final prepare saves keep an offline-capable Retry visible', async () => {
  for (const setupComplete of [false, true]) {
    const h = setupHarness('error');
    h.state.pluginSetupOpen = true;
    h.state.setupComplete = setupComplete;
    h.state.setupCanStart = false;
    Object.assign(h.state.pluginSetup, { status: 'error', error: 'Activation or save failed', checkingUpdate: true });
    h.render();
    const card = h.byID('setup-steps').children[1];
    const action = card.querySelector('.setup-actions').children.at(-1);
    assert.equal(action.textContent, 'Retry');
    assert.equal(action.hidden, false);
    assert.equal(action.disabled, false);
    await action.onclick();
    assert.deepEqual(h.calls, ['check']);
    h.state.phase = 'setup';
    h.state.setupCanStart = true;
    Object.assign(h.state.pluginSetup, { status: 'ready', error: '', checkingUpdate: false });
    h.render();
    assert.equal(h.byID('setup-start').disabled, false);
    assert.equal(h.byID('setup-start').textContent, setupComplete ? 'Apply' : 'Start');
    await h.byID('setup-start').onclick();
    assert.deepEqual(h.calls, ['check', 'start']);
  }
});

test('cancelled updates retry the download rather than tearing down the active cached host', async () => {
  for (const updateAvailable of [false, true]) {
    const h = setupHarness('active');
    Object.assign(h.state, { setupComplete: true, pluginSetupOpen: true });
    Object.assign(h.state.pluginSetup, { status: 'cancelled', runtimeReady: true, updateAvailable, checkingUpdate: true });
    h.render();
    const action = h.byID('setup-steps').children[1].querySelector('.setup-actions').children.at(-1);
    assert.equal(action.textContent, 'Retry');
    assert.equal(action.hidden, false);
    assert.equal(action.disabled, false);
    await action.onclick();
    assert.deepEqual(h.calls, ['update-plugin']);
    assert.equal(h.byID('setup-start').textContent, 'Close');
  }
});

test('setup save warnings are nonfatal, survive polling and clear after a successful save', () => {
  const h = setupHarness('active');
  Object.assign(h.state, { setupComplete: true, pluginSetupOpen: true });
  h.state.pluginSetup.saveError = 'Disk full';
  h.render();
  const card = h.byID('setup-steps').children[1];
  const warning = card.querySelector('.setup-save-warning');
  assert.equal(h.byID('plugin-setup').hidden, false);
  assert.equal(h.byID('plugin-setup').parent.open, true);
  assert.equal(warning.attributes.role, 'status');
  assert.equal(warning.hidden, false);
  assert.equal(warning.title, 'Disk full');
  assert.match(warning.textContent, /Settings not saved.*restart/);
  assert.equal(card.querySelector('.setup-step-error').hidden, true);
  assert.equal(h.byID('setup-start').disabled, false);
  assert.equal(h.byID('setup-start').textContent, 'Close');
  h.render();
  assert.equal(warning.hidden, false);
  h.state.pluginSetup.saveError = '';
  h.render();
  assert.equal(warning.hidden, true);
});

test('CLI sessions import is compact and has no description or selection instructions', async () => {
  const h = setupHarness('active');
  await h.byID('import-history').onclick();
  assert.equal(h.byID('history-title').textContent, 'Import Claude Code CLI sessions');
  assert.equal(h.cancelButton.textContent, 'Cancel');
  assert.equal(h.importButton.textContent, 'Import');
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '../web/history.js'), 'utf8'), /\p{Script=Han}/u);
  assert.equal(h.byID('history-description'), undefined);
  assert.equal(h.byID('history-dialog').attributes['aria-describedby'], undefined);
  assert.equal(h.byID('history-status').hidden, true);
  h.inputs[0].checked = true;
  h.inputs[0].onchange();
  assert.equal(h.byID('history-status').hidden, true);
  assert.equal(h.inputs[0].parent.title, '/projects/one');
  assert.equal(h.byID('history-dialog').querySelector('.history-added'), null);
  assert.equal(h.importButton.nextElementSibling, h.cancelButton);
  const pathValue = h.inputs[0].nextElementSibling.children[0];
  assert.equal(pathValue.tagName, 'bdi');
  assert.equal(pathValue.attributes.dir, 'ltr');
  assert.equal(pathValue.textContent, '/projects/one');
  const css = fs.readFileSync(path.join(__dirname, '../web/host.css'), 'utf8');
  assert.match(css, /\.history-dialog \{[^}]*width: min\(420px, calc\(100vw - 24px\)\)/);
  assert.match(css, /\.history-project-path \{[^}]*text-overflow: ellipsis; white-space: nowrap;/);
  assert.match(css, /\.history-project-path \{[^}]*direction: rtl; text-align: left;/);
});

test('history path labels use uppercase drives but import retains the original path', async () => {
  const raw = 'd:\\Code\\MyProject';
  const h = setupHarness('active', true, value => value.replace(/^d:/, 'D:'));
  h.projects = [{ path: raw }];
  await h.byID('import-history').onclick();
  const input = h.inputs[0];
  assert.equal(input.parent.title, 'D:\\Code\\MyProject');
  assert.equal(input.nextElementSibling.children[0].textContent, 'D:\\Code\\MyProject');
  assert.equal(input.value, raw);
  input.checked = true;
  input.onchange();
  await h.importButton.onclick();
  assert.deepEqual(Array.from(h.calls[0]), [raw]);
  await h.byID('import-history').onclick();
  assert.equal(h.inputs.length, 0);
});

test('history picker imports multiple projects and omits already added projects', async () => {
  const h = setupHarness('active');
  await h.byID('import-history').onclick();
  assert.equal(h.inputs.length, 2);
  assert.equal(h.importButton.disabled, true);
  assert.equal(h.inputs.some(input => input.value === '/projects/added'), false);
  for (const input of h.inputs.slice(0, 2)) { input.checked = true; input.onchange(); }
  assert.equal(h.importButton.disabled, false);
  await h.importButton.onclick();
  assert.deepEqual(Array.from(h.calls[0]), ['/projects/one', '/projects/two']);
  assert.equal(h.byID('history-dialog').open, false);
  assert.equal(h.focused.id, 'import-history');
  assert.equal(h.byID('setup-start').disabled, false);
  await h.byID('import-history').onclick();
  assert.equal(h.inputs.length, 0);
  assert.equal(h.importButton.disabled, true);
  assert.equal(h.byID('history-status').textContent, 'No CLI sessions available to import');
});

test('projects added elsewhere disappear while the import dialog is open', async () => {
  const h = setupHarness('active');
  await h.byID('import-history').onclick();
  h.inputs[0].checked = true;
  h.inputs[0].onchange();
  h.state.workspaces.push({ path: '/projects/one' });
  h.render();
  assert.equal(h.inputs.length, 1);
  assert.equal(h.inputs[0].value, '/projects/two');
  assert.equal(h.importButton.disabled, true);
  h.state.workspaces.push({ path: '/projects/two' });
  h.render();
  assert.equal(h.inputs.length, 0);
  assert.equal(h.byID('history-status').hidden, false);
});

test('select all toggles available projects and follows individual selections', async () => {
  const h = setupHarness('active');
  await h.byID('import-history').onclick();
  const selectAll = h.byID('history-select-all');
  assert.equal(selectAll.hidden, false);
  assert.equal(selectAll.disabled, false);
  assert.equal(selectAll.textContent, 'Select All');
  selectAll.onclick();
  assert.ok(h.inputs.every(input => input.checked));
  assert.equal(selectAll.textContent, 'Deselect All');
  assert.equal(h.importButton.disabled, false);
  selectAll.onclick();
  assert.ok(h.inputs.every(input => !input.checked));
  assert.equal(selectAll.textContent, 'Select All');
  assert.equal(h.importButton.disabled, true);
  h.inputs[0].checked = true;
  h.inputs[0].onchange();
  assert.equal(selectAll.textContent, 'Select All');
  selectAll.onclick();
  h.inputs[1].checked = false;
  h.inputs[1].onchange();
  assert.equal(selectAll.textContent, 'Select All');
  selectAll.onclick();
  await h.importButton.onclick();
  assert.deepEqual(Array.from(h.calls[0]), ['/projects/one', '/projects/two']);
  assert.equal(selectAll.hidden, true);
  assert.equal(selectAll.disabled, true);
});

test('select all is unavailable during discovery and import', async () => {
  const h = setupHarness('active');
  const selectAll = h.byID('history-select-all');
  let resolveDiscovery;
  h.discovery = new Promise(done => { resolveDiscovery = done; });
  const discovering = h.byID('import-history').onclick();
  assert.equal(h.byID('history-status').textContent, 'Loading...');
  assert.equal(selectAll.hidden, true);
  assert.equal(selectAll.disabled, true);
  selectAll.onclick();
  resolveDiscovery([{ path: '/projects/one' }, { path: '/projects/added' }]);
  await discovering;
  assert.equal(h.inputs.length, 1);
  selectAll.onclick();
  let resolveImport;
  h.importing = new Promise(done => { resolveImport = done; });
  const importing = h.importButton.onclick();
  assert.equal(h.importButton.textContent, 'Importing...');
  assert.equal(selectAll.disabled, true);
  selectAll.onclick();
  assert.equal(h.inputs[0].checked, true);
  resolveImport();
  await importing;
});

test('cancelling, empty history and failed import stay separate from setup', async () => {
  const h = setupHarness('active');
  await h.byID('import-history').onclick();
  h.cancelButton.onclick();
  assert.equal(h.byID('history-dialog').open, false);
  assert.equal(h.calls.length, 0);
  h.projects = [];
  await h.byID('import-history').onclick();
  assert.equal(h.inputs.length, 0);
  assert.equal(h.importButton.disabled, true);
  assert.equal(h.byID('history-status').textContent, 'No CLI sessions available to import');
  h.cancelButton.onclick();
  h.projects = [{ path: '/projects/one' }];
  await h.byID('import-history').onclick();
  h.inputs[0].checked = true;
  h.inputs[0].onchange();
  h.failure = new Error('Project unavailable');
  await h.importButton.onclick();
  assert.equal(h.byID('history-dialog').open, true);
  assert.equal(h.byID('history-error').textContent, 'Project unavailable');
  assert.equal(h.byID('setup-start').disabled, false);
  assert.equal(h.importButton.disabled, false);
});

test('discovery errors can be dismissed with Escape and retried', async () => {
  const h = setupHarness('active');
  h.failure = new Error('Cannot read history');
  await h.byID('import-history').onclick();
  assert.equal(h.byID('history-error').hidden, false);
  assert.equal(h.byID('history-error').textContent, 'Cannot read history');
  let prevented = false;
  h.byID('history-dialog').handlers.cancel({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(h.byID('history-dialog').open, false);
  h.failure = undefined;
  await h.byID('import-history').onclick();
  assert.equal(h.byID('history-error').hidden, true);
  assert.equal(h.inputs.length, 2);
});

test('closing discovery ignores stale results after the dialog reopens', async () => {
  const h = setupHarness('active');
  let resolve;
  h.discovery = new Promise(done => { resolve = done; });
  const first = h.byID('import-history').onclick();
  assert.equal(h.byID('history-dialog').open, true);
  assert.equal(h.importButton.disabled, true);
  h.cancelButton.onclick();
  assert.equal(h.byID('history-dialog').open, false);
  h.discovery = undefined;
  await h.byID('import-history').onclick();
  resolve([{ path: '/stale/project' }]);
  await first;
  assert.equal(h.inputs.length, 2);
  assert.equal(h.inputs.some(input => input.value === '/stale/project'), false);
  assert.equal(h.byID('history-dialog').open, true);
});

test('import cannot be submitted twice or dismissed before it completes', async () => {
  const h = setupHarness('active');
  await h.byID('import-history').onclick();
  h.inputs[0].checked = true;
  h.inputs[0].onchange();
  let resolve;
  h.importing = new Promise(done => { resolve = done; });
  const pending = h.importButton.onclick();
  assert.equal(h.cancelButton.disabled, true);
  await h.importButton.onclick();
  h.cancelButton.onclick();
  assert.equal(h.byID('history-dialog').open, true);
  assert.equal(h.calls.length, 1);
  resolve();
  await pending;
  assert.equal(h.byID('history-dialog').open, false);
});

test('opening initialization closes history without blocking Start', async () => {
  const h = setupHarness('active');
  await h.byID('import-history').onclick();
  h.state.pluginSetupOpen = true;
  h.render();
  assert.equal(h.byID('history-dialog').open, false);
  assert.equal(h.byID('import-history').disabled, true);
  assert.equal(h.byID('setup-start').disabled, false);
});
