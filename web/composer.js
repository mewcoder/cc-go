'use strict';

(() => {
  function observeComposer(window, document) {
    let frame, observed, anchor, previous, stopped = false;
    const resize = new window.ResizeObserver(schedule);
    const mutations = new window.MutationObserver(schedule);

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
      const report = { type: 'claude-host:composer', rect, hasDraft, viewport: { width: window.innerWidth, height: window.innerHeight } };
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
        attributes: true, attributeFilter: ['class', 'hidden', 'style'] });
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
      window.removeEventListener('pagehide', stop);
      document.removeEventListener('DOMContentLoaded', start);
    }

    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('pagehide', stop);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
    document.fonts?.ready.then(schedule);
    return stop;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { observeComposer };
  else observeComposer(window, document);
})();
