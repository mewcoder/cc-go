'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

// Electron snapshot, except the explicitly approved host adjustments below.
const expected = {
  "shell.html": "67439454869550e93a9272287e752436a33b551bee05a47cd08185dd9e5a27e0",
  "shell.js": "9bdbd7da3ef846c7c3df2a7d5cfa0ad076549965eb1449504801cd0d198fd782",
  "shell.css": "d8b56cab1b9b539710c09c4c35805532a764cfdc110dda75311b51ee92552d47",
  "theme.css": "bc5909055a6e74219de0223386752651b1fd6b0b25a1df9ac46a2b9e0a88ddbf",
  "theme-light.css": "21b2ae2b09bba9c27fe745666dd6afcdf62cd735a3cb08bde49cf320b4b1a7bc"
};
// Changes made in this host, each rewritten back to the Electron text before hashing.
const approvedChanges = {
  'shell.html': [
    ['        <button id="new-chat" class="sidebar-new-chat" type="button" disabled>New Chat</button>\n', ''],
    ['<title>CC Go</title>', '<title>Claude VSIX Desktop</title>'],
    ['<h2 id="log-title">VSIX Output</h2>', '<h2 id="log-title">Output</h2>'],
    ['title="Close VSIX Output" aria-label="Close VSIX Output"', 'title="Close Output" aria-label="Close Output"'],
    ['aria-label="VSIX Output contents"', 'aria-label="Output contents"'],
  ],
  'shell.css': [
    [
      '.workspace-row:hover .workspace-new, .workspace-new:focus-visible { opacity: 1; }',
      '.workspace-row:hover .workspace-new, .workspace-new:focus-visible, .workspace-row.active .workspace-new { opacity: 1; }',
    ],
    [
      '.sidebar-actions .icon-button .icon { width: 14px; height: 14px; }',
      '.sidebar-actions .icon-button .icon { width: 15px; height: 15px; }',
    ],
    [
      '.session-action .icon { width: 14px; height: 14px; }',
      '.session-action .icon { width: 12px; height: 12px; }',
    ],
  ],
  'shell.js': [
    ["      entry.open.setAttribute('aria-label', `${entry.expanded ? 'Collapse' : 'Expand'} ${entry.label.textContent}`);\n", ''],
    ["    if (key === 'desktop.transcriptWidth') {\n      control = window.goWidthControl.create(document, { value: current, status, save: value => desktop.setTranscriptWidth(value) });\n    } else if (property.type === 'boolean') {", "    if (property.type === 'boolean') {"],
    ["  ui.setupImport.addEventListener('click', () => { void runCommand('plugin', () => desktop.importPlugin()); });", "  ui.setupSelectCli.addEventListener('click', () => { void runCommand('plugin', () => desktop.selectClaude()); });\n  ui.setupImport.addEventListener('click', () => { void runCommand('plugin', () => desktop.importPlugin()); });"],
    ["  ui.pluginUpdate.addEventListener('click', () => {", "  element('setup-copy-install').addEventListener('click', () => {\n    void runCommand('copy-install', async () => {\n      await desktop.copyInstallCommand();\n      element('setup-copy-install').textContent = 'Copied';\n      setTimeout(() => { element('setup-copy-install').textContent = 'Copy'; }, 1600);\n    });\n  });\n  ui.pluginUpdate.addEventListener('click', () => {"],
    // Desktop-only column widths have their own behavioral tests in transcript-width.test.cjs.
    ["      if (key === 'desktop.transcriptWidth') await desktop.setTranscriptWidth(value);\n      else settingsData = await desktop.updateSetting(key, value);", "      settingsData = await desktop.updateSetting(key, value);"],
    ["    const properties = {\n      'desktop.transcriptWidth': {\n        title: 'Transcript Width',\n        description: 'Maximum width of the transcript and composer columns.',\n        type: 'string', default: 'narrow',\n        enum: ['narrow', 'medium', 'wide'], enumItemLabels: ['Narrow', 'Medium', 'Wide'],\n      },\n      ...Object.fromEntries(Object.entries(settingsData.properties ?? {})\n        .filter(([key]) => !unsupportedSettings.has(key))),\n    };\n    const values = { ...settingsData.values, 'desktop.transcriptWidth': state.transcriptWidth ?? 'narrow' };\n    const keys = ['desktop.transcriptWidth', ...settingOrder.map(key => `claudeCode.${key}`)];", "    const properties = Object.fromEntries(Object.entries(settingsData.properties ?? {})\n      .filter(([key]) => !unsupportedSettings.has(key)));\n    const values = settingsData.values ?? {};\n    const keys = settingOrder.map(key => `claudeCode.${key}`);"],
    ["    newChat: element('new-chat'),\n", ''],
    ["  ui.newChat.replaceChildren(icon('plus'), document.createTextNode('New Chat'));\n", ''],
    ["    ui.newChat.disabled = !desktop || phase !== 'active' || pending.has('new-chat') || Boolean(state.settingsOpen || state.pluginSetupOpen || state.viewLoading);\n    ui.newChat.title = items.some(item => item.path === state.workspace) ? `New Chat in ${state.workspace}` : 'Start a new chat in an available workspace';\n", ''],
    ["  ui.newChat.addEventListener('click', () => {\n    void runCommand('new-chat', () => desktop.newSession());\n  });\n", ''],
    ["          if (!ui.newChat.disabled) ui.newChat.click();", "          void runCommand(`new-session:${state.workspace}`, () => desktop.newSession(state.workspace));"],
    ['Open VSIX Output for error details.', 'Open Output for error details.'],
    ['    if (window.__goRenderSetup) return window.__goRenderSetup(state);\n', ''],
    ["    plus: ['M12 5v14', 'M5 12h14'],\n", ''],
    ["  ui.addWorkspace.replaceChildren(icon('plus'));\n", ''],
    ["    upgrade: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z', 'M12 16V8', 'm8 12 4-4 4 4'],\n", ''],
    ["  ui.pluginUpdate.append(icon('upgrade'));", "  ui.pluginUpdate.append(icon('refresh'));"],
    ["    let empty = entry.sessionList.querySelector('.session-empty');\n    if (!sessions.length && !empty) {\n      empty = document.createElement('p');\n      empty.className = 'session-empty';\n      empty.textContent = 'No chats yet';\n      entry.sessionList.append(empty);\n    } else if (sessions.length) empty?.remove();\n", ''],
  ],
};

test('output panel and menu retain the existing VSIX Output entry', () => {
  const html = fs.readFileSync(path.join(__dirname, '../web/shell.html'), 'utf8');
  const menu = fs.readFileSync(path.join(__dirname, '../internal/desktop/desktop.go'), 'utf8');
  assert.match(html, /<h2 id="log-title">VSIX Output<\/h2>/);
  assert.match(html, /title="Close VSIX Output" aria-label="Close VSIX Output"/);
  assert.match(menu, /action\("VSIX Output", "CmdOrCtrl\+Shift\+U"/);
});

for (const [name, digest] of Object.entries(expected)) {
  test(`Electron UI baseline is preserved except approved changes: ${name}`, () => {
    const contents = fs.readFileSync(path.join(__dirname, '../web', name));
    let baseline = contents.toString();
    // The user requested descriptive plugin terminology in all visible shell copy.
    if (name === 'shell.html' || name === 'shell.js') {
      baseline = baseline.replaceAll('VS Code extension (.vsix)', 'VSIX');
    }
    for (const [changed, original] of approvedChanges[name] ?? []) {
      baseline = baseline.replace(changed, original);
    }
    assert.equal(createHash('sha256').update(baseline).digest('hex'), digest);
  });
}

test('Electron snapshot retains its workspace-action hover rules', () => {
  const css = fs.readFileSync(path.join(__dirname, '../web/shell.css'), 'utf8');
  assert.match(css, /\.workspace-row:hover \.workspace-new, \.workspace-new:focus-visible \{ opacity: 1; \}/);
  assert.doesNotMatch(css, /\.workspace-row\.active \.workspace-new/);
});

test('Go host keeps every project new-chat button visible without hover or focus', () => {
  const css = fs.readFileSync(path.join(__dirname, '../web/host.css'), 'utf8');
  assert.match(css, /(?:^|\n)\.workspace-new \{ opacity: 1; \}/);
});

test('Electron snapshot icon rules remain unchanged beneath host overrides', () => {
  const css = fs.readFileSync(path.join(__dirname, '../web/shell.css'), 'utf8');
  for (const selector of ['.sidebar-actions .icon-button .icon', '.session-action .icon']) {
    assert.match(css, new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{ width: 14px; height: 14px; \\}`));
  }
  assert.doesNotMatch(css, /\.icon \{[^}]*width: (?!14px)\d+px/);
});
