'use strict';

(() => {
  function setupView(state) {
    const setup = state.pluginSetup || {};
    const [os, arch] = (setup.platform || '').split('-');
    const system = [{ darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[os] || os, arch].filter(Boolean).join(' · ');
    const nodeReady = Boolean(setup.nodeVersion);
    const step = Number.isInteger(setup.step) ? Math.min(1, Math.max(0, setup.step)) : 0;
    const status = setup.status;
    const busy = ['detecting-node', 'checking-installed', 'downloading', 'cancelling', 'extracting', 'checking-runtime', 'reloading'].includes(status)
      || state.phase === 'activating';
    const error = setup.nodeError || setup.error || '';
    const pluginReady = Boolean(setup.readyVersion || state.extension?.version);
    const runtimeReady = Boolean(setup.runtimeReady);
    const localReuse = setup.source === 'vscode' && pluginReady && runtimeReady && !busy && !error;
    const received = Math.max(0, Number(setup.received) || 0);
    const total = Math.max(0, Number(setup.total) || 0);
    const size = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    const rate = Math.max(0, Number(setup.bytesPerSecond) || 0);
    const speed = rate >= 1024 * 1024 ? `${(rate / 1024 / 1024).toFixed(1)} MB/s` : `${Math.round(rate / 1024)} KB/s`;
    const progressText = status === 'downloading' && !setup.verifying
      ? total ? `${size(received)} / ${size(total)} · ${Math.min(100, Math.floor(received / total * 100))}% · ${speed}`
        : received ? `${size(received)} · ${speed}` : '' : '';
    const busyLabel = status === 'cancelling' ? 'Cancelling…' : state.phase === 'activating' || status === 'reloading' ? 'Starting…'
      : status === 'downloading' ? setup.verifying ? 'Verifying…' : setup.targetVersion ? 'Downloading…' : 'Checking…'
        : status === 'checking-installed' ? 'Checking VS Code…' : status === 'extracting' ? 'Extracting…' : 'Checking…';
    const cards = [
      { kind: nodeReady ? 'ready' : status === 'detecting-node' ? 'busy' : 'waiting',
        label: nodeReady ? 'Ready' : status === 'detecting-node' ? 'Checking' : 'Pending',
        version: nodeReady ? setup.nodeVersion : '',
        description: [system, !nodeReady && 'Node.js 22+'].filter(Boolean).join(' · ') },
      { kind: nodeReady && step === 1 && busy ? 'busy' : pluginReady && runtimeReady ? 'ready' : 'waiting',
        label: status === 'downloading' ? setup.verifying ? 'Verifying' : 'Downloading' : nodeReady && step === 1 && busy ? 'Preparing' : pluginReady && runtimeReady ? 'Ready' : 'Pending',
        description: localReuse ? 'From VS Code' : '',
        version: status === 'downloading' ? setup.targetVersion || '' : setup.readyVersion || state.extension?.version || '' },
    ];
    if (error) {
      const failed = !nodeReady ? 0 : 1;
      cards[failed] = { ...cards[failed], kind: 'error', label: 'Error', error };
    }
    return { cards, busy, busyLabel, error, nodeReady, step, pluginReady, runtimeReady, localReuse, progressText, received, total };

  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { setupView };
    return;
  }

  const $ = id => document.getElementById(id);
  function create(tag, className, value) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value) element.textContent = value;
    return element;
  }
  function text(element, value) {
    if (element.textContent !== value) element.textContent = value;
  }

  const root = $('plugin-setup');
  root.classList.add('setup-vertical');
  const dialog = create('dialog', 'setup-dialog');
  dialog.setAttribute('aria-labelledby', 'setup-title');
  dialog.addEventListener('cancel', event => event.preventDefault());
  // A modal's top layer blocks the shell titlebar, so it needs its own drag surface.
  const drag = create('div', 'setup-drag');
  drag.setAttribute('aria-hidden', 'true');
  root.before(dialog);
  dialog.append(drag, root);
  const heading = root.querySelector('.setup-heading');
  const steps = $('setup-steps');
  const actionErrors = ['', ''];
  steps.setAttribute('aria-label', 'Setup steps');
  steps.replaceChildren();
  const cards = [
    ['Node.js', 'Node.js 22+'],
    ['VSCode Plugin(.vsix)', ''],
  ].map(([title, description], index) => {
    const row = create('li', 'setup-card');
    const number = create('span', 'setup-step-number', String(index + 1));
    number.setAttribute('aria-hidden', 'true');
    const body = create('div', 'setup-card-body');
    const header = create('div', 'setup-card-header');
    const label = create('h2', '', title);
    header.append(label);
    if (index === 1) {
      const link = create('a', 'setup-plugin-link');
      link.href = 'https://open-vsx.org/extension/Anthropic/claude-code';
      link.title = 'Open in Open VSX';
      if (!window.desktop?.nativeExternalLinks) link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.setAttribute('aria-label', link.title);
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      const attributes = {
        viewBox: '0 0 24 24', width: '14', height: '14', fill: 'none', stroke: 'currentColor',
        'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
      };
      for (const [name, value] of Object.entries(attributes)) svg.setAttribute(name, value);
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M15 3h6v6 M10 14 21 3 M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5');
      svg.append(path);
      link.append(svg);
      const openLink = event => {
        if (!window.desktop?.nativeExternalLinks || event.type === 'auxclick' && event.button !== 1) return;
        event.preventDefault();
        actionErrors[1] = '';
        void window.desktop.openPluginDownload().catch(error => showActionError(error, 1));
      };
      link.onclick = openLink;
      link.addEventListener('auxclick', openLink);
      header.append(link);
    }
    const status = create('span', 'setup-card-status', 'Pending');
    status.setAttribute('role', 'status');
    const version = create('span', 'setup-card-version');
    const details = create('div', 'setup-card-details');
    const actions = create('div', 'setup-actions');
    const hint = create('p', 'setup-card-description', description);
    const error = create('p', 'setup-step-error');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    details.append(version, hint);
    actions.append(status);
    body.append(header, details, actions, error);
    row.append(number, body);
    steps.append(row);
    return { row, number, body, status, version, details, actions, hint, error };
  });

  const retry = $('setup-retry');
  retry.className = '';
  retry.title = 'Check Node.js';
  retry.setAttribute('aria-label', retry.title);
  cards[0].actions.append($('setup-retry'));
  cards[1].actions.append($('setup-import'));
  const install = $('setup-install');
  install.hidden = true;
  $('setup-select-cli').hidden = true;
  $('setup-copy-install').hidden = true;
  const offline = root.querySelector('.setup-offline');
  cards[1].body.append($('setup-progress'));
  const progressStatus = create('p', 'setup-download-status');
  progressStatus.setAttribute('role', 'status');
  progressStatus.setAttribute('aria-live', 'polite');
  cards[1].body.append(progressStatus);
  const update = create('button', '', 'Check for Updates');
  update.type = 'button';
  let updateAvailable = false, installLatest = false, needsRecovery = false;
  update.onclick = async () => {
    update.disabled = true;
    actionErrors[1] = '';
    try {
      if (needsRecovery) await window.desktop.checkPlugin();
      else if (installLatest) await window.desktop.reloadPlugin();
      else await window.desktop.checkPluginUpdates();
    } catch (error) { showActionError(error, 1); }
    finally { update.disabled = false; }
  };
  cards[1].actions.append(update);
  const cancel = create('button', '', 'Cancel');
  cancel.type = 'button';
  cancel.setAttribute('aria-label', 'Cancel download');
  cancel.onclick = async () => {
    if (cancel.disabled) return;
    cancel.disabled = true;
    actionErrors[1] = '';
    try { await window.desktop.cancelPluginDownload(); }
    catch (error) { showActionError(error, 1); }
    finally { cancel.disabled = false; }
  };
  cards[1].actions.insertBefore(cancel, update);
  const updateStatus = create('p', 'setup-update-status');
  updateStatus.setAttribute('role', 'status');
  cards[1].details.append(updateStatus);
  const saveWarning = create('p', 'setup-save-warning');
  saveWarning.setAttribute('role', 'status');
  cards[1].details.append(saveWarning);

  const footer = create('div', 'setup-footer');
  const start = create('button', 'setup-primary', 'Start');
  start.id = 'setup-start';
  start.type = 'button';
  start.disabled = true;
  start.onclick = async () => {
    start.disabled = true;
    actionErrors[1] = '';
    try { await window.desktop.startUsing(); } catch (error) {
      showActionError(error);
    } finally { start.disabled = !canStart; }
  };
  let canStart = false;
  footer.append(start);

  // Keep the shell's status fields connected; its renderer still updates them.
  const legacy = create('div');
  legacy.hidden = true;
  for (const child of [...root.children]) {
    if (child !== heading && child !== steps) legacy.append(child);
  }
  root.replaceChildren(heading, steps, footer, legacy);

  function showActionError(error, index = 1) {
    actionErrors[index] = String(error?.message || error);
    text(cards[index].error, actionErrors[index]);
    cards[index].error.hidden = false;
  }

  function render(state) {
    const setup = state.pluginSetup || {};
    const view = setupView(state);
    // Cancelling an update leaves the old runtime usable; Retry must download
    // again, not reload that old archive and discard its chat views.
    const retryDownload = setup.status === 'cancelled' && view.runtimeReady;
    needsRecovery = state.phase === 'error' || setup.status === 'error' || setup.status === 'cancelled' && !view.runtimeReady;
    const initialReady = !state.setupComplete && view.pluginReady && view.runtimeReady && !view.busy && !needsRecovery && !retryDownload;
    const visible = Boolean(state.pluginSetupOpen);
    // A new operation or closed panel ends the previous local error's lifetime;
    // ordinary state polling must leave that error visible.
    if (!visible || view.busy) actionErrors.fill('');
    root.hidden = !visible;
    if (visible && !dialog.open) dialog.showModal();
    else if (!visible && dialog.open) dialog.close();
    text($('setup-title'), state.setupComplete ? 'Updates' : 'Setup');
    steps.setAttribute('aria-label', state.setupComplete ? 'Plugin updates' : 'Setup steps');
    root.classList.toggle('setup-updates', Boolean(state.setupComplete) && view.nodeReady);
    cards[0].row.hidden = Boolean(state.setupComplete) && view.nodeReady;
    cards[1].number.hidden = Boolean(state.setupComplete) && view.nodeReady;
    $('setup-back').hidden = true;
    cards.forEach((card, index) => {
      const current = view.cards[index];
      card.row.dataset.status = current.kind;
      card.row.classList.toggle('is-complete', current.kind === 'ready');
      card.row.classList.toggle('is-current', index === view.step && current.kind !== 'ready');
      if (index === view.step && current.kind !== 'ready') card.row.setAttribute('aria-current', 'step');
      else card.row.removeAttribute('aria-current');
      text(card.number, current.kind === 'ready' ? '' : String(index + 1));
      text(card.status, current.label);
      text(card.version, current.version);
      card.version.hidden = !current.version;
      if (index === 0) text(retry, view.busy && !view.nodeReady ? 'Checking…' : 'Retry');
      text(card.hint, current.description || '');
      card.hint.hidden = !card.hint.textContent;
      card.details.hidden = card.version.hidden && card.hint.hidden;
      card.status.hidden = index === 0 ? !view.nodeReady : !initialReady;
      const error = current.error || actionErrors[index];
      text(card.error, error);
      card.error.hidden = !error;
    });
    cards[0].version.title = setup.nodePath || '';
    cards[1].row.querySelector('.setup-plugin-link').hidden = view.localReuse;
    retry.hidden = view.nodeReady;
    $('setup-select-cli').hidden = true;
    install.hidden = true;
    offline.hidden = true;
    text($('setup-import'), 'Import');
    $('setup-import').title = 'Import VS Code extension (.vsix)';
    $('setup-import').hidden = view.busy || !view.nodeReady || view.pluginReady && view.runtimeReady;
    $('setup-progress').setAttribute('aria-label', 'Download progress');
    const progress = $('setup-progress');
    progress.hidden = setup.status !== 'downloading';
    if (view.total && !setup.verifying) {
      progress.max = view.total;
      progress.value = view.received;
    } else progress.removeAttribute('value');
    text(progressStatus, view.progressText);
    progressStatus.hidden = !view.progressText;
    $('setup-retry').disabled = view.busy;
    $('setup-import').disabled = view.busy || !view.nodeReady;
    updateAvailable = Boolean(setup.updateAvailable);
    installLatest = retryDownload || updateAvailable || !view.runtimeReady;
    text(update, needsRecovery || retryDownload ? 'Retry' : setup.checkingUpdate ? 'Checking for Updates…' : updateAvailable ? 'Update' : installLatest ? 'Download' : 'Check for Updates');
    if (view.busy) text(update, view.busyLabel);
    update.hidden = !view.nodeReady || initialReady;
    update.setAttribute('aria-label', update.textContent);
    // Metadata checks use a separate lock and cannot replace the runtime. Do not
    // let a slow background check block local recovery or a cancelled download retry.
    update.disabled = view.busy || (!needsRecovery && !retryDownload && setup.checkingUpdate) || !view.nodeReady;
    cancel.hidden = !setup.canCancel;
    cancel.disabled = setup.status === 'cancelling';
    text(updateStatus, setup.updateError ? `Failed: ${setup.updateError}`
      : updateAvailable ? `${setup.latestVersion} available`
      : setup.latestVersion ? 'Latest' : '');
    updateStatus.setAttribute('role', setup.updateError ? 'alert' : 'status');
    updateStatus.hidden = view.busy || !updateStatus.textContent || !state.setupComplete && !setup.updateError;
    text(saveWarning, setup.saveError ? 'Settings not saved. Setup may appear again after restart.' : '');
    saveWarning.title = setup.saveError || '';
    saveWarning.hidden = !setup.saveError;
    cards[1].details.hidden = cards[1].version.hidden && cards[1].hint.hidden && updateStatus.hidden && saveWarning.hidden;
    const indicator = $('plugin-update');
    if (indicator) {
      indicator.hidden = state.phase !== 'active' || !updateAvailable;
      indicator.disabled = view.busy;
      indicator.title = `Update plugin to ${setup.latestVersion || ''}`;
      indicator.setAttribute('aria-label', indicator.title);
    }
    canStart = Boolean(state.setupCanStart) && !view.busy;
    start.disabled = !canStart;
    text(start, state.phase === 'active' ? 'Close' : state.phase === 'activating' ? 'Starting…' : state.setupComplete ? 'Apply' : 'Start');
    return visible;
  }

  // Run after every shell render, including local button/pending-state updates.
  window.__goRenderSetup = render;
})();
