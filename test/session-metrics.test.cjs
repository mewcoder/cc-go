'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionMetricsTracker } = require('../runtime/session-metrics.cjs');

function harness() {
  const tracker = new SessionMetricsTracker();
  const send = message => tracker.observe('view', message, true);
  const receive = message => tracker.observe('view', message, false);
  const entry = message => receive({ type: 'io_message', channelId: 'channel', message });
  send({ type: 'launch_claude', channelId: 'channel', resume: 'session' });
  return { tracker, send, receive, entry };
}
const assistant = (extra = {}) => ({ type: 'assistant', message: {
  model: 'model-a', usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 800, cache_creation_input_tokens: 100 },
}, ...extra });
const result = (extra = {}) => ({ type: 'result', modelUsage: { 'model-a': { contextWindow: 200000 } }, ...extra });

test('context is latest main request usage including cache, never cumulative result usage', () => {
  const h = harness();
  const first = h.entry(assistant());
  assert.equal(first.metrics.contextTokens, 1000);
  assert.equal(first.metrics.inputTokens, 100);
  assert.equal(first.metrics.outputTokens, 20);
  const final = h.entry(result({ usage: { input_tokens: 999999 }, total_cost_usd: 1.5 }));
  assert.equal(final.metrics.contextTokens, 1000);
  assert.equal(final.metrics.contextWindow, 200000);
  assert.equal(final.metrics.costUSD, undefined, 'Do not collect deselected cost information');
  assert.equal(h.entry(assistant()), undefined, 'Duplicate usage does not create redundant host events');
});

test('stream deltas replace counters rather than summing, and null fields preserve counts', () => {
  const h = harness();
  h.entry({ type: 'stream_event', event: { type: 'message_start', message: assistant().message } });
  const delta = output_tokens => h.entry({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens, input_tokens: null } } });
  assert.equal(delta(30).metrics.contextTokens, 1000);
  assert.equal(delta(40).metrics.contextTokens, 1000);
  assert.equal(delta(40), undefined);
});

test('subagents, synthetic messages and background notifications cannot overwrite main usage', () => {
  const h = harness();
  h.entry(assistant());
  for (const extra of [{ parent_tool_use_id: 'tool' }, { isSidechain: true }, { isMeta: true }, { isSynthetic: true }]) {
    assert.equal(h.entry(assistant({ ...extra, message: { model: 'child', usage: { input_tokens: 9000 } } })), undefined);
  }
  assert.equal(h.entry(assistant({ message: { model: '<synthetic>', usage: { input_tokens: 9999 } } })), undefined);
  assert.equal(h.entry(result({ num_turns: 0, origin: { kind: 'task-notification' } })), undefined);
  assert.equal(h.entry(result()).metrics.contextTokens, 1000);
});

test('model changes and compaction invalidate stale context data', () => {
  const h = harness();
  h.entry(assistant());
  h.entry(result());
  const switched = h.entry(assistant({ message: { model: 'model-b', usage: { input_tokens: 5, output_tokens: 3 } } }));
  assert.equal(switched.metrics.contextWindow, undefined);
  assert.equal(switched.metrics.cacheReadTokens, undefined);
  assert.equal(h.entry(result()), undefined, 'Never use a different model window');
  const compacted = h.entry({ type: 'system', subtype: 'compact_boundary' });
  assert.equal(compacted.metrics.contextTokens, undefined);
  assert.equal(compacted.metrics.inputTokens, undefined);
});

test('new session binds pre-init usage and a replacement session does not inherit old values', () => {
  const h = harness();
  h.send({ type: 'launch_claude', channelId: 'channel' });
  assert.equal(h.entry(assistant()), undefined);
  const bound = h.entry({ type: 'system', subtype: 'init', session_id: 'new', model: 'model-a' });
  assert.equal(bound.sessionId, 'new');
  assert.equal(bound.metrics.contextTokens, 1000);
  const replaced = h.entry({ type: 'system', subtype: 'init', session_id: 'replacement', model: 'model-a' });
  assert.equal(replaced.metrics.contextTokens, undefined);
});

test('channels and views remain isolated and resume restores only its own metrics', () => {
  const h = harness();
  h.entry(assistant());
  h.send({ type: 'close_channel', channelId: 'channel' });
  assert.equal(h.entry(result()), undefined);
  h.send({ type: 'launch_claude', channelId: 'other', resume: 'other-session' });
  assert.equal(h.receive({ type: 'io_message', channelId: 'other', message: result() }).metrics.contextTokens, undefined);
  h.send({ type: 'launch_claude', channelId: 'channel', resume: 'session' });
  assert.equal(h.entry(result()).metrics.contextTokens, 1000);
  assert.equal(h.tracker.observe('other-view', { type: 'io_message', channelId: 'channel', message: result() }, false), undefined);
});

test('history replay supplies latest usage without running a model or querying files', () => {
  const h = harness();
  h.send({ type: 'request', requestId: 'history', request: { type: 'get_session_request', sessionId: 'history-session' } });
  const update = h.receive({ type: 'response', requestId: 'history', response: { messages: [
    assistant(), result(), { type: 'system', subtype: 'compact_boundary' },
    assistant({ message: { model: 'model-a', usage: { input_tokens: 4, output_tokens: 6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),
  ] } });
  assert.equal(update.sessionId, 'history-session');
  assert.equal(update.metrics.contextTokens, 4);
  assert.equal(update.metrics.contextWindow, 200000);
  assert.equal(h.tracker.channels.size, 1, 'Temporary replay channels are removed');
});

test('cancelled or stale history replies cannot overwrite current live data', () => {
  const h = harness();
  const request = id => h.send({ type: 'request', requestId: id, request: { type: 'get_session_request', sessionId: 'session' } });
  const reply = id => h.receive({ type: 'response', requestId: id, response: { messages: [assistant()] } });
  request('cancelled');
  h.send({ type: 'cancel_request', targetRequestId: 'cancelled' });
  assert.equal(reply('cancelled'), undefined);
  request('stale');
  h.entry(assistant());
  assert.equal(reply('stale'), undefined);
});

test('invalid counters never become NaN, negative values or fake zeros', () => {
  const h = harness();
  const update = h.entry(assistant({ message: { model: 'model-a', usage: { input_tokens: 10, output_tokens: NaN, cache_read_input_tokens: -2 } } }));
  assert.equal(update.metrics.outputTokens, undefined);
  assert.equal(update.metrics.cacheReadTokens, undefined);
  assert.equal(update.metrics.contextTokens, 10);
  assert.equal(h.entry(result({ modelUsage: { 'model-a': { contextWindow: -1 } } })), undefined);
});

test('history keeps the known current model window and belongs to the requested fork', () => {
  const h = harness();
  h.entry(assistant());
  h.entry(result());
  h.send({ type: 'request', requestId: 'history', request: { type: 'get_session_request', sessionId: 'session' } });
  const update = h.receive({ type: 'response', requestId: 'history', response: { messages: [
    assistant({ session_id: 'original-before-fork' }),
  ] } });
  assert.equal(update.sessionId, 'session');
  assert.equal(update.metrics.contextWindow, 200000);
  assert.equal(h.tracker.sessions.has(JSON.stringify(['view', 'original-before-fork'])), false);
});

test('a synthetic stream cannot apply deltas to the previous real response', () => {
  const h = harness();
  h.entry({ type: 'stream_event', event: { type: 'message_start', message: assistant().message } });
  h.entry({ type: 'stream_event', event: { type: 'message_start', message: { model: '<synthetic>' } } });
  assert.equal(h.entry({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 9999 } } }), undefined);
});

test('provider display-name aliases use the declared SDK window only when unambiguous', () => {
  const h = harness();
  h.entry({ type: 'system', subtype: 'init', model: 'provider/model-a[1m]' });
  h.entry(assistant({ message: { ...assistant().message, model: 'Model A' } }));
  const update = h.entry(result({ modelUsage: { 'provider/model-a[1m]': { contextWindow: 1000000 } } }));
  assert.equal(update.metrics.contextWindow, 1000000);
  h.entry(assistant({ message: { ...assistant().message, model: 'Model B' } }));
  assert.equal(h.entry(result({ modelUsage: { 'provider/model-a[1m]': { contextWindow: 1000000 } } })), undefined);
  assert.equal(h.entry(result({ modelUsage: { 'provider/model-a[1m]': { contextWindow: 1000000 }, 'other-model': { contextWindow: 200000 } } })), undefined);
});

const contextReply = (requestId, usage = {}) => ({ type: 'response', requestId, response: {
  type: 'get_context_usage_response', usage: { model: 'sdk-model', totalTokens: 72542, rawMaxTokens: 1000000,
    apiUsage: { input_tokens: 72465, output_tokens: 193, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, ...usage },
} });

test('native context query supplies the actual window and total independently of provider aliases', () => {
  const h = harness();
  h.entry(assistant());
  h.send({ type: 'request', channelId: 'channel', requestId: 'context', request: { type: 'get_context_usage' } });
  const update = h.receive(contextReply('context'));
  assert.equal(update.sessionId, 'session');
  assert.equal(update.metrics.model, 'model-a');
  assert.equal(update.metrics.contextTokens, 72542);
  assert.equal(update.metrics.contextWindow, 1000000);
  assert.equal(update.metrics.inputTokens, 72465);
  assert.equal(update.metrics.outputTokens, 193);
  assert.equal(h.tracker.contextRequests.size, 0);
});

test('native responses cannot overwrite a changed model, replaced channel or different view', () => {
  for (const change of [
    h => h.entry(assistant({ message: { model: 'other', usage: { input_tokens: 3 } } })),
    h => h.send({ type: 'launch_claude', channelId: 'channel', resume: 'other-session' }),
    h => h.send({ type: 'close_channel', channelId: 'channel' }),
    h => h.send({ type: 'cancel_request', targetRequestId: 'context' }),
  ]) {
    const h = harness();
    h.send({ type: 'request', channelId: 'channel', requestId: 'context', request: { type: 'get_context_usage' } });
    assert.equal(h.tracker.observe('other-view', contextReply('context'), false), undefined);
    change(h);
    assert.equal(h.receive(contextReply('context')), undefined);
  }
});

test('native window survives same-model progress without overwriting newer usage', () => {
  const h = harness();
  h.entry(assistant());
  h.send({ type: 'request', channelId: 'channel', requestId: 'context', request: { type: 'get_context_usage' } });
  h.send({ type: 'io_message', channelId: 'channel', message: { type: 'user' } });
  h.entry(assistant({ message: { model: 'model-a', usage: { input_tokens: 7, output_tokens: 3,
    cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }));
  const update = h.receive(contextReply('context'));
  assert.equal(update.metrics.contextWindow, 1000000);
  assert.equal(update.metrics.contextWindowSource, 'native');
  assert.equal(update.metrics.contextTokens, 7);
  assert.equal(update.metrics.inputTokens, 7);
  assert.equal(update.metrics.outputTokens, 3);
});

test('native errors and invalid totals keep honest unknowns rather than guessing a model window', () => {
  for (const usage of [{ rawMaxTokens: 0 }, { rawMaxTokens: -1 }, { totalTokens: NaN }, { totalTokens: undefined }]) {
    const h = harness();
    h.send({ type: 'request', channelId: 'channel', requestId: 'context', request: { type: 'get_context_usage' } });
    assert.equal(h.receive(contextReply('context', usage)), undefined);
  }
  const h = harness();
  h.send({ type: 'request', channelId: 'channel', requestId: 'context', request: { type: 'get_context_usage' } });
  assert.equal(h.receive({ type: 'response', requestId: 'context', response: { type: 'get_context_usage_response', error: 'unavailable' } }), undefined);
});
