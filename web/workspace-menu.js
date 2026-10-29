'use strict';

(() => {
  function create(document, desktop) {
    const dialog = document.createElement('dialog');
    dialog.className = 'hud-picker workspace-menu';
    dialog.setAttribute('aria-label', 'Project actions');
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'hud-picker-choice';
    item.textContent = desktop.platform === 'darwin' ? 'Open in Finder'
      : desktop.platform === 'win32' ? 'Open in File Explorer' : 'Open in File Manager';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'hud-picker-choice';
    remove.textContent = 'Remove';
    remove.title = 'Remove from sidebar only. Files and chat history are kept. Open conversations continue.';
    const error = document.createElement('p');
    error.className = 'hud-picker-status';
    error.setAttribute('role', 'alert');
    error.hidden = true;
    dialog.append(item, remove, error);
    document.body.append(dialog);
    let projects = new Set(), selected, opener, busy = false;

    function close(removed = false) {
      if (!dialog.open) return;
      dialog.close();
      selected = undefined;
      (removed ? document.getElementById('add-workspace') : opener)?.focus();
    }

    function open(event, keyboard = false) {
      if (busy) return;
      const row = event.target.closest?.('.workspace-row');
      const target = row?.querySelector('.workspace-open');
      if (!target || !projects.has(target.dataset.path)) return;
      event.preventDefault();
      selected = target.dataset.path;
      opener = target;
      error.textContent = '';
      error.hidden = true;
      const anchor = row.getBoundingClientRect();
      const x = keyboard || !event.clientX ? anchor.left : event.clientX;
      const y = keyboard || !event.clientY ? anchor.bottom : event.clientY;
      dialog.style.left = `${Math.max(8, x)}px`;
      dialog.style.top = `${Math.max(8, y)}px`;
      if (!dialog.open) dialog.showModal();
      const rect = dialog.getBoundingClientRect();
      dialog.style.left = `${Math.max(8, Math.min(x, document.documentElement.clientWidth - rect.width - 8))}px`;
      dialog.style.top = `${Math.max(8, Math.min(y, document.documentElement.clientHeight - rect.height - 8))}px`;
      item.focus();
    }

    async function perform(action) {
      if (!selected || busy) return;
      const directory = selected;
      busy = item.disabled = remove.disabled = true;
      error.hidden = true;
      try {
        await desktop[action](directory);
        if (selected === directory) close(action === 'removeWorkspace');
      } catch (failure) {
        if (selected === directory) {
          error.textContent = String(failure?.message || failure);
          error.hidden = false;
        }
      } finally { busy = item.disabled = remove.disabled = false; }
    }
    item.addEventListener('click', () => perform('openWorkspaceFolder'));
    remove.addEventListener('click', () => perform('removeWorkspace'));
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'Tab') close();
      if (!busy && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const next = event.key === 'Home' ? item : event.key === 'End' ? remove : document.activeElement === item ? remove : item;
        next.focus();
      }
    }, true);
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
    });
    document.addEventListener('contextmenu', event => open(event));
    document.addEventListener('keydown', event => {
      if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) open(event, true);
    });
    desktop.onState(state => {
      projects = new Set((state.workspaces || []).map(project => project.path));
      if (selected && !projects.has(selected)) close(true);
      else if (selected && (state.settingsOpen || state.pluginSetupOpen)) close();
    });
    return { close };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { create };
  else if (window.desktop?.openWorkspaceFolder) create(document, window.desktop);
})();
