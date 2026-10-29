'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const host = read('web/host.css');
const shell = read('web/shell.css');
const rules = [...host.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)];
function rule(selector) {
  const match = rules.find(item => item[1].trim() === selector);
  assert.ok(match, `Missing scoped rule: ${selector}`);
  return match[2];
}
function property(css, name) {
  const match = css.match(new RegExp(`(?:^|[;{])\\s*${name}\\s*:\\s*([^;{}]+)`));
  assert.ok(match, `Missing property: ${name}`);
  return match[1].trim();
}

test('sidebar uses the same font family and 13px base as the plugin host', () => {
  const sidebar = rule('.sidebar');
  assert.equal(property(sidebar, 'font-family'), 'var(--vscode-chat-font-family, var(--vscode-font-family))');
  assert.equal(property(sidebar, 'font-size'), 'var(--vscode-chat-font-size, 13px)');
  assert.equal(property(rule('.sidebar :is(.workspace-open, .session-item, .session-rename)'), 'font-size'), 'inherit');
  for (const theme of ['theme.css', 'theme-light.css']) {
    assert.equal(property(read(`web/${theme}`), '--vscode-chat-font-size'), '13px');
    assert.equal(property(read(`web/${theme}`), '--vscode-chat-font-family'), property(read(`runtime/${theme}`), '--vscode-chat-font-family'));
    for (const name of ['--vscode-foreground', '--vscode-descriptionForeground']) {
      assert.equal(property(read(`web/${theme}`), name), property(read(`runtime/${theme}`), name));
    }
  }
});

test('sidebar weights follow the plugin while auxiliary labels remain readable', () => {
  assert.equal(property(rule('.sidebar .sidebar-new-chat'), 'font-weight'), '500');
  assert.equal(property(rule('.sidebar .session-row.active .session-title'), 'font-weight'), '600');
  const metadata = rule('.sidebar :is(.session-time, .session-empty, .session-load-more)');
  assert.equal(property(metadata, 'font-size'), '12px');
  assert.equal(property(metadata, 'font-weight'), '400');
  assert.match(host, /body\[data-theme\] \.sidebar \.session-row:is\(\.active, :hover, :focus-within\) \.session-time,/);
  assert.equal(property(rule('body[data-theme] .sidebar .session-row:is(.active, :hover, :focus-within) .session-time,\nbody[data-theme] .sidebar .session-load-more:is(:hover, :focus-visible)'), 'color'), 'var(--vscode-foreground)');
});

test('typography keeps the agreed heading, New Chat height and icon sizing', () => {
  assert.equal(property(rule(':root .sidebar-header'), 'flex-basis'), '36px');
  assert.equal(property(rule('.sidebar-header h2'), 'font-size'), '11px');
  assert.equal(property(rule('.sidebar-new-chat'), 'min-height'), '28px');
  assert.equal(property(rule('.sidebar .session-item'), 'min-height'), '28px');
  assert.equal(property(rule('.sidebar .session-rename'), 'height'), '28px');
  assert.equal(property(rule(':root'), '--shell-sidebar-icon-size'), '14px');
  assert.match(shell, /\.sidebar-header h2 \{[^}]*font-weight: 600;/);
  // Host-only typography must not bleed into the extension iframe or settings dialogs.
  assert.doesNotMatch(host, /(?:^|\n)body\s*\{[^}]*font-size:/);
});

function rgb(hex) {
  return hex.replace('#', '').match(/../g).map(part => parseInt(part, 16));
}
function contrast(a, b) {
  const luminance = color => color.map(value => {
    value /= 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
function overlay(base, color) {
  const alpha = parseInt(color.slice(-2), 16) / 255;
  return rgb(color.slice(0, 7)).map((value, index) => value * alpha + base[index] * (1 - alpha));
}

test('light sidebar tokens match the plugin and small text meets 4.5:1 in both themes', () => {
  const light = rule('body[data-theme="light"] .sidebar');
  for (const name of ['--vscode-foreground', '--vscode-descriptionForeground']) {
    assert.equal(property(light, name), property(read('runtime/theme-light.css'), name).toLowerCase());
  }
  assert.match(rule('body[data-theme] .sidebar :is(.session-time, .session-empty, .session-load-more, .sidebar-header h2)'), /color: var\(--vscode-descriptionForeground\)/);
  assert.match(rule('body[data-theme] .sidebar :is(.workspace-open, .session-item, .archive-toggle),\nbody[data-theme] .sidebar .session-item:hover:not(:disabled),\nbody[data-theme] .sidebar .session-row.active .session-item'), /color: var\(--vscode-foreground\)/);
  for (const theme of ['dark', 'light']) {
    const colors = theme === 'light' ? light : read('runtime/theme.css');
    const backgrounds = theme === 'light' ? shell.slice(shell.indexOf('body[data-theme="light"] {')) : shell;
    const background = rgb(property(backgrounds, '--shell-sidebar-background'));
    const foreground = rgb(property(colors, '--vscode-foreground'));
    const secondary = rgb(property(colors, '--vscode-descriptionForeground'));
    assert.ok(contrast(secondary, background) >= 4.5, `${theme} normal metadata contrast`);
    const hover = property(backgrounds, '--shell-hover-background');
    const selected = property(backgrounds, '--shell-selected-background');
    for (const surface of [background, overlay(background, hover), overlay(background, selected), overlay(overlay(background, selected), hover)]) {
      assert.ok(contrast(foreground, surface) >= 4.5, `${theme} primary/interactive text contrast`);
    }
    const archive = rgb(property(theme === 'light' ? rule('body[data-theme="light"]') : rules.find(item => item[1].trim() === ':root' && item[2].includes('--shell-archive-background'))[2], '--shell-archive-background'));
    assert.ok(contrast(foreground, archive) >= 4.5, `${theme} Archive text contrast`);
  }
});
