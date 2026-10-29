'use strict';

const Module = require('node:module');
const path = require('node:path');
const readline = require('node:readline');
const { Console } = require('node:console');
const { createPeer } = require('./rpc.cjs');
const { createVscodeApi } = require('./vscode-api.cjs');
const { SessionStatusTracker } = require('./session-status.cjs');
const tracker = new SessionStatusTracker();
const { SessionMetricsTracker } = require('./session-metrics.cjs');
const metrics = new SessionMetricsTracker();
const { SessionContextQueries } = require('./session-context.cjs');
const contextQueries = new SessionContextQueries(metrics, (id, message) => host?.receiveWebviewMessage(id, message));
let workspace;

function observe(id, message, fromWebview) {
  if (!workspace) return;
  // The real VSIX wraps outgoing protocol messages; leave the forwarded payload intact.
  if (!fromWebview && message?.type === 'from-extension') message = message.message;
  const usage = metrics.observe(id, message, fromWebview);
  if (usage) send({ kind: 'event', method: 'host.metrics', args: usage });
  contextQueries.observe(id, message, fromWebview);
  if (tracker.observe(id, workspace, message, fromWebview)) {
    send({ kind: 'event', method: 'host.sessions', args: { sessions: [...tracker.sessions.values()] } });
  }
  const request = message?.type === 'request' && message.request;
  if (fromWebview && request?.type === 'update_session_state' && !request.isFarewell && !request.panelNoLongerHosts && request.idConfirmed) {
    send({ kind: 'event', method: 'host.selection', args: { id, sessionId: request.sessionId } });
  }
}

// stdout is a framed protocol. Plugin logging must never corrupt it.
const send = message => {
  if (message.kind === 'call' && message.method === 'webview.post') {
    observe(message.args.id, message.args.message, false);
    const payload = message.args.message?.type === 'from-extension' ? message.args.message.message : message.args.message;
    // Host-owned query replies must not reach the plugin UI's request resolver.
    if (contextQueries.consume(message.args.id, payload)) {
      queueMicrotask(() => peer.receive({ kind: 'result', id: message.id, value: true }));
      return;
    }
  }
  if (message.kind === 'event' && message.method === 'webview.dispose') contextQueries.disconnect(message.args.id);
  process.stdout.write(`${JSON.stringify(message)}\n`);
};
global.console = new Console(process.stderr, process.stderr);
const peer = createPeer(send);
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  try {
    const message = JSON.parse(line);
    if (message.kind === 'event' && message.method === 'webview.receive') observe(message.args.id, message.args.message, true);
    void peer.receive(message);
  }
  catch (error) { console.error('Invalid host message:', error.message); }
});
let host, extension;
const originalLoad = Module._load;

peer.handle('activate', async options => {
  if (host) throw new Error('The extension is already loaded');
  workspace = options.workspacePath;
  host = await createVscodeApi(options, peer);
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode' && parent?.filename.startsWith(`${options.extensionPath}${path.sep}`)) return host.vscode;
    return originalLoad.call(this, request, parent, isMain);
  };
  extension = require(path.resolve(options.extensionPath, options.packageJSON.main));
  if (typeof extension.activate !== 'function') throw new Error('The VS Code extension (.vsix) entry does not export activate()');
  const exported = await extension.activate(host.context);
  host.context.extension.isActive = true;
  host.context.extension.exports = exported;
  return { commands: await host.vscode.commands.getCommands(), extensionId: host.context.extension.id };
});
peer.handle('command', async ({ command, args = [] }) => {
  if (!host?.context.extension.isActive) throw new Error('The extension has not activated');
  await host.vscode.commands.executeCommand(command, ...args);
});
peer.handle('settings.get', async () => {
  if (!host?.context.extension.isActive) throw new Error('The extension has not activated');
  return host.getSettings();
});
peer.handle('settings.update', async ({ key, value }) => {
  if (!host?.context.extension.isActive) throw new Error('The extension has not activated');
  return host.updateSetting(key, value);
});
peer.handle('shutdown', async () => {
  try { await extension?.deactivate?.(); }
  finally {
    await host?.dispose();
    Module._load = originalLoad;
    setImmediate(() => process.exit(0));
  }
});
input.on('close', () => { peer.dispose(); process.exit(0); });
process.on('unhandledRejection', error => peer.notify('host.error', { message: String(error), stack: error?.stack }));
process.on('uncaughtException', error => {
  peer.notify('host.error', { message: error.message, stack: error.stack });
  process.exit(1);
});
peer.notify('host.ready');
