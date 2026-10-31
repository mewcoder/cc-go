'use strict';

(() => {
  const diff = typeof module !== 'undefined' && module.exports ? require('./vendor/diff2html/diff2html.min.js') : window.Diff2Html;

  function renderPatch(patch) {
    const lines = patch.split('\n', 6001);
    return {
      truncated: lines.length > 6000,
      html: diff.html(lines.slice(0, 6000).join('\n'), {
        drawFileList: false, outputFormat: 'line-by-line', matching: 'none',
        diffStyle: 'word', maxLineLengthHighlight: 1000, renderNothingWhenEmpty: true,
      }),
    };
  }

  function create(document, { request }) {
    function element(tag, className, text) {
      const node = document.createElement(tag);
      node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }
    function button(className, text, title) {
      const node = element('button', className, text);
      node.type = 'button';
      if (title) { node.title = title; node.setAttribute('aria-label', title); }
      return node;
    }
    function icon(paths) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      for (const [key, value] of Object.entries({ class: 'icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(key, value);
      for (const data of paths) {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', data);
        svg.append(path);
      }
      return svg;
    }
    const dialog = element('dialog', 'git-review-dialog');
    dialog.setAttribute('aria-label', 'Git Changes');
    const header = element('header', 'git-review-header');
    const title = element('h1', '', 'Changes');
    const summary = element('span', 'git-review-summary');
    const refresh = button('git-review-refresh', undefined, 'Refresh changes');
    refresh.append(icon(['M3 12a9 9 0 0 1 15.36-6.36L21 8', 'M21 3v5h-5', 'M21 12a9 9 0 0 1-15.36 6.36L3 16', 'M8 16H3v5']));
    const dismiss = button('git-review-close', undefined, 'Close Changes');
    dismiss.append(icon(['m18 6-12 12', 'm6 6 12 12']));
    header.append(title, summary, refresh, dismiss);
    const scope = element('p', 'git-review-scope', 'Compared with HEAD \u00b7 staged, unstaged and untracked files');
    const body = element('div', 'git-review-body');
    const sidebar = element('nav', 'git-review-sidebar');
    sidebar.setAttribute('aria-label', 'Changed files');
    const filter = element('input', 'git-review-filter');
    filter.type = 'search';
    filter.placeholder = 'Filter files...';
    filter.setAttribute('aria-label', 'Filter changed files');
    const files = element('div', 'git-review-files');
    sidebar.append(filter, files);
    const preview = element('section', 'git-review-preview');
    preview.setAttribute('aria-label', 'File diff');
    const filename = element('h2', 'git-review-filename');
    const message = element('p', 'git-review-message');
    message.setAttribute('role', 'status');
    const patch = element('div', 'git-review-patch');
    patch.tabIndex = 0;
    patch.setAttribute('aria-label', 'Diff preview');
    preview.append(filename, message, patch);
    body.append(sidebar, preview);
    const status = element('p', 'git-review-status');
    status.setAttribute('role', 'status');
    dialog.append(header, scope, status, body);
    document.body.append(dialog);
    let current, entries = [], selected, generation = 0, detailGeneration = 0;

    function close(restore = true) {
      const anchor = current?.anchor;
      current = undefined;
      generation++;
      detailGeneration++;
      dialog.close();
      if (restore && anchor?.isConnected && !anchor.hidden) anchor.focus();
    }

    function renderFiles() {
      const focused = files.contains?.(document.activeElement) ? document.activeElement.dataset.path : undefined;
      files.replaceChildren();
      const query = filter.value.trim().toLowerCase();
      for (const file of entries.filter(file => `${file.path} ${file.originalPath || ''}`.toLowerCase().includes(query))) {
        const row = button('git-review-file');
        row.dataset.path = file.path;
        row.title = file.originalPath ? `${file.originalPath} \u2192 ${file.path}` : file.path;
        row.setAttribute('aria-pressed', String(file.path === selected));
        const path = element('span', 'git-review-path', file.path);
        const state = element('span', 'git-review-file-status', file.status === '??' ? 'U' : file.status.trim());
        const counts = element('span', 'git-review-counts');
        if (file.binary) counts.textContent = 'Binary';
        else {
          if (file.added) counts.append(element('span', 'hud-added', `+${file.added.toLocaleString('en-US')}`));
          if (file.deleted) counts.append(element('span', 'hud-deleted', `-${file.deleted.toLocaleString('en-US')}`));
        }
        row.append(state, path, counts);
        row.addEventListener('click', () => { void choose(file); });
        files.append(row);
        if (file.path === focused) row.focus();
      }
      if (entries.length && !files.children.length) files.append(element('p', 'git-review-no-files', 'No matching files.'));
    }

    async function choose(file, position) {
      if (!current) return;
      const version = ++detailGeneration, workspace = current.workspace;
      selected = file.path;
      renderFiles();
      filename.textContent = file.originalPath ? `${file.originalPath} \u2192 ${file.path}` : file.path;
      filename.title = filename.textContent;
      const keepPreview = position?.path === file.path;
      message.textContent = keepPreview ? '' : 'Loading diff...';
      if (!keepPreview) {
        patch.replaceChildren();
        patch.scrollTop = patch.scrollLeft = 0;
      }
      preview.setAttribute('aria-busy', 'true');
      try {
        const result = await request('git-diff', { workspace, path: file.path });
        if (!current || version !== detailGeneration) return;
        const rendered = renderPatch(result.patch || '');
        const truncated = result.truncated || rendered.truncated;
        message.textContent = [result.message, truncated ? 'Preview truncated. Showing the beginning of this diff.' : ''].filter(Boolean).join(' ');
        // diff2html escapes file names and source text before returning markup.
        patch.innerHTML = rendered.html;
        if (position?.path === file.path) {
          patch.scrollTop = position.top;
          patch.scrollLeft = position.left;
        }
      } catch (error) {
        if (current && version === detailGeneration) message.textContent = error.message || String(error);
      } finally {
        if (current && version === detailGeneration) preview.setAttribute('aria-busy', 'false');
      }
    }

    async function load() {
      if (!current) return;
      const version = ++generation, workspace = current.workspace;
      const restoreRefresh = document.activeElement === refresh;
      const position = { path: selected, top: patch.scrollTop, left: patch.scrollLeft };
      const refreshing = entries.length > 0;
      detailGeneration++;
      refresh.disabled = true;
      refresh.setAttribute('aria-busy', 'true');
      filter.disabled = true;
      preview.setAttribute('aria-busy', 'false');
      status.textContent = refreshing ? '' : 'Loading changes...';
      status.hidden = refreshing;
      try {
        const result = await request('git-changes', { workspace });
        if (!current || version !== generation) return;
        entries = result.files;
        summary.textContent = `${entries.length} ${entries.length === 1 ? 'file' : 'files'}`;
        scope.title = result.root;
        status.textContent = entries.length ? '' : 'No uncommitted changes.';
        status.hidden = Boolean(entries.length);
        renderFiles();
        const file = entries.find(file => file.path === selected) || entries[0];
        if (file) await choose(file, position);
        else {
          selected = undefined;
          filename.textContent = message.textContent = '';
          patch.replaceChildren();
        }
      } catch (error) {
        if (current && version === generation) {
          status.textContent = error.message || String(error);
          status.hidden = false;
        }
      } finally {
        if (current && version === generation) {
          refresh.disabled = false;
          refresh.setAttribute('aria-busy', 'false');
          filter.disabled = false;
          if (restoreRefresh) refresh.focus();
        }
      }
    }

    filter.addEventListener('input', renderFiles);
    refresh.addEventListener('click', () => { if (!refresh.disabled) void load(); });
    dismiss.addEventListener('click', () => close());
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
    });
    files.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const rows = [...files.children].filter(row => row.tagName === 'BUTTON');
      if (!rows.length) return;
      event.preventDefault();
      const index = rows.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length;
      rows[next].focus();
    });

    return {
      open(state, anchor) {
        if (state.phase !== 'active' || state.settingsOpen || state.pluginSetupOpen || !state.workspace) return;
        current = { workspace: state.workspace, view: state.views?.find(view => view.active)?.id, anchor };
        selected = undefined;
        entries = [];
        files.replaceChildren();
        patch.replaceChildren();
        filename.textContent = message.textContent = '';
        filter.value = '';
        summary.textContent = '';
        if (!dialog.open) dialog.showModal();
        dismiss.focus();
        void load();
      },
      sync(state) {
        if (current && (state.phase !== 'active' || state.settingsOpen || state.pluginSetupOpen || state.workspace !== current.workspace
          || state.views?.find(view => view.active)?.id !== current.view)) close(false);
      },
    };
  }

  const api = { create, renderPatch };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.goGitReview = api;
})();
