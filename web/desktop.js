'use strict';

(() => {
  const config = window.__goDesktopConfig;
  // Display only: keep original path keys for APIs, drafts and session history.
  const formatPath = value => config.platform === 'win32'
    ? String(value).replace(/^[a-z]:/, drive => drive.toUpperCase()) : String(value);
  const stateListeners = new Set();
  const actionListeners = new Set();
  const frames = new Map();
  const composers = new Map();
  const titlebarDrags = [];
  let presentedFrame;
  let viewStatus;
  let latest, timer, stopped = false;
  let refreshStarted = 0, refreshApplied = 0;
  let draftUpdates = Promise.resolve();
  let sidebarOptionsSave = Promise.resolve();
  const draftSensitiveActions = new Set(['workspace', 'new', 'open-session', 'select-project', 'select-branch', 'retry', 'import', 'update-plugin', 'close']);
  let sidebarWidth = 248, sidebarCollapsed = false;
  let logsPending = false;
  let hud;
  let chooser;
  let gitReview;
  let projectPending = false, projectWorkspace, projectRevision, projectForce = true;
  let projectFocused = document.hasFocus?.() ?? true;

  function projectVisible() {
    return !stopped && projectFocused && !document.hidden && latest?.windowVisible !== false && latest?.phase === 'active'
      && !latest.pluginSetupOpen && !latest.settingsOpen && !latest.viewLoading;
  }

  async function refreshProject() {
    if (!projectVisible() || projectPending) return;
    const workspace = latest.workspace;
    if (!workspace || !projectForce && projectWorkspace === workspace && projectRevision === latest.projectRevision) return;
    projectForce = false;
    projectPending = true;
    const revision = latest.projectRevision;
    try {
      const project = await request('project', { workspace, force: true });
      if (project && latest?.workspace === workspace && latest.projectRevision === revision
        && projectVisible() && !projectForce) {
        projectWorkspace = workspace;
        projectRevision = revision;
        latest = { ...latest, project };
        renderHUD(latest);
        for (const callback of stateListeners) callback(latest);
      }
    } catch (error) {
      // Retry on the next explicit event, without polling Git after transport failures.
      projectWorkspace = workspace;
      projectRevision = revision;
      console.error('Git status:', error);
    }
    finally { projectPending = false; }
  }

  function requestGitRefresh() {
    projectForce = true;
    return refreshProject();
  }

  function renderHUD(state) {
    const active = state.views?.find(view => view.active);
    hud?.render({ ...state, contextAvailable: frames.get(active?.id)?.contextReady === true });
  }

  function openContext() {
    const active = latest?.views?.find(view => view.active);
    const frame = frames.get(active?.id);
    if (frame && !frame.hidden && frame.contextReady) {
      frame.contentWindow.postMessage({ type: 'claude-host:open-context' }, new URL(frame.dataset.url).origin);
    }
  }

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
    const left = sidebarCollapsed ? integrated ? 0 : 36 : sidebarWidth;
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
    if (viewStatus) {
      const measured = frame?.loadingLayout ?? presentedFrame?.loadingLayout;
      const bounds = viewStatus.root.dataset.state === 'loading'
        && measured?.viewport.width === width && measured.viewport.height === height ? measured.rect : null;
      Object.assign(viewStatus.root.style, {
        left: left + (bounds?.left ?? 0) + 'px', top: top + (bounds?.top ?? 0) + 'px',
        width: (bounds?.width ?? width) + 'px', height: (bounds?.height ?? height) + 'px',
      });
    }
    const rect = composer?.rect;
    hud?.setDraft(composer?.hasDraft !== false);
    chooser?.sync(latest);
    gitReview?.sync(latest);
    const fits = rect && composer.viewport.width === width && composer.viewport.height === height
      && rect.left >= 0 && rect.top >= 0 && rect.left + rect.width <= width + 1
      && rect.top + rect.height + window.goHUD.gap + window.goHUD.height <= height + 1;
    hud?.layout(frame && !frame.hidden && fits
      ? { left: left + rect.left, top: top + rect.top + rect.height + window.goHUD.gap, width: rect.width } : null);
    const regions = window.mygo && integrated && frame && !frame.hidden && !frame.inert && !latest.pluginUpdating
      && composer?.viewport.width === width && composer.viewport.height === height ? composer.dragRegions : [];
    while (titlebarDrags.length > regions.length) titlebarDrags.pop().remove();
    regions.forEach((region, index) => {
      if (!titlebarDrags[index]) {
        const drag = document.createElement('div');
        drag.className = 'go-titlebar-drag';
        drag.setAttribute('aria-hidden', 'true');
        document.body.append(drag);
        titlebarDrags.push(drag);
      }
      Object.assign(titlebarDrags[index].style, { left: left + region.left + 'px', top: top + region.top + 'px',
        width: region.width + 'px', height: region.height + 'px' });
    });
  }

  window.addEventListener('message', event => {
    if (!['claude-host:composer', 'claude-host:transport', 'claude-host:native-ready', 'claude-host:context-ready'].includes(event.data?.type)) return;
    const entry = [...frames].find(([, frame]) => frame.contentWindow === event.source);
    if (!entry || event.origin !== new URL(entry[1].dataset.url).origin) return;
    if (event.data.type === 'claude-host:context-ready') {
      entry[1].contextReady = true;
      renderHUD(latest);
      return;
    }
    if (event.data.type === 'claude-host:native-ready') {
      if (window.mygo) window.goViewRelay.attach(entry[1], event);
      return;
    }
    if (event.data.type === 'claude-host:transport') {
      const { sequence, connected } = event.data;
      if (!Number.isSafeInteger(sequence) || sequence < 0 || typeof connected !== 'boolean') return;
      entry[1].transport = { sequence, connected };
      syncTransport(entry[1], latest?.views?.find(view => view.id === entry[0]));
      return;
    }
    const { rect, viewport, hasDraft } = event.data;
    if (typeof hasDraft !== 'boolean') return;
    if (!viewport || ![viewport.width, viewport.height].every(value => Number.isFinite(value) && value > 0)) return;
    if (rect !== null && (!rect || ![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)
      || rect.width <= 0 || rect.height <= 0)) return;
    const previous = composers.get(entry[0]);
    // Only permit native drag surfaces in the plugin's top strip.
    const dragRegions = event.data.dragRegions;
    const validDrags = Array.isArray(dragRegions) && dragRegions.length <= 32 && dragRegions.every(region =>
      region && [region.left, region.top, region.width, region.height].every(Number.isFinite)
      && region.left >= 0 && region.top >= 0 && region.top <= 1 && region.width >= 4 && region.height > 0 && region.height <= 64
      && region.left + region.width <= viewport.width && region.top + region.height <= viewport.height);
    composers.set(entry[0], { rect, viewport, hasDraft, dragRegions: validDrags ? dragRegions : [] });
    const loadingRect = event.data.loadingRect;
    if (loadingRect && [loadingRect.left, loadingRect.top, loadingRect.width, loadingRect.height].every(Number.isFinite)
      && loadingRect.left >= 0 && loadingRect.top >= 0 && loadingRect.width > 0 && loadingRect.height > 0
      && loadingRect.left + loadingRect.width <= viewport.width + 1 && loadingRect.top + loadingRect.height <= viewport.height + 1) {
      entry[1].loadingLayout = { rect: loadingRect, viewport };
    }
    entry[1].loadingReady = event.data.loading === true;
    if (event.data.loadError === true) {
      failView(entry[1]);
    } else if (rect && !entry[1].loadingReady) {
      entry[1].contentReady = true;
      entry[1].loadState = 'ready';
      clearViewTimers(entry[1]);
      presentView();
    } else if (entry[1].loadingReady) {
      presentView();
    }
    if (previous?.hasDraft !== hasDraft) {
      void reportDraft(entry[0], hasDraft).catch(error => console.error('Go desktop draft state:', error));
    }
    layout();
  });

  function syncTransport(frame, view) {
    if (!frame.transport || !view) return;
    // The existing state poll wakes suspended views when the host queues new data.
    const keepAlive = !frame.hidden && latest.windowVisible !== false && !document.hidden || view.busy === true
      || !frame.transport.connected && view.sequence > frame.transport.sequence;
    if (frame.transportWanted === keepAlive) return;
    frame.transportWanted = keepAlive;
    frame.contentWindow.postMessage({ type: 'claude-host:transport', keepAlive }, new URL(frame.dataset.url).origin);
  }

  function presentView() {
    const state = latest;
    if (state.pluginUpdating) return;
    const active = state.views.find(view => view.active);
    const target = frames.get(active?.id);
    const visible = state.phase === 'active' && !state.settingsOpen && !state.pluginSetupOpen;
    // Keep the previous pixels until the new composer has laid out. The old
    // conversation becomes inert immediately, so input cannot reach it.
    if (!visible || !active || target?.loadState === 'error') presentedFrame = undefined;
    else if (!presentedFrame || ![...frames.values()].includes(presentedFrame) || target?.contentReady) {
      presentedFrame = target;
    }
    for (const [id, frame] of frames) {
      frame.hidden = !visible || frame !== presentedFrame;
      frame.inert = frame.hidden || frame !== target;
      syncTransport(frame, state.views.find(view => view.id === id));
    }
    renderViewStatus(target, visible);
  }

  function clearViewTimers(frame) {
    clearTimeout(frame.revealTimer);
    clearTimeout(frame.loadingTimer);
  }

  function failView(frame) {
    clearViewTimers(frame);
    frame.contentReady = false;
    frame.loadState = 'error';
    presentView();
    layout();
  }

  function loadView(frame, url, retry = false) {
    clearViewTimers(frame);
    window.goViewRelay?.close(frame);
    const id = [...frames].find(([, candidate]) => candidate === frame)?.[0];
    composers.delete(id);
    frame.transport = undefined;
    frame.transportWanted = undefined;
    frame.contextReady = false;
    frame.contentReady = false;
    frame.loadingReady = false;
    frame.loadingLayout = undefined;
    frame.loadState = 'loading';
    frame.showLoading = retry;
    frame.dataset.url = url;
    frame.loadingTimer = setTimeout(() => { frame.showLoading = true; presentView(); layout(); }, 400);
    frame.revealTimer = setTimeout(() => failView(frame), 15000);
    frame.src = url + (retry ? '&retry=' + Date.now() : '');
  }

  function renderViewStatus(target, visible) {
    const failed = target?.loadState === 'error';
    const show = visible && target && (failed || target.loadState === 'loading' && target.showLoading);
    if (!show) { if (viewStatus) viewStatus.root.hidden = true; return; }
    if (!viewStatus) {
      const root = document.createElement('section');
      root.className = 'go-view-status';
      root.setAttribute('aria-live', 'polite');
      const content = document.createElement('div');
      const title = document.createElement('h2'), detail = document.createElement('p');
      const retry = document.createElement('button'), logs = document.createElement('button');
      retry.type = logs.type = 'button';
      retry.textContent = 'Retry';
      logs.textContent = 'View logs';
      retry.onclick = () => {
        const active = latest.views.find(view => view.active);
        const frame = frames.get(active?.id);
        if (!frame || composers.get(active.id)?.hasDraft) return;
        loadView(frame, frame.dataset.url, true);
        presentView();
        layout();
      };
      logs.onclick = () => { void invoke('ui', { key: 'logs', open: true }).catch(error => console.error('VSIX Output:', error)); };
      content.append(title, detail, retry, logs);
      root.append(content);
      document.body.append(root);
      viewStatus = { root, title, detail, retry, logs };
    }
    viewStatus.root.hidden = false;
    viewStatus.root.dataset.state = failed ? 'error' : 'loading';
    viewStatus.root.setAttribute('role', failed ? 'alert' : 'status');
    viewStatus.title.textContent = failed ? 'Could not load this chat' : 'Loading...';
    viewStatus.detail.textContent = failed ? 'The chat did not finish loading. Retry, or view the logs for details. Your saved conversation is unchanged.' : '';
    viewStatus.detail.hidden = viewStatus.retry.hidden = viewStatus.logs.hidden = !failed;
  }

  function mountViews(state) {
    if (!document.body) return;
    // Retain the current chat while its replacement host is being prepared.
    if (state.pluginUpdating && frames.size) {
      for (const frame of frames.values()) frame.inert = true;
      layout();
      return;
    }
    const ids = new Set(state.views.map(view => view.id));
    for (const [id, frame] of frames) {
      if (!ids.has(id)) { clearViewTimers(frame); window.goViewRelay?.close(frame); frame.remove(); frames.delete(id); composers.delete(id); }
    }
    for (const view of state.views) {
      if (!view.ready) continue;
      let frame = frames.get(view.id);
      if (!frame) {
        if (!view.active && !view.busy) continue;
        frame = document.createElement('iframe');
        frame.className = 'go-extension-view';
        frame.title = 'Claude extension view';
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-downloads');
        frame.setAttribute('allow', 'clipboard-read; clipboard-write');
        frame.referrerPolicy = 'no-referrer';
        frame.hidden = true;
        frame.addEventListener('error', () => failView(frame));
        frames.set(view.id, frame);
        document.body.append(frame);
      }
      const url = view.url + '?revision=' + view.revision;
      if (frame.dataset.url !== url) {
        loadView(frame, url);
      }
    }
    presentView();
    if (!chooser && window.goSelection) chooser = window.goSelection.create(document, { request, invoke, formatPath });
    if (!gitReview && window.goGitReview) gitReview = window.goGitReview.create(document, { request });
    if (!hud && window.goHUD) hud = window.goHUD.create(document, chooser ? {
      formatPath,
      project: field => chooser.open('project', latest, field),
      branch: field => chooser.open('branch', latest, field),
      changes: field => gitReview?.open(latest, field),
      context: openContext,
    } : { changes: field => gitReview?.open(latest, field), context: openContext, formatPath });
    renderHUD(state);
    layout();
  }

  async function refresh() {
    const sequence = ++refreshStarted;
    const state = await request('state');
    // An action refresh can overtake the background poll. Never restore its older snapshot.
    if (sequence < refreshApplied) return latest;
    refreshApplied = sequence;
    if (latest?.windowVisible === false && state.windowVisible !== false) projectForce = true;
    if (latest?.project && latest.workspace === state.workspace && latest.project.path === state.workspace
      && latest.project.gitStatus !== 'unknown' && latest.project.gitStatus
      && state.project?.gitStatus === 'unknown') {
      state.project = latest.project;
    }
    if (latest?.pluginUpdating && state.phase === 'active' && state.viewLoading) state.pluginUpdating = true;
    latest = state;
    const fontSize = { small: 12, medium: 14, large: 16 }[state.interfaceSize] ?? 12;
    const iconSize = { small: 14, medium: 15, large: 16 }[state.interfaceSize] ?? 14;
    document.documentElement.style.setProperty('--host-font-scale', String(fontSize / 13));
    document.documentElement.style.setProperty('--shell-sidebar-icon-size', `${iconSize}px`);
    for (const variable of ['--vscode-chat-font-size', '--vscode-font-size', '--vscode-editor-font-size']) {
      document.documentElement.style.setProperty(variable, `${fontSize}px`);
    }
    sidebarWidth = state.sidebarWidth;
    sidebarCollapsed = state.sidebarCollapsed;
    mountViews(state);
    for (const callback of stateListeners) callback(state);
    document.getElementById('connection-status')?.setAttribute('aria-expanded', String(state.logsOpen));
    const menu = document.getElementById('application-menu');
    if (menu) menu.hidden = state.nativeMenu !== true;
    void refreshProject();
    return state;
  }

  async function invoke(method, args = {}) {
    if (draftSensitiveActions.has(method)) {
      // Flush all views, including hidden drafts, before an operation can replace the host.
      for (const id of frames.keys()) await reportDraft(id, composers.get(id)?.hasDraft !== false);
    }
    const value = await request(method, args);
    if (['select-branch', 'select-project', 'workspace', 'start'].includes(method)) projectForce = true;
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
    formatPath,
    nativeExternalLinks: Boolean(config.nativeExternalLinks),
    getState: refresh,
    refreshGit: requestGitRefresh,
    onState(callback) { stateListeners.add(callback); return () => stateListeners.delete(callback); },
    onAction(callback) { actionListeners.add(callback); return () => actionListeners.delete(callback); },
    checkPlugin: () => invoke('retry'),
    cancelPluginDownload: () => invoke('cancel-download'),
    reloadPlugin: () => invoke('update-plugin'),
    checkPluginUpdates: () => invoke('update-check'),
    startUsing: () => invoke('start'),
    showPluginSetup: open => invoke('ui', { key: 'setup', open }),
    selectNode: async () => { await invoke('native', { key: 'select-node' }); return invoke('retry'); },
    downloadNode: () => invoke('native', { key: 'download-node' }),
    importPlugin: () => invoke('import'),
    openPluginDirectory: () => invoke('native', { key: 'folder' }),
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
    setInterfaceSize: value => invoke('ui', { key: 'interface-size', value }),
    setSidebarOptions: patch => {
      const save = sidebarOptionsSave.catch(() => {}).then(() => invoke('ui', {
        key: 'sidebar-options', value: { display: 'grouped', sort: 'updated', ...latest?.sidebarOptions, ...patch },
      }));
      sidebarOptionsSave = save;
      return save;
    },
    setTheme: theme => invoke('theme', { theme }),
    setSidebar: options => {
      if (options.width !== undefined) sidebarWidth = options.width;
      if (options.collapsed !== undefined) sidebarCollapsed = options.collapsed;
      layout();
      return request('ui', { key: 'sidebar', ...options });
    },
  }), writable: false, configurable: false });

  window.__goDesktopAction = action => {
    if (action === 'refresh-git') {
      void requestGitRefresh();
      return;
    }
    if (action === 'open-setup') {
      void invoke('ui', { key: 'setup', open: true }).catch(error => console.error('Setup:', error));
      return;
    }
    for (const callback of actionListeners) callback(action);
  };
  window.addEventListener('resize', layout);
  const foreground = () => {
    projectFocused = document.hasFocus?.() ?? true;
    projectForce = true;
    if (!document.hidden) void refresh().catch(error => console.error('Foreground refresh:', error));
  };
  window.addEventListener('focus', foreground);
  window.addEventListener('blur', () => { projectFocused = false; });
  window.addEventListener('pageshow', foreground);
  document.addEventListener?.('visibilitychange', foreground);
  window.addEventListener('beforeunload', () => { stopped = true; clearTimeout(timer); });
  window.addEventListener('DOMContentLoaded', () => {
    if (config.platform === 'win32') {
      const menu = document.createElement('button');
      menu.type = 'button';
      menu.id = 'application-menu';
      menu.className = 'window-menu window-toggle';
      menu.hidden = true;
      menu.title = 'Menu';
      menu.setAttribute('aria-label', 'Application menu');
      menu.setAttribute('aria-haspopup', 'menu');
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', width: '14', height: '14', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'aria-hidden': 'true' })) icon.setAttribute(key, value);
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M4 6h16M4 12h16M4 18h16');
      icon.append(path);
      menu.append(icon);
      menu.addEventListener('click', async () => {
        if (menu.disabled) return;
        menu.disabled = true;
        try { await request('native', { key: 'menu' }); }
        catch (error) { console.error('Application menu:', error); }
        finally { menu.disabled = false; }
      });
      document.getElementById('window-controls')?.prepend(menu);
    }
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
