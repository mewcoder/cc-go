const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SessionStatusTracker, readTranscriptStatus, transcriptStatus } = require('../runtime/session-status.cjs');

function harness() {
  const tracker = new SessionStatusTracker();
  return {
    tracker,
    send: message => tracker.observe('view', '/project', message, true),
    receive: message => tracker.observe('view', '/project', message, false),
    status: id => tracker.get('/project', id),
    native: (id, state, extra = {}) => tracker.observe('view', '/project', {
      type: 'request', request: { type: 'update_session_state', sessionId: id, state, ...extra },
    }, true),
  };
}
const launch = (resume = 'session') => ({ type: 'launch_claude', channelId: 'channel', resume });
const input = { type: 'io_message', channelId: 'channel', message: { type: 'user' } };
const result = (extra = {}) => ({
  type: 'io_message', channelId: 'channel', message: { type: 'result', subtype: 'success', ...extra },
});
const permission = (id, type = 'tool_permission_request') => ({
  type: 'request', channelId: 'channel', requestId: id, request: { type },
});

test('a new session binds the pending run when the CLI assigns its ID', () => {
  const h = harness();
  h.send({ ...launch(), resume: undefined });
  h.send(input);
  assert.equal(h.status('new-session'), undefined);
  h.receive({ type: 'io_message', channelId: 'channel', message: { type: 'system', subtype: 'init', session_id: 'new-session' } });
  assert.equal(h.status('new-session'), 'working');
  h.receive(result());
  assert.equal(h.status('new-session'), 'completed');
});

test('permissions and questions keep waiting until all requests are answered or cancelled', () => {
  const h = harness();
  h.send(launch());
  h.send(input);
  assert.equal(h.status('session'), 'working');
  h.receive(permission('permission'));
  h.receive(permission('question', 'user_dialog_request'));
  assert.equal(h.status('session'), 'needs_input');
  h.send({ type: 'response', requestId: 'permission', response: { type: 'tool_permission_response' } });
  assert.equal(h.status('session'), 'needs_input');
  h.receive({ type: 'cancel_request', targetRequestId: 'question' });
  assert.equal(h.status('session'), 'working');
  h.receive(result());
  assert.equal(h.status('session'), 'completed');
  h.send({ type: 'response', requestId: 'question' });
  assert.equal(h.status('session'), 'completed', 'Late responses cannot restart a finished turn');
});

test('native status reports do not complete blank chats or runs left in another panel tab', () => {
  const h = harness();
  h.native('blank', 'idle');
  assert.equal(h.status('blank'), undefined);
  h.native('session', 'running');
  h.native('session', 'idle', { isFarewell: true });
  assert.equal(h.status('session'), 'working');
  h.native('session', 'waiting_input');
  assert.equal(h.status('session'), 'needs_input');
  h.native('session', 'running');
  h.native('session', 'idle');
  assert.equal(h.status('session'), 'completed');
});

test('failures and interrupts survive idle reports and allow a new user turn', () => {
  const h = harness();
  h.send(launch());
  h.send(input);
  h.receive(result({ is_error: true, subtype: 'error_during_execution' }));
  h.native('session', 'idle');
  h.native('session', 'running');
  assert.equal(h.status('session'), 'error');
  h.send(input);
  assert.equal(h.status('session'), 'working');
  h.send({ type: 'interrupt_claude', channelId: 'channel' });
  h.native('session', 'idle');
  h.receive(result());
  assert.equal(h.status('session'), 'interrupted');
  h.send(input);
  h.receive(result());
  assert.equal(h.status('session'), 'completed');
});

test('stream termination and host disconnection stop active runs without changing successful ones', () => {
  const h = harness();
  h.send(launch());
  h.send(input);
  h.receive({ type: 'io_message', channelId: 'channel', done: true });
  assert.equal(h.status('session'), 'interrupted');
  h.send(input);
  h.receive(result());
  h.native('another', 'waiting_input');
  h.tracker.disconnect('view');
  assert.equal(h.status('session'), 'completed');
  assert.equal(h.status('another'), 'interrupted');
  assert.equal(h.tracker.channels.size, 0);
});

test('a CLI process exit reports its error and an explicit interrupted-turn resume restarts it', () => {
  const h = harness();
  h.send(launch());
  h.send(input);
  h.receive({ type: 'close_channel', channelId: 'channel', error: 'Process exited' });
  h.native('session', 'idle');
  assert.equal(h.status('session'), 'error');
  h.send({ ...launch(), resumeInterruptedTurn: true });
  assert.equal(h.status('session'), 'working');
  h.receive(result({ num_turns: 0, origin: { kind: 'task-notification' } }));
  assert.equal(h.status('session'), 'working');
  h.receive(result());
  h.receive({ type: 'close_channel', channelId: 'channel' });
  assert.equal(h.status('session'), 'completed');
});

test('session states and channel request IDs stay scoped to workspace and webview', () => {
  const h = harness();
  h.send(launch());
  h.send(input);
  h.receive(permission('same-request'));
  h.tracker.observe('other-view', '/other', launch(), true);
  h.tracker.observe('other-view', '/other', input, true);
  h.tracker.observe('other-view', '/other', permission('same-request'), false);
  h.send({ type: 'response', requestId: 'same-request' });
  assert.equal(h.status('session'), 'working');
  assert.equal(h.tracker.get('/other', 'session'), 'needs_input');
  h.tracker.disconnect('other-view');
  assert.equal(h.status('session'), 'working');
  assert.equal(h.tracker.get('/other', 'session'), 'interrupted');
});

test('historical status requires a completed assistant turn and never guesses a live run', () => {
  const completed = { type: 'assistant', message: { stop_reason: 'end_turn' } };
  assert.equal(transcriptStatus([completed, { type: 'custom-title' }]), 'completed');
  assert.equal(transcriptStatus([completed, { type: 'user' }]), undefined);
  assert.equal(transcriptStatus([completed, { type: 'user', isMeta: true }]), 'completed');
  assert.equal(transcriptStatus([completed, { type: 'assistant', isSidechain: true }]), 'completed');
  assert.equal(transcriptStatus([{ type: 'assistant', message: { stop_reason: 'tool_use' } }]), undefined);
  assert.equal(transcriptStatus([{ ...completed, isApiErrorMessage: true }]), 'error');
  assert.equal(transcriptStatus([completed, { type: 'assistant', message: { stop_reason: 'max_tokens' } }]), undefined);
});

test('bounded transcript reads skip partial leading lines and tolerate incomplete trailing writes', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-status-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'session.jsonl');
  const completed = { type: 'assistant', message: { stop_reason: 'end_turn' } };
  const contents = `${JSON.stringify({ type: 'user', message: { content: 'x'.repeat(150000) } })}\n${JSON.stringify(completed)}\n{"unfinished":`;
  await fs.writeFile(file, contents);
  assert.equal(await readTranscriptStatus(file, Buffer.byteLength(contents)), 'completed');
  await fs.writeFile(file, '');
  assert.equal(await readTranscriptStatus(file, 0), undefined);
});

test('completion time stays stable across repeated idle reports and changes for the next turn', t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const h = harness();
  h.send(launch());
  h.send(input);
  h.receive(result());
  assert.equal(h.tracker.completedAt('/project', 'session'), 1000);
  now = 2000;
  h.native('session', 'idle');
  h.receive(result());
  assert.equal(h.tracker.completedAt('/project', 'session'), 1000);
  h.send(input);
  assert.equal(h.tracker.completedAt('/project', 'session'), undefined);
  h.receive(result());
  assert.equal(h.tracker.completedAt('/project', 'session'), 2000);
});
