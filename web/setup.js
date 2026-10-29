'use strict';

(() => {
  function setupView(state) {
    const setup = state.pluginSetup || {};
    const [os, arch] = (setup.platform || '').split('-');
    const system = [{ darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[os] || os, arch].filter(Boolean).join(' · ');
    const nodeReady = Boolean(setup.nodeVersion);
    const step = Number.isInteger(setup.step) ? Math.min(1, Math.max(0, setup.step)) : 0;
    const status = setup.status;
    const busy = ['detecting-node', 'downloading', 'cancelling', 'extracting', 'checking-runtime', 'reloading'].includes(status)
      || state.phase === 'activating';
    const error = setup.nodeError || setup.error || '';
    const pluginReady = Boolean(setup.readyVersion || state.extension?.version);
    const runtimeReady = Boolean(setup.runtimeReady);
    const received = Math.max(0, Number(setup.received) || 0);
    const total = Math.max(0, Number(setup.total) || 0);
    const size = bytes => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    const rate = Math.max(0, Number(setup.bytesPerSecond) || 0);
    const speed = rate >= 1024 * 1024 ? `${(rate / 1024 / 1024).toFixed(1)} MB/s` : `${Math.round(rate / 1024)} KB/s`;
    const progressText = status === 'downloading' && !setup.verifying
      ? total ? `${size(received)} / ${size(total)} · ${Math.min(100, Math.floor(received / total * 100))}% · ${speed}`
        : received ? `已下载 ${size(received)} · ${speed}` : '' : '';
    const busyLabel = status === 'cancelling' ? '取消中…' : state.phase === 'activating' || status === 'reloading' ? '启动中…'
      : status === 'downloading' ? setup.verifying ? '校验中…' : setup.targetVersion ? '下载中…' : '获取版本…'
        : status === 'extracting' ? '解压中…' : '检查中…';
    const cards = [
      { kind: nodeReady ? 'ready' : status === 'detecting-node' ? 'busy' : 'waiting',
        label: nodeReady ? '已就绪' : status === 'detecting-node' ? '检查中' : '待检查',
        version: nodeReady ? `Node.js ${setup.nodeVersion}` : '',
        description: [system, !nodeReady && '需要 Node.js 22 或更高版本。'].filter(Boolean).join(' · ') },
      { kind: nodeReady && step === 1 && busy ? 'busy' : pluginReady && runtimeReady ? 'ready' : 'waiting',
        label: status === 'downloading' ? setup.verifying ? '校验中' : '下载中' : nodeReady && step === 1 && busy ? '准备中' : pluginReady && runtimeReady ? '已就绪' : '待安装',
        version: status === 'downloading' ? setup.targetVersion || '' : setup.readyVersion || state.extension?.version || '' },
    ];
    if (error) {
      const failed = !nodeReady ? 0 : 1;
      cards[failed] = { ...cards[failed], kind: 'error', label: failed === 0 ? '请安装' : '未完成', error };
    }
    return { cards, busy, busyLabel, error, nodeReady, step, pluginReady, runtimeReady, progressText, received, total };

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
  const description = create('p', 'setup-product', '基于 Claude Code 的 VS Code 插件 (.vsix)的轻量非官方客户端，使用 Go 构建，10 MB 级体积。');
  const steps = $('setup-steps');
  steps.setAttribute('aria-label', '初始化步骤');
  steps.replaceChildren();
  const cards = [
    ['运行环境', '需要 Node.js 22 或更高版本。'],
    ['VS Code 插件 (.vsix)', ''],
  ].map(([title, description], index) => {
    const row = create('li', 'setup-card');
    const number = create('span', 'setup-step-number', String(index + 1));
    number.setAttribute('aria-hidden', 'true');
    const body = create('div', 'setup-card-body');
    const header = create('div', 'setup-card-header');
    const label = create('h2', '', title);
    const status = create('span', 'setup-card-status', index === 1 ? '待安装' : '待检查');
    status.setAttribute('role', 'status');
    const version = create('span', 'setup-card-version');
    const details = create('div', 'setup-card-details');
    const actions = create('div', 'setup-actions');
    const hint = create('p', 'setup-card-description', description);
    const error = create('p', 'setup-step-error');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    header.append(label);
    details.append(version, hint);
    actions.append(status);
    body.append(header, details, actions, error);
    row.append(number, body);
    steps.append(row);
    return { row, number, body, status, version, details, actions, hint, error };
  });

  const retry = $('setup-retry');
  retry.className = '';
  retry.title = '重新检测 Node.js';
  retry.setAttribute('aria-label', retry.title);
  cards[0].actions.append($('setup-retry'));
  cards[1].actions.append($('setup-import'));
  const install = $('setup-install');
  install.hidden = true;
  $('setup-select-cli').hidden = true;
  $('setup-copy-install').hidden = true;
  const offline = root.querySelector('.setup-offline');
  text(offline.querySelector('summary'), '手动安装');
  text(offline.querySelector('p'), '导入对应平台的 Anthropic VS Code 插件 (.vsix)，包内必须包含 Claude 可执行文件。');
  cards[1].body.append($('setup-progress'), offline);
  const progressStatus = create('p', 'setup-download-status');
  progressStatus.setAttribute('role', 'status');
  progressStatus.setAttribute('aria-live', 'polite');
  cards[1].body.append(progressStatus);
  const update = create('button', '', '检查更新');
  update.type = 'button';
  let updateAvailable = false, installLatest = false;
  update.onclick = async () => {
    update.disabled = true;
    try {
      if (installLatest) await window.desktop.reloadPlugin();
      else await window.desktop.checkPluginUpdates();
    } catch (error) { showActionError(error, 1); }
    finally { update.disabled = false; }
  };
  cards[1].actions.append(update);
  const cancel = create('button', '', '取消');
  cancel.type = 'button';
  cancel.setAttribute('aria-label', '取消下载');
  cancel.onclick = async () => {
    if (cancel.disabled) return;
    cancel.disabled = true;
    try { await window.desktop.cancelPluginDownload(); }
    catch (error) { showActionError(error, 1); }
    finally { cancel.disabled = false; }
  };
  cards[1].actions.insertBefore(cancel, update);
  const updateStatus = create('p', 'setup-update-status');
  updateStatus.setAttribute('role', 'status');
  cards[1].body.append(updateStatus);

  const footer = create('div', 'setup-footer');
  const start = create('button', 'setup-primary', '开始使用');
  start.id = 'setup-start';
  start.type = 'button';
  start.disabled = true;
  start.onclick = async () => {
    start.disabled = true;
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
  root.replaceChildren(heading, description, steps, footer, legacy);

  function showActionError(error, index = 1) {
    text(cards[index].error, String(error?.message || error));
    cards[index].error.hidden = false;
  }

  function render(state) {
    const setup = state.pluginSetup || {};
    const view = setupView(state);
    const visible = Boolean(state.pluginSetupOpen);
    root.hidden = !visible;
    if (visible && !dialog.open) dialog.showModal();
    else if (!visible && dialog.open) dialog.close();
    text($('setup-title'), state.setupComplete ? '插件更新' : '欢迎使用 CC Go');
    root.classList.toggle('setup-updates', Boolean(state.setupComplete) && view.nodeReady);
    description.hidden = Boolean(state.setupComplete);
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
      if (index === 0) text(retry, view.busy && !view.nodeReady ? '检查中…' : '重新检测');
      if (index === 0) text(card.hint, current.description);
      card.hint.hidden = !card.hint.textContent || index !== 0 && current.kind === 'ready';
      card.details.hidden = card.version.hidden && card.hint.hidden;
      card.status.hidden = index !== 0 || !view.nodeReady;
      text(card.error, current.error || '');
      card.error.hidden = !current.error;
    });
    cards[0].version.title = setup.nodePath || '';
    retry.hidden = view.nodeReady;
    $('setup-select-cli').hidden = true;
    install.hidden = true;
    offline.hidden = !view.nodeReady || view.busy || view.pluginReady && view.runtimeReady;
    text($('setup-open-download'), '下载插件');
    $('setup-open-download').title = '下载 VS Code 插件 (.vsix)';
    text($('setup-import'), '导入插件');
    $('setup-import').title = '导入 VS Code 插件 (.vsix)';
    $('setup-import').hidden = view.busy || !view.nodeReady || view.pluginReady && view.runtimeReady;
    $('setup-progress').setAttribute('aria-label', '插件下载进度');
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
    installLatest = updateAvailable || !view.runtimeReady || setup.status === 'cancelled';
    text(update, setup.checkingUpdate ? '检查中…' : setup.status === 'cancelled' || setup.status === 'error' && !view.runtimeReady ? '重试下载' : updateAvailable ? '更新插件' : installLatest ? '下载插件' : '检查更新');
    if (view.busy) text(update, view.busyLabel);
    update.hidden = !view.nodeReady;
    update.setAttribute('aria-label', update.textContent);
    update.disabled = view.busy || setup.checkingUpdate || !view.nodeReady;
    cancel.hidden = !setup.canCancel;
    cancel.disabled = setup.status === 'cancelling';
    text(updateStatus, setup.updateError ? `检查或更新失败：${setup.updateError}。${view.runtimeReady ? '已有插件仍可使用。' : '请检查网络后重试。'}`
      : updateAvailable ? `可更新至 ${setup.latestVersion}`
      : setup.latestVersion ? `未发现更新（最新稳定版 ${setup.latestVersion}）。` : '');
    updateStatus.hidden = view.busy || !updateStatus.textContent;
    const indicator = $('plugin-update');
    if (indicator) {
      indicator.hidden = state.phase !== 'active' || !updateAvailable;
      indicator.disabled = view.busy;
      indicator.title = `更新 VS Code 插件至 ${setup.latestVersion || ''}`;
      indicator.setAttribute('aria-label', indicator.title);
    }
    canStart = Boolean(state.setupCanStart) && !view.busy;
    start.disabled = !canStart;
    text(start, state.phase === 'active' ? '返回对话' : state.phase === 'activating' ? '正在启动' : state.setupComplete ? '应用更新' : '开始使用');
    return visible;
  }

  // Run after every shell render, including local button/pending-state updates.
  window.__goRenderSetup = render;
})();
