'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionMetricsTracker } = require('../runtime/session-metrics.cjs');
const { SessionContextQueries } = require('../runtime/session-context.cjs');
const wait = () => new Promise(resolve => setTimeout(resolve, 300));

function harness(t) {
  const metrics = new SessionMetricsTracker();
  const sent = [];
  const queries = new SessionContextQueries(metrics, (id, message) => sent.push({ id, message }));
  const observe = (message, outgoing = true) => {
    metrics.observe('view', message, outgoing);
    queries.observe('view', message, outgoing);
  };
  t.after(() => queries.disconnect('view'));
  observe({ type: 'launch_claude', channelId: 'channel', resume: 'session' });
  observe({ type: 'io_message', channelId: 'channel', message: { type: 'system', subtype: 'init', model: 'model' } }, false);
  return { metrics, queries, sent, observe };
}

test('missing history window triggers one native query, whose reply is consumed only in its own view', async t => {
  const h = harness(t);
  await wait();
  assert.equal(h.sent.length, 1);
  const request = h.sent[0].message;
  assert.equal(request.request.type, 'get_context_usage');
  assert.equal(h.metrics.contextRequests.size, 1);
  for (let i = 0; i < 3; i++) h.observe({ type: 'io_message', channelId: 'channel', message: { type: 'system', subtype: 'status' } }, false);
  await wait();
  assert.equal(h.sent.length, 1, 'No status-poll driven token-count requests');
  const response = { type: 'response', requestId: request.requestId };
  assert.equal(h.queries.consume('other-view', response), false);
  assert.equal(h.queries.consume('view', response), true);
  assert.equal(h.queries.requests.size, 0);
  assert.equal(h.queries.consume('view', { type: 'response', requestId: 'plugin-request' }), false);
});

test('cheap SDK window metadata avoids the native token-count query', async t => {
  const h = harness(t);
  h.observe({ type: 'io_message', channelId: 'channel', message: { type: 'result', modelUsage: { model: { contextWindow: 200000 } } } }, false);
  await wait();
  assert.equal(h.sent.length, 0);
});

test('native token-count requests wait for a known model rather than racing initialization', async t => {
  const h = harness(t);
  h.observe({ type: 'launch_claude', channelId: 'channel', resume: 'other-session' });
  await wait();
  assert.equal(h.sent.length, 0);
  h.observe({ type: 'io_message', channelId: 'channel', message: { type: 'system', subtype: 'init', model: 'other-model' } }, false);
  await wait();
  assert.equal(h.sent[0].message.request.type, 'get_context_usage');
});

test('closing a view cancels scheduled queries and clears pending telemetry', async t => {
  const h = harness(t);
  h.queries.disconnect('view');
  await wait();
  assert.equal(h.sent.length, 0);
  assert.equal(h.metrics.channels.size, 0);
  const other = harness(t);
  await wait();
  other.queries.disconnect('view');
  assert.equal(other.queries.requests.size, 0);
  assert.equal(other.metrics.contextRequests.size, 0);
});

