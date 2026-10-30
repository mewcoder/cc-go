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

  const opener = button('import-history', 'icon-button');
  opener.title = 'Import Claude Code CLI sessions';
  opener.setAttribute('aria-label', 'Import Claude Code CLI sessions');
  opener.setAttribute('aria-haspopup', 'dialog');
  opener.setAttribute('aria-controls', 'history-dialog');
  opener.disabled = true;
  opener.append(icon(['M2 9V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-1', 'M2 13h10', 'm9 10 3 3-3 3']));
  addWorkspace.before(opener);

  const dialog = create('dialog', 'history-dialog');
  dialog.id = 'history-dialog';
  dialog.setAttribute('aria-labelledby', 'history-title');
  const header = create('header', 'history-header');
  const title = create('h1', '', 'Import Claude Code CLI sessions');
  title.id = 'history-title';
  const close = button('history-close', 'icon-button');
  close.title = 'Close';
  close.setAttribute('aria-label', 'Close Import Claude Code CLI sessions');
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
    opener.disabled = !available || loading || importing;
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
    opener.focus();
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
    available = !['starting', 'setup', 'activating'].includes(state.phase) && !state.pluginSetupOpen;
    registered = new Set((state.workspaces || []).map(project => project.path));
    if (!available && dialog.open && !importing) closeDialog();
    update();
  });
})();
