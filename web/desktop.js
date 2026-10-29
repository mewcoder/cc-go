'use strict';

(() => {
  const config = window.__goDesktopConfig;
  const stateListeners = new Set();
  const actionListeners = new Set();
  const frames = new Map();
  const composers = new Map();
  let latest, timer, stopped = false;
  let refreshStarted = 0, refreshApplied = 0;
  let draftUpdates = Promise.resolve();
  const draftSensitiveActions = new Set(['workspace', 'new', 'open-session', 'select-project', 'select-branch', 'retry', 'import', 'close']);
  let sidebarWidth = 248, sidebarCollapsed = false;
  let logsPending = false;
  let hud;
  let chooser;

  async function request(method, args) {
    const response = await fetch('/api/' + method, {
      method: args === undefined ? 'GET' : 'POST',
      headers: { 'X-Claude-Desktop-Token': config.token, 'Content-Type': 'application/json' },
      ...(args === undefined ? {} : { body: JSON.stringify(args) }),
    });
    const text = await response.text();
    let result;
    try { result = JSON.parse(text); } catch { result = { error: text }; }
    if (!response.ok) throw new Error(result.error || text);
    return result;
  }

  function reportDraft(id, draft) {
    draftUpdates = draftUpdates.catch(() => {}).then(async () => {
      if (!frames.has(id)) return;
      try { await request('view-draft', { id, draft }); }
      catch (error) { if (frames.has(id)) throw error; }
    });
    return draftUpdates;
  }

  function layout() {
    if (!latest || !document.body) return;
    const integrated = ['darwin', 'win32'].includes(config.platform);
    const left = sidebarCollapsed ? integrated ? 0 : 36 : sidebarWidth + 4;
    const top = config.platform === 'win32' || config.platform === 'darwin' && sidebarCollapsed ? 30 : 0;
    const bottom = latest.logsOpen ? 256 : 0;
    for (const frame of frames.values()) {
      frame.style.left = left + 'px';
      frame.style.top = top + 'px';
      frame.style.width = Math.max(0, innerWidth - left) + 'px';
      frame.style.height = Math.max(0, innerHeight - top - bottom) + 'px';
    }
    const active = latest.views?.find(view => view.active);
    const frame = frames.get(active?.id), composer = composers.get(active?.id);
    const width = Math.max(0, innerWidth - left), height = Math.max(0, innerHeight - top - bottom);
    const rect = composer?.rect;
    hud?.setDraft(composer?.hasDraft !== false);
    chooser?.sync(latest);
    const fits = rect && composer.viewport.width === width && composer.viewport.height === height
      && rect.left >= 0 && rect.top >= 0 && rect.left + rect.width <= width + 1
      && rect.top + rect.height + window.goHUD.gap + window.goHUD.height <= height + 1;
    hud?.layout(frame && !frame.hidden && fits
      ? { left: left + rect.left, top: top + rect.top + rect.height + window.goHUD.gap, width: rect.width } : null);
  }

  window.addEventListener('message', event => {
    if (event.data?.type !== 'claude-host:composer') return;
    const entry = [...frames].find(([, frame]) => frame.contentWindow === event.source);
    if (!entry || event.origin !== new URL(entry[1].dataset.url).origin) return;
    const { rect, viewport, hasDraft } = event.data;
    if (typeof hasDraft !== 'boolean') return;
    if (!viewport || ![viewport.width, viewport.height].every(value => Number.isFinite(value) && value > 0)) return;
    if (rect !== null && (!rect || ![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)
      || rect.width <= 0 || rect.height <= 0)) return;
    const previous = composers.get(entry[0]);
    composers.set(entry[0], { rect, viewport, hasDraft });
    if (previous?.hasDraft !== hasDraft) {
      void reportDraft(entry[0], hasDraft).catch(error => console.error('Go desktop draft state:', error));
    }
    layout();
  });

  function mountViews(state) {
    if (!document.body) return;
    const ids = new Set(state.views.map(view => view.id));
    for (const [id, frame] of frames) {
      if (!ids.has(id)) { frame.remove(); frames.delete(id); composers.delete(id); }
    }
    for (const view of state.views) {
      if (!view.ready) continue;
      let frame = frames.get(view.id);
      if (!frame) {
        frame = document.createElement('iframe');
        frame.className = 'go-extension-view';
        frame.title = 'Claude extension view';
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-downloads');
        frame.setAttribute('allow', 'clipboard-read; clipboard-write');
        frame.referrerPolicy = 'no-referrer';
        frames.set(view.id, frame);
        document.body.append(frame);
      }
      const url = view.url + '?revision=' + view.revision;
      if (frame.dataset.url !== url) { composers.delete(view.id); frame.dataset.url = url; frame.src = url; }
      frame.hidden = !view.active || state.phase !== 'active' || state.settingsOpen || state.pluginSetupOpen;
    }
    if (!chooser && window.goSelection) chooser = window.goSelection.create(document, { request, invoke });
    if (!hud && window.goHUD) hud = window.goHUD.create(document, chooser ? {
      project: field => chooser.open('project', latest, field),
      branch: field => chooser.open('branch', latest, field),
    } : undefined);
    hud?.render(state);
    layout();
  }

  async function refresh() {
    const sequence = ++refreshStarted;
    const state = await request('state');
    // An action refresh can overtake the background poll. Never restore its older snapshot.
    if (sequence < refreshApplied) return latest;
    refreshApplied = sequence;
    latest = state;
    sidebarWidth = state.sidebarWidth;
    sidebarCollapsed = state.sidebarCollapsed;
    mountViews(state);
    for (const callback of stateListeners) callback(state);
    document.getElementById('connection-status')?.setAttribute('aria-expanded', String(state.logsOpen));
    return state;
  }

  async function invoke(method, args = {}) {
    if (draftSensitiveActions.has(method)) {
      // Flush all views, including hidden drafts, before an operation can replace the host.
      for (const id of frames.keys()) await reportDraft(id, composers.get(id)?.hasDraft !== false);
    }
    const value = await request(method, args);
    await refresh();
    return value;
  }

  async function toggleLogs() {
    if (!latest || logsPending) return;
    logsPending = true;
    try { await invoke('ui', { key: 'logs', open: !latest.logsOpen }); }
    catch (error) { console.error('Go desktop logs:', error); }
    finally { logsPending = false; }
  }

  Object.defineProperty(window, 'desktop', { value: Object.freeze({
    platform: config.platform,
    getState: refresh,
    onState(callback) { stateListeners.add(callback); return () => stateListeners.delete(callback); },
    onAction(callback) { actionListeners.add(callback); return () => actionListeners.delete(callback); },
    checkPlugin: () => invoke('retry'),
    reloadPlugin: () => invoke('retry'),
    startUsing: () => invoke('start'),
    showPluginSetup: open => invoke('ui', { key: 'setup', open }),
    selectClaude: async () => { await invoke('native', { key: 'select-claude' }); return invoke('retry'); },
    selectNode: async () => { await invoke('native', { key: 'select-node' }); return invoke('retry'); },
    downloadNode: () => invoke('native', { key: 'download-node' }),
    importPlugin: () => invoke('import'),
    openPluginDirectory: () => invoke('native', { key: 'folder' }),
    copyInstallCommand: () => invoke('native', { key: 'copy-install' }),
    openPluginDownload: () => invoke('native', { key: 'download' }),
    showLogs: open => invoke('ui', { key: 'logs', open }),
    addWorkspace: () => invoke('workspace'),
    historyProjects: () => request('history-projects', {}),
    importProjects: paths => invoke('import-projects', { paths }),
    switchWorkspace: path => invoke('workspace', { path }),
    openWorkspaceFolder: path => request('open-workspace-folder', { path }),
    removeWorkspace: path => invoke('remove-workspace', { path }),
    openSession: (workspace, id) => invoke('open-session', { workspace, id }),
    renameSession: (workspace, id, title) => invoke('session-meta', { workspace, id, title }),
    archiveSession: (workspace, id, archived) => invoke('session-meta', { workspace, id, archived }),
    newSession: workspace => invoke('new', { workspace }),
    openSettings: async () => { const value = await request('settings', {}); await invoke('ui', { key: 'settings', open: true }); return value; },
    closeSettings: () => invoke('ui', { key: 'settings', open: false }),
    updateSetting: (key, value) => request('settings-update', { key, value }),
    setTranscriptWidth: value => invoke('ui', { key: 'transcript-width', value }),
    setTheme: theme => invoke('theme', { theme }),
    setSidebar: options => {
      if (options.width !== undefined) sidebarWidth = options.width;
      if (options.collapsed !== undefined) sidebarCollapsed = options.collapsed;
      layout();
      return request('ui', { key: 'sidebar', ...options });
    },
  }), writable: false, configurable: false });

  window.__goDesktopAction = action => {
    if (action === 'open-setup') {
      void invoke('ui', { key: 'setup', open: true }).catch(error => console.error('Setup:', error));
      return;
    }
    for (const callback of actionListeners) callback(action);
  };
  window.addEventListener('resize', layout);
  window.addEventListener('beforeunload', () => { stopped = true; clearTimeout(timer); });
  window.addEventListener('DOMContentLoaded', () => {
    const connection = document.getElementById('connection-status');
    connection.setAttribute('role', 'button');
    connection.setAttribute('aria-controls', 'log-panel');
    connection.addEventListener('click', () => { void toggleLogs(); });
    connection.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        void toggleLogs();
      }
    });
    (async function poll() {
      try { await refresh(); } catch (error) { console.error('Go desktop:', error); }
      if (!stopped) timer = setTimeout(poll, document.hidden ? 2500 : 750);
    })();
  });
})();
