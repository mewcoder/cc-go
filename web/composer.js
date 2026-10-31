'use strict';

(() => {
  function titlebarRegions(window, document) {
    const header = [...document.querySelectorAll('[class*="header_"]')].find(element => {
      const rect = element.getBoundingClientRect();
      return rect.top >= 0 && rect.top <= 1 && rect.left >= 0 && rect.width >= window.innerWidth * .8
        && rect.height > 0 && rect.height <= 64;
    });
    if (!header) return [];
    const visible = element => element.getClientRects().length > 0;
    if ([...document.querySelectorAll('dialog[open], [role="dialog"], [role="menu"], [role="listbox"], [popover]')].some(visible)
      || [...header.querySelectorAll('[aria-expanded="true"]')].some(visible)) return [];
    const rect = header.getBoundingClientRect();
    const right = Math.min(window.innerWidth, rect.right);
    const controls = [...header.querySelectorAll('button, a, input, select, textarea, summary, label, [role="button"], [role="combobox"], [role="textbox"], [tabindex], [contenteditable]:not([contenteditable="false"]), [draggable="true"]')]
      .filter(visible).map(element => element.getBoundingClientRect())
      .filter(control => control.bottom > rect.top && control.top < rect.bottom)
      .sort((a, b) => a.left - b.left);
    const regions = [];
    let left = rect.left;
    for (const control of [...controls, { left: right, right }]) {
      const end = Math.min(right, Math.max(left, control.left - 2));
      if (end - left >= 4) regions.push({ left, top: rect.top, width: end - left, height: rect.height });
      left = Math.max(left, control.right + 2);
    }
    return regions;
  }

  function observeComposer(window, document) {
    let frame, observed, anchor, previous, stopped = false;
    let composingInput;
    const inputSelector = '[role="textbox"][aria-label="Message input"]';
    const resize = new window.ResizeObserver(schedule);
    const mutations = new window.MutationObserver(schedule);

    function messageInput(event) {
      return event.target?.closest?.(inputSelector);
    }

    function compositionStart(event) {
      composingInput = messageInput(event);
    }

    function compositionEnd() {
      composingInput = undefined;
    }

    function protectComposition(event) {
      if (event.key !== 'Enter') return;
      const input = messageInput(event);
      if (input && (input === composingInput || event.isComposing || event.keyCode === 229)) {
        // WebKit can end composition before Enter and report isComposing=false.
        // Keep the native commit action, but hide this key from plugin shortcuts.
        event.stopImmediatePropagation();
      }
    }

    function measure() {
      frame = undefined;
      if (stopped) return;
      const inputs = [...document.querySelectorAll('[role="textbox"][aria-label="Message input"]')];
      const visibleInput = inputs.find(element => element.getClientRects().length > 0);
      const input = visibleInput ?? inputs[0];
      const composer = input?.closest('[class*="inputContainer_"]');
      const candidate = composer?.parentElement?.closest('[class*="inputContainer_"]');
      const nextAnchor = visibleInput && candidate && window.getComputedStyle(candidate).position === 'absolute' ? candidate : null;
      if (nextAnchor !== anchor) {
        anchor?.removeAttribute('data-claude-host-composer-anchor');
        anchor = nextAnchor;
        anchor?.setAttribute('data-claude-host-composer-anchor', '');
      }
      if (composer !== observed) {
        if (observed) resize.unobserve(observed);
        observed = composer;
        if (observed) resize.observe(observed);
      }
      const bounds = visibleInput && composer?.getBoundingClientRect();
      const rect = bounds && bounds.width > 0 && bounds.height > 0
        ? { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height } : null;
      const hasDraft = Boolean(input?.textContent?.trim()
        || composer?.querySelector?.('[class*="attachedFilesContainer"] > *')
        || composer?.getAttribute?.('data-recording') === 'true');
      const loadError = Boolean(document.getElementById?.('claude-load-failure')?.textContent?.trim()
        || document.getElementById?.('claude-error')?.textContent?.trim());
      const loading = Boolean(document.querySelector?.('[class*="loadingState_"]'));
      const chatBounds = document.querySelector?.('[class*="chatContainer_"]')?.getBoundingClientRect?.();
      const loadingRect = chatBounds?.width > 0 && chatBounds.height > 0
        ? { left: chatBounds.left, top: chatBounds.top, width: chatBounds.width, height: chatBounds.height } : null;
      const report = { type: 'claude-host:composer', rect, hasDraft, loadError, loading, loadingRect,
        dragRegions: titlebarRegions(window, document), viewport: { width: window.innerWidth, height: window.innerHeight } };
      const next = JSON.stringify(report);
      if (next !== previous) {
        previous = next;
        // Only geometry and draft presence leave the webview, never message text.
        window.parent.postMessage(report, '*');
      }
    }

    function schedule() {
      if (!stopped && frame === undefined) frame = window.requestAnimationFrame(measure);
    }

    function start() {
      if (stopped) return;
      resize.observe(document.documentElement);
      mutations.observe(document.documentElement, { subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter: ['class', 'hidden', 'style', 'aria-expanded', 'open'] });
      schedule();
    }

    function stop() {
      stopped = true;
      resize.disconnect();
      mutations.disconnect();
      anchor?.removeAttribute('data-claude-host-composer-anchor');
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('toggle', schedule, true);
      window.removeEventListener('pagehide', stop);
      document.removeEventListener('DOMContentLoaded', start);
      window.removeEventListener('compositionstart', compositionStart, true);
      window.removeEventListener('compositionend', compositionEnd, true);
      window.removeEventListener('focusout', compositionEnd, true);
      window.removeEventListener('blur', compositionEnd);
      window.removeEventListener('keydown', protectComposition, true);
      composingInput = undefined;
    }

    window.addEventListener('compositionstart', compositionStart, true);
    window.addEventListener('compositionend', compositionEnd, true);
    window.addEventListener('focusout', compositionEnd, true);
    window.addEventListener('blur', compositionEnd);
    window.addEventListener('keydown', protectComposition, true);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('toggle', schedule, true);
    window.addEventListener('pagehide', stop);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
    document.fonts?.ready.then(schedule);
    return stop;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { observeComposer, titlebarRegions };
  else observeComposer(window, document);
})();
