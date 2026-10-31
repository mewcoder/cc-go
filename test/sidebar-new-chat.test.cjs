'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../web/shell.js'), 'utf8');

test('global new chat is permanently above the workspace heading with a quiet plus icon', () => {
  const html = fs.readFileSync(path.join(__dirname, '../web/shell.html'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../web/host.css'), 'utf8');
  assert.ok(html.indexOf('id="new-chat"') < html.indexOf('class="sidebar-header"'));
  assert.ok(html.indexOf('class="sidebar-header"') < html.indexOf('id="workspace-list"'));
  assert.match(source, /ui\.newChat\.replaceChildren\(icon\('plus'\)/);
  assert.match(css, /\.sidebar-new-chat[^}]*border: 1px solid color-mix\(in srgb, var\(--vscode-foreground\) 12%, transparent\);[^}]*background: transparent;/);
  assert.match(css, /\.sidebar \.sidebar-new-chat:hover:not\(:disabled\)[^}]*var\(--shell-hover-background\)/);
});

test('New Chat shares a transparent fill and subtle themed border across light and dark themes', () => {
  const css = fs.readFileSync(path.join(__dirname, '../web/host.css'), 'utf8');
  assert.doesNotMatch(css, /body\[data-theme="light"\][^{]*\.sidebar-new-chat/);
  assert.match(css, /\.sidebar \.sidebar-new-chat:hover:not\(:disabled\) \{ border-color: color-mix\(in srgb, var\(--vscode-foreground\) 20%, transparent\); background: var\(--shell-hover-background\); \}/);
});

test('global new chat delegates automatic workspace choice and Cmd+N shares its pending guard', () => {
  const start = source.indexOf("  ui.newChat.addEventListener('click'");
  const end = source.indexOf('\n  });', start) + '\n  });'.length;
  let click, calls = 0;
  vm.runInNewContext(source.slice(start, end), {
    ui: { newChat: { addEventListener(type, fn) { assert.equal(type, 'click'); click = fn; } } },
    runCommand(key, fn) { assert.equal(key, 'new-chat'); return fn(); },
    desktop: { newSession(...args) { calls++; assert.deepEqual(args, []); } },
  });
  click();
  assert.equal(calls, 1);
  assert.match(source, /if \(!ui\.newChat\.disabled\) ui\.newChat\.click\(\);/);
  assert.match(source, /ui\.newChat\.disabled = .*phase !== 'active'.*pending\.has\('new-chat'\)/);
  assert.match(source, /desktop\.newSession\(path\)/);
  assert.doesNotMatch(source, /Choose a workspace for a new chat/);
});

test('new chat aligns with project rows and keeps the workspace heading compact on every platform', () => {
  const css = fs.readFileSync(path.join(__dirname, '../web/host.css'), 'utf8');
  const shell = fs.readFileSync(path.join(__dirname, '../web/shell.css'), 'utf8');
  const rule = css.match(/(?:^|\n)\.sidebar-new-chat \{([^}]+)\}/)[1];
  assert.match(shell, /\.workspace-list \{[^}]*padding: 0 6px 8px;/);
  assert.match(shell, /\.workspace-open \{[^}]*gap: 8px;[^}]*padding: 0 6px;/);
  assert.match(rule, /margin: 4px var\(--shell-sidebar-inset\) 8px;/);
  assert.match(shell, /button \{[^}]*border: 1px solid transparent;/);
  assert.match(rule, /padding: 0 6px;/);
  assert.match(rule, /gap: 8px;/);
  assert.match(rule, /min-height: 28px;/);
  assert.match(css, /:root \.sidebar-header \{ flex-basis: 36px; padding: 0 var\(--shell-sidebar-inset\) 0 var\(--shell-sidebar-content-inset\); \}/);
  assert.match(css, /\.sidebar-header h2 \{ font-size: var\(--vscode-chat-font-size, 12px\);[^}]*text-transform: none;[^}]*\}/);
});
