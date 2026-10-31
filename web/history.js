'use strict';

(() => {
  const desktop = window.desktop;
  const addWorkspace = document.getElementById('add-workspace');
  if (!desktop || !addWorkspace) return;

  function create(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
  }
  function icon(paths) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('stroke-width', '1.5');
    svg.setAttribute('aria-hidden', 'true');
    for (const data of paths) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', data);
      svg.append(path);
    }
    return svg;
  }
  function button(id, className, label) {
    const element = create('button', className, label);
    element.id = id;
    element.type = 'button';
    return element;
  }

  const menuButton = button('project-more', 'icon-button');
  menuButton.title = 'Project actions';
  menuButton.setAttribute('aria-label', 'Project actions');
  menuButton.setAttribute('aria-haspopup', 'menu');
  menuButton.setAttribute('aria-controls', 'project-menu');
  menuButton.setAttribute('aria-expanded', 'false');
  menuButton.disabled = true;
  menuButton.append(icon(['M6 12a1 1 0 1 1-2 0 1 1 0 0 1 2 0', 'M13 12a1 1 0 1 1-2 0 1 1 0 0 1 2 0', 'M20 12a1 1 0 1 1-2 0 1 1 0 0 1 2 0']));
  addWorkspace.before(menuButton);

  const menu = create('dialog', 'hud-picker workspace-menu project-menu');
  menu.id = 'project-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Project actions');
  const opener = button('import-history', 'hud-picker-choice');
  opener.title = 'Import Claude Code CLI Sessions';
  opener.setAttribute('aria-label', 'Import Claude Code CLI Sessions');
  opener.setAttribute('role', 'menuitem');
  opener.setAttribute('aria-haspopup', 'dialog');
  opener.setAttribute('aria-controls', 'history-dialog');
  opener.disabled = true;
  opener.append(create('span', '', 'Import'));
  const submenu = create('div', 'hud-picker workspace-menu project-submenu');
  submenu.id = 'project-submenu';
  submenu.setAttribute('role', 'menu');
  submenu.hidden = true;
  const display = menuChoice('sidebar-display', 'Group by');
  const sorting = menuChoice('sidebar-sort', 'Sort by');
  const separator = create('hr');
  separator.setAttribute('role', 'separator');
  const archived = button('show-archive', 'hud-picker-choice', 'Archived');
  archived.setAttribute('role', 'menuitem');
  archived.setAttribute('aria-controls', 'archive-list');
  const menuError = create('p', 'hud-picker-status');
  menuError.setAttribute('role', 'alert');
  menuError.hidden = true;
  menu.append(display, sorting, separator, archived, opener, submenu, menuError);
  document.body.append(menu);
  let latestState = {}, menuBusy = false, submenuKey, submenuTrigger;
  const radioItems = [];

  function menuChoice(id, label) {
    const item = button(id, 'hud-picker-choice');
    item.setAttribute('role', 'menuitem');
    item.setAttribute('aria-haspopup', 'menu');
    item.setAttribute('aria-controls', 'project-submenu');
    item.setAttribute('aria-expanded', 'false');
    item.summary = create('span', 'project-menu-value');
    item.append(create('span', '', label), item.summary, icon(['m9 6 6 6-6 6']));
    return item;
  }
  function closeSubmenu() {
    submenu.hidden = true;
    submenuTrigger?.setAttribute('aria-expanded', 'false');
    submenuKey = undefined;
  }
  function openSubmenu(kind, trigger, focus = false) {
    if (menuBusy || !menu.open || trigger.disabled) return;
    closeSubmenu();
    submenuKey = kind;
    submenuTrigger = trigger;
    radioItems.length = 0;
    submenu.replaceChildren();
    submenu.setAttribute('aria-label', kind === 'display' ? 'Group by' : 'Sort by');
    const choices = kind === 'display'
      ? [['grouped', 'Project'], ['merged', 'None']]
      : [['updated', 'Last updated'], ['created', 'Date Created'], ['manual', 'Manual']];
    for (const [value, label] of choices) {
      const item = button(`sidebar-${kind}-${value}`, 'hud-picker-choice');
      item.setAttribute('role', 'menuitemradio');
      item.append(create('span', '', label), icon(['m20 6-11 11-5-5']));
      item.onclick = () => saveOption(kind, value);
      radioItems.push({ item, kind, value });
      submenu.append(item);
    }
    submenu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    updateMenu();
    const anchor = trigger.getBoundingClientRect(), parent = menu.getBoundingClientRect();
    const rect = submenu.getBoundingClientRect();
    const x = parent.right + 4 + rect.width <= document.documentElement.clientWidth - 8
      ? parent.right + 4 : parent.left - rect.width - 4;
    submenu.style.left = `${Math.max(8, Math.min(x, document.documentElement.clientWidth - rect.width - 8))}px`;
    submenu.style.top = `${Math.max(8, Math.min(anchor.top, document.documentElement.clientHeight - rect.height - 8))}px`;
    if (focus) radioItems[0].item.focus();
  }
  function updateMenu() {
    const preferences = window.goSidebarList.options(latestState);
    display.summary.textContent = preferences.display === 'grouped' ? 'Project' : 'None';
    sorting.summary.textContent = { updated: 'Last updated', created: 'Date Created', manual: 'Manual' }[preferences.sort];
    for (const { item, kind, value } of radioItems) {
      item.setAttribute('aria-checked', String(preferences[kind] === value));
      item.disabled = menuBusy;
    }
    display.disabled = sorting.disabled = menuBusy || !available;
    archived.disabled = menuBusy || !available;
    opener.disabled = menuBusy || !available || loading || importing;
  }
  async function saveOption(kind, value) {
    if (!available || menuBusy) return;
    const preferences = window.goSidebarList.options(latestState);
    if (preferences[kind] === value) { closeMenu(); return; }
    const patch = { [kind]: value };
    if (kind === 'sort' && value === 'manual' && !preferences.order.length) {
      patch.order = window.goSidebarList.currentOrder(latestState);
    }
    menuBusy = true;
    menuError.hidden = true;
    update();
    let saved = false;
    try {
      await desktop.setSidebarOptions(patch);
      saved = true;
      closeMenu(false);
    } catch (failure) {
      menuError.textContent = String(failure?.message || failure);
      menuError.hidden = false;
    } finally { menuBusy = false; update(); if (saved) menuButton.focus(); }
  }
  for (const [kind, trigger] of [['display', display], ['sort', sorting]]) {
    trigger.onclick = () => openSubmenu(kind, trigger, true);
    trigger.addEventListener('pointerenter', () => openSubmenu(kind, trigger));
    trigger.addEventListener('keydown', event => {
      if (event.key === 'ArrowRight') { event.preventDefault(); openSubmenu(kind, trigger, true); }
    });
  }
  opener.addEventListener('pointerenter', closeSubmenu);
  archived.addEventListener('pointerenter', closeSubmenu);
  archived.onclick = () => {
    if (archived.disabled) return;
    closeMenu(false);
    window.__goShowArchive();
  };

  function closeMenu(restoreFocus = true) {
    if (!menu.open) return;
    closeSubmenu();
    menu.close();
    menuButton.setAttribute('aria-expanded', 'false');
    if (restoreFocus) menuButton.focus();
  }
  function openMenu() {
    if (menuButton.disabled) return;
    if (menu.open) { closeMenu(); return; }
    const anchor = menuButton.getBoundingClientRect();
    menu.style.left = `${anchor.left}px`;
    menu.style.top = `${anchor.bottom + 4}px`;
    menu.showModal();
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(anchor.left, document.documentElement.clientWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(anchor.bottom + 4, document.documentElement.clientHeight - rect.height - 8))}px`;
    menuButton.setAttribute('aria-expanded', 'true');
    display.focus();
  }
  menuButton.onclick = openMenu;
  menuButton.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openMenu();
    }
  });
  menu.addEventListener('cancel', event => { event.preventDefault(); closeMenu(); });
  menu.addEventListener('keydown', event => {
    if (event.defaultPrevented) return;
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault();
      closeMenu();
    } else if (event.key === 'ArrowLeft' && submenuKey) {
      event.preventDefault();
      const trigger = submenuTrigger;
      closeSubmenu();
      trigger.focus();
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const choices = submenuKey && submenu.contains(event.target) ? radioItems.map(value => value.item) : [display, sorting, archived, opener];
      const current = choices.indexOf(document.activeElement);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
        : (current + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
      choices[index].focus();
    }
  });
  menu.addEventListener('click', event => {
    if (event.target !== menu) return;
    const rect = menu.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeMenu();
  });

  const dialog = create('dialog', 'history-dialog');
  dialog.id = 'history-dialog';
  dialog.setAttribute('aria-labelledby', 'history-title');
  const header = create('header', 'history-header');
  const title = create('h1', '', 'Import Claude Code CLI Sessions');
  title.id = 'history-title';
  const close = button('history-close', 'icon-button');
  close.title = 'Close';
  close.setAttribute('aria-label', 'Close Import Claude Code CLI Sessions');
  close.autofocus = true;
  close.append(icon(['m6 6 12 12', 'M18 6 6 18']));
  header.append(title, close);
  const status = create('p', 'history-status');
  status.id = 'history-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const list = create('div', 'history-project-list');
  list.id = 'history-project-list';
  list.setAttribute('role', 'group');
  list.setAttribute('aria-label', 'Claude Code CLI sessions');
  const error = create('p', 'history-error');
  error.id = 'history-error';
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const footer = create('footer', 'history-footer');
  const selectAll = button('history-select-all', 'history-select-all', 'Select All');
  const cancel = button('history-cancel', '', 'Cancel');
  const submit = button('history-import', 'history-primary', 'Import');
  footer.append(selectAll, submit, cancel);
  dialog.append(header, status, list, error, footer);
  document.body.append(dialog);

  let available = false, loading = false, importing = false, generation = 0;
  let registered = new Set(), inputs = [];
  function update() {
    inputs = inputs.filter(input => {
      if (!registered.has(input.value)) return true;
      input.parentElement.remove();
      return false;
    });
    let selected = 0;
    for (const input of inputs) {
      input.disabled = loading || importing;
      if (input.checked) selected++;
    }
    menuButton.disabled = !available || loading || importing || menuBusy;
    if (!available || loading || importing) closeMenu();
    updateMenu();
    close.disabled = cancel.disabled = importing;
    selectAll.hidden = !inputs.length;
    selectAll.disabled = loading || importing || !inputs.length;
    selectAll.textContent = inputs.length && selected === inputs.length ? 'Deselect All' : 'Select All';
    submit.disabled = loading || importing || !selected;
    submit.textContent = importing ? 'Importing...' : 'Import';
    list.setAttribute('aria-busy', String(loading || importing));
    status.textContent = loading ? 'Loading...' : !inputs.length && error.hidden ? 'No CLI sessions available to import' : '';
    status.hidden = !status.textContent;
  }
  function closeDialog() {
    if (importing) return;
    // Ignore a discovery response if its dialog was closed or reopened meanwhile.
    generation++;
    loading = false;
    dialog.close();
    update();
    menuButton.focus();
  }
  close.onclick = cancel.onclick = closeDialog;
  selectAll.onclick = () => {
    if (loading || importing || !inputs.length) return;
    const checked = !inputs.every(input => input.checked);
    for (const input of inputs) input.checked = checked;
    update();
  };
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });

  opener.onclick = async () => {
    if (!available || loading || importing || dialog.open) return;
    closeMenu(false);
    const current = ++generation;
    loading = true;
    inputs = [];
    list.replaceChildren();
    error.hidden = true;
    update();
    dialog.showModal();
    try {
      const projects = await desktop.historyProjects();
      if (current !== generation) return;
      for (const project of projects) {
        if (registered.has(project.path)) continue;
        const label = create('label', 'history-project');
        const input = create('input');
        input.type = 'checkbox';
        input.value = project.path;
        input.onchange = update;
        inputs.push(input);
        const displayPath = desktop.formatPath?.(project.path) ?? project.path;
        label.title = displayPath;
        const path = create('span', 'history-project-path');
        const value = create('bdi', 'history-project-value', displayPath);
        value.setAttribute('dir', 'ltr');
        path.append(value);
        label.append(input, path);
        list.append(label);
      }
    } catch (failure) {
      if (current !== generation) return;
      error.textContent = String(failure?.message || failure);
      error.hidden = false;
    } finally {
      if (current === generation) {
        loading = false;
        update();
      }
    }
  };

  submit.onclick = async () => {
    const paths = inputs.filter(input => input.checked && !input.disabled).map(input => input.value);
    if (!paths.length || loading || importing) return;
    importing = true;
    error.hidden = true;
    update();
    let imported = false;
    try {
      await desktop.importProjects(paths);
      for (const path of paths) registered.add(path);
      imported = true;
    } catch (failure) {
      error.textContent = String(failure?.message || failure);
      error.hidden = false;
    } finally {
      importing = false;
      update();
      if (imported) closeDialog();
    }
  };

  desktop.onState(state => {
    latestState = state;
    available = !['starting', 'setup', 'activating'].includes(state.phase) && !state.pluginSetupOpen && !state.settingsOpen;
    registered = new Set((state.workspaces || []).map(project => project.path));
    if (!available && dialog.open && !importing) closeDialog();
    update();
  });
})();
