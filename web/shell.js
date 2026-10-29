'use strict';

(() => {
  const desktop = window.desktop;
  const integratedTitlebar = ['darwin', 'win32'].includes(desktop?.platform);
  document.documentElement.dataset.platform = desktop?.platform || 'unknown';
  const element = (id) => document.getElementById(id);
  const ui = {
    windowControls: element('window-controls'),
    sidebarHeader: document.querySelector('.sidebar-header'),
    content: document.querySelector('.content'),
    connectionStatus: element('connection-status'),
    connectionLabel: element('connection-label'),
    pluginUpdate: element('plugin-update'),
    setup: element('plugin-setup'),
    setupTitle: element('setup-title'),
    setupSteps: [...element('setup-steps').children],
    setupBack: element('setup-back'),
    setupStatus: element('setup-status-text'),
    setupIndicator: element('setup-indicator'),
    setupProgress: element('setup-progress'),
    setupCliVersion: element('setup-cli-version'),
    setupPlatform: element('setup-platform'),
    setupError: element('setup-error'),
    setupInstall: element('setup-install'),
    setupRetry: element('setup-retry'),
    setupSelectCli: element('setup-select-cli'),
    setupImport: element('setup-import'),
    setupOffline: document.querySelector('.setup-offline'),
    setupDirectory: element('setup-open-directory'),
    workspaceList: element('workspace-list'),
    toggleWorkspaces: element('toggle-workspaces'),
    addWorkspace: element('add-workspace'),
    newChat: element('new-chat'),
    toggleArchive: element('toggle-archive'),
    archiveList: element('archive-list'),
    archiveCount: element('archive-count'),
    toggleSidebar: element('toggle-sidebar'),
    resizer: element('sidebar-resizer'),
    openSettings: element('open-settings'),
    theme: element('toggle-theme'),
    closeLogs: element('close-logs'),
    settingsPanel: element('settings-panel'),
    settingsTitle: element('settings-title'),
    settingsContent: element('settings-content'),
    settingsList: element('settings-list'),
    closeSettings: element('close-settings'),
    message: element('phase-message'),
    messageTitle: element('message-title'),
    messageDetail: element('message-detail'),
    logPanel: element('log-panel'),
    logOutput: element('log-output'),
  };
  const phaseNames = {
    starting: 'Starting',
    setup: 'Setup',
    activating: 'Starting Claude Code',
    active: 'Ready',
    error: 'Error',
  };
  const sessionStatusDisplay = {
    working: 'Working',
    needs_input: 'Needs input',
    completed: 'Done',
    interrupted: 'Stopped',
    error: 'Error',
    idle: 'Idle',
  };
  const pending = new Set();
  const workspaceElements = new Map();
  const archiveElements = new Map();
  let archiveExpanded = false;
  const collapsedWorkspaces = new Set();
  try {
    const saved = JSON.parse(localStorage.getItem('collapsedWorkspaces') || '[]');
    if (Array.isArray(saved)) for (const path of saved) if (typeof path === 'string') collapsedWorkspaces.add(path);
  } catch { /* ignore malformed UI state */ }

  function saveCollapsed() {
    localStorage.setItem('collapsedWorkspaces', JSON.stringify([...collapsedWorkspaces]));
  }

  const sidebarMinWidth = 180;
  const sidebarMaxWidth = 420;
  const sidebarCollapseThreshold = 140;
  let sidebarWidth = 248;
  let sidebarCollapsed = false;
  let sidebarInitialized = false;
  let hasEnteredApp = false;
  let sidebarDrag;
  let sidebarFrame = 0;
  let pendingSidebarWidth = sidebarWidth;

  function clampSidebarWidth(value) {
    return Math.min(sidebarMaxWidth, Math.max(sidebarMinWidth, Math.round(value)));
  }

  function applySidebar() {
    document.documentElement.style.setProperty('--shell-sidebar-width', `${sidebarWidth}px`);
    document.body.classList.toggle('sidebar-collapsed', sidebarCollapsed);
    ui.resizer.hidden = sidebarCollapsed;
    ui.resizer.setAttribute('aria-valuenow', String(sidebarWidth));
    ui.toggleSidebar.replaceChildren(icon(sidebarCollapsed ? 'panel-left-open' : 'panel-left-close'));
    ui.toggleSidebar.title = sidebarCollapsed ? 'Show Sidebar' : 'Hide Sidebar';
    ui.toggleSidebar.setAttribute('aria-label', ui.toggleSidebar.title);
    if (!integratedTitlebar) {
      const parent = sidebarCollapsed ? ui.content : ui.sidebarHeader;
      if (ui.windowControls.parentElement !== parent) {
        const focused = document.activeElement === ui.toggleSidebar;
        parent.prepend(ui.windowControls);
        if (focused) ui.toggleSidebar.focus({ preventScroll: true });
      }
    }
  }

  function endSidebarDrag(event) {
    if (!sidebarDrag) return;
    sidebarDrag = null;
    document.body.classList.remove('sidebar-resizing');
    if (sidebarFrame) {
      cancelAnimationFrame(sidebarFrame);
      sidebarFrame = 0;
    }
    void desktop.setSidebar({ width: sidebarWidth, collapsed: sidebarCollapsed, persist: true });
    if (event && ui.resizer.hasPointerCapture?.(event.pointerId)) ui.resizer.releasePointerCapture(event.pointerId);
  }

  // Lucide icons (ISC), inlined to keep the shell dependency-free.
  const iconPaths = {
    plus: ['M12 5v14', 'M5 12h14'],
    folder: ['M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'],
    'folder-open': ['m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2'],
    'folder-archive': ['M17 19a2 2 0 1 1-4 0 2 2 0 0 1 4 0Z', 'M20.9 19.8A2 2 0 0 0 22 18V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h5.1', 'M15 11v-1', 'M15 17v-2'],
    'message-square-plus': ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z', 'M12 7v6', 'M9 10h6'],
    pencil: ['m16 3 5 5', 'm3 21 4-1 14-14a2 2 0 0 0-5-5L2 15l-1 5Z'],
    archive: ['M3 3h18v5H3z', 'M5 8v13h14V8', 'M10 12h4'],
    restore: ['M3 7h11a7 7 0 0 1 0 14h-3', 'm7 3-4 4 4 4'],
    settings: ['M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z', 'M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z'],
    sun: ['M12 2v2', 'M12 20v2', 'm4.93 4.93 1.41 1.41', 'm17.66 17.66 1.41 1.41', 'M2 12h2', 'M20 12h2', 'm6.34 17.66-1.41 1.41', 'm19.07 4.93-1.41 1.41', 'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0z'],
    moon: ['M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z'],
    x: ['M18 6 6 18', 'm6 6 12 12'],
    refresh: ['M3 11a9 9 0 0 1 15.4-6.4L21 7', 'M21 3v4h-4', 'M21 13a9 9 0 0 1-15.4 6.4L3 17', 'M7 17H3v4'],
    upgrade: ['M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z', 'M12 16V8', 'm8 12 4-4 4 4'],
    'panel-left-close': ['M3 3h18v18H3z', 'M9 3v18', 'm16 15-3-3 3-3'],
    'panel-left-open': ['M3 3h18v18H3z', 'M9 3v18', 'm14 9 3 3-3 3'],
  };

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('icon');
    for (const data of iconPaths[name]) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', data);
      svg.append(path);
    }
    return svg;
  }

  ui.addWorkspace.replaceChildren(icon('plus'));
  ui.newChat.replaceChildren(icon('plus'), document.createTextNode('New Chat'));
  element('archive-icon').append(icon('folder-archive'));
  ui.closeLogs.append(icon('x'));
  ui.openSettings.append(icon('settings'));
  ui.theme.append(icon('sun'));
  ui.theme.dataset.theme = 'dark';
  ui.closeSettings.append(icon('x'));
  ui.pluginUpdate.append(icon('upgrade'));
  ui.toggleSidebar.append(icon('panel-left-close'));
  applySidebar();

  function relativeTime(timestamp) {
    const value = Number(timestamp);
    if (!Number.isFinite(value) || value <= 0) return '';
    const elapsed = Date.now() - value;
    if (!Number.isFinite(elapsed) || elapsed < 0) return '';
    if (elapsed < 60_000) return 'Just now';
    if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} min ago`;
    if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} hr ago`;
    if (elapsed < 30 * 86_400_000) return `${Math.floor(elapsed / 86_400_000)} days ago`;
    return new Date(value).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
  }

  function refreshSessionTimes() {
    for (const entry of workspaceElements.values()) {
      for (const row of entry.sessions.values()) {
        row.parts.time.textContent = relativeTime(row.session.updatedAt);
      }
    }
  }

  const settingOrder = [
    'useCtrlEnterToSend', 'scrollToBottomOnSend', 'showMessageTimestamps', 'focusView',
    'archiveInactiveSessions', 'respectGitIgnore', 'initialPermissionMode',
    'allowDangerouslySkipPermissions',
    'hideOnboarding', 'disableLoginPrompt', 'claudeProcessWrapper', 'spinnerVerbs',
    'environmentVariables',
  ];
  let settingsData;
  const unsupportedSettings = new Set([
    'claudeCode.useTerminal',
    'claudeCode.autosave',
    'claudeCode.lockEditorGroups',
    'claudeCode.enableNewConversationShortcut',
    'claudeCode.enableReopenClosedSessionShortcut',
    'claudeCode.attachOpenFile',
    'claudeCode.attachSelection',
    'claudeCode.continueAfterReload',
    'claudeCode.usePythonEnvironment',
    'claudeCode.preferredLocation',
  ]);

  async function saveSetting(key, value, status) {
    status.textContent = 'Saving…';
    status.classList.remove('error');
    try {
      if (key === 'desktop.transcriptWidth') await desktop.setTranscriptWidth(value);
      else settingsData = await desktop.updateSetting(key, value);
      status.textContent = 'Saved';
      setTimeout(() => { if (status.textContent === 'Saved') status.textContent = ''; }, 1600);
    } catch (error) {
      status.textContent = errorText(error);
      status.classList.add('error');
    }
  }

  function createSettingControl(key, property, value, status) {
    const current = value ?? property.default;
    let control;
    if (key === 'desktop.transcriptWidth') {
      control = window.goWidthControl.create(document, { value: current, status, save: value => desktop.setTranscriptWidth(value) });
    } else if (property.type === 'boolean') {
      control = document.createElement('input');
      control.type = 'checkbox';
      control.setAttribute('role', 'switch');
      control.className = 'setting-switch';
      control.checked = Boolean(current);
      control.addEventListener('change', () => saveSetting(key, control.checked, status));
    } else if (Array.isArray(property.enum)) {
      control = document.createElement('select');
      if (property.default === undefined) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'Claude default';
        control.append(option);
      }
      for (const [index, option] of property.enum.entries()) {
        const element = document.createElement('option');
        element.value = String(option);
        element.textContent = property.enumItemLabels?.[index] ?? String(option);
        control.append(element);
      }
      control.value = current == null ? '' : String(current);
      control.addEventListener('change', () => saveSetting(key, control.value === '' ? undefined : property.type === 'number' ? Number(control.value) : control.value, status));
    } else if (property.type === 'number') {
      control = document.createElement('input');
      control.type = 'number';
      control.value = String(current ?? '');
      control.addEventListener('change', () => {
        const number = Number(control.value);
        if (Number.isFinite(number)) saveSetting(key, number, status);
      });
    } else if (property.type === 'array' || property.type === 'object') {
      control = document.createElement('textarea');
      control.value = JSON.stringify(current ?? (property.type === 'array' ? [] : {}), null, 2);
      control.addEventListener('blur', () => {
        try {
          const parsed = JSON.parse(control.value);
          control.classList.remove('invalid');
          saveSetting(key, parsed, status);
        } catch {
          control.classList.add('invalid');
          status.textContent = 'Invalid JSON';
          status.classList.add('error');
        }
      });
    } else {
      control = document.createElement('input');
      control.type = 'text';
      control.value = String(current ?? '');
      control.placeholder = 'Use default';
      control.addEventListener('change', () => saveSetting(key, control.value, status));
    }
    control.id = `setting-${key}`;
    control.setAttribute('aria-describedby', `description-${key} status-${key}`);
    return control;
  }

  function renderSettings() {
    if (!settingsData) return;
    const properties = {
      'desktop.transcriptWidth': {
        title: 'Transcript Width',
        description: 'Maximum width of the transcript and composer columns.',
        type: 'string', default: 'narrow',
        enum: ['narrow', 'medium', 'wide'], enumItemLabels: ['Narrow', 'Medium', 'Wide'],
      },
      ...Object.fromEntries(Object.entries(settingsData.properties ?? {})
        .filter(([key]) => !unsupportedSettings.has(key))),
    };
    const values = { ...settingsData.values, 'desktop.transcriptWidth': state.transcriptWidth ?? 'narrow' };
    const keys = ['desktop.transcriptWidth', ...settingOrder.map(key => `claudeCode.${key}`)];
    const knownKeys = new Set(keys);
    const extraKeys = Object.keys(properties).filter(key => !knownKeys.has(key));
    keys.push(...extraKeys);
    ui.settingsList.replaceChildren();
    for (const key of keys) {
      const property = properties[key];
      if (!property) continue;
      const row = document.createElement('div');
      row.className = 'setting-row';
      row.classList.toggle('setting-row-stacked', property.type === 'array' || property.type === 'object' || property.type === 'string' && !property.enum);
      const copy = document.createElement('div');
      copy.className = 'setting-copy';
      const label = document.createElement('label');
      label.className = 'setting-label';
      label.htmlFor = `setting-${key}`;
      label.title = key;
      const title = property.title ?? key.replace(/^claudeCode\./, '')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/\b\w/g, letter => letter.toUpperCase());
      label.append(document.createTextNode(title));
      const description = document.createElement('p');
      description.className = 'setting-description';
      description.id = `description-${key}`;
      description.textContent = property.description ?? property.markdownDescription ?? '';
      copy.append(label, description);
      const controls = document.createElement('div');
      controls.className = 'setting-control';
      const status = document.createElement('span');
      status.className = 'setting-status';
      status.id = `status-${key}`;
      status.setAttribute('role', 'status');
      if (property.type === 'array' || property.type === 'object') {
        const hint = document.createElement('span');
        hint.className = 'setting-format';
        hint.textContent = 'JSON';
        controls.append(hint);
      }
      controls.append(createSettingControl(key, property, values[key], status), status);
      row.append(copy, controls);
      ui.settingsList.append(row);
    }
  }
  let state = { phase: 'starting', label: '', logs: [], tabs: [] };
  let logsOpen = false;
  let actionError = '';
  let unsubscribe;
  let unsubscribeActions;
  let revision = 0;

  const errorText = (error) => String(error?.message || error || 'Unknown error');

  async function runCommand(key, action) {
    if (!desktop || pending.has(key)) return;
    pending.add(key);
    actionError = '';
    render();
    try {
      await action();
    } catch (error) {
      actionError = errorText(error);
    } finally {
      pending.delete(key);
      render();
    }
  }

  function createWorkspaceNode(path) {
    const container = document.createElement('div');
    container.className = 'workspace-group';
    const row = document.createElement('div');
    row.className = 'workspace-row';
    const expanded = !collapsedWorkspaces.has(path);
    const folderIcon = document.createElement('span');
    folderIcon.append(icon(expanded ? 'folder-open' : 'folder'));
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'workspace-open';
    open.dataset.path = path;
    const label = document.createElement('span');
    label.className = 'workspace-label';
    open.append(folderIcon, label);
    const newSession = document.createElement('button');
    newSession.type = 'button';
    newSession.className = 'workspace-new';
    newSession.title = 'New Chat';
    newSession.setAttribute('aria-label', 'New Chat');
    newSession.append(icon('message-square-plus'));
    newSession.addEventListener('click', () => {
      void runCommand(`new-session:${path}`, () => desktop.newSession(path));
    });
    row.append(open, newSession);
    const sessionList = document.createElement('div');
    sessionList.className = 'session-list';
    container.append(row, sessionList);
    open.addEventListener('click', () => {
      const entry = workspaceElements.get(path);
      if (!entry) return;
      if (collapsedWorkspaces.has(path)) collapsedWorkspaces.delete(path);
      else collapsedWorkspaces.add(path);
      saveCollapsed();
      entry.sessionList.hidden = collapsedWorkspaces.has(path);
      entry.expanded = !collapsedWorkspaces.has(path);
      entry.folderIcon.replaceChildren(icon(entry.expanded ? 'folder-open' : 'folder'));
      entry.open.setAttribute('aria-expanded', String(entry.expanded));
      entry.open.setAttribute('aria-label', `${entry.expanded ? 'Collapse' : 'Expand'} ${entry.label.textContent}`);
    });
    const entry = { container, row, open, label, folderIcon, newSession, sessionList, expanded, sessions: new Map() };
    workspaceElements.set(path, entry);
    return entry;
  }

  function createSessionRow(workspacePath, id, archived) {
    const row = document.createElement('div');
    row.className = 'session-row';
    row.dataset.sessionId = id;
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'session-item';
    const title = document.createElement('span');
    title.className = 'session-title';
    const status = document.createElement('span');
    status.className = 'session-status';
    status.setAttribute('aria-hidden', 'true');
    const time = document.createElement('span');
    time.className = 'session-time';
    open.append(status, title, time);
    open.addEventListener('click', () => {
      void runCommand(`open-session:${id}`, () => desktop.openSession(workspacePath, id));
    });
    const input = document.createElement('input');
    input.className = 'session-rename';
    input.type = 'text';
    input.maxLength = 200;
    input.setAttribute('aria-label', 'Chat name');
    input.hidden = true;
    const finishRename = (cancel = false) => {
      if (!row.editing) return;
      const value = input.value.trim();
      row.editing = false;
      input.hidden = true;
      open.hidden = false;
      if (!cancel && value && value !== row.session.title) {
        void runCommand(`rename-session:${id}`, () => desktop.renameSession(workspacePath, id, value));
      }
    };
    input.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'Enter' || event.key === 'Escape') {
        event.preventDefault();
        finishRename(event.key === 'Escape');
        open.focus();
      }
    });
    input.addEventListener('blur', () => finishRename());
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'session-action';
    rename.append(icon('pencil'));
    rename.addEventListener('click', () => {
      row.editing = true;
      input.value = row.session.title;
      open.hidden = true;
      input.hidden = false;
      input.focus();
      input.select();
    });
    const archive = document.createElement('button');
    archive.type = 'button';
    archive.className = 'session-action';
    archive.append(icon(archived ? 'restore' : 'archive'));
    archive.addEventListener('click', () => {
      void runCommand(`archive-session:${id}`, () => desktop.archiveSession(workspacePath, id, !archived));
    });
    row.append(open, input, rename, archive);
    row.parts = { open, status, title, time, input, rename, archive };
    return row;
  }

  function updateSessionRow(row, session, workspacePath, phase, archived = false) {
    row.session = session;
    const { open, status, title, time, rename, archive } = row.parts;
    const name = String(session.title || 'Chat');
    title.textContent = name;
    const statusName = session.status === 'completed' && !session.completionUnread
      ? 'idle' : Object.hasOwn(sessionStatusDisplay, session.status) ? session.status : 'idle';
    const label = sessionStatusDisplay[statusName];
    status.hidden = archived;
    if (status.dataset.status !== statusName) {
      status.dataset.status = statusName;
    }
    status.title = label;
    open.title = archived ? `${name}\n${workspacePath}` : `${name}\n${label}`;
    open.setAttribute('aria-label', archived ? name : `${name}, ${label}`);
    row.classList.toggle('active', Boolean(session.active));
    time.textContent = archived ? '' : relativeTime(session.updatedAt);
    time.title = session.updatedAt ? `Last activity: ${new Date(Number(session.updatedAt)).toLocaleString('en-US')}` : '';
    const busy = !desktop || phase === 'starting' || phase === 'activating'
      || pending.has(`open-session:${session.id}`) || pending.has(`rename-session:${session.id}`)
      || pending.has(`archive-session:${session.id}`) || pending.has(`switch:${workspacePath}`);
    open.disabled = busy;
    rename.disabled = busy;
    archive.disabled = busy;
    rename.title = 'Rename Chat';
    rename.setAttribute('aria-label', `Rename ${name}`);
    archive.title = archived ? 'Unarchive Chat' : 'Archive Chat';
    archive.setAttribute('aria-label', `${archived ? 'Unarchive' : 'Archive'} ${name}`);
  }

  function renderSessions(entry, workspacePath, sessions, phase) {
    const ids = new Set(sessions.map((session) => session.id));
    for (const [id, node] of entry.sessions) {
      if (!ids.has(id)) {
        node.remove();
        entry.sessions.delete(id);
      }
    }
    sessions.forEach((session, index) => {
      let row = entry.sessions.get(session.id);
      if (!row) {
        row = createSessionRow(workspacePath, session.id, false);
        entry.sessions.set(session.id, row);
      }
      updateSessionRow(row, session, workspacePath, phase);
      if (entry.sessionList.children[index] !== row) {
        entry.sessionList.insertBefore(row, entry.sessionList.children[index] || null);
      }
    });
    let empty = entry.sessionList.querySelector('.session-empty');
    if (!sessions.length && !empty) {
      empty = document.createElement('p');
      empty.className = 'session-empty';
      empty.textContent = 'No chats yet';
      entry.sessionList.append(empty);
    } else if (sessions.length) empty?.remove();
    entry.sessionList.hidden = collapsedWorkspaces.has(workspacePath);
  }

  function renderArchive(phase) {
    const sessions = Array.isArray(state.archivedSessions) ? state.archivedSessions : [];
    const keys = new Set(sessions.map(session => JSON.stringify([session.workspace, session.id])));
    for (const [key, row] of archiveElements) {
      if (!keys.has(key)) {
        row.remove();
        archiveElements.delete(key);
      }
    }
    sessions.forEach((session, index) => {
      const key = JSON.stringify([session.workspace, session.id]);
      let row = archiveElements.get(key);
      if (!row) {
        row = createSessionRow(session.workspace, session.id, true);
        archiveElements.set(key, row);
      }
      updateSessionRow(row, session, session.workspace, phase, true);
      if (ui.archiveList.children[index] !== row) {
        ui.archiveList.insertBefore(row, ui.archiveList.children[index] || null);
      }
    });
    let empty = ui.archiveList.querySelector('.archive-empty');
    if (!sessions.length && !empty) {
      empty = document.createElement('p');
      empty.className = 'archive-empty';
      empty.textContent = 'No archived chats';
      ui.archiveList.append(empty);
    } else if (sessions.length) empty?.remove();
    ui.archiveCount.textContent = String(sessions.length);
    ui.toggleArchive.setAttribute('aria-expanded', String(archiveExpanded));
    ui.archiveList.hidden = !archiveExpanded;
  }

  function renderWorkspaces(phase) {
    const listCollapsed = Boolean(state.workspaceListCollapsed);
    ui.workspaceList.hidden = listCollapsed;
    ui.toggleWorkspaces.setAttribute('aria-expanded', String(!listCollapsed));
    ui.toggleWorkspaces.disabled = !desktop || pending.has('workspace-list');
    const items = Array.isArray(state.workspaces) ? state.workspaces : [];
    const paths = new Set(items.map((item) => item.path));
    for (const [path, entry] of workspaceElements) {
      if (!paths.has(path)) {
        entry.container.remove();
        workspaceElements.delete(path);
      }
    }
    const disabled = !desktop || phase === 'setup' || phase === 'starting' || phase === 'activating';
    items.forEach((item, index) => {
      const entry = workspaceElements.get(item.path) ?? createWorkspaceNode(item.path);
      const collapsed = collapsedWorkspaces.has(item.path);
      const name = String(item.name || item.path);
      entry.row.classList.toggle('active', Boolean(item.active));
      entry.open.classList.toggle('active', Boolean(item.active));
      entry.open.setAttribute('aria-current', item.active ? 'true' : 'false');
      entry.open.title = String(item.path);
      entry.label.textContent = name;
      if (entry.expanded !== !collapsed) {
        entry.expanded = !collapsed;
        entry.folderIcon.replaceChildren(icon(entry.expanded ? 'folder-open' : 'folder'));
      }
      entry.open.setAttribute('aria-expanded', String(!collapsed));
      entry.open.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} ${name}`);
      entry.open.disabled = disabled || pending.has(`switch:${item.path}`);
      entry.newSession.disabled = disabled || pending.has(`new-session:${item.path}`);
      renderSessions(entry, item.path, Array.isArray(item.sessions) ? item.sessions : [], phase);
      if (ui.workspaceList.children[index] !== entry.container) {
        ui.workspaceList.insertBefore(entry.container, ui.workspaceList.children[index] || null);
      }
    });
    ui.addWorkspace.disabled = !desktop || pending.has('add-workspace') || phase === 'setup' || phase === 'starting' || phase === 'activating';
    ui.newChat.disabled = !desktop || phase !== 'active' || pending.has('new-chat') || Boolean(state.settingsOpen || state.pluginSetupOpen || state.viewLoading);
    ui.newChat.title = items.some(item => item.path === state.workspace) ? `New Chat in ${state.workspace}` : 'Start a new chat in an available workspace';
  }

  function renderPluginSetup(phase) {
    const setup = state.pluginSetup ?? {};
    const status = setup.status;
    const busy = ['detecting', 'downloading', 'extracting', 'reloading'].includes(status);
    const visible = phase === 'setup' || Boolean(state.pluginSetupOpen)
      || (!hasEnteredApp && phase === 'activating' && Boolean(state.pluginSetup));
    ui.setup.hidden = !visible;
    ui.setupBack.hidden = phase !== 'active';
    ui.setupTitle.textContent = hasEnteredApp ? 'Update VS Code extension (.vsix)' : 'Setup';
    const step = setup.cliVersion || ['downloading', 'extracting', 'ready', 'reloading', 'idle'].includes(status) ? 1 : 0;
    ui.setupOffline.hidden = step === 0;
    ui.setupSteps.forEach((item, index) => {
      item.classList.toggle('is-current', index === step);
      item.classList.toggle('is-complete', index < step && Boolean(setup.cliVersion));
      if (index === step) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
      item.querySelector('.setup-step-number').textContent = index < step && setup.cliVersion ? '' : String(index + 1);
    });
    const names = { detecting: 'Checking Claude Code…', 'needs-cli': 'Claude Code not found',
      downloading: `Downloading VS Code extension (.vsix) ${setup.targetVersion ?? ''}`, extracting: 'Checking and unpacking VS Code extension (.vsix)…',
      error: setup.cliVersion ? 'VS Code extension (.vsix) is not ready' : 'Claude Code check failed', ready: `${setup.readyVersion} is ready. Reload to use it.`,
      reloading: 'Reloading…', idle: 'Ready' };
    let text = phase === 'activating' ? 'Starting Claude Code…' : names[status] ?? 'Getting ready…';
    if (status === 'downloading' && setup.received) {
      const size = `${(setup.received / 1024 / 1024).toFixed(1)} MB`;
      text += setup.total ? ` · ${Math.min(100, Math.floor(setup.received / setup.total * 100))}%` : ` · ${size}`;
    }
    ui.setupStatus.textContent = text;
    ui.setupIndicator.hidden = !busy;
    ui.setupProgress.hidden = status !== 'downloading';
    if (setup.total) { ui.setupProgress.max = setup.total; ui.setupProgress.value = setup.received ?? 0; }
    else ui.setupProgress.removeAttribute('value');
    ui.setupCliVersion.textContent = setup.cliVersion ?? (status === 'detecting' ? 'Checking' : 'Not found');
    ui.setupCliVersion.title = setup.cliPath ?? '';
    ui.setupPlatform.textContent = setup.platform ?? '';
    ui.setupError.textContent = setup.error || setup.cliError || setup.cacheError || '';
    ui.setupError.hidden = !ui.setupError.textContent;
    ui.setupInstall.hidden = Boolean(setup.cliVersion) || status === 'detecting';
    ui.setupRetry.textContent = status === 'ready' ? 'Reload' : setup.cliVersion && status === 'error' ? 'Try Download Again' : 'Check Again';
    for (const button of [ui.setupRetry, ui.setupSelectCli, ui.setupImport]) button.disabled = busy || pending.has('plugin');
    ui.setupDirectory.textContent = setup.directory ?? '';
    ui.pluginUpdate.hidden = phase !== 'active' || !['downloading', 'extracting', 'ready', 'error', 'reloading'].includes(status);
    ui.pluginUpdate.disabled = busy || pending.has('plugin');
    ui.pluginUpdate.classList.toggle('is-busy', busy);
    ui.pluginUpdate.classList.toggle('is-ready', status === 'ready');
    ui.pluginUpdate.title = status === 'error' ? `${setup.error}\nClick for details or try again` : text;
    ui.pluginUpdate.setAttribute('aria-label', status === 'ready' ? `Reload VS Code extension (.vsix) ${setup.readyVersion}` : ui.pluginUpdate.title);
    if (window.__goRenderSetup) return window.__goRenderSetup(state);
    return visible;
  }

  function render() {
    const phase = Object.hasOwn(phaseNames, state.phase) ? state.phase : 'starting';
    if (phase === 'active') hasEnteredApp = true;
    document.body.dataset.initializing = String(!hasEnteredApp);
    const label = String(state.label || phaseNames[phase]);
    const error = state.error ? errorText(state.error) : '';
    const version = state.extension?.version;
    const extensionId = String(state.extension?.id || 'Claude VS Code extension (.vsix)');

    const settingsOpen = Boolean(state.settingsOpen);
    const theme = state.theme === 'light' ? 'light' : 'dark';
    const setupVisible = renderPluginSetup(phase);
    document.body.dataset.phase = phase;
    document.body.dataset.theme = theme;
    if (ui.theme.dataset.theme !== theme) {
      ui.theme.dataset.theme = theme;
      ui.theme.replaceChildren(icon(theme === 'light' ? 'moon' : 'sun'));
    }
    ui.theme.title = theme === 'light' ? 'Switch to Dark Theme' : 'Switch to Light Theme';
    ui.theme.setAttribute('aria-label', ui.theme.title);
    ui.theme.disabled = !desktop || pending.has('theme');
    renderWorkspaces(phase);
    renderArchive(phase);
    ui.closeLogs.disabled = !desktop || pending.has('logs');
    ui.logPanel.hidden = !logsOpen;
    ui.openSettings.disabled = !desktop || pending.has('settings') || phase !== 'active';
    ui.openSettings.classList.toggle('selected', settingsOpen);
    ui.closeSettings.disabled = !desktop || pending.has('settings');
    if (settingsOpen && !ui.settingsPanel.open) {
      ui.settingsPanel.hidden = false;
      ui.settingsPanel.showModal();
    } else if (!settingsOpen && ui.settingsPanel.open) {
      ui.settingsPanel.close();
      ui.settingsPanel.hidden = true;
    }
    const viewLoading = Boolean(state.viewLoading);
    const loadingView = phase === 'active' && viewLoading;
    ui.message.hidden = (phase === 'active' && !viewLoading) || settingsOpen || setupVisible;
    ui.messageTitle.textContent = phase === 'error' ? 'Could not start Claude Code' : loadingView ? 'Opening chat' : label;
    ui.messageDetail.textContent = phase === 'error'
      ? error || 'Open VSIX Output for error details.'
      : loadingView ? 'Loading Claude Code…'
        : phase === 'activating' ? 'Starting Claude Code.' : 'Setting up Claude Code.';
    const connection = phase === 'error' ? 'Connection failed' : phase === 'active' ? 'Connected' : 'Connecting';
    ui.connectionLabel.textContent = actionError ? 'Action failed'
      : phase === 'active' && version ? String(version) : connection;
    ui.connectionStatus.classList.toggle('has-error', Boolean(actionError) || phase === 'error');
    const versionDetail = version ? `${extensionId} · ${version}` : extensionId;
    ui.connectionStatus.title = `${actionError || error || label}\n${versionDetail}${state.pluginSetup?.cliError ? `\n${state.pluginSetup.cliError}` : ''}`;
    ui.connectionStatus.setAttribute('aria-label', `${actionError || connection}, ${versionDetail}`);

    const logs = Array.isArray(state.logs) ? state.logs : [];
    const logText = logs.length ? logs.map(String).join('\n') : 'No output yet.';
    if (ui.logOutput.textContent !== logText) {
      const follow = ui.logOutput.scrollHeight - ui.logOutput.scrollTop - ui.logOutput.clientHeight <= 24;
      ui.logOutput.textContent = logText;
      if (follow) ui.logOutput.scrollTop = ui.logOutput.scrollHeight;
    }
  }

  async function setLogsOpen(open) {
    if (pending.has('logs') || open === logsOpen) return;
    const previous = logsOpen;
    const restoreFocus = !open && ui.logPanel.contains(document.activeElement);
    await runCommand('logs', async () => {
      logsOpen = open;
      render();
      if (open) ui.logOutput.scrollTop = ui.logOutput.scrollHeight;
      try {
        await desktop.showLogs(open);
      } catch (error) {
        logsOpen = previous;
        throw error;
      }
    });
    if (restoreFocus && !logsOpen) ui.connectionStatus.focus();
  }

  function acceptState(nextState) {
    if (!nextState || typeof nextState !== 'object') return;
    state = nextState;
    if (!sidebarInitialized) {
      sidebarInitialized = true;
      const width = Number(state.sidebarWidth);
      sidebarWidth = Number.isFinite(width) ? clampSidebarWidth(width) : 248;
      sidebarCollapsed = Boolean(state.sidebarCollapsed);
      applySidebar();
    }
    logsOpen = Boolean(state.logsOpen);
    render();
  }

  ui.toggleWorkspaces.addEventListener('click', () => {
    void runCommand('workspace-list', () => desktop.setWorkspaceListCollapsed(!state.workspaceListCollapsed));
  });
  ui.addWorkspace.addEventListener('click', () => {
    void runCommand('add-workspace', () => desktop.addWorkspace());
  });
  ui.newChat.addEventListener('click', () => {
    void runCommand('new-chat', () => desktop.newSession());
  });
  ui.setupRetry.addEventListener('click', () => {
    void runCommand('plugin', () => state.pluginSetup?.status === 'ready' ? desktop.reloadPlugin() : desktop.checkPlugin());
  });
  ui.setupImport.addEventListener('click', () => { void runCommand('plugin', () => desktop.importPlugin()); });
  ui.setupDirectory.addEventListener('click', () => { void runCommand('plugin-folder', () => desktop.openPluginDirectory()); });
  ui.setupBack.addEventListener('click', () => { void runCommand('plugin-panel', () => desktop.showPluginSetup(false)); });
  element('setup-open-download').addEventListener('click', () => { void runCommand('plugin-download', () => desktop.openPluginDownload()); });
  ui.pluginUpdate.addEventListener('click', () => {
    void runCommand('plugin', () => state.pluginSetup?.status === 'ready'
      ? desktop.reloadPlugin() : desktop.showPluginSetup(true));
  });
  ui.toggleArchive.addEventListener('click', () => {
    archiveExpanded = !archiveExpanded;
    renderArchive(state.phase);
  });
  ui.theme.addEventListener('click', () => {
    void runCommand('theme', () => desktop.setTheme(state.theme === 'light' ? 'dark' : 'light'));
  });
  ui.toggleSidebar.addEventListener('click', () => {
    sidebarCollapsed = !sidebarCollapsed;
    applySidebar();
    void desktop.setSidebar({ width: sidebarWidth, collapsed: sidebarCollapsed, persist: true });
  });
  ui.resizer.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || sidebarCollapsed) return;
    sidebarDrag = { startX: event.clientX, startWidth: sidebarWidth };
    document.body.classList.add('sidebar-resizing');
    ui.resizer.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  ui.resizer.addEventListener('pointermove', (event) => {
    if (!sidebarDrag) return;
    const rawWidth = sidebarDrag.startWidth + event.clientX - sidebarDrag.startX;
    if (rawWidth <= sidebarCollapseThreshold) {
      sidebarWidth = sidebarDrag.startWidth;
      sidebarCollapsed = true;
      applySidebar();
      endSidebarDrag(event);
      return;
    }
    sidebarWidth = clampSidebarWidth(rawWidth);
    applySidebar();
    pendingSidebarWidth = sidebarWidth;
    if (!sidebarFrame) {
      sidebarFrame = requestAnimationFrame(() => {
        sidebarFrame = 0;
        void desktop.setSidebar({ width: pendingSidebarWidth, persist: false });
      });
    }
  });
  ui.resizer.addEventListener('pointerup', endSidebarDrag);
  ui.resizer.addEventListener('pointercancel', endSidebarDrag);
  ui.resizer.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    sidebarWidth = clampSidebarWidth(sidebarWidth + (event.key === 'ArrowRight' ? 16 : -16));
    applySidebar();
    void desktop.setSidebar({ width: sidebarWidth, persist: true });
  });
  ui.resizer.addEventListener('dblclick', () => {
    sidebarWidth = 248;
    applySidebar();
    void desktop.setSidebar({ width: sidebarWidth, persist: true });
  });
  ui.closeLogs.addEventListener('click', () => setLogsOpen(false));
  ui.openSettings.addEventListener('click', () => {
    if (state.settingsOpen) {
      void runCommand('settings', () => desktop.closeSettings());
      return;
    }
    void runCommand('settings', async () => {
      settingsData = await desktop.openSettings();
      renderSettings();
      ui.settingsContent.scrollTop = 0;
      requestAnimationFrame(() => {
        if (ui.settingsPanel.open) ui.closeSettings.focus();
      });
    });
  });
  ui.closeSettings.addEventListener('click', () => {
    void runCommand('settings', () => desktop.closeSettings());
  });
  ui.settingsPanel.addEventListener('cancel', (event) => {
    event.preventDefault();
    void runCommand('settings', () => desktop.closeSettings());
  });
  ui.settingsPanel.addEventListener('click', (event) => {
    if (event.target !== ui.settingsPanel) return;
    const bounds = ui.settingsPanel.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
      void runCommand('settings', () => desktop.closeSettings());
    }
  });
  window.addEventListener('beforeunload', () => {
    unsubscribe?.();
    unsubscribeActions?.();
  }, { once: true });

  async function initialize() {
    render();
    try {
      if (!desktop) throw new Error('Cannot connect to the app. Please start it with Electron.');
      unsubscribeActions = desktop.onAction(action => {
        const buttons = {
          'add-workspace': ui.addWorkspace,
          'open-settings': ui.openSettings,
          'toggle-sidebar': ui.toggleSidebar,
          'toggle-theme': ui.theme,
        };
        if (action === 'new-session' && state.phase === 'active' && !state.settingsOpen) {
          if (!ui.newChat.disabled) ui.newChat.click();
        } else if (Object.hasOwn(buttons, action)) buttons[action].click();
      });
      unsubscribe = desktop.onState((nextState) => {
        revision += 1;
        acceptState(nextState);
      });
      const requestRevision = revision;
      const initialState = await desktop.getState();
      if (revision === requestRevision) acceptState(initialState);
    } catch (error) {
      actionError = errorText(error);
      if (revision === 0) state = { ...state, phase: 'error', error: actionError };
      render();
    }
  }

  const timeRefresh = setInterval(refreshSessionTimes, 30_000);
  window.addEventListener('beforeunload', () => clearInterval(timeRefresh), { once: true });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshSessionTimes();
  });
  window.addEventListener('focus', refreshSessionTimes);
  void initialize();
})();
