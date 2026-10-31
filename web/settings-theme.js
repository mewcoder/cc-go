'use strict';

(() => {
  let catalogRequest;
  function loadCatalog() {
    return catalogRequest ??= fetch('code-themes/catalog.json').then(response => {
      if (!response.ok) throw Error('Could not load themes');
      return response.json();
    }).catch(error => { catalogRequest = undefined; throw error; });
  }
  function create(document, { value, save, status, catalog = loadCatalog, schedule = setTimeout }) {
    let families = [], latest = value;
    const family = theme => families.find(item => item.id === theme || item.light === theme || item.dark === theme)?.id ?? 'default';
    let selected = 'default';
    let pending = false;
    const control = document.createElement('select');
    control.setAttribute('aria-label', 'Theme');
    control.disabled = true;
    control.ready = Promise.resolve().then(catalog).then(items => {
      families = items;
      for (const item of [{ id: 'default', label: 'Default' }, ...items]) {
        const option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.label;
        control.append(option);
      }
      selected = family(latest);
      control.value = selected;
      control.disabled = false;
    }).catch(error => {
      status.textContent = String(error?.message || error);
      status.classList.add('error');
    });
    control.syncTheme = theme => {
      if (pending) return;
      latest = theme;
      selected = family(theme);
      control.value = selected;
    };
    control.addEventListener('change', async () => {
      if (pending || control.value === selected) return;
      const next = control.value;
      pending = true;
      control.disabled = true;
      status.classList.remove('error');
      status.textContent = 'Saving...';
      try {
        await save(next);
        selected = next;
        status.textContent = 'Saved';
        schedule(() => { if (status.textContent === 'Saved') status.textContent = ''; }, 1600);
      } catch (error) {
        status.textContent = String(error?.message || error);
        status.classList.add('error');
      } finally {
        pending = false;
        control.value = selected;
        control.disabled = false;
      }
    });
    return control;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { create };
  else window.goThemeControl = { create };
})();
