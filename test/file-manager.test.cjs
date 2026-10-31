const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createVscodeApi } = require('../runtime/vscode-api.cjs');

test('revealFileInOS forwards local paths intact and propagates native errors', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-go-reveal-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const calls = [];
  let failure;
  const host = await createVscodeApi({
    extensionPath: directory, workspacePath: directory, storageRoot: path.join(directory, 'state'),
    packageJSON: {},
  }, { events: new EventEmitter(), notify() {}, call: async (method, args) => {
    calls.push({ method, args });
    if (failure) throw failure;
  } });
  t.after(() => host.dispose());
  const { commands, Uri } = host.vscode;
  const memory = path.join(os.tmpdir(), 'project with spaces;literal', 'memory', 'MEMORY #1%.md');
  await commands.executeCommand('revealFileInOS', Uri.file(memory));
  // VS Code file URIs normalize Windows drive letters to lowercase.
  const expectedPath = process.platform === 'win32' ? memory.replace(/^[A-Z]:/, drive => drive.toLowerCase()) : memory;
  assert.deepEqual(calls, [{ method: 'file.reveal', args: { path: expectedPath } }]);
  for (const uri of [undefined, Uri.parse('https://example.com/memory'), Uri.parse('file://remote/share/memory')]) {
    await assert.rejects(commands.executeCommand('revealFileInOS', uri), /local file URI/);
  }
  assert.equal(calls.length, 1);
  failure = new Error('file manager unavailable');
  await assert.rejects(commands.executeCommand('revealFileInOS', Uri.file(memory)), failure);
});
