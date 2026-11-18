import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AgentHostChatProjection, emptyRun, reduceNormalizedEvent, runState, snapshotEvents,
} from '../dist/vscode-chat-state.js';

function snapshot(parts, status = 8, id = 'turn') {
  const projection = new AgentHostChatProjection();
  projection.apply({ status, activeTurn: { id, responseParts: parts } });
  return projection.snapshot();
}

test('AHP projects questions, reviews, elicitation and parallel tool blockers by exact identity', () => {
  const parts = [
    { kind: 'inputRequest', request: { id: 'ask', purpose: 'askUser' } },
    { kind: 'inputRequest', request: { id: 'elicit', purpose: 'elicitation' } },
    { kind: 'inputRequest', request: { id: 'plan', planReview: {} } },
    { kind: 'toolCall', toolCall: { toolCallId: 'pre', status: 'pending-confirmation' } },
    { kind: 'toolCall', toolCall: { toolCallId: 'post', status: 'pending-result-confirmation' } },
    { kind: 'toolCall', toolCall: { toolCallId: 'auth', status: 'auth-required' } },
    { kind: 'toolCall', toolCall: { toolCallId: 'auto', status: 'pending-confirmation', _meta: { autoApproveBySetting: true } } },
  ];
  const waiting = snapshot(parts, 24);
  assert.deepEqual([...waiting.blockers.values()].map(({ kind }) => kind), [
    'question', 'elicitation', 'plan-review', 'tool-confirmation', 'tool-result-confirmation', 'tool-authentication',
  ]);
  assert.equal(waiting.blockers.size, 6);
  assert.equal(waiting.busy, false);
  const resolved = snapshot(parts.map((part) => part.kind === 'inputRequest'
    ? { ...part, response: { cancelled: true } }
    : { ...part, toolCall: { ...part.toolCall, status: 'completed' } }));
  assert.equal(resolved.blockers.size, 0);
  assert.equal(resolved.busy, true);
  assert.deepEqual(resolved.incompatibilities, []);
});

test('unknown tool statuses and unexplained waiting fail closed without leaking input', () => {
  const unknown = snapshot([{ kind: 'toolCall', toolCall: { toolCallId: 'future', status: 'private text /path' } }]);
  assert.equal(unknown.incompatibilities[0].toolStatus, 'invalid');
  assert.equal(unknown.busy, false);
  const waiting = snapshot([{ kind: 'futureReview' }], 24);
  assert.equal(waiting.incompatibilities[0].code, 'unknown-agent-host-response');
  assert.equal(waiting.incompatibilities[0].responsePartKind, 'futureReview');
});

test('new turns discard old blockers and stale events cannot resolve current blockers', () => {
  const run = emptyRun();
  const apply = (current) => snapshotEvents(run, current).forEach((event) => reduceNormalizedEvent(run, event));
  const parts = [{ kind: 'inputRequest', request: { id: 'question' } }];
  apply(snapshot(parts, 24, 'first'));
  apply(snapshot(parts, 24, 'second'));
  assert.deepEqual([...run.blockers.keys()], ['second:inputRequest:question']);
  reduceNormalizedEvent(run, { type: 'request.finished', requestId: 'first', outcome: 'complete' });
  assert.equal(runState(run), 'input');
  apply(snapshot([], 8, 'second'));
  assert.equal(runState(run), 'running');
});

test('every terminal outcome clears all blockers and retains errors', () => {
  for (const outcome of ['complete', 'cancelled', 'failed']) {
    const run = emptyRun();
    for (const event of snapshotEvents(run, snapshot([
      { kind: 'inputRequest', request: { id: 'ask' } },
      { kind: 'toolCall', toolCall: { toolCallId: 'auth', status: 'auth-required' } },
    ], 24))) reduceNormalizedEvent(run, event);
    assert.equal(run.blockers.size, 2);
    reduceNormalizedEvent(run, { type: 'request.finished', requestId: 'turn', outcome });
    assert.equal(run.blockers.size, 0);
    assert.equal(runState(run), outcome === 'failed' ? 'error' : 'done');
  }
});

test('snapshot events recover a lost feed and optionally suppress repeated terminal outcomes', () => {
  const run = emptyRun();
  const current = snapshot([]);
  for (const event of snapshotEvents(run, current)) reduceNormalizedEvent(run, event);
  run.error = 'agent-host-state-unavailable';
  assert.deepEqual(snapshotEvents(run, current), []);
  for (const event of snapshotEvents(run, current, { restarted: true })) reduceNormalizedEvent(run, event);
  assert.equal(runState(run), 'running');
  const projection = new AgentHostChatProjection();
  projection.apply({ turns: [{ id: 'turn', state: 'cancelled' }] });
  assert.deepEqual(snapshotEvents(run, projection.snapshot(), { reportTerminal: false }), []);
  for (const event of snapshotEvents(run, projection.snapshot())) reduceNormalizedEvent(run, event);
  assert.equal(runState(run), 'done');
});
