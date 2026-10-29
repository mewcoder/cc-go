'use strict';

(() => {
  const { base } = __claudeBridge;
  let theme = __claudeBridge.theme;
  let state = __claudeBridge.state;
  let acquired = false;
  let listenerReady = false;
  const pending = [];
  let outgoing = Promise.resolve();

  function applyTranscriptWidth(value) {
    const widths = { narrow: 680, medium: 860, wide: 1040 };
    document.documentElement.style.setProperty('--claude-host-transcript-width', `${widths[value] ?? widths.narrow}px`);
  }
  applyTranscriptWidth(__claudeBridge.transcriptWidth);

  function send(endpoint, value) {
    // Preserve message order, including initialization followed by user input.
    outgoing = outgoing.then(async () => {
      const result = await fetch(base + endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      });
      if (!result.ok) throw new Error(await result.text());
    }).catch(error => console.error('Claude host bridge:', error));
  }

  Object.defineProperty(window, 'acquireVsCodeApi', {
    value: () => {
      if (acquired) throw new Error('The VS Code API has already been acquired');
      acquired = true;
      return Object.freeze({
        postMessage: message => send('message', message),
        getState: () => state,
        setState: value => { state = value; send('state', value); return value; },
      });
    },
    writable: false, configurable: false,
  });

  function deliver(message) {
    if (message?._claudeHostTranscriptWidth) {
      applyTranscriptWidth(message._claudeHostTranscriptWidth);
      return;
    }
    if (message?._claudeHostTheme) {
      theme = message._claudeHostTheme;
      applyTheme();
      return;
    }
    window.dispatchEvent(new MessageEvent('message', { data: message, origin: location.origin }));
  }

  function applyTheme() {
    if (!document.body) return;
    document.body.classList.remove('vscode-dark', 'vscode-light');
    document.body.classList.add(`vscode-${theme}`);
    document.body.dataset.vscodeThemeKind = `vscode-${theme}`;
    const link = document.getElementById('claude-host-theme');
    if (link) link.href = base + 'theme.css?theme=' + theme;
  }

  // SSE may connect before the plugin registers its window message listener.
  const originalAdd = window.addEventListener;
  window.addEventListener = function (type, listener, options) {
    const result = originalAdd.call(this, type, listener, options);
    if (type === 'message' && !listenerReady) {
      listenerReady = true;
      queueMicrotask(() => { for (const message of pending.splice(0)) deliver(message); });
    }
    return result;
  };

  const stream = new EventSource(base + 'events');
  stream.onmessage = event => {
    try {
      const message = JSON.parse(event.data);
      if (listenerReady || window.onmessage) deliver(message);
      else pending.push(message);
    } catch (error) { console.error('Claude host event:', error); }
  };
  originalAdd.call(window, 'pagehide', () => stream.close());
  originalAdd.call(window, 'DOMContentLoaded', applyTheme);
  document.addEventListener('click', event => {
    const link = event.target.closest?.('a[href]');
    if (!link) return;
    const url = new URL(link.href, location.href);
    if (['http:', 'https:', 'mailto:'].includes(url.protocol) && url.origin !== location.origin) {
      event.preventDefault();
      send('external', url.href);
    }
  }, true);
  // Never give the plugin a reference to the privileged parent shell.
  window.open = url => { send('external', new URL(url, location.href).href); return null; };
})();
