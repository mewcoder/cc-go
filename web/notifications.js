'use strict';

(() => {
  function create(document, { request }) {
    const root = document.createElement('section');
    root.className = 'host-notifications';
    root.setAttribute('aria-label', 'Claude Code notifications');
    root.hidden = true;
    document.body.append(root);
    const cards = new Map();
    const answered = new Set();

    function element(tag, className, text) {
      const node = document.createElement(tag);
      node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }

    function card(item) {
      const node = element('article', 'host-notification');
      node.dataset.type = item.type;
      node.setAttribute('role', item.type === 'error' ? 'alert' : 'status');
      const heading = element('div', 'host-notification-heading');
      const kind = { info: 'Information', warning: 'Warning', error: 'Error' }[item.type] || 'Information';
      const label = element('span', 'host-notification-kind', kind);
      const message = element('p', 'host-notification-message', item.message);
      const detail = element('p', 'host-notification-detail', item.detail || '');
      detail.hidden = !item.detail;
      const close = element('button', 'host-notification-close', '\u00d7');
      close.type = 'button';
      close.title = 'Dismiss notification';
      close.setAttribute('aria-label', 'Dismiss notification');
      const actions = element('div', 'host-notification-actions');
      const error = element('p', 'host-notification-error');
      error.hidden = true;
      error.setAttribute('role', 'alert');
      const buttons = [close];
      let pending = false;
      async function answer(index) {
        if (pending) return;
        pending = true;
        for (const button of buttons) button.disabled = true;
        error.hidden = true;
        try {
          await request('notification-action', { id: item.id, action: index });
          answered.add(item.id);
          node.remove();
          cards.delete(item.id);
          root.hidden = cards.size === 0;
        } catch (failure) {
          error.textContent = failure.message;
          error.hidden = false;
        } finally {
          pending = false;
          for (const button of buttons) button.disabled = false;
        }
      }
      for (const [index, title] of (item.actions || []).entries()) {
        const button = element('button', 'host-notification-action', title);
        button.type = 'button';
        button.addEventListener('click', () => { void answer(index); });
        actions.append(button);
        buttons.push(button);
      }
      close.addEventListener('click', () => { void answer(-1); });
      heading.append(label, close);
      node.append(heading, message, detail, actions, error);
      return node;
    }

    return {
      render(items) {
        const ids = new Set(items.map(item => item.id));
        for (const id of answered) if (!ids.has(id)) answered.delete(id);
        for (const [id, node] of cards) {
          if (!ids.has(id)) { node.remove(); cards.delete(id); }
        }
        for (const item of items) {
          if (!cards.has(item.id) && !answered.has(item.id)) {
            const node = card(item);
            cards.set(item.id, node);
            root.append(node);
          }
        }
        root.hidden = cards.size === 0;
      },
    };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { create };
  else window.goNotifications = { create };
})();
