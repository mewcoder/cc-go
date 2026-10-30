'use strict';

(() => {
  const { base } = __claudeBridge;
  let theme = __claudeBridge.theme;
  let state = __claudeBridge.state;
  let acquired = false;
  let listenerReady = false;
  const pending = [];
  let outgoing = Promise.resolve();
  const requests = new Set();
  const hostRequestsWithResponse = new Set(['tool_permission_request', 'user_dialog_request', 'engine_prompt_ask']);
  let posts = 0;

  function applyTranscriptWidth(value) {
    const widths = { narrow: 680, medium: 860, wide: 1040 };
    document.documentElement.style.setProperty('--claude-host-transcript-width', `${widths[value] ?? widths.narrow}px`);
  }
  applyTranscriptWidth(__claudeBridge.transcriptWidth);

  function send(endpoint, value) {
    posts++;
    if (endpoint === 'message') trackRequest(value, true);
    ensureConnection();
    // Preserve message order, including initialization followed by user input.
    outgoing = outgoing.then(async () => {
      const result = await fetch(base + endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      });
      if (!result.ok) throw new Error(await result.text());
    }).catch(error => {
      if (endpoint === 'message' && value?.type === 'request') requests.delete(value.requestId);
      console.error('Claude host bridge:', error);
    }).finally(() => { posts--; scheduleIdle(); });
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

  // Messages may arrive before the plugin registers its window message listener.
  const originalAdd = window.addEventListener;
  window.addEventListener = function (type, listener, options) {
    const result = originalAdd.call(this, type, listener, options);
    if (type === 'message' && !listenerReady) {
      listenerReady = true;
      queueMicrotask(() => { for (const message of pending.splice(0)) deliver(message); });
    }
    return result;
  };

  // SSE reserves one of only six HTTP/1 connections per origin; retained
  // conversations can otherwise block the next page's script and CSS loads.
  let stream, reconnect, idle, closed = false, sequence = 0, retry = 250, keepAlive = true;

  function trackRequest(message, fromWebview) {
    // The VSIX also wraps one-way host notifications in request envelopes.
    if (message?.type === 'request' && message.requestId
      && (fromWebview || hostRequestsWithResponse.has(message.request?.type))) requests.add(message.requestId);
    if (message?.type === 'response') requests.delete(message.requestId);
    if (message?.type === 'cancel_request') requests.delete(message.targetRequestId);
  }

  function needed() { return keepAlive || posts > 0 || requests.size > 0; }

  function reportTransport(connected) {
    if (__claudeBridge.shellOrigin) {
      window.parent.postMessage({ type: 'claude-host:transport', sequence, connected }, __claudeBridge.shellOrigin);
    }
  }

  function ensureConnection() {
    clearTimeout(idle);
    if (!closed && !stream && !reconnect) connect();
  }

  function scheduleIdle() {
    clearTimeout(idle);
    if (closed || needed()) return;
    if (!stream) {
      clearTimeout(reconnect);
      reconnect = undefined;
      return;
    }
    // Keep initialization, in-flight RPCs and brief conversation switches warm.
    idle = setTimeout(() => {
      if (closed || needed() || !stream) return;
      const socket = stream;
      stream = undefined;
      clearTimeout(reconnect);
      reconnect = undefined;
      socket.close();
      reportTransport(false);
    }, 5000);
  }

  originalAdd.call(window, 'message', event => {
    if (!__claudeBridge.shellOrigin || event.source !== window.parent || event.origin !== __claudeBridge.shellOrigin
      || event.data?.type !== 'claude-host:transport' || typeof event.data.keepAlive !== 'boolean') return;
    event.stopImmediatePropagation();
    if (keepAlive === event.data.keepAlive) return;
    keepAlive = event.data.keepAlive;
    if (needed()) ensureConnection();
    else scheduleIdle();
  });

  function connect() {
    reconnect = undefined;
    if (closed) return;
    const url = new URL('socket?since=' + sequence, new URL(base, location.href));
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = stream = new WebSocket(url.href);
    socket.onopen = () => {
      if (stream !== socket) return;
      retry = 250;
      reportTransport(true);
      scheduleIdle();
    };
    socket.onmessage = event => {
      if (stream !== socket) return;
      try {
        const frame = JSON.parse(event.data);
        if (frame.ping || !Number.isSafeInteger(frame.sequence) || frame.sequence <= sequence) return;
        trackRequest(frame.data, false);
        if (listenerReady || window.onmessage) deliver(frame.data);
        else pending.push(frame.data);
        sequence = frame.sequence;
        scheduleIdle();
      } catch (error) { console.error('Claude host event:', error); }
    };
    socket.onclose = () => {
      if (stream !== socket) return;
      stream = undefined;
      clearTimeout(idle);
      if (closed) return;
      reportTransport(false);
      if (!needed() || stream) return;
      reconnect = setTimeout(connect, retry);
      retry = Math.min(retry * 2, 10000);
    };
  }
  connect();
  originalAdd.call(window, 'pagehide', () => {
    closed = true;
    clearTimeout(reconnect);
    reconnect = undefined;
    clearTimeout(idle);
    const socket = stream;
    stream = undefined;
    socket?.close();
  });
  originalAdd.call(window, 'pageshow', event => {
    if (!event.persisted) return;
    closed = false;
    reportTransport(false);
    if (needed()) ensureConnection();
  });
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
