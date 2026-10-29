'use strict';

const { randomUUID } = require('node:crypto');

// Native /context may call the provider's token-count endpoint. Wait for a
// known model and request it once per model only when SDK/history has no window.
class SessionContextQueries {
  constructor(metrics, receive) {
    this.metrics = metrics;
    this.receive = receive;
    this.channels = new Map();
    this.requests = new Map();
    this.owned = new Map();
  }

  observe(viewId, message, fromWebview) {
    const key = JSON.stringify([viewId, message?.channelId]);
    if (message?.type === 'close_channel') {
      const state = this.channels.get(key);
      clearTimeout(state?.timer);
      this.channels.delete(key);
      for (const [id, pending] of this.requests) if (pending.key === key) this.finish(id);
      return;
    }
    if (fromWebview && message?.type === 'launch_claude') {
      clearTimeout(this.channels.get(key)?.timer);
      for (const [id, pending] of this.requests) if (pending.key === key) {
        this.metrics.observe(viewId, { type: 'cancel_request', targetRequestId: id }, true);
        this.finish(id);
      }
      this.channels.set(key, { viewId, channelId: message.channelId, attempted: false });
    }
    const state = this.channels.get(key);
    const channel = this.metrics.channels.get(key);
    if (!state || !channel) return;
    if (state.model !== channel.metrics.model) {
      state.model = channel.metrics.model;
      state.attempted = false;
    }
    if (!fromWebview || message.type === 'launch_claude') {
      clearTimeout(state.timer);
      state.timer = setTimeout(() => {
        if (this.channels.get(key) !== state) return;
        const current = this.metrics.channels.get(key);
        if (!current) return;
        if (state.attempted || !current.sessionId || !current.metrics.model) return;
        const saved = this.metrics.sessions.get(JSON.stringify([viewId, current.sessionId]));
        if (saved?.contextWindow > 0 || current.metrics.contextWindow > 0) return;
        state.attempted = true;
        this.request(key, state);
      }, 250);
      state.timer.unref?.();
    }
  }

  request(key, state) {
    const { viewId, channelId } = state;
    const requestId = randomUUID();
    const request = { type: 'request', requestId, channelId, request: { type: 'get_context_usage' } };
    const timeout = setTimeout(() => {
      this.finish(requestId);
      const cancel = { type: 'cancel_request', targetRequestId: requestId };
      this.metrics.observe(viewId, cancel, true);
      this.receive(viewId, cancel);
    }, 60000);
    timeout.unref?.();
    this.requests.set(requestId, { key, timeout });
    this.owned.set(requestId, viewId);
    if (this.owned.size > 256) this.owned.delete(this.owned.keys().next().value);
    this.metrics.observe(viewId, request, true);
    this.receive(viewId, request);
  }

  finish(id) {
    clearTimeout(this.requests.get(id)?.timeout);
    this.requests.delete(id);
  }

  consume(viewId, message) {
    if (message?.type !== 'response' || this.owned.get(message.requestId) !== viewId) return false;
    this.finish(message.requestId);
    return true;
  }

  disconnect(viewId) {
    for (const state of this.channels.values()) if (state.viewId === viewId) {
      this.observe(viewId, { type: 'close_channel', channelId: state.channelId }, false);
      this.metrics.observe(viewId, { type: 'close_channel', channelId: state.channelId }, false);
    }
  }
}

module.exports = { SessionContextQueries };
