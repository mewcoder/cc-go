'use strict';

(() => {
  function dirtySummary({ files, untracked }) {
    if (!Number.isSafeInteger(files) || !Number.isSafeInteger(untracked) || files < 1 || untracked < 0 || untracked > files) return 'Working tree has changes';
    const changed = files - untracked;
    if (!changed) return `${untracked} untracked ${untracked === 1 ? 'file' : 'files'}`;
    if (!untracked) return `${changed} changed ${changed === 1 ? 'file' : 'files'}`;
    return `${changed} changed \u00b7 ${untracked} untracked files`;
  }

  function create(document, { request, invoke, formatPath = value => value }) {
    const dialog = document.createElement('dialog');
    dialog.className = 'hud-picker';
    const filter = document.createElement('input');
    filter.type = 'search';
    filter.placeholder = 'Search...';
    filter.setAttribute('aria-label', 'Filter projects or branches');
    const status = document.createElement('p');
    status.className = 'hud-picker-status';
    status.setAttribute('role', 'status');
    const list = document.createElement('div');
    list.className = 'hud-picker-list';
    const group = document.createElement('div');
    group.className = 'hud-picker-label';
    group.textContent = 'Projects';
    const footer = document.createElement('div');
    footer.className = 'hud-picker-footer';
    dialog.append(filter, group, list, footer, status);
    document.body.append(dialog);
    let current, choices = [], busy = false, generation = 0;

    function close() {
      if (busy) return;
      current = undefined;
      generation++;
      dialog.close();
    }

    function render() {
      list.replaceChildren();
      footer.replaceChildren();
      group.hidden = current?.kind !== 'project' || !choices.some(choice => !choice.browse);
      footer.hidden = !choices.some(choice => choice.browse);
      status.hidden = !status.textContent;
      const query = filter.value.trim().toLowerCase();
      for (const choice of choices.filter(value => value.browse || `${value.name} ${value.detail || ''}`.toLowerCase().includes(query))) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'hud-picker-choice';
        button.disabled = busy || choice.disabled;
        button.title = choice.detail || choice.name;
        button.setAttribute('aria-current', String(Boolean(choice.current)));
        const title = document.createElement('span');
        title.textContent = choice.name;
        button.append(title);
        if (choice.current) {
          const check = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          check.setAttribute('viewBox', '0 0 16 16');
          check.setAttribute('aria-hidden', 'true');
          check.classList.add('hud-picker-check');
          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('d', 'm3 8 3 3 7-7');
          check.append(path);
          button.append(check);
        }
        button.addEventListener('click', () => choose(choice));
        (choice.browse ? footer : list).append(button);
      }
      filter.disabled = busy;
    }

    function focusChoice() {
      filter.focus();
    }

    async function choose(choice) {
      if (!current || busy || choice.disabled) return;
      if (choice.current) { close(); return; }
      const selection = current;
      busy = true;
      status.textContent = 'Switching...';
      render();
      try {
        await invoke(selection.kind === 'project' ? 'select-project' : 'select-branch', {
          id: selection.id, workspace: selection.workspace,
          ...(selection.kind === 'project' ? { path: choice.value } : { branch: choice.value }),
        });
        busy = false;
        close();
      } catch (error) {
        status.textContent = error.message;
        // A failed checkout may have reopened the host; don't reuse stale view IDs.
        current = undefined;
        choices = [];
        busy = false;
        render();
      }
    }

    filter.addEventListener('input', render);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || busy) return;
      if (event.target === filter && ['Home', 'End'].includes(event.key)) return;
      const buttons = [...list.children, ...footer.children].filter(button => !button.disabled);
      if (!buttons.length) return;
      event.preventDefault();
      const index = buttons.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : index < 0 ? event.key === 'ArrowDown' ? 0 : buttons.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus();
    }, true);
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
    });

    return {
      async open(kind, state, anchor) {
        if (busy || !state.canSelectProject) return;
        const id = state.views.find(view => view.active)?.id;
        if (!id) return;
        const version = ++generation;
        current = { kind, id, workspace: state.workspace };
        dialog.setAttribute('aria-label', kind === 'project' ? 'Choose project' : 'Switch branch');
        filter.placeholder = kind === 'project' ? 'Search folders\u2026' : 'Search branches\u2026';
        filter.value = '';
        status.textContent = '';
        status.title = '';
        choices = [];
        if (kind === 'project') {
          choices = (state.workspaces || []).map(project => ({ name: formatPath(project.name), detail: formatPath(project.path),
            value: project.path, current: project.path === state.workspace }));
          choices.push({ name: 'Open folder\u2026', value: '', browse: true });
        }
        const rect = anchor.getBoundingClientRect();
        dialog.style.left = `${Math.max(8, Math.min(rect.left, document.documentElement.clientWidth - 256))}px`;
        dialog.style.bottom = `${Math.max(8, document.documentElement.clientHeight - rect.top + 6)}px`;
        busy = kind === 'branch';
        if (busy) status.textContent = 'Loading...';
        render();
        if (!dialog.open) dialog.showModal();
        if (!busy) focusChoice();
        if (kind !== 'branch') return;
        try {
          const result = await request('branches', { id, workspace: state.workspace });
          if (version !== generation) return;
          choices = result.branches.map(name => ({ name, value: name, current: name === result.current,
            detail: result.dirty && name !== result.current ? 'Commit or stash changes before switching branches.'
              : `${name}\nSwitches the working tree shared by chats in this project.`,
            disabled: result.dirty && name !== result.current }));
          status.textContent = result.dirty ? dirtySummary(result)
            : choices.length ? '' : 'No local branches found.';
          status.title = result.dirty ? 'Commit or stash changes yourself before switching. Nothing will be discarded.' : '';
        } catch (error) {
          if (version === generation) status.textContent = error.message;
        } finally {
          if (version === generation) { busy = false; render(); focusChoice(); }
        }
      },
      sync(state) {
        if (!current || busy) return;
        if (!state.canSelectProject || state.workspace !== current.workspace
          || state.views.find(view => view.active)?.id !== current.id) close();
      },
    };
  }

  const api = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.goSelection = api;
})();
