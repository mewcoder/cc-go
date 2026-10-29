const fs = require('node:fs/promises');

const liveStatuses = new Set(['working', 'needs_input']);
const terminalStatuses = new Set(['error', 'interrupted']);

function transcriptStatus(entries) {
  let status;
  for (const entry of entries) {
    if (!entry || entry.isSidechain || entry.isMeta) continue;
    if (entry.type === 'user') status = undefined;
    else if (entry.type === 'assistant') {
      status = entry.isApiErrorMessage ? 'error'
        : entry.message?.stop_reason === 'end_turn' ? 'completed' : undefined;
    } else if (entry.type === 'result') {
      status = entry.is_error || entry.subtype !== 'success' ? 'error' : 'completed';
    }
  }
  return status;
}

async function readTranscriptStatus(file, size) {
  const handle = await fs.open(file, 'r');
  try {
    const start = Math.max(0, size - 131072);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    if (start) lines.shift();
    return transcriptStatus(lines.flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    }));
  } finally {
    await handle.close();
  }
}

class SessionStatusTracker {
  constructor() {
    this.sessions = new Map();
    this.channels = new Map();
    this.revision = 0;
  }

  key(workspace, id) { return JSON.stringify([workspace, id]); }
  get(workspace, id) { return this.sessions.get(this.key(workspace, id))?.status; }
  completedAt(workspace, id) { return this.sessions.get(this.key(workspace, id))?.completedAt; }

  set(viewId, workspace, id, status, preserveOutcome = false) {
    if (typeof id !== 'string' || !id || !status) return;
    const key = this.key(workspace, id);
    const previous = this.sessions.get(key);
    if (preserveOutcome && terminalStatuses.has(previous?.status)) return;
    const completedAt = status === 'completed'
      ? previous?.status === 'completed' ? previous.completedAt : Date.now()
      : undefined;
    this.sessions.set(key, { viewId, workspace, id, status, completedAt });
    if (previous?.status !== status) this.revision += 1;
  }

  observe(viewId, workspace, message, fromWebview) {
    if (!message || typeof message !== 'object') return false;
    const before = this.revision;
    const channelKey = this.key(viewId, message.channelId);
    let channel = this.channels.get(channelKey);
    if (fromWebview && message.type === 'launch_claude' && typeof message.channelId === 'string') {
      channel = { viewId, workspace, sessionId: message.resume, requests: new Set() };
      this.channels.set(channelKey, channel);
    }
    const update = (status, preserveOutcome = false) => {
      if (!channel) return;
      if (preserveOutcome && terminalStatuses.has(channel.status)) return;
      channel.status = status;
      this.set(viewId, workspace, channel.sessionId, status, preserveOutcome);
    };
    if (fromWebview && message.type === 'launch_claude' && message.resumeInterruptedTurn) update('working');
    if (fromWebview && message.type === 'request' && message.request?.type === 'update_session_state') {
      const request = message.request;
      // A farewell is a panel selection change, not evidence that execution ended.
      if (!request.isFarewell && !request.panelNoLongerHosts) {
        const previous = this.get(workspace, request.sessionId);
        const status = request.state === 'waiting_input' ? 'needs_input'
          : request.state === 'running' ? 'working'
            : request.state === 'idle' && (liveStatuses.has(previous) || previous === 'completed') ? 'completed' : undefined;
        this.set(viewId, workspace, request.sessionId, status, true);
        if (status && !terminalStatuses.has(this.get(workspace, request.sessionId))) {
          for (const candidate of this.channels.values()) {
            if (candidate.viewId === viewId && candidate.sessionId === request.sessionId) candidate.status = status;
          }
        }
      }
    }
    if (channel && message.type === 'io_message') {
      const entry = message.message;
      if (!fromWebview && typeof entry?.session_id === 'string') {
        channel.sessionId = entry.session_id;
        this.set(viewId, workspace, channel.sessionId, channel.status, true);
      }
      if (fromWebview && entry?.type === 'user') {
        channel.requests.clear();
        update('working');
      } else if (!fromWebview && entry?.type === 'result'
        && !(entry.num_turns === 0 && entry.origin?.kind === 'task-notification')) {
        channel.requests.clear();
        update(entry.is_error || entry.subtype !== 'success' ? 'error' : 'completed', true);
      } else if (!fromWebview && entry?.type === 'assistant' && entry.isApiErrorMessage) {
        update('error');
      }
      if (!fromWebview && message.done && liveStatuses.has(channel.status)) update('interrupted');
    }
    if (!fromWebview && message.type === 'request'
      && ['tool_permission_request', 'user_dialog_request'].includes(message.request?.type)
      && channel && typeof message.requestId === 'string') {
      channel.requests.add(message.requestId);
      update('needs_input', true);
    }
    if (fromWebview && message.type === 'response') {
      for (const candidate of this.channels.values()) {
        if (candidate.viewId !== viewId || !candidate.requests.delete(message.requestId)) continue;
        const status = candidate.requests.size ? 'needs_input' : 'working';
        candidate.status = status;
        this.set(viewId, candidate.workspace, candidate.sessionId, status, true);
      }
    }
    if (!fromWebview && message.type === 'cancel_request') {
      for (const candidate of this.channels.values()) {
        if (candidate.viewId !== viewId || !candidate.requests.delete(message.targetRequestId)) continue;
        const status = candidate.requests.size ? 'needs_input' : 'working';
        candidate.status = status;
        this.set(viewId, candidate.workspace, candidate.sessionId, status, true);
      }
    }
    if (fromWebview && ['interrupt_claude', 'close_channel'].includes(message.type) && channel) {
      channel.requests.clear();
      if (liveStatuses.has(this.get(workspace, channel.sessionId) ?? channel.status)) update('interrupted');
      if (message.type === 'close_channel') this.channels.delete(channelKey);
    }
    if (!fromWebview && message.type === 'close_channel' && channel) {
      if (message.error) update('error', true);
      else if (liveStatuses.has(this.get(workspace, channel.sessionId) ?? channel.status)) update('interrupted');
      this.channels.delete(channelKey);
    }
    return before !== this.revision;
  }

  disconnect(viewId) {
    const before = this.revision;
    for (const [key, channel] of this.channels) if (channel.viewId === viewId) this.channels.delete(key);
    for (const session of this.sessions.values()) {
      if (session.viewId === viewId && liveStatuses.has(session.status)) {
        this.set(viewId, session.workspace, session.id, 'interrupted');
      }
    }
    return before !== this.revision;
  }
}

module.exports = { SessionStatusTracker, readTranscriptStatus, transcriptStatus };
