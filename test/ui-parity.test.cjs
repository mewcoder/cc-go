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
    ['        <input id="archive-search" class="archive-search" type="search" placeholder="Search archived chats" aria-label="Search archived chats" aria-controls="archive-list" autocomplete="off" spellcheck="false" hidden>\n', ''],
    ['          <button id="archive-back" class="icon-button" type="button" title="Back to Projects" aria-label="Back to Projects" hidden></button>\n', ''],
    ['          <span id="archive-count" class="archive-count" hidden>0</span>\n', ''],
    ['        <nav id="archive-list" class="archive-list" aria-label="Archived chats" hidden></nav>', `        <section class="archive-section" aria-label="Archived chats">
          <button id="toggle-archive" class="archive-toggle" type="button" aria-expanded="false" aria-controls="archive-list">
            <span id="archive-icon" aria-hidden="true"></span>
            <span>Archive</span>
            <span id="archive-count" class="archive-count">0</span>
          </button>
          <div id="archive-list" class="archive-list" hidden></div>
        </section>`],
    ['    <link rel="stylesheet" href="theme-light.css">\n', ''],
    ['    <link rel="stylesheet" href="theme-palettes.css">\n    <script src="settings-theme.js" defer></script>\n', ''],
    ['aria-label="Project"', 'aria-label="Workspace"'],
    ['<h2>Project</h2>', '<h2>Workspace</h2>'],
    ['title="Add Project" aria-label="Add Project"', 'title="Add Workspace" aria-label="Add Workspace"'],
    ['aria-label="Project list"', 'aria-label="Workspace list"'],
    ['        <button id="new-chat" class="sidebar-new-chat" type="button" disabled>New Chat</button>\n', ''],
    ['<title>CC Go</title>', '<title>Claude VSIX Desktop</title>'],
    ['<h2 id="log-title">VSIX Output</h2>', '<h2 id="log-title">Output</h2>'],
    ['title="Close VSIX Output" aria-label="Close VSIX Output"', 'title="Close Output" aria-label="Close Output"'],
    ['aria-label="VSIX Output contents"', 'aria-label="Output contents"'],
  ],
  'shell.css': [
    ['button:hover:not(:disabled) { background: var(--shell-hover-background); }\nbutton.selected { background: var(--shell-selected-background); }', 'button:hover:not(:disabled), button.selected { background: #37373d; }'],
    ['body[data-theme="light"] .window-toggle { color: #5f5f68; }', 'body[data-theme="light"] button:hover:not(:disabled), body[data-theme="light"] button.selected { background: #e7e7ec; }\nbody[data-theme="light"] .window-toggle { color: #5f5f68; }'],
    ['.workspace-list, .archive-list, .log-output {', '.workspace-list, .archive-section, .archive-list, .log-output {'],
    [`.archive-count { color: var(--shell-muted); font-size: 10px; }
.archive-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 0 6px 8px; -webkit-app-region: no-drag; }
.archive-list .session-time { max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }`, `.archive-section { flex: 0 1 auto; min-height: 28px; padding: 4px 0 4px 6px; overflow-y: auto; -webkit-app-region: no-drag; }
.archive-toggle { display: flex; align-items: center; gap: 8px; width: 100%; padding: 0 14px 0 8px; color: var(--shell-muted); text-align: left; }
.archive-count { margin-left: auto; font-size: 10px; }
.archive-list { max-height: 220px; overflow-y: auto; padding: 3px 6px 3px 8px; }`],
    [
      `.session-status .icon { display: none; }
.session-status[data-status="working"] { color: #d97757; }
.session-status[data-status="working"]::before { display: none; }
.session-status[data-status="working"] .icon {
  display: block;
  animation: session-pulse 1.2s ease-in-out infinite;
}`,
      `.session-status[data-status="working"] { color: var(--shell-accent); }
.session-status[data-status="working"]::before {
  box-sizing: border-box;
  width: 9px;
  height: 9px;
  border: 1.25px solid currentColor;
  border-right-color: transparent;
  background: transparent;
  animation: session-spin 0.85s linear infinite;
}`,
    ],
    [
      `/* Match the plugin's pending-glyph pulse. */
@keyframes session-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}`,
      '@keyframes session-spin { to { transform: rotate(360deg); } }',
    ],
    ['.session-status[data-status="working"] .icon { animation: none; }', '.session-status[data-status="working"]::before { animation: none; }'],
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
    ["    archiveSearch: element('archive-search'),\n", ''],
    ["    if (!open) ui.archiveSearch.value = '';\n", ''],
    [String.raw`    const allSessions = Array.isArray(state.archivedSessions) ? state.archivedSessions : [];
    const terms = ui.archiveSearch.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const sessions = allSessions.filter(session => {
      const text = ` + "`${session.title || 'Chat'} ${session.workspaceName || ''} ${session.workspace || ''}`" + String.raw`.toLowerCase();
      return terms.every(term => text.includes(term));
    });`, '    const sessions = Array.isArray(state.archivedSessions) ? state.archivedSessions : [];'],
    ["    if (empty && !sessions.length) empty.textContent = terms.length ? 'No matching archived chats' : 'No archived chats';\n", ''],
    ['    ui.archiveCount.textContent = terms.length ? `${sessions.length} / ${allSessions.length}` : String(allSessions.length);', '    ui.archiveCount.textContent = String(sessions.length);'],
    ["    ui.archiveSearch.hidden = !archiveExpanded;\n", ''],
    ["  ui.archiveSearch.addEventListener('input', () => {\n    ui.archiveList.scrollTop = 0;\n    renderArchive(state.phase);\n  });\n", ''],
    ["    archiveBack: element('archive-back'),", "    toggleArchive: element('toggle-archive'),"],
    ["    'arrow-left': ['M19 12H5', 'm12 19-7-7 7-7'],", "    'folder-archive': ['M17 19a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z', 'M20.9 19.8A2 2 0 0 0 22 18V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h5.1', 'M15 11v-1', 'M15 17v-2'],"],
    ["  ui.archiveBack.append(icon('arrow-left'));", "  element('archive-icon').append(icon('folder-archive'));"],
    [String.raw`    time.textContent = archived ? String(session.workspaceName || workspacePath.split(/[\\/]/).filter(Boolean).pop() || workspacePath) : relativeTime(session.updatedAt);`, "    time.textContent = archived ? '' : relativeTime(session.updatedAt);"],
    ["    time.title = archived ? formatPath(workspacePath) : session.updatedAt ? `Last activity: ${new Date(Number(session.updatedAt)).toLocaleString('en-US')}` : '';", "    time.title = session.updatedAt ? `Last activity: ${new Date(Number(session.updatedAt)).toLocaleString('en-US')}` : '';"],
    [`  function setArchiveView(open) {
    archiveExpanded = open;
    renderArchive(state.phase);
    if (open) ui.archiveBack.focus();
    else element('project-more')?.focus();
  }

`, ''],
    [`    ui.sidebarHeader.querySelector('h2').textContent = archiveExpanded ? 'Archived Chats' : 'Project';
    ui.archiveBack.hidden = ui.archiveCount.hidden = !archiveExpanded;
    ui.addWorkspace.hidden = archiveExpanded;
    const projectMore = element('project-more');
    if (projectMore) projectMore.hidden = archiveExpanded;
    ui.workspaceList.hidden = archiveExpanded;`, "    ui.toggleArchive.setAttribute('aria-expanded', String(archiveExpanded));"],
    ["  window.__goShowArchive = () => setArchiveView(true);\n  ui.archiveBack.addEventListener('click', () => setArchiveView(false));", `  ui.toggleArchive.addEventListener('click', () => {
    archiveExpanded = !archiveExpanded;
    renderArchive(state.phase);
  });`],
    ["    const phase = state.pluginUpdating ? 'active' : Object.hasOwn(phaseNames, state.phase) ? state.phase : 'starting';", "    const phase = Object.hasOwn(phaseNames, state.phase) ? state.phase : 'starting';"],
    ["    ui.message.hidden = Boolean(state.pluginUpdating) || phase === 'active' || settingsOpen || setupVisible;", "    const viewLoading = Boolean(state.viewLoading);\n    const loadingView = phase === 'active' && viewLoading;\n    ui.message.hidden = (phase === 'active' && !viewLoading) || settingsOpen || setupVisible;"],
    ["    ui.messageTitle.textContent = phase === 'error' ? 'Could not start Claude Code' : label;", "    ui.messageTitle.textContent = phase === 'error' ? 'Could not start Claude Code' : loadingView ? 'Opening chat' : label;"],
    ["      : phase === 'activating' ? 'Starting Claude Code.' : 'Setting up Claude Code.';", "      : loadingView ? 'Loading Claude Code\u2026'\n        : phase === 'activating' ? 'Starting Claude Code.' : 'Setting up Claude Code.';"],
    ["    document.body.classList.toggle('vscode-light', theme === 'light');\n", ''],
    ["    const theme = state.themeKind ?? (state.theme === 'light' ? 'light' : 'dark');", "    const theme = state.theme === 'light' ? 'light' : 'dark';"],
    ["desktop.setTheme(state.themeKind === 'light' ? 'dark' : 'light')", "desktop.setTheme(state.theme === 'light' ? 'dark' : 'light')"],
    ["    } else if (key === 'desktop.theme') {\n      control = window.goThemeControl.create(document, { value: current, status, save: value => desktop.setTheme(value) });\n", ''],
    ["      'desktop.theme': {\n        title: 'Theme',\n        description: 'Colors across the sidebar and plugin pages.',\n        type: 'string', default: 'dark',\n        enum: [],\n      },\n", ''],
    [", 'desktop.theme': state.theme ?? 'dark'", ''],
    ["const keys = ['desktop.theme', 'desktop.interfaceSize',", "const keys = ['desktop.interfaceSize',"],
    ["    document.body.dataset.colorTheme = state.theme ?? 'dark';\n    document.body.dataset.themeFamily = state.themeFamily ?? 'default';\n    element('setting-desktop.theme')?.syncTheme(state.theme);\n", ''],
    ["    svg.setAttribute('fill', name === 'claude' ? 'currentColor' : 'none');", "    svg.setAttribute('fill', 'none');"],
    ["    svg.setAttribute('stroke', name === 'claude' ? 'none' : 'currentColor');", "    svg.setAttribute('stroke', 'currentColor');"],
    ["    status.append(icon('claude'));\n", ''],
    ["    ui.toggleSidebar.replaceChildren(icon('panel-left'));", "    ui.toggleSidebar.replaceChildren(icon(sidebarCollapsed ? 'panel-left-open' : 'panel-left-close'));"],
    ["  ui.toggleSidebar.append(icon('panel-left'));", "  ui.toggleSidebar.append(icon('panel-left-close'));"],
    ["    'panel-left': ['M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2Z', 'M9 3v18'],", "    'panel-left-close': ['M3 3h18v18H3z', 'M9 3v18', 'm16 15-3-3 3-3'],\n    'panel-left-open': ['M3 3h18v18H3z', 'M9 3v18', 'm14 9 3 3-3 3'],"],
    ["  const sidebarList = window.goSidebarList.create(document, desktop, {\n    list: ui.workspaceList, createRow: createSessionRow, updateRow: updateSessionRow, render, formatPath,\n  });\n", ''],
    ["    row.dataset.workspacePath = workspacePath;\n", ''],
    ['    const items = sidebarList.prepare(state);', '    const items = Array.isArray(state.workspaces) ? state.workspaces : [];'],
    ['      entry.container.hidden = sidebarList.merged;\n', ''],
    ['    sidebarList.renderMerged(phase);\n', ''],
    ["    folderIcon.className = 'workspace-folder-icon';\n", ''],
    ["    newSession.append(icon('plus'));", "    newSession.append(icon('message-square-plus'));"],
    ["    'folder-plus': ['M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z', 'M12 10v6', 'M9 13h6'],\n", ''],
    ['Start a new chat in an available project', 'Start a new chat in an available workspace'],
    ["    } else if (key === 'desktop.interfaceSize') {\n      control = window.goInterfaceSizeControl.create(document, { value: current, status, save: value => desktop.setInterfaceSize(value) });\n", ''],
    ["      'desktop.interfaceSize': {\n        title: 'Interface Size',\n        description: 'Text size across the sidebar, settings, and plugin pages.',\n        type: 'string', default: 'small',\n        enum: ['small', 'medium', 'large'], enumItemLabels: ['Small', 'Medium', 'Large'],\n      },\n", ''],
    [", 'desktop.interfaceSize': state.interfaceSize ?? 'small'", ''],
    ["const keys = ['desktop.interfaceSize', 'desktop.transcriptWidth',", "const keys = ['desktop.transcriptWidth',"],
    ["    void runCommand('plugin', () => desktop.reloadPlugin());", "    void runCommand('plugin', () => state.pluginSetup?.status === 'ready'\n      ? desktop.reloadPlugin() : desktop.showPluginSetup(true));"],
    ["    if (elapsed < 60_000) return 'now';", "    if (elapsed < 60_000) return 'Just now';"],
    ['    if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;', '    if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} min ago`;'],
    ['    if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;', '    if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} hr ago`;'],
    ['    if (elapsed < 30 * 86_400_000) return `${Math.floor(elapsed / 86_400_000)}d`;', '    if (elapsed < 30 * 86_400_000) return `${Math.floor(elapsed / 86_400_000)} days ago`;'],
    ['    if (elapsed < 365 * 86_400_000) return `${Math.floor(elapsed / (30 * 86_400_000))}mo`;\n', ''],
    ['    return `${Math.floor(elapsed / (365 * 86_400_000))}y`;', "    return new Date(value).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });"],
    [String.raw`  function formatOutputLog(line) {
    // Only format the host's leading timestamp; leave plugin text and saved logs intact.
    return String(line).replace(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))(?= \[)/, timestamp => {
      const date = new Date(timestamp);
      if (!Number.isFinite(date.getTime())) return timestamp;
      const pad = value => String(value).padStart(2, '0');
      const day = [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join('-');
      const time = [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join(':');
      const fraction = timestamp.includes('.') ? '.' + String(date.getMilliseconds()).padStart(3, '0') : '';
      return day + ' ' + time + fraction;
    });
  }

`, ''],
    ["logs.map(formatOutputLog).join('\\n')", "logs.map(String).join('\\n')"],
    ["    const openingLogs = Boolean(state.logsOpen) && !logsOpen;\n", ''],
    ["    if (openingLogs) ui.logOutput.scrollTop = ui.logOutput.scrollHeight;\n", ''],
    ["  const formatPath = value => desktop?.formatPath?.(value) ?? String(value);\n", ''],
    ['${formatPath(workspacePath)}', '${workspacePath}'],
    ['      const name = formatPath(item.name || item.path);', '      const name = String(item.name || item.path);'],
    ['      entry.open.title = formatPath(item.path);', '      entry.open.title = String(item.path);'],
    ['${formatPath(state.workspace)}', '${state.workspace}'],
    ["    ui.setupDirectory.textContent = formatPath(setup.directory ?? '');", "    ui.setupDirectory.textContent = setup.directory ?? '';"],
    ["    entry.sessionLimit ??= 5;\n    const total = sessions.length;\n    sessions = sessions.slice(0, entry.sessionLimit);\n", ''],
    ["    if (!entry.loadMore) {\n      entry.loadMore = document.createElement('button');\n      entry.loadMore.type = 'button';\n      entry.loadMore.className = 'session-load-more';\n      entry.loadMore.textContent = 'Show More';\n      entry.loadMore.addEventListener('click', () => {\n        entry.sessionLimit += 5;\n        render();\n        if (entry.loadMore.hidden) entry.sessionList.querySelector('.session-row:last-of-type .session-item')?.focus();\n      });\n    }\n    entry.loadMore.hidden = total <= sessions.length;\n    entry.loadMore.setAttribute('aria-label', `Show more chats in ${entry.label.textContent}`);\n    if (entry.sessionList.lastElementChild !== entry.loadMore) entry.sessionList.append(entry.loadMore);\n", ''],
    ["      entry.open.setAttribute('aria-label', `${entry.expanded ? 'Collapse' : 'Expand'} ${entry.label.textContent}`);\n", ''],
    ["      if (!entry.expanded) {\n        entry.sessionLimit = 5;\n        render();\n      }\n", ''],
    ["    if (key === 'desktop.transcriptWidth') {\n      control = window.goWidthControl.create(document, { value: current, status, save: value => desktop.setTranscriptWidth(value) });\n    } else if (property.type === 'boolean') {", "    if (property.type === 'boolean') {"],
    ["  ui.setupImport.addEventListener('click', () => { void runCommand('plugin', () => desktop.importPlugin()); });", "  ui.setupSelectCli.addEventListener('click', () => { void runCommand('plugin', () => desktop.selectClaude()); });\n  ui.setupImport.addEventListener('click', () => { void runCommand('plugin', () => desktop.importPlugin()); });"],
    ["  ui.pluginUpdate.addEventListener('click', () => {", "  element('setup-copy-install').addEventListener('click', () => {\n    void runCommand('copy-install', async () => {\n      await desktop.copyInstallCommand();\n      element('setup-copy-install').textContent = 'Copied';\n      setTimeout(() => { element('setup-copy-install').textContent = 'Copy'; }, 1600);\n    });\n  });\n  ui.pluginUpdate.addEventListener('click', () => {"],
    // Desktop-only column widths have their own behavioral tests in transcript-width.test.cjs.
    ["    const properties = {\n      'desktop.transcriptWidth': {\n        title: 'Transcript Width',\n        description: 'Maximum width of the transcript and composer columns.',\n        type: 'string', default: 'narrow',\n        enum: ['narrow', 'medium', 'wide'], enumItemLabels: ['Narrow', 'Medium', 'Wide'],\n      },\n      ...Object.fromEntries(Object.entries(settingsData.properties ?? {})\n        .filter(([key]) => !unsupportedSettings.has(key))),\n    };\n    const values = { ...settingsData.values, 'desktop.transcriptWidth': state.transcriptWidth ?? 'narrow' };\n    const keys = ['desktop.transcriptWidth', ...settingOrder.map(key => `claudeCode.${key}`)];", "    const properties = Object.fromEntries(Object.entries(settingsData.properties ?? {})\n      .filter(([key]) => !unsupportedSettings.has(key)));\n    const values = settingsData.values ?? {};\n    const keys = settingOrder.map(key => `claudeCode.${key}`);"],
    ["    newChat: element('new-chat'),\n", ''],
    ["  ui.newChat.replaceChildren(icon('plus'), document.createTextNode('New Chat'));\n", ''],
    ["    ui.newChat.disabled = !desktop || phase !== 'active' || pending.has('new-chat') || Boolean(state.settingsOpen || state.pluginSetupOpen || state.viewLoading);\n    ui.newChat.title = items.some(item => item.path === state.workspace) ? `New Chat in ${state.workspace}` : 'Start a new chat in an available workspace';\n", ''],
    ["  ui.newChat.addEventListener('click', () => {\n    void runCommand('new-chat', () => desktop.newSession());\n  });\n", ''],
    ["          if (!ui.newChat.disabled) ui.newChat.click();", "          void runCommand(`new-session:${state.workspace}`, () => desktop.newSession(state.workspace));"],
    ['Open VSIX Output for error details.', 'Open Output for error details.'],
    ['    if (window.__goRenderSetup) return window.__goRenderSetup(state);\n', ''],
    ["    plus: ['M12 5v14', 'M5 12h14'],\n", ''],
    ["  ui.addWorkspace.replaceChildren(icon('folder-plus'));\n", ''],
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
    // User-approved Claude status glyph, copied from the installed plugin.
    if (name === 'shell.js') baseline = baseline.replace(/  \/\/ Original path from the plugin's resources\/claude-logo\.svg\.\n  iconPaths\.claude = \['[^'\n]+'\];\n\n/, '');
    if (name === 'shell.css') {
      baseline = baseline.replace(/calc\((\d+(?:\.\d+)?px) \* var\(--host-font-scale, 1\)\)/g, '$1');
      // Theme overrides retain the original Default colors as their fallbacks.
      baseline = baseline.replace(/var\(--shell-(?:focus-color|success|warning|error|window-hover-foreground), (#[\da-f]+)\)/gi, '$1');
      baseline = baseline.replace(/var\(--shell-window-hover-background, (rgba\([^)]*\)|#[\da-f]+)\)/gi, '$1');
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
