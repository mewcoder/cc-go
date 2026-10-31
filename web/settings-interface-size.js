'use strict';

(() => {
  function create(document, { value, save, status, schedule = setTimeout }) {
    const presets = ['small', 'medium', 'large'];
    let selected = presets.includes(value) ? value : 'small';
    let pending = false;
    const group = document.createElement('div');
    group.className = 'setting-width';
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Interface Size');
    const inputs = presets.map(preset => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'interface-size';
      input.value = preset;
      input.checked = preset === selected;
      const text = document.createElement('span');
      text.textContent = preset[0].toUpperCase() + preset.slice(1);
      label.append(input, text);
      group.append(label);
      input.addEventListener('change', async () => {
        if (!input.checked || pending || preset === selected) return;
        pending = true;
        inputs.forEach(item => { item.disabled = true; });
        status.classList.remove('error');
        status.textContent = 'Saving…';
        try {
          await save(preset);
          selected = preset;
          status.textContent = 'Saved';
          schedule(() => { if (status.textContent === 'Saved') status.textContent = ''; }, 1600);
        } catch (error) {
          status.textContent = String(error?.message || error);
          status.classList.add('error');
        } finally {
          pending = false;
          inputs.forEach(item => {
            item.checked = item.value === selected;
            item.disabled = false;
          });
        }
      });
      return input;
    });
    return group;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { create };
  else window.goInterfaceSizeControl = { create };
})();
