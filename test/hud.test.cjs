'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const hud = require('../web/hud.js');

function state(extra = {}) {
  return {
    phase: 'active', views: [{ id: 'view', active: true, ready: true, url: 'http://127.0.0.1:1234/view', revision: 1 }],
    activeSessionId: 'session', sidebarWidth: 248, sidebarCollapsed: false,
    workspace: '/code/project', project: { name: 'project', path: '/code/project', branch: 'main', gitStatus: 'branch' },
    sessionMetrics: { contextTokens: 84000, contextWindow: 200000, inputTokens: 10000, outputTokens: 4000, cacheReadTokens: 60000, cacheWriteTokens: 10000 },
    ...extra,
  };
}

function documentFixture() {
  function element(tag) {
    return { tag, children: [], attributes: {}, dataset: {}, style: {}, handlers: {}, textContent: '', contentWindow: tag === 'iframe' ? {} : undefined,
      append(...children) { this.children.push(...children); },
      setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener(name, callback) { this.handlers[name] = callback; },
      remove() {},
    };
  }
  return { body: element('body'), createElement: element, createElementNS: (_, tag) => element(tag) };
}

test('HUD combines context and cache while preserving the selected metrics', () => {
  const data = hud.describe(state());
  assert.deepEqual(Object.keys(data), ['project', 'branch', 'changes', 'context', 'tokens', 'percent']);
  assert.equal(data.project.text, 'project');
  assert.equal(data.project.title, '/code/project');
  assert.equal(data.branch.text, 'main');
  assert.equal(data.context.text, '42% (84k/200k) \u00b7 Cache 75%');
  assert.equal(data.tokens.text, '\u219110k \u21934k');
  assert.match(data.context.title, /total input: 80,000/);
});

test('window provenance stays in the tooltip without restoring the Context text label', () => {
  for (const [source, description] of [['native', /native context query/], ['sdk', /SDK model usage/]]) {
    const data = hud.describe(state({ sessionMetrics: { ...state().sessionMetrics, contextWindowSource: source } }));
    assert.equal(data.context.text, '42% (84k/200k) \u00b7 Cache 75%');
    assert.match(data.context.title, description);
  }
});

test('project and branch selectors require a blank new conversation and known empty draft', () => {
  const document = documentFixture(), clicks = [];
  const widget = hud.create(document, { project: () => clicks.push('project'), branch: () => clicks.push('branch') });
  const bar = document.body.children[0];
  const next = state({ activeSessionId: '', sessionMetrics: {}, canSelectProject: true });
  widget.render(next);
  widget.layout({ left: 0, top: 100, width: 680 });
  bar.children[0].handlers.click();
  assert.deepEqual(clicks, [], 'Unknown draft state must fail closed');
  widget.setDraft(false);
  assert.equal(bar.children[0].attributes['aria-disabled'], 'false');
  bar.children[0].handlers.click();
  bar.children[1].handlers.keydown({ key: 'Enter', preventDefault() {} });
  assert.deepEqual(clicks, ['project', 'branch']);
  widget.setDraft(true);
  bar.children[0].handlers.click();
  assert.equal(clicks.length, 2);
  widget.setDraft(false);
  widget.render(state({ canSelectProject: false }));
  bar.children[1].handlers.click();
  assert.equal(clicks.length, 2);
  assert.equal(bar.children[1].attributes['aria-disabled'], 'true');
});

test('project and branch interactions use neutral feedback, not accent colors', () => {
  const css = fs.readFileSync(require.resolve('../web/host.css'), 'utf8');
  const hover = css.match(/\.session-hud \.hud-selectable:hover[^{}]*\{([^}]*)\}/)[1];
  assert.match(hover, /color: inherit/);
  assert.match(hover, /background: var\(--shell-hover-background\)/);
  assert.doesNotMatch(hover, /accent/);
  const menuHover = css.match(/\.hud-picker-choice:is\(:hover[^{}]*\{([^}]*)\}/)[1];
  assert.match(menuHover, /color: inherit/);
  assert.match(menuHover, /background: var\(--shell-hover-background\)/);
  assert.match(css, /\.hud-selectable:focus \{ outline: none/);
  assert.match(css, /\.hud-selectable:focus-visible \{ box-shadow: inset 0 -1px var\(--shell-muted\)/);
  const picker = css.match(/\.hud-picker \{([^}]*)\}/)[1];
  assert.match(picker, /background: var\(--shell-sidebar-background\)/);
  assert.match(picker, /color: inherit/);
  assert.doesNotMatch(picker, /--vscode-menu/);
  const chevron = css.match(/\.hud-selectable::after \{([^}]*)\}/)[1];
  assert.match(chevron, /width: 8px/);
  assert.match(chevron, /height: 8px/);
  assert.match(chevron, /align-self: center/);
  assert.match(chevron, /clip-path: polygon/);
  assert.doesNotMatch(chevron, /url\(/, 'Shell CSP does not allow image-backed arrows');
  assert.doesNotMatch(chevron, /transform|border-bottom|border-right/);
});

test('unknown and zero values are distinct, with no hardcoded model window or invalid ratio', () => {
  const unknown = hud.describe(state({ sessionMetrics: {} }));
  assert.equal(unknown.context.text, '');
  const zero = hud.describe(state({ sessionMetrics: { contextTokens: 0, contextWindow: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }));
  assert.equal(zero.tokens.text, '\u21910 \u21930');
  assert.equal(zero.context.hidden, false);
  assert.equal(zero.context.text, '0/\u2014');
  const uncached = hud.describe(state({ sessionMetrics: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 } }));
  assert.equal(uncached.context.text, 'Cache 0%');
  const missingCacheWrite = hud.describe(state({ sessionMetrics: { inputTokens: 100, cacheReadTokens: 100 } }));
  assert.equal(missingCacheWrite.context.hidden, true);
});

test('No Git, detached HEAD and unknown Git are shown honestly', () => {
  assert.equal(hud.describe(state({ project: { gitStatus: 'none' } })).branch.text, 'No Git');
  assert.equal(hud.describe(state({ project: { gitStatus: 'unknown' } })).branch.text, '\u2014');
  assert.equal(hud.describe(state({ project: { gitStatus: 'detached', branch: 'abc1234' } })).branch.text, 'HEAD abc1234');
});

test('Git changes show file counts and colored line totals without adding another icon', () => {
  const project = { ...state().project, changes: { files: 3, untracked: 1, added: 28, deleted: 9, binary: 1 } };
  const data = hud.describe(state({ project }));
  assert.equal(data.changes.text, '3 files +28 -9');
  assert.match(data.changes.title, /1 untracked/);
  assert.match(data.changes.title, /1 binary files are excluded/);
  assert.match(data.changes.title, /including new untracked text files/);
  const document = documentFixture();
  const widget = hud.create(document);
  widget.render(state({ project, activeSessionId: '', sessionMetrics: {} }));
  const fields = document.body.children[0].children;
  assert.deepEqual(fields.filter(field => !field.hidden).map(field => field.className), ['hud-project', 'hud-branch', 'hud-changes']);
  assert.deepEqual(fields[2].children.map(child => child.textContent), ['3 files', '+28', '-9']);
  assert.equal(fields[2].children[1].className, 'hud-added');
  assert.equal(fields[2].children[2].className, 'hud-deleted');
  widget.render(state());
  assert.equal(fields[2].hidden, true, 'Previous repository changes must not leak into another project');
});

test('clean, unknown or invalid Git changes stay hidden; empty or binary-only files have no line totals', () => {
  for (const changes of [undefined, {}, { files: 0, untracked: 0, added: 0, deleted: 0, binary: 0 },
    { files: 1, untracked: 0, added: -1, deleted: 0, binary: 0 }]) {
    assert.equal(hud.describe(state({ project: { changes } })).changes.hidden, true);
  }
  const data = hud.describe(state({ project: { changes: { files: 1, untracked: 1, added: 0, deleted: 0, binary: 0 } } }));
  assert.equal(data.changes.text, '1 file');
  assert.equal(data.changes.addedText, '');
  assert.equal(data.changes.deletedText, '');
  const newFile = hud.describe(state({ project: { changes: { files: 1, untracked: 1, added: 100, deleted: 0, binary: 0 } } }));
  assert.equal(newFile.changes.text, '1 file +100');
});

test('new conversations show only project and Git, then reveal real data without leaking old fields', () => {
  const document = documentFixture();
  const widget = hud.create(document);
  const bar = document.body.children[0];
  const shown = () => bar.children.filter(field => !field.hidden).map(field => field.className);
  widget.render(state({ activeSessionId: '', sessionMetrics: {} }));
  assert.deepEqual(shown(), ['hud-project', 'hud-branch']);
  widget.render(state());
  assert.deepEqual(shown(), ['hud-project', 'hud-branch', 'hud-tokens', 'hud-context']);
  widget.render(state({ activeSessionId: 'another-session', sessionMetrics: {} }));
  assert.deepEqual(shown(), ['hud-project', 'hud-branch']);
  widget.render(state({ sessionMetrics: { contextTokens: 0, contextWindow: 200000,
    inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }));
  assert.equal(bar.children[3].hidden, false);
  assert.equal(bar.children[4].children[1].textContent, '0% (0/200k) \u00b7 Cache 0%');
  assert.equal(bar.children[4].hidden, false);
  const css = fs.readFileSync(require.resolve('../web/host.css'), 'utf8');
  assert.match(css, /\.session-hud > span\[hidden\]\s*\{\s*display: none;/);
});

test('known context tokens stay visible without a window or a Context text label', () => {
  const document = documentFixture();
  const widget = hud.create(document);
  const field = document.body.children[0].children[4];
  for (const contextWindow of [undefined, 0, -1, NaN, Infinity]) {
    widget.render(state({ sessionMetrics: { contextTokens: 22299, contextWindow,
      inputTokens: 22299, outputTokens: 252, cacheReadTokens: 0, cacheWriteTokens: 0 } }));
    assert.equal(field.hidden, false);
    assert.equal(field.children[0].tag, 'svg');
    assert.equal(field.children[1].textContent, '22.3k/\u2014 \u00b7 Cache 0%');
    assert.doesNotMatch(field.children[1].textContent, /Context|NaN|Infinity/);
    assert.equal(field.dataset.level, 'normal');
  }
  widget.render(state({ sessionMetrics: { contextTokens: 0 } }));
  assert.equal(field.hidden, false);
  assert.equal(field.children[1].textContent, '0/\u2014');
  widget.render(state());
  assert.equal(field.children[1].textContent, '42% (84k/200k) \u00b7 Cache 75%');
  widget.render(state({ activeSessionId: 'another-session', sessionMetrics: {} }));
  assert.equal(field.hidden, true);
  assert.equal(field.children[1].textContent, '');
});

test('incomplete token and cache counters stay hidden independently of known context tokens', () => {
  const document = documentFixture();
  const widget = hud.create(document);
  const bar = document.body.children[0];
  widget.render(state({ sessionMetrics: { contextTokens: 100, inputTokens: 100 } }));
  assert.deepEqual(bar.children.map(field => field.hidden), [false, false, true, true, false]);
  assert.equal(bar.children[4].children[1].textContent, '100/\u2014');
  widget.render(state({ sessionMetrics: { contextTokens: 100, contextWindow: 1000 } }));
  assert.deepEqual(bar.children.map(field => field.hidden), [false, false, true, true, false]);
  widget.render(state({ sessionMetrics: { inputTokens: 100, outputTokens: 0 } }));
  assert.deepEqual(bar.children.map(field => field.hidden), [false, false, true, false, true]);
});

test('HUD only shows under a ready, visible extension view', () => {
  assert.equal(hud.visible(state()), true);
  for (const extra of [{ phase: 'setup' }, { settingsOpen: true }, { pluginSetupOpen: true }, { viewLoading: true }, { views: [] }]) {
    assert.equal(Boolean(hud.visible(state(extra))), false);
  }
});

test('project and Git stay left while context and tokens align right, including tokens-only data', () => {
  const document = documentFixture();
  const widget = hud.create(document);
  const bar = document.body.children[0];
  widget.render(state());
  assert.deepEqual(bar.children.map(field => field.className), ['hud-project', 'hud-branch', 'hud-changes', 'hud-tokens', 'hud-context']);
  widget.render(state({ sessionMetrics: { inputTokens: 100, outputTokens: 0 } }));
  assert.equal(bar.children[3].hidden, false);
  assert.equal(bar.children[4].hidden, true);
  const css = fs.readFileSync(require.resolve('../web/host.css'), 'utf8');
  assert.match(css, /\.session-hud > \.hud-tokens,\s*\.session-hud > \.hud-tokens\[hidden\] \+ \.hud-context\s*\{\s*margin-left: auto;/);
});

test('fields have safe text and accessible names; only tokens omit the redundant group icon', () => {
  const document = documentFixture();
  const widget = hud.create(document);
  const bar = document.body.children[0];
  widget.render(state());
  assert.equal(bar.hidden, true, 'Wait for composer geometry before showing the HUD');
  widget.layout({ left: 300, top: 760, width: 680 });
  assert.equal(bar.children.length, 5);
  assert.equal(bar.hidden, false);
  for (const field of bar.children) {
    if (field.className === 'hud-changes') {
      assert.equal(field.hidden, true);
    } else if (field.className === 'hud-tokens') {
      assert.equal(field.children.length, 1);
      assert.equal(field.children[0].tag, 'span');
      assert.equal(field.children[0].textContent, '\u219110k \u21934k');
    } else {
      assert.equal(field.children[0].tag, 'svg');
      assert.equal(field.children[0].attributes['aria-hidden'], 'true');
      assert.ok(field.children[0].children.length > 0);
    }
    assert.ok(field.attributes['aria-label']);
    assert.ok(field.title);
  }
  widget.render(state({ project: { name: '<script>bad()</script>', gitStatus: 'branch', branch: 'feature/<test>' }, sessionMetrics: {} }));
  assert.equal(bar.children[0].children[1].textContent, '<script>bad()</script>');
  assert.equal(bar.children[1].children[1].textContent, 'feature/<test>');
  assert.equal(bar.children[4].children[1].textContent, '');
  widget.layout({ left: 252, top: 700, width: 600 });
  assert.deepEqual(bar.style, { left: '252px', top: '700px', width: '600px' });
  const css = fs.readFileSync(require.resolve('../web/host.css'), 'utf8');
  assert.match(css, /overflow-x: auto/);
  assert.doesNotMatch(css, /\.hud-(?:branch|context|tokens|cache)[^{]*\{[^}]*display: none/);
  const style = css.match(/\.session-hud\s*\{([^}]*)\}/)[1];
  assert.match(style, /position: absolute/);
  assert.doesNotMatch(style, /border-top|right:|bottom:/);
  assert.doesNotMatch(css, /\.session-hud > span \+ span/);
});

async function desktopFixture(platform = 'darwin') {
  const document = documentFixture();
  let latest = state();
  const handlers = new Map();
  const window = { __goDesktopConfig: { platform, token: 'fixture' }, goHUD: hud,
    addEventListener(name, callback) { handlers.set(name, callback); } };
  const context = {
    window, URL, document: { ...document, getElementById: () => null }, innerWidth: 1200, innerHeight: 800,
    fetch: async url => ({ ok: true, text: async () => JSON.stringify(url === '/api/project' ? latest.project : latest) }),
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../web/desktop.js'), 'utf8'), context);
  await window.desktop.getState();
  const frame = document.body.children.find(child => child.tag === 'iframe');
  const bar = document.body.children.find(child => child.className === 'session-hud');
  const report = (rect, viewport = { width: 948, height: 800 }, extra = {}) => handlers.get('message')({
    source: frame.contentWindow, origin: 'http://127.0.0.1:1234',
    data: { type: 'claude-host:composer', rect, viewport, hasDraft: false }, ...extra,
  });
  return { window, context, handlers, frame, bar, report,
    update: async extra => { latest = state(extra); await window.desktop.getState(); } };
}

test('HUD follows the actual composer without reducing iframe height, including sidebar and Output changes', async () => {
  const { frame, bar, report, update } = await desktopFixture();
  assert.equal(frame.style.height, '800px');
  assert.equal(frame.style.left, '252px');
  assert.equal(bar.hidden, true);
  report({ left: 100, top: 648, width: 680, height: 124 });
  assert.equal(bar.hidden, false);
  assert.deepEqual(bar.style, { left: '352px', top: '776px', width: '680px' });
  assert.equal(800 - parseFloat(bar.style.top) - hud.height, 4);
  await update({ sidebarCollapsed: true, logsOpen: true });
  assert.equal(frame.style.top, '30px');
  assert.equal(frame.style.left, '0px');
  assert.equal(frame.style.height, '514px');
  assert.equal(bar.hidden, true, 'Stale viewport measurements must not be reused');
  report({ left: 260, top: 362, width: 680, height: 124 }, { width: 1200, height: 514 });
  assert.deepEqual(bar.style, { left: '260px', top: '520px', width: '680px' });
  assert.equal(bar.hidden, false);
  await update({ pluginSetupOpen: true });
  assert.equal(frame.hidden, true);
  assert.equal(bar.hidden, true);
  assert.equal(frame.style.height, '800px');
});

test('untrusted, invalid, stale and clipped geometry cannot position the HUD', async () => {
  const { bar, report, update } = await desktopFixture();
  const rect = { left: 100, top: 648, width: 680, height: 124 };
  report(rect, undefined, { source: {} });
  assert.equal(bar.hidden, true);
  report(rect, undefined, { origin: 'https://attacker.example' });
  assert.equal(bar.hidden, true);
  report({ ...rect, width: NaN });
  assert.equal(bar.hidden, true);
  report({ ...rect, left: -10 });
  assert.equal(bar.hidden, true);
  report({ ...rect, top: 760 });
  assert.equal(bar.hidden, true, 'Never cover the composer when there is no room underneath');
  report(rect);
  assert.equal(bar.hidden, false);
  report(null);
  assert.equal(bar.hidden, true);
  report(rect);
  await update({ views: [{ ...state().views[0], revision: 2 }] });
  assert.equal(bar.hidden, true, 'Reloaded views wait for fresh geometry');
});

test('narrow windows and Windows titlebars preserve exact composer alignment', async () => {
  const h = await desktopFixture('win32');
  h.context.innerWidth = 390;
  h.context.innerHeight = 700;
  await h.update({ sidebarCollapsed: true });
  h.report({ left: 16, top: 518, width: 358, height: 124 }, { width: 390, height: 670 });
  assert.equal(h.frame.style.height, '670px');
  assert.equal(h.bar.hidden, false);
  assert.deepEqual(h.bar.style, { left: '16px', top: '676px', width: '358px' });
});

test('clicking change statistics refreshes Git without requiring an empty draft or a new chat', () => {
  const document = documentFixture();
  let refreshes = 0;
  const bar = hud.create(document, { changes: () => refreshes++ });
  bar.layout({ left: 0, top: 100, width: 600 });
  bar.render(state({ canSelectProject: false, project: { changes: { files: 1, untracked: 0, added: 2, deleted: 1, binary: 0 } } }));
  bar.setDraft(true);
  const field = document.body.children[0].children[2];
  assert.equal(field.attributes.role, 'button');
  assert.equal(field.attributes['aria-haspopup'], undefined);
  field.handlers.click();
  field.handlers.keydown({ key: 'Enter', preventDefault() {} });
  assert.equal(refreshes, 2);
  bar.render(state({ phase: 'setup' }));
  field.handlers.click();
  assert.equal(refreshes, 2, 'hidden HUD must not refresh');
});
