'use strict';

(() => {
  const sidebar = typeof module !== 'undefined' && module.exports ? require('./sidebar-list.js') : window.goSidebarList;
  const key = session => JSON.stringify([session.workspace, session.id]);

  function search(state, query, workspace) {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const sessions = new Map();
    const projects = new Map((state.workspaces || []).map(project => [project.path, project]));
    for (const project of projects.values()) {
      for (const session of project.sessions || []) {
        if (session.archived) continue;
        const item = { ...session, workspace: project.path, workspaceName: project.name || project.path };
        sessions.set(key(item), item);
      }
    }
    return [...sessions.values()].filter(session => {
      if (workspace && session.workspace !== workspace) return false;
      const text = `${session.title || 'Chat'} ${session.workspaceName} ${session.workspace}`.toLowerCase();
      return terms.every(term => text.includes(term));
    }).sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0)
      || key(a).localeCompare(key(b)));
  }

  function create(document, desktop) {
    const anchor = document.getElementById('toggle-sidebar');
    if (!anchor) return;
    const element = (tag, className = '', text) => {
      const node = document.createElement(tag);
      node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    function button(className, label) {
      const node = element('button', className);
      node.type = 'button';
      node.title = label;
      node.setAttribute('aria-label', label);
      return node;
    }
    function icon(paths) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      for (const [name, value] of Object.entries({ class: 'icon', viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) {
        svg.setAttribute(name, value);
      }
      for (const data of paths) {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', data);
        svg.append(path);
      }
      return svg;
    }
    const opener = button('window-toggle', 'Search Chats');
    opener.id = 'search-chats';
    opener.disabled = true;
    opener.setAttribute('aria-haspopup', 'dialog');
    opener.setAttribute('aria-controls', 'chat-search-dialog');
    opener.append(icon(['M21 21l-4.35-4.35', 'M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0']));
    anchor.after(opener);
    const dialog = element('dialog', 'history-dialog chat-search-dialog');
    dialog.id = 'chat-search-dialog';
    dialog.setAttribute('aria-labelledby', 'chat-search-title');
    const header = element('header', 'history-header');
    const title = element('h1', '', 'Search Chats');
    title.id = 'chat-search-title';
    const dismiss = button('icon-button', 'Close Search');
    dismiss.append(icon(['M18 6 6 18', 'm6 6 12 12']));
    header.append(title, dismiss);
    const controls = element('div', 'chat-search-controls');
    const input = element('input', 'chat-search-input');
    input.type = 'search';
    input.placeholder = 'Search chat titles or projects';
    input.setAttribute('aria-label', 'Search chat titles or projects');
    input.setAttribute('aria-controls', 'chat-search-results');
    const scope = element('select', 'chat-search-scope');
    scope.setAttribute('aria-label', 'Search scope');
    scope.value = 'all';
    controls.append(scope, input);
    const status = element('p', 'chat-search-status');
    status.setAttribute('role', 'status');
    const error = element('p', 'history-error');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    const results = element('div', 'chat-search-results');
    results.id = 'chat-search-results';
    results.setAttribute('role', 'group');
    results.setAttribute('aria-label', 'Matching chats');
    const more = button('session-load-more', 'Show more matching chats');
    more.textContent = 'Show More';
    dialog.append(header, controls, status, error, results, more);
    document.body.append(dialog);
    let latest = {}, busy = false, limit = 50, selected, matches = [], rows = [], projectChoices;
    const available = () => latest.phase === 'active' && !latest.settingsOpen && !latest.pluginSetupOpen;
    const formatPath = value => desktop.formatPath?.(value) ?? value;

    function syncScope() {
      const choices = [['all', 'All projects'], ...sidebar.projects(latest)
        .map(project => [project.path, formatPath(project.name || project.path)])];
      const signature = JSON.stringify(choices);
      // Keep the native menu open during background state refreshes.
      if (signature === projectChoices) return;
      projectChoices = signature;
      const value = scope.value;
      scope.replaceChildren(...choices.map(([value, label]) => {
        const option = element('option', '', label);
        option.value = value;
        return option;
      }));
      scope.value = choices.some(choice => choice[0] === value) ? value : 'all';
    }
    function close(restore = true) {
      dialog.close();
      if (restore && !opener.disabled) opener.focus();
    }
    async function openSession(session) {
      if (busy || !available()) return;
      busy = true;
      error.hidden = true;
      update();
      try {
        await desktop.openSession(session.workspace, session.id);
        // Let the selected conversation receive focus after its view is ready.
        close(false);
      } catch (failure) {
        error.textContent = String(failure?.message || failure);
        error.hidden = false;
      } finally {
        busy = false;
        update();
      }
    }
    function render() {
      const focused = rows.find(row => row.node === document.activeElement)?.key;
      const scrollTop = results.scrollTop;
      matches = search(latest, input.value, scope.value === 'all' ? undefined : scope.value);
      const visible = matches.slice(0, limit);
      if (!visible.some(session => key(session) === selected)) selected = visible[0] && key(visible[0]);
      results.replaceChildren();
      rows = visible.map(session => {
        const id = key(session), row = button('chat-search-result', session.title || 'Chat');
        row.dataset.selected = String(id === selected);
        row.disabled = busy;
        row.title = `${session.title || 'Chat'}\n${formatPath(session.workspace)}`;
        row.append(element('span', 'chat-search-name', session.title || 'Chat'),
          element('span', 'chat-search-project', formatPath(session.workspaceName)));
        row.addEventListener('click', () => { void openSession(session); });
        row.addEventListener('focus', () => select(id));
        results.append(row);
        return { key: id, node: row };
      });
      status.hidden = matches.length > 0;
      status.textContent = matches.length ? '' : 'No matching chats';
      more.hidden = matches.length <= limit;
      more.disabled = busy;
      results.scrollTop = scrollTop;
      if (focused) rows.find(row => row.key === focused)?.node.focus({ preventScroll: true });
    }
    function select(id) {
      selected = id;
      for (const row of rows) row.node.dataset.selected = String(row.key === selected);
    }
    function update() {
      syncScope();
      opener.disabled = busy || !available();
      input.disabled = scope.disabled = busy;
      if (dialog.open && !available()) close(false);
      if (dialog.open) render();
    }
    opener.addEventListener('click', () => {
      if (opener.disabled) return;
      input.value = '';
      scope.value = 'all';
      limit = 50;
      selected = undefined;
      error.hidden = true;
      dialog.showModal();
      render();
      input.focus();
    });
    const filter = () => { limit = 50; selected = undefined; error.hidden = true; results.scrollTop = 0; render(); };
    input.addEventListener('input', filter);
    scope.addEventListener('change', filter);
    more.addEventListener('click', () => {
      const index = rows.length;
      limit += 50;
      render();
      rows[index]?.node.focus();
    });
    dismiss.addEventListener('click', () => close());
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
    });
    dialog.addEventListener('keydown', event => {
      if (!dialog.open || event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (busy || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.target !== input && !rows.some(row => row.node === event.target)) return;
      if (event.key === 'Enter' && event.target === input) {
        const session = matches.find(session => key(session) === selected);
        if (session) { event.preventDefault(); void openSession(session); }
      } else if (['ArrowDown', 'ArrowUp'].includes(event.key) && rows.length) {
        event.preventDefault();
        const index = event.target === input ? event.key === 'ArrowDown' ? -1 : 0
          : rows.findIndex(row => row.key === selected);
        const next = (index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
        select(rows[next].key);
        rows[next].node.focus();
      }
    }, true);
    desktop.onState(state => { latest = state; update(); });
    return { dialog, opener, input, scope, results, more };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { search, create };
  else if (window.desktop) create(document, window.desktop);
})();
