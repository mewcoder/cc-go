'use strict';

(() => {
  function setupView(state) {
    const setup = state.pluginSetup || {};
    const [os, arch] = (setup.platform || '').split('-');
    const system = [{ darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[os] || os, arch].filter(Boolean).join(' · ');
    const nodeReady = Boolean(setup.nodeVersion);
    const cliReady = Boolean(setup.cliVersion);
    const step = Number.isInteger(setup.step) ? setup.step : 0;
    const status = setup.status;
    const busy = ['detecting-node', 'detecting', 'downloading', 'extracting', 'reloading'].includes(status)
      || state.phase === 'activating';
    const error = setup.nodeError || setup.error || setup.cliError || setup.cacheError || '';
    const pluginReady = ['ready', 'idle'].includes(status) || state.phase === 'active' && !busy && !error;
    const cards = [
      { kind: nodeReady ? 'ready' : status === 'detecting-node' ? 'busy' : 'waiting',
        label: nodeReady ? '已就绪' : status === 'detecting-node' ? '检查中' : '待检查',
        version: nodeReady ? `Node.js ${setup.nodeVersion}` : '',
        description: [system, !nodeReady && '需要 Node.js 22 或更高版本。'].filter(Boolean).join(' · ') },
      { kind: cliReady ? 'ready' : nodeReady && status === 'detecting' ? 'busy' : 'waiting',
        label: cliReady ? '已就绪' : nodeReady && status === 'detecting' ? '检查中' : '待检查', version: setup.cliVersion || '' },
      { kind: pluginReady ? 'ready' : step === 2 && busy ? 'busy' : 'waiting',
        label: pluginReady ? '已就绪' : status === 'downloading' ? '下载中' : step === 2 && busy ? '准备中' : '待安装',
        version: setup.readyVersion || (pluginReady ? state.extension?.version || '' : '') },
    ];
    if (error) {
      const failed = !nodeReady ? 0 : step < 2 && !cliReady ? 1 : 2;
      cards[failed] = { ...cards[failed], kind: 'error', label: failed === 2 ? '未完成' : '请安装', error };
    }
    return { cards, busy, error, nodeReady, cliReady, step, pluginReady };
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
  const close = create('button', 'setup-close');
  const closeIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  closeIcon.setAttribute('viewBox', '0 0 24 24');
  closeIcon.setAttribute('fill', 'none');
  closeIcon.setAttribute('stroke', 'currentColor');
  closeIcon.setAttribute('stroke-width', '1.8');
  closeIcon.setAttribute('stroke-linecap', 'round');
  closeIcon.setAttribute('aria-hidden', 'true');
  const closePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  closePath.setAttribute('d', 'M6 6l12 12M18 6L6 18');
  closeIcon.append(closePath);
  close.append(closeIcon);
  close.type = 'button';
  close.setAttribute('aria-label', '关闭初始化');
  close.title = '关闭';
  function closeSetup() {
    void window.desktop.showPluginSetup(false).catch(error => {
      showActionError(error);
    });
  }
  close.onclick = closeSetup;
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeSetup(); });
  root.before(dialog);
  dialog.append(close, root);
  const heading = root.querySelector('.setup-heading');
  const description = create('p', 'setup-product', '基于 Claude Code 的 VS Code 插件 (.vsix)的轻量非官方客户端，使用 Go 构建，10 MB 级体积。');
  const steps = $('setup-steps');
  steps.setAttribute('aria-label', '初始化步骤');
  steps.replaceChildren();
  const cards = [
    ['运行环境', '需要 Node.js 22 或更高版本。'],
    ['Claude Code CLI', '安装后重新检测。'],
    ['VS Code 插件 (.vsix)', '匹配 Claude Code CLI 版本。'],
  ].map(([title, description], index) => {
    const row = create('li', 'setup-card');
    const number = create('span', 'setup-step-number', String(index + 1));
    number.setAttribute('aria-hidden', 'true');
    const body = create('div', 'setup-card-body');
    const header = create('div', 'setup-card-header');
    const label = create('h2', '', title);
    const status = create('span', 'setup-card-status', index === 2 ? '待安装' : '待检查');
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
    body.append(header, status, details, actions, error);
    row.append(number, body);
    steps.append(row);
    return { row, number, body, status, version, actions, hint, error };
  });

  const retryButtons = [1, 2].map(index => {
    const button = create('button', '', '重新检测');
    button.type = 'button';
    button.onclick = async () => {
      button.disabled = true;
      try { await window.desktop.checkPlugin(); } catch (error) { showActionError(error, index); }
      finally { button.disabled = false; }
    };
    return button;
  });
  [$('setup-retry'), ...retryButtons].forEach((button, index) => {
    button.className = '';
    const label = ['重新检测 Node.js', '重新检测 Claude Code CLI', '检查并准备 VS Code 插件 (.vsix)'][index];
    button.title = label;
    button.setAttribute('aria-label', label);
    cards[index].retry = button;
  });
  cards[0].actions.append($('setup-retry'));
  cards[1].actions.append($('setup-select-cli'), retryButtons[0]);
  cards[2].actions.append($('setup-import'), retryButtons[1]);
  const install = $('setup-install');
  text(install.querySelector('p'), '安装命令：');
  $('setup-copy-install').hidden = true;
  cards[1].body.insertBefore(install, cards[1].error);
  const offline = root.querySelector('.setup-offline');
  text(offline.querySelector('summary'), '手动安装');
  text(offline.querySelector('p'), '下载 VS Code 插件 (.vsix) 后导入，或放入插件文件夹。');
  cards[2].body.append($('setup-progress'), offline);

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

  function showActionError(error, index = 2) {
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
    text($('setup-title'), '欢迎使用 CC Go');
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
      text(card.retry, '重新检测');
      if (index === 0) text(card.hint, current.description);
      card.hint.hidden = index === 0 ? !current.description : current.kind === 'ready';
      text(card.error, current.error || '');
      card.error.hidden = !current.error;
    });
    cards[0].version.title = setup.nodePath || '';
    $('setup-select-cli').hidden = view.cliReady;
    text($('setup-select-cli'), '选择程序');
    install.hidden = !view.nodeReady || view.cliReady || view.busy;
    offline.hidden = !view.nodeReady || view.step < 2 || view.busy || view.pluginReady;
    text($('setup-open-download'), '下载插件');
    $('setup-open-download').title = '下载 VS Code 插件 (.vsix)';
    text($('setup-import'), '导入插件');
    $('setup-import').title = '导入 VS Code 插件 (.vsix)';
    $('setup-import').hidden = view.pluginReady;
    $('setup-progress').setAttribute('aria-label', '插件下载进度');
    $('setup-retry').disabled ||= view.busy;
    $('setup-import').disabled ||= view.busy || !view.cliReady;
    $('setup-select-cli').disabled ||= view.busy || !view.nodeReady;
    retryButtons[0].disabled = view.busy || !view.nodeReady;
    retryButtons[1].disabled = view.busy || !view.cliReady;
    canStart = Boolean(state.setupCanStart) && !view.busy;
    start.disabled = !canStart;
    text(start, state.phase === 'active' ? '返回对话' : state.phase === 'activating' ? '正在启动' : '开始使用');
    return visible;
  }

  // Run after every shell render, including local button/pending-state updates.
  window.__goRenderSetup = render;
})();
