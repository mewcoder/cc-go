'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../web/desktop.js'), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture(platform = 'darwin') {
  let now = 100000, blocked, projectResult;
  const events = new Map(), documentEvents = new Map(), calls = [], seen = [];
  const state = { phase: 'active', workspace: '/one', views: [], windowVisible: true };
  const document = { body: null, hidden: false, documentElement: { style: { setProperty() {} } }, getElementById: () => null,
    addEventListener: (name, callback) => documentEvents.set(name, callback) };
  const window = { __goDesktopConfig: { platform, token: 'fixture' },
    addEventListener: (name, callback) => events.set(name, callback) };
  vm.runInNewContext(source, { window, document, Date: { now: () => now },
    fetch: async (url, options) => {
      const body = options.body && JSON.parse(options.body);
      calls.push({ url, body });
      if (url === '/api/project' && blocked) await blocked;
      const data = url === '/api/state' ? { ...state }
        : url === '/api/project' ? projectResult ?? { path: body.workspace, branch: 'main', gitStatus: 'branch' } : { ok: true };
      return { ok: true, text: async () => JSON.stringify(data) };
    }, console: { error() {} },
  });
  window.desktop.onState(value => seen.push(value));
  return { window, document, state, seen,
    advance: value => { now += value; },
    async refresh() { await window.desktop.getState(); await settle(); },
    async event(name, native = true) { (native ? events : documentEvents).get(name)?.(); await settle(); },
    set blocked(value) { blocked = value; },
    set projectResult(value) { projectResult = value; },
    git: () => calls.filter(call => call.url === '/api/project'),
  };
}

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`${platform}: idle state polling never schedules Git, even after hours`, async () => {
    const h = fixture(platform);
    await h.refresh();
    assert.equal(h.git().length, 1);
    for (let i = 0; i < 30; i++) { h.advance(3600000); await h.refresh(); }
    assert.equal(h.git().length, 1);
    h.state.projectRevision = 1;
    await h.refresh();
    assert.equal(h.git().length, 2);
    for (let i = 0; i < 5; i++) await h.refresh();
    assert.equal(h.git().length, 2);
    await h.window.desktop.refreshGit();
    assert.equal(h.git().length, 3);
    assert.equal(h.git()[2].body.force, true);
  });
}

test('Git pauses in setup, Settings, hidden documents and native-hidden windows', async () => {
  for (const mode of ['setup', 'settings', 'document-hidden', 'native-hidden']) {
    const h = fixture();
    if (mode === 'setup') h.state.pluginSetupOpen = true;
    if (mode === 'settings') h.state.settingsOpen = true;
    if (mode === 'document-hidden') h.document.hidden = true;
    if (mode === 'native-hidden') h.state.windowVisible = false;
    await h.refresh();
    h.advance(60000);
    await h.refresh();
    assert.equal(h.git().length, 0, mode);
    h.state.pluginSetupOpen = h.state.settingsOpen = h.document.hidden = false;
    h.state.windowVisible = true;
    await h.refresh();
    assert.equal(h.git().length, 1, mode);
  }
});

test('focus, native restore and workspace switches request fresh Git only on explicit events', async () => {
  const h = fixture();
  await h.refresh();
  h.advance(3000);
  await h.event('focus');
  assert.equal(h.git().length, 2);
  assert.equal(h.git()[1].body.force, true);
  h.state.windowVisible = false;
  await h.refresh();
  h.state.windowVisible = true;
  await h.refresh();
  assert.equal(h.git().length, 3);
  h.state.workspace = '/two';
  await h.refresh();
  assert.equal(h.git().length, 4);
  assert.equal(h.git()[3].body.workspace, '/two');
});

test('filesystem revisions wait until a blurred window receives focus', async () => {
  const h = fixture();
  await h.refresh();
  await h.event('blur');
  h.state.projectRevision = 10;
  for (let i = 0; i < 10; i++) await h.refresh();
  assert.equal(h.git().length, 1);
  await h.event('focus');
  assert.equal(h.git().length, 2);
});

test('pending Git requests merge and cannot put a stale workspace into the HUD', async () => {
  const h = fixture();
  let release;
  h.blocked = new Promise(resolve => { release = resolve; });
  await h.refresh();
  h.advance(20000);
  await h.refresh();
  assert.equal(h.git().length, 1);
  h.state.workspace = '/two';
  await h.refresh();
  release();
  await settle();
  assert.equal(h.seen.some(value => value.workspace === '/two' && value.project?.path === '/one'), false);
  h.blocked = null;
  await h.refresh();
  assert.equal(h.git().length, 2);
  assert.equal(h.seen.at(-1).project.path, '/two');
});

test('a Git reply discarded while the view loads is retried when the view becomes visible', async () => {
  const h = fixture();
  let release;
  h.blocked = new Promise(resolve => { release = resolve; });
  await h.refresh();
  h.state.viewLoading = true;
  await h.refresh();
  release();
  await settle();
  assert.equal(h.seen.some(value => value.project?.branch === 'main'), false);
  h.blocked = null;
  h.state.viewLoading = false;
  await h.refresh();
  assert.equal(h.git().length, 2);
  assert.equal(h.seen.at(-1).project.branch, 'main');
  for (let i = 0; i < 5; i++) await h.refresh();
  assert.equal(h.git().length, 2);
});

test('filesystem revisions reject an in-flight old reply and request the new branch', async () => {
  const h = fixture();
  h.state.projectRevision = 1;
  let release;
  h.blocked = new Promise(resolve => { release = resolve; });
  await h.refresh();
  h.state.projectRevision = 2;
  await h.refresh();
  release();
  await settle();
  assert.equal(h.seen.some(value => value.project?.branch === 'main'), false);
  h.blocked = null;
  h.projectResult = { path: '/one', branch: 'new-branch', gitStatus: 'branch' };
  await h.refresh();
  assert.equal(h.git().length, 2);
  assert.equal(h.seen.at(-1).project.branch, 'new-branch');
});

test('unknown snapshots do not erase a known branch, while a verified no-Git result does', async () => {
  const h = fixture();
  h.state.project = { path: '/one', gitStatus: 'unknown' };
  await h.refresh();
  assert.equal(h.seen.at(-1).project.branch, 'main');
  await h.refresh();
  assert.equal(h.seen.at(-1).project.branch, 'main');
  assert.equal(h.git().length, 1);
  h.projectResult = { path: '/one', gitStatus: 'none' };
  await h.window.desktop.refreshGit();
  assert.equal(h.seen.at(-1).project.gitStatus, 'none');
  h.state.workspace = '/two';
  h.state.project = { path: '/two', gitStatus: 'unknown' };
  h.state.viewLoading = true;
  await h.refresh();
  assert.equal(h.seen.at(-1).project.branch, undefined);
});
