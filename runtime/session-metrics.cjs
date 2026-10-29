'use strict';

const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

class SessionMetricsTracker {
  constructor() {
    this.channels = new Map();
    this.sessions = new Map();
    this.historyRequests = new Map();
    this.contextRequests = new Map();
  }

  observe(viewId, message, fromWebview) {
    if (!message || typeof message !== 'object') return;
    const requestKey = JSON.stringify([viewId, message.requestId ?? message.targetRequestId]);
    const key = JSON.stringify([viewId, message.channelId]);
    const channel = this.channels.get(key);
    if (fromWebview && message.type === 'request' && message.request?.type === 'get_context_usage') {
      if (channel?.sessionId) this.contextRequests.set(requestKey, {
        key, channel, sessionId: channel.sessionId, revision: channel.revision, modelRevision: channel.modelRevision,
      });
      return;
    }
    if (message.type === 'cancel_request') this.contextRequests.delete(requestKey);
    if (!fromWebview && message.type === 'response' && this.contextRequests.has(requestKey)) {
      const pending = this.contextRequests.get(requestKey);
      this.contextRequests.delete(requestKey);
      const current = this.channels.get(pending.key);
      const usage = message.response?.usage;
      if (current !== pending.channel || current.sessionId !== pending.sessionId || current.modelRevision !== pending.modelRevision
        || message.response?.type !== 'get_context_usage_response'
        || number(usage?.totalTokens) === undefined || !(number(usage?.rawMaxTokens) > 0)) return;
      const metrics = { ...this.sessions.get(JSON.stringify([viewId, pending.sessionId])) };
      if (!metrics.model && typeof usage.model === 'string') metrics.model = usage.model;
      metrics.contextTokens = usage.totalTokens;
      metrics.contextWindow = usage.rawMaxTokens;
      metrics.contextWindowSource = 'native';
      if (current.revision === pending.revision) {
        for (const [target, source] of Object.entries({ inputTokens: 'input_tokens', outputTokens: 'output_tokens',
          cacheReadTokens: 'cache_read_input_tokens', cacheWriteTokens: 'cache_creation_input_tokens' })) {
          if (number(usage.apiUsage?.[source]) !== undefined) metrics[target] = usage.apiUsage[source];
        }
      } else {
        // A window remains valid during the same model's turn; occupancy does not.
        if (number(current.metrics.contextTokens) === undefined) delete metrics.contextTokens;
        else metrics.contextTokens = current.metrics.contextTokens;
      }
      current.metrics = metrics;
      this.sessions.set(JSON.stringify([viewId, pending.sessionId]), { ...metrics });
      return { id: viewId, sessionId: pending.sessionId, metrics: { ...metrics } };
    }
    if (fromWebview && message.type === 'request' && message.request?.type === 'get_session_request') {
      const sessionId = message.request.sessionId;
      this.historyRequests.set(requestKey, {
        sessionId, previous: this.sessions.get(JSON.stringify([viewId, sessionId])),
      });
      return;
    }
    if (message.type === 'cancel_request') this.historyRequests.delete(requestKey);
    if (!fromWebview && message.type === 'response') {
      const pending = this.historyRequests.get(requestKey);
      this.historyRequests.delete(requestKey);
      if (!pending || typeof pending.sessionId !== 'string' || !Array.isArray(message.response?.messages)) return;
      // A late history response must not overwrite newer live usage.
      if (this.sessions.get(JSON.stringify([viewId, pending.sessionId])) !== pending.previous) return;
      const historyId = `history:${message.requestId}`;
      const historyKey = JSON.stringify([viewId, historyId]);
      this.channels.set(historyKey, { sessionId: pending.sessionId, metrics: {} });
      let update;
      for (const entry of message.response.messages) {
        if (!['assistant', 'result', 'system'].includes(entry?.type)) continue;
        update = this.observe(viewId, { type: 'io_message', channelId: historyId, message: { ...entry, session_id: pending.sessionId } }, false) ?? update;
      }
      this.channels.delete(historyKey);
      if (update && update.metrics.model === pending.previous?.model && !update.metrics.contextWindow && pending.previous?.contextWindow) {
        update.metrics.contextWindow = pending.previous.contextWindow;
        update.metrics.contextWindowSource = pending.previous.contextWindowSource;
        this.sessions.set(JSON.stringify([viewId, pending.sessionId]), { ...update.metrics });
      }
      return update;
    }
    if (fromWebview && message.type === 'launch_claude' && typeof message.channelId === 'string') {
      const sessionId = typeof message.resume === 'string' ? message.resume : '';
      const saved = this.sessions.get(JSON.stringify([viewId, sessionId]));
      this.channels.set(key, { sessionId, metrics: { ...saved }, revision: 0, modelRevision: 0 });
      return;
    }
    if (!channel) return;
    if (message.type === 'close_channel') {
      this.channels.delete(key);
      for (const [id, pending] of this.contextRequests) if (pending.key === key) this.contextRequests.delete(id);
      return;
    }
    if (fromWebview && message.type === 'io_message' && message.message?.type === 'user') channel.revision = (channel.revision ?? 0) + 1;
    if (fromWebview || message.type !== 'io_message') return;
    const entry = message.message;
    if (!entry || entry.parent_tool_use_id || entry.isSidechain || entry.isMeta || entry.isSynthetic) return;
    if (entry.type === 'result' && entry.num_turns === 0 && entry.origin?.kind === 'task-notification') return;
    const previousSessionId = channel.sessionId;
    if (previousSessionId && entry.session_id && entry.session_id !== previousSessionId) channel.metrics = {};
    if (typeof entry.session_id === 'string') channel.sessionId = entry.session_id;
    const metrics = channel.metrics;
    const before = JSON.stringify(metrics);
    const setModel = (model, fromResponse = false) => {
      if (typeof model !== 'string' || !model || model === '<synthetic>') return;
      if (fromResponse && !channel.servedModel) channel.servedModel = model;
      if (model !== metrics.model) {
        channel.modelRevision = (channel.modelRevision ?? 0) + 1;
        metrics.model = model;
        delete metrics.contextWindow;
        delete metrics.contextWindowSource;
      }
    };
    const setUsage = usage => {
      if (!usage || number(usage.input_tokens) === undefined) return;
      metrics.inputTokens = number(usage.input_tokens);
      metrics.outputTokens = number(usage.output_tokens);
      metrics.cacheReadTokens = number(usage.cache_read_input_tokens);
      metrics.cacheWriteTokens = number(usage.cache_creation_input_tokens);
      metrics.contextTokens = metrics.inputTokens + (metrics.cacheReadTokens ?? 0) + (metrics.cacheWriteTokens ?? 0);
    };
    if (entry.type === 'system' && entry.subtype === 'init') {
      channel.initModel = entry.model;
      channel.servedModel = undefined;
      setModel(entry.model);
    }
    if (entry.type === 'assistant' && entry.message?.model !== '<synthetic>') {
      setModel(entry.message?.model, true);
      setUsage(entry.message?.usage);
    }
    if (entry.type === 'stream_event') {
      const event = entry.event;
      if (event?.type === 'message_start') {
        channel.streamUsage = undefined;
        if (event.message?.model !== '<synthetic>') {
          channel.streamUsage = { ...event.message?.usage };
          setModel(event.message?.model, true);
          setUsage(channel.streamUsage);
        }
      } else if (event?.type === 'message_delta' && channel.streamUsage) {
        // Delta counters are cumulative for this response, not increments to sum.
        for (const [name, value] of Object.entries(event.usage ?? {})) {
          if (number(value) !== undefined) channel.streamUsage[name] = value;
        }
        setUsage(channel.streamUsage);
      }
    }
    if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
      for (const name of ['contextTokens', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) delete metrics[name];
      channel.streamUsage = undefined;
    }
    if (entry.type === 'result') {
      const models = entry.modelUsage && typeof entry.modelUsage === 'object' ? entry.modelUsage : {};
      if (!metrics.model && Object.keys(models).length === 1) setModel(Object.keys(models)[0]);
      // Custom providers may return a display name different from the SDK model ID.
      // Only bind that alias when the init ID and a single result model agree.
      const usage = models[metrics.model] ?? (Object.keys(models).length === 1 && channel.servedModel === metrics.model
        ? models[channel.initModel] : undefined);
      if (number(usage?.contextWindow) > 0 && metrics.contextWindowSource !== 'native') {
        metrics.contextWindow = usage.contextWindow;
        metrics.contextWindowSource = 'sdk';
      }
      // result.usage is session-wide accounting, not current context occupancy.
      channel.streamUsage = undefined;
    }
    if (!channel.sessionId || (JSON.stringify(metrics) === before && previousSessionId === channel.sessionId)) return;
    channel.revision = (channel.revision ?? 0) + 1;
    this.sessions.set(JSON.stringify([viewId, channel.sessionId]), { ...metrics });
    return { id: viewId, sessionId: channel.sessionId, metrics: { ...metrics } };
  }

}

module.exports = { SessionMetricsTracker };
