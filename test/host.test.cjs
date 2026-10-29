const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { JsonStore } = require('../runtime/host-storage.cjs');
const { createPeer } = require('../runtime/rpc.cjs');
const { createVscodeApi } = require('../runtime/vscode-api.cjs');

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-host-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function host(t, properties = { 'claudeCode.autosave': { default: true } }) {
  const directory = await temporary(t);
  const notices = [];
  const peer = { events: new EventEmitter(), notify: (name, value) => notices.push({ name, value }), call: async () => true };
  const result = await createVscodeApi({
    extensionPath: directory, workspacePath: directory, storageRoot: path.join(directory, 'state'), machineId: 'test-machine',
    packageJSON: { publisher: 'Test', name: 'extension', version: '1.0.0', contributes: { configuration: { properties } } },
  }, peer);
  t.after(() => result.dispose());
  return { ...result, peer, notices, directory };
}

test('storage serializes writes and preserves falsy values and deletion', async t => {
  const directory = await temporary(t);
  const file = path.join(directory, 'nested', 'state.json');
  const store = new JsonStore(file);
  await Promise.all([store.update('value', 1), store.update('value', false), store.update('empty', ''), store.update('deleted', 1), store.update('deleted', undefined)]);
  const saved = new JsonStore(file);
  assert.equal(saved.get('value', true), false);
  assert.equal(saved.get('empty', 'fallback'), '');
  assert.equal(saved.get('deleted', 'fallback'), 'fallback');
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test('RPC propagates results, errors, notifications and disconnects', async () => {
  let left, right;
  left = createPeer(message => queueMicrotask(() => right.receive(message)));
  right = createPeer(message => queueMicrotask(() => left.receive(message)));
  right.handle('add', ({ a, b }) => a + b);
  assert.equal(await left.call('add', { a: 2, b: 3 }), 5);
  await assert.rejects(left.call('missing'), /Unsupported host RPC/);
  let notification;
  right.events.once('changed', value => notification = value);
  left.notify('changed', 3);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(notification, 3);
  right.handle('pending', () => new Promise(() => {}));
  const pending = left.call('pending');
  left.dispose();
  await assert.rejects(pending, /disconnected/);
  right.dispose();
});

test('configuration uses declared defaults and persists updates with change events', async t => {
  const { vscode } = await host(t);
  const config = vscode.workspace.getConfiguration('claudeCode');
  assert.equal(config.get('autosave'), true);
  let changed;
  const subscription = vscode.workspace.onDidChangeConfiguration(event => changed = event);
  await config.update('autosave', false, vscode.ConfigurationTarget.Global);
  assert.equal(config.get('autosave'), false);
  assert.equal(changed.affectsConfiguration('claudeCode'), true);
  assert.equal(changed.affectsConfiguration('other'), false);
  assert.equal(config.inspect('autosave').globalValue, false);
  subscription.dispose();
});

test('desktop defaults preserve explicit overrides and unrelated manifest defaults', async t => {
  const defaults = {
    allowDangerouslySkipPermissions: true,
    hideOnboarding: true,
    disableLoginPrompt: true,
  };
  const properties = Object.fromEntries(Object.entries(defaults).map(([key, value]) => [
    `claudeCode.${key}`, { type: typeof value, default: typeof value === 'boolean' ? false : 'default' },
  ]));
  properties['claudeCode.initialPermissionMode'] = { type: 'string' };
  properties['claudeCode.focusView'] = { type: 'boolean', default: false };
  const { vscode, getSettings, updateSetting } = await host(t, properties);
  const config = vscode.workspace.getConfiguration('claudeCode');
  for (const [key, value] of Object.entries(defaults)) {
    const override = typeof value === 'boolean' ? false : 'default';
    assert.equal(config.get(key), value);
    assert.equal(config.inspect(key).defaultValue, value);
    assert.equal(getSettings().properties[`claudeCode.${key}`].default, value);
    assert.equal(getSettings().values[`claudeCode.${key}`], value);
    assert.equal(properties[`claudeCode.${key}`].default, override, 'Keep the extension manifest unchanged');
    await updateSetting(`claudeCode.${key}`, override);
    assert.equal(config.get(key), override, 'An explicit global value overrides the default');
    assert.equal(getSettings().values[`claudeCode.${key}`], override);
    await config.update(key, undefined, vscode.ConfigurationTarget.Global);
    assert.equal(config.get(key), value, 'Resetting restores the desktop default');
    await config.update(key, override, vscode.ConfigurationTarget.Workspace);
    assert.equal(config.get(key), override, 'An explicit workspace value overrides the default');
  }
  assert.equal(config.get('initialPermissionMode'), undefined);
  assert.equal(config.get('focusView'), false);
});

test('workspace filesystem reads actual data and supports registered providers', async t => {
  const { vscode, directory } = await host(t);
  const file = vscode.Uri.file(path.join(directory, 'sample.txt'));
  await vscode.workspace.fs.writeFile(file, Buffer.from('actual content'));
  assert.equal(Buffer.from(await vscode.workspace.fs.readFile(file)).toString(), 'actual content');
  assert.equal((await vscode.workspace.fs.stat(file)).size, 14);
  const provider = vscode.workspace.registerFileSystemProvider('memory', { readFile: async () => Buffer.from('provided') });
  assert.equal(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.parse('memory:/document'))).toString(), 'provided');
  provider.dispose();
  await assert.rejects(vscode.workspace.fs.readFile(vscode.Uri.parse('memory:/document')));
});

test('webviews forward native messages and maintain tab lifecycle', async t => {
  const { vscode, peer, notices } = await host(t);
  const panel = vscode.window.createWebviewPanel('native', 'Native plugin', 1, {});
  panel.webview.html = '<html>native extension document</html>';
  let received;
  panel.webview.onDidReceiveMessage(value => received = value);
  peer.events.emit('webview.receive', { id: panel.id, message: { type: 'ready' } });
  assert.deepEqual(received, { type: 'ready' });
  assert.equal(vscode.window.tabGroups.activeTabGroup.activeTab.label, 'Native plugin');
  assert.ok(notices.some(notice => notice.name === 'webview.html' && notice.value.html.includes('native extension document')));
  const stylesheet = panel.webview.asWebviewUri(vscode.Uri.file('/extension/webview/index.css'));
  assert.equal(new URL('fonts/font.woff2', stylesheet.toString()).pathname, '/extension/webview/fonts/font.woff2');
  assert.equal(await panel.webview.postMessage({ type: 'reply' }), true);
  panel.dispose();
  assert.equal(vscode.window.tabGroups.activeTabGroup.tabs.length, 0);
});

test('unsupported commands and editor services fail instead of claiming success', async t => {
  const { vscode } = await host(t);
  await assert.rejects(vscode.commands.executeCommand('vscode.diff'), /Unsupported VS Code host capability/);
  assert.throws(() => vscode.window.createTerminal(), /Unsupported VS Code host capability/);
  assert.throws(() => vscode.workspace.applyEdit(new vscode.WorkspaceEdit()), /Unsupported VS Code host capability/);
});
