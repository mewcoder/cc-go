'use strict';

(() => {
  const sections = [
    { id: 'appearance', category: 'general', title: 'Appearance' },
    { id: 'conversation', category: 'extension', title: 'Conversation' },
    { id: 'sessions', category: 'extension', title: 'Sessions & permissions' },
    { id: 'advanced', category: 'extension', title: 'Advanced' },
  ];
  const conversationKeys = new Set(['useCtrlEnterToSend', 'scrollToBottomOnSend', 'showMessageTimestamps', 'focusView']);
  const sessionKeys = new Set(['archiveInactiveSessions', 'respectGitIgnore', 'initialPermissionMode', 'allowDangerouslySkipPermissions']);

  function sectionFor(key) {
    if (key.startsWith('desktop.')) return 'appearance';
    const name = key.replace(/^claudeCode\./, '');
    if (conversationKeys.has(name)) return 'conversation';
    if (sessionKeys.has(name)) return 'sessions';
    return 'advanced';
  }

  function create({ search, navigation, content, list, empty }) {
    const buttons = [...navigation.querySelectorAll('[data-category]')];
    let selected = 'general';
    const scrollPositions = new Map();

    function refresh() {
      const query = search.value.trim().toLowerCase();
      let matches = 0;
      for (const section of list.children) {
        let visible = 0;
        for (const row of section.querySelectorAll('.setting-row')) {
          row.hidden = query ? !row.dataset.search.includes(query) : section.dataset.category !== selected;
          if (!row.hidden) visible++;
        }
        section.hidden = visible === 0;
        matches += visible;
      }
      for (const button of buttons) {
        if (!query && button.dataset.category === selected) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      }
      list.classList.toggle('is-searching', Boolean(query));
      empty.hidden = matches > 0;
    }

    for (const button of buttons) {
      button.addEventListener('click', () => {
        if (!search.value) scrollPositions.set(selected, content.scrollTop);
        selected = button.dataset.category;
        search.value = '';
        refresh();
        content.scrollTop = scrollPositions.get(selected) ?? 0;
      });
    }
    search.addEventListener('input', () => {
      refresh();
      content.scrollTop = 0;
    });

    return {
      refresh,
      reset() {
        search.value = '';
        scrollPositions.clear();
        refresh();
        content.scrollTop = 0;
      },
    };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { sections, sectionFor, create };
  else window.goSettingsNavigation = { sections, sectionFor, create };
})();
