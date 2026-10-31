'use strict';

(() => {
  const key = session => JSON.stringify([session.workspace, session.id]);
  function options(state) {
    const value = state.sidebarOptions || {};
    return { display: value.display === 'merged' ? 'merged' : 'grouped',
      sort: ['created', 'manual'].includes(value.sort) ? value.sort : 'updated',
      order: Array.isArray(value.order) ? value.order : [],
      projectOrder: Array.isArray(value.projectOrder) ? value.projectOrder : [] };
  }
  function sortSessions(sessions, preferences) {
    const ranks = new Map(preferences.order.map((value, index) => [value, index]));
    return [...sessions].sort((a, b) => {
      if (preferences.sort === 'manual') {
        const rank = (ranks.get(key(a)) ?? Infinity) - (ranks.get(key(b)) ?? Infinity);
        if (rank && !Number.isNaN(rank)) return rank;
      }
      const timestamp = preferences.sort === 'created' ? 'createdAt' : 'updatedAt';
      return (Number(b[timestamp]) || 0) - (Number(a[timestamp]) || 0)
        || key(a).localeCompare(key(b));
    });
  }
  function projects(state) {
    const ranks = new Map(options(state).projectOrder.map((path, index) => [path, index]));
    return (state.workspaces || []).map(project => ({ ...project,
      sessions: (project.sessions || []).map(session => ({ ...session, workspace: project.path })) }))
      .sort((a, b) => (ranks.get(a.path) ?? Infinity) - (ranks.get(b.path) ?? Infinity) || 0);
  }
  function currentOrder(state) {
    const preferences = options(state), items = projects(state);
    return (preferences.display === 'merged'
      ? sortSessions(items.flatMap(project => project.sessions), preferences)
      : items.flatMap(project => sortSessions(project.sessions, preferences))).map(key);
  }
  function movedOrder(order, source, target, after = false) {
    if (source === target || !order.includes(source) || !order.includes(target)) return null;
    const result = order.filter(value => value !== source);
    result.splice(result.indexOf(target) + Number(after), 0, source);
    return result.every((value, index) => value === order[index]) ? null : result;
  }

  function create(document, desktop, { list, createRow, updateRow, render, formatPath }) {
    const merged = document.createElement('div');
    merged.className = 'merged-session-list';
    merged.hidden = true;
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'session-load-more';
    more.textContent = 'Show More';
    more.setAttribute('aria-label', 'Show more chats');
    const empty = document.createElement('p');
    empty.className = 'session-empty';
    empty.textContent = 'No chats yet';
    const error = document.createElement('p');
    error.className = 'sidebar-list-error';
    error.setAttribute('role', 'alert');
    error.hidden = true;
    const rows = new Map();
    let latest = {}, limit = 10, dragging, draggingProject, busy = false, displayMode, sortMode;
    more.addEventListener('click', () => { limit += 10; render(); });

    function prepare(state) {
      const preferences = options(state);
      if (preferences.display !== displayMode || preferences.sort !== sortMode) limit = 10;
      displayMode = preferences.display;
      sortMode = preferences.sort;
      latest = state;
      return projects(state).map(project => ({ ...project, sessions: sortSessions(project.sessions, options(state)) }));
    }
    function available() {
      return !busy && latest.phase === 'active'
        && !latest.settingsOpen && !latest.pluginSetupOpen;
    }
    function canReorder() { return available() && options(latest).sort === 'manual'; }
    function canReorderProjects() { return available() && options(latest).display === 'grouped'; }
    function renderMerged(phase) {
      const preferences = options(latest);
      merged.hidden = preferences.display !== 'merged';
      if (merged.hidden) {
        for (const row of rows.values()) row.remove();
        rows.clear();
      } else {
        const all = sortSessions(projects(latest).flatMap(project => project.sessions), preferences);
        const visible = all.slice(0, limit), keys = new Set(visible.map(key));
        for (const [id, row] of rows) {
          if (!keys.has(id)) { row.remove(); rows.delete(id); }
        }
        visible.forEach((session, index) => {
          const id = key(session);
          let row = rows.get(id);
          if (!row) {
            row = createRow(session.workspace, session.id, false);
            rows.set(id, row);
          }
          updateRow(row, session, session.workspace, phase);
          row.parts.open.title = `${session.title || 'Chat'}\n${formatPath(session.workspace)}`;
          if (merged.children[index] !== row) merged.insertBefore(row, merged.children[index] || null);
        });
        empty.hidden = all.length !== 0;
        more.hidden = all.length <= limit;
        merged.append(empty, more);
      }
      list.append(merged, error);
      for (const row of list.querySelectorAll('.session-row')) {
        row.draggable = canReorder();
        if (row.draggable) row.setAttribute('aria-description', 'Drag to reorder, or press Alt+Up or Alt+Down.');
        else row.removeAttribute('aria-description');
      }
      for (const row of list.querySelectorAll('.workspace-row')) {
        row.draggable = canReorderProjects();
        row.setAttribute('aria-description', 'Drag to reorder projects, or press Alt+Up or Alt+Down.');
      }
    }
    const rowKey = row => JSON.stringify([row.dataset.workspacePath, row.dataset.sessionId]);
    function targetRow(event) {
      const row = event.target.closest?.('.session-row');
      return row && list.contains(row) && !row.closest('[hidden]') ? row : null;
    }
    function projectRow(event) {
      const row = event.target.closest?.('.workspace-row');
      return row && list.contains(row) && !row.closest('[hidden]') ? row : null;
    }
    const projectPath = row => row.querySelector('.workspace-open').dataset.path;
    async function moveProject(source, target, after, restoreFocus = false) {
      if (!canReorderProjects()) return;
      const order = movedOrder(projects(latest).map(project => project.path), source, target, after);
      if (!order) return;
      busy = true;
      error.hidden = true;
      try { await desktop.setSidebarOptions({ projectOrder: order }); }
      catch (failure) { error.textContent = String(failure?.message || failure); error.hidden = false; }
      finally {
        busy = false;
        render();
        if (restoreFocus) {
          const row = [...list.querySelectorAll('.workspace-row')].find(item => projectPath(item) === source);
          row?.querySelector('.workspace-open').focus({ preventScroll: true });
        }
      }
    }
    function compatible(source, target) {
      try { return options(latest).display === 'merged' || JSON.parse(source)[0] === JSON.parse(target)[0]; }
      catch { return false; }
    }
    async function move(source, target, after, restoreFocus = false) {
      if (!canReorder() || !compatible(source, target)) return;
      const order = movedOrder(currentOrder(latest), source, target, after);
      if (!order) return;
      const preferences = options(latest);
      // Keep orders for temporarily archived/removed chats without retaining stale DOM rows.
      order.push(...preferences.order.filter(value => !order.includes(value)));
      busy = true;
      error.hidden = true;
      try { await desktop.setSidebarOptions({ order }); }
      catch (failure) { error.textContent = String(failure?.message || failure); error.hidden = false; }
      finally {
        busy = false;
        render();
        if (restoreFocus) {
          const row = [...list.querySelectorAll('.session-row')].find(item => rowKey(item) === source);
          row?.parts.open.focus({ preventScroll: true });
        }
      }
    }
    function clearDrag() {
      dragging = undefined;
      draggingProject = undefined;
      for (const row of list.querySelectorAll('.session-drop-target')) row.classList.remove('session-drop-target');
    }
    list.addEventListener('dragstart', event => {
      const project = projectRow(event);
      if (project && canReorderProjects()) {
        draggingProject = projectPath(project);
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', draggingProject);
        return;
      }
      const row = targetRow(event);
      if (!row || !canReorder() || event.target.closest?.('input, textarea')) { event.preventDefault(); return; }
      dragging = rowKey(row);
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', dragging);
    });
    list.addEventListener('dragover', event => {
      if (draggingProject) {
        const row = projectRow(event);
        if (!row || !canReorderProjects()) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        for (const item of list.querySelectorAll('.session-drop-target')) item.classList.remove('session-drop-target');
        row.classList.add('session-drop-target');
        return;
      }
      const row = targetRow(event);
      if (!dragging || !row || !canReorder() || !compatible(dragging, rowKey(row))) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      for (const item of list.querySelectorAll('.session-drop-target')) item.classList.remove('session-drop-target');
      row.classList.add('session-drop-target');
    });
    list.addEventListener('drop', event => {
      if (draggingProject) {
        const row = projectRow(event), source = draggingProject;
        clearDrag();
        if (!row) return;
        event.preventDefault();
        const rect = row.getBoundingClientRect();
        void moveProject(source, projectPath(row), event.clientY > rect.top + rect.height / 2);
        return;
      }
      const row = targetRow(event), source = dragging;
      clearDrag();
      if (!source || !row) return;
      event.preventDefault();
      const rect = row.getBoundingClientRect();
      void move(source, rowKey(row), event.clientY > rect.top + rect.height / 2);
    });
    list.addEventListener('dragend', clearDrag);
    list.addEventListener('keydown', event => {
      if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key) && canReorderProjects()
        && event.target.closest?.('.workspace-open')) {
        const row = projectRow(event);
        if (!row) return;
        const order = projects(latest).map(project => project.path);
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        const target = order[order.indexOf(projectPath(row)) + direction];
        if (!target) return;
        event.preventDefault();
        void moveProject(projectPath(row), target, direction > 0, true);
        return;
      }
      if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key) || !canReorder()
        || !event.target.closest?.('.session-item')) return;
      const row = targetRow(event);
      if (!row) return;
      const order = currentOrder(latest).filter(id => compatible(rowKey(row), id));
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      const target = order[order.indexOf(rowKey(row)) + direction];
      if (!target) return;
      event.preventDefault();
      void move(rowKey(row), target, direction > 0, true);
    });
    return { prepare, renderMerged, get merged() { return options(latest).display === 'merged'; } };
  }
  const api = { key, options, projects, sortSessions, currentOrder, movedOrder, create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.goSidebarList = api;
})();
