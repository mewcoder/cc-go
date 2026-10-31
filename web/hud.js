'use strict';

(() => {
  const missing = '\u2014';
  const valid = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const tokens = value => !valid(value) ? missing : value >= 1000000
    ? `${+(value / 1000000).toFixed(2)}m` : value >= 1000 ? `${+(value / 1000).toFixed(1)}k` : String(value);
  const exact = value => valid(value) ? value.toLocaleString('en-US') : missing;
  const icons = {
    project: ['M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'],
    branch: ['M6 3v12', 'M18 6a6 6 0 0 1-6 6H6', 'M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0', 'M21 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0'],
    context: [],
  };

  function visible(state) {
    return state.phase === 'active' && !state.pluginSetupOpen && !state.settingsOpen
      && !state.viewLoading && state.views?.some(view => view.active && view.ready);
  }

  function describe(state, formatPath = value => value) {
    const m = state.sessionMetrics ?? {}, project = state.project ?? {};
    const percent = valid(m.contextTokens) && valid(m.contextWindow) && m.contextWindow > 0
      ? Math.round(m.contextTokens / m.contextWindow * 100) : undefined;
    const context = `${tokens(m.contextTokens)} / ${tokens(m.contextWindow).replace(/m$/, 'M')}`;
    const branch = project.gitStatus === 'none' ? 'No Git'
      : project.branch ? `${project.gitStatus === 'detached' ? 'HEAD ' : ''}${project.branch}` : missing;
    const input = [m.inputTokens, m.cacheReadTokens, m.cacheWriteTokens];
    const totalInput = input.every(valid) ? input.reduce((sum, value) => sum + value, 0) : undefined;
    const cachePercent = totalInput > 0 ? Math.round(m.cacheReadTokens / totalInput * 100) : undefined;
    const contextText = !valid(m.contextTokens) ? '' : percent === undefined
      ? `${tokens(m.contextTokens)} / ${missing}` : `${context} (${percent}%)`;
    const cacheText = cachePercent === undefined ? '' : `Cache ${cachePercent}%`;
    const windowSource = m.contextWindowSource === 'native' ? 'Window source: native context query.'
      : m.contextWindowSource === 'sdk' ? 'Window source: SDK model usage.' : 'Window source unavailable.';
    const changes = project.changes;
    const hasChanges = ['files', 'untracked', 'added', 'deleted', 'binary'].every(key => Number.isSafeInteger(changes?.[key]) && changes[key] >= 0)
      && changes.files > 0 && changes.untracked <= changes.files;
    const filesText = hasChanges ? `${changes.files} ${changes.files === 1 ? 'file' : 'files'}` : '';
    const addedText = hasChanges && changes.added ? `+${exact(changes.added)}` : '';
    const deletedText = hasChanges && changes.deleted ? `-${exact(changes.deleted)}` : '';
    return {
      project: { text: formatPath(project.name || missing), title: formatPath(project.path || state.workspace || 'Project directory unavailable') },
      branch: { text: branch, title: [project.gitStatus === 'none' ? 'This directory is not in a Git repository'
        : project.gitStatus === 'detached' ? `Detached HEAD: ${project.branch}` : project.branch || 'Git information unavailable', project.watchError].filter(Boolean).join('. ') },
      changes: { hidden: !hasChanges, text: [filesText, addedText, deletedText].filter(Boolean).join(' '), filesText, addedText, deletedText,
        title: hasChanges ? `Uncommitted changes across this repository: ${changes.files} files, including ${changes.untracked} untracked. Text changes compared with HEAD (staged and unstaged combined), including new untracked text files: +${exact(changes.added)} / -${exact(changes.deleted)} lines. ${changes.binary} binary files are excluded from line totals. Native file notifications refresh external edits with debounce/rate limiting. Also refreshes on project/branch changes, window focus/restore and completed Claude operations. Click to view changed files and diffs. Use View > Refresh Git to refresh manually. No periodic Git polling. ${project.watchError || ''}` : 'No Git changes available' },
      context: { hidden: !contextText && !cacheText, text: contextText,
        tooltip: [`Context ${contextText || missing}`, cacheText].filter(Boolean).join('\n'),
        title: `Current context: ${exact(m.contextTokens)} / ${exact(m.contextWindow)} tokens. ${windowSource} Native context query when available; otherwise latest request input including cache, excluding output. Not cumulative session tokens. ${cacheText ? `${cacheText}. ` : ''}Cache read / total input (uncached + cache read + cache write). Read: ${exact(m.cacheReadTokens)}, write: ${exact(m.cacheWriteTokens)}, total input: ${exact(totalInput)} tokens.` },
      percent,
    };
  }

  function create(document, actions = {}) {
    const bar = document.createElement('section');
    bar.className = 'session-hud';
    bar.setAttribute('aria-label', 'Conversation status');
    bar.tabIndex = 0;
    bar.hidden = true;
    const fields = {};
    const tooltip = document.createElement('div');
    tooltip.className = 'context-tooltip';
    tooltip.id = 'context-usage-tooltip';
    tooltip.setAttribute('role', 'tooltip');
    tooltip.hidden = true;
    function hideTooltip() { tooltip.hidden = true; }
    function showTooltip() {
      if (!enabled || !positioned || fields.context.field.hidden) return;
      const rect = fields.context.field.getBoundingClientRect();
      const viewport = document.defaultView;
      tooltip.style.right = `${Math.max(8, viewport.innerWidth - rect.right)}px`;
      tooltip.style.bottom = `${viewport.innerHeight - rect.top + 8}px`;
      tooltip.hidden = false;
    }
    let editable = false, hasDraft = true, contextAvailable = false;
    const selectable = name => name === 'context' ? contextAvailable : name === 'changes' || editable && !hasDraft;
    const select = (name, field) => {
      if (selectable(name) && enabled && positioned && !field.hidden) {
        hideTooltip();
        actions[name]?.(field);
      }
    };
    for (const name of ['project', 'branch', 'changes', 'context']) {
      const field = document.createElement('span');
      field.className = `hud-${name}`;
      if (actions[name]) {
        field.setAttribute('role', 'button');
        field.setAttribute('aria-haspopup', 'dialog');
        field.addEventListener('click', () => select(name, field));
        field.addEventListener('keydown', event => {
          if (event.key === 'Escape') hideTooltip();
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            select(name, field);
          }
        });
      }
      if (icons[name]) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
        for (const d of icons[name]) {
          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('d', d);
          svg.append(path);
        }
        if (name === 'context') {
          for (const kind of ['track', 'progress']) {
            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            for (const [key, value] of Object.entries({ cx: 12, cy: 12, r: 9, pathLength: 100, class: `context-${kind}` })) circle.setAttribute(key, value);
            svg.append(circle);
          }
        }
        field.append(svg);
      }
      const text = document.createElement('span');
      if (name === 'context') {
        text.hidden = true;
        field.setAttribute('aria-describedby', tooltip.id);
        field.addEventListener('mouseenter', showTooltip);
        field.addEventListener('mouseleave', hideTooltip);
        field.addEventListener('focus', showTooltip);
        field.addEventListener('blur', hideTooltip);
      }
      field.append(text);
      fields[name] = { field, text };
      if (name === 'changes') {
        for (const kind of ['added', 'deleted']) {
          const count = document.createElement('span');
          count.className = `hud-${kind}`;
          field.append(count);
          fields[name][kind] = count;
        }
      }
      bar.append(field);
    }
    document.body.append(bar, tooltip);
    let selection, positioned = false, enabled = false;
    function updateSelectors() {
      for (const name of ['project', 'branch', 'changes', 'context']) {
        if (!actions[name]) continue;
        const field = fields[name].field;
        const active = selectable(name) && enabled && positioned && !field.hidden;
        field.className = `hud-${name}${active ? name === 'changes' || name === 'context' ? ' hud-refreshable' : ' hud-selectable' : ''}`;
        field.tabIndex = active ? 0 : -1;
        field.setAttribute('aria-disabled', String(!active));
      }
    }
    return {
      render(state) {
        enabled = Boolean(visible(state));
        contextAvailable = state.contextAvailable === true;
        editable = state.canSelectProject === true;
        bar.hidden = !enabled || !positioned;
        const next = JSON.stringify([state.workspace, state.activeSessionId]);
        if (next !== selection) { bar.scrollLeft = 0; hideTooltip(); }
        selection = next;
        const data = describe(state, actions.formatPath);
        for (const [name, { field, text }] of Object.entries(fields)) {
          field.hidden = Boolean(data[name].hidden);
          const content = name === 'changes' ? data.changes.filesText : data[name].text;
          if (text.textContent !== content) text.textContent = content;
          field.title = name === 'context' ? '' : data[name].title;
          field.setAttribute('aria-label', `${name}: ${data[name].text}. ${data[name].title}`);
        }
        for (const kind of ['added', 'deleted']) {
          fields.changes[kind].textContent = data.changes[`${kind}Text`];
          fields.changes[kind].hidden = !data.changes[`${kind}Text`];
        }
        fields.context.field.dataset.level = data.percent >= 90 ? 'high' : data.percent >= 75 ? 'medium' : 'normal';
        fields.context.field.children[0].children[1].setAttribute('stroke-dasharray', `${Math.min(data.percent ?? 0, 100)} 100`);
        tooltip.textContent = data.context.tooltip;
        if (!enabled || fields.context.field.hidden) hideTooltip();
        updateSelectors();
      },
      setDraft(value) { hasDraft = value; updateSelectors(); },
      layout(rect) {
        positioned = Boolean(rect);
        if (!rect || bar.style.left !== `${rect.left}px` || bar.style.top !== `${rect.top}px` || bar.style.width !== `${rect.width}px`) hideTooltip();
        bar.hidden = !enabled || !positioned;
        updateSelectors();
        if (!rect) return;
        bar.style.left = `${rect.left}px`;
        bar.style.top = `${rect.top}px`;
        bar.style.width = `${rect.width}px`;
      },
    };
  }

  const api = { describe, visible, create, height: 20, gap: 4 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.goHUD = api;
})();
