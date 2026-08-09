import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AgentHostChatProjection,
  NativeChatProjection,
  emptyRun,
  reduceEvent,
  reduceNormalizedEvent,
  snapshotEvents,
} from '../dist/vscode-chat-state.js';
import { event } from './vscode-event.mjs';

test('native chat projection correlates completion with the latest request', () => {
  const projection = new NativeChatProjection();
  projection.apply({
    kind: 0,
    v: {
      requests: [
        { requestId: 'older', response: [], modelState: { value: 0 } },
        {
          requestId: 'latest',
          response: [{ kind: 'questionCarousel', resolveId: 'questions', isUsed: false }],
          modelState: { value: 4 },
        },
      ],
    },
  });

  projection.apply({ kind: 1, k: ['requests', 0, 'result'], v: {} });
  let snapshot = projection.snapshot();
  assert.equal(snapshot.requestId, 'latest');
  assert.equal(snapshot.active, true);
  assert.equal(snapshot.busy, false);
  assert.equal(snapshot.terminal, null);
  assert.deepEqual([...snapshot.blockers.keys()], ['latest:questionCarousel:questions']);

  projection.apply({ kind: 1, k: ['requests', 1, 'response', 0, 'isUsed'], v: true });
  snapshot = projection.snapshot();
  assert.equal(snapshot.active, true);
  assert.equal(snapshot.busy, true);
  assert.equal(snapshot.blockers.size, 0);

  projection.apply({ kind: 1, k: ['requests', 1, 'modelState'], v: { value: 1, completedAt: 123 } });
  snapshot = projection.snapshot();
  assert.equal(snapshot.active, false);
  assert.equal(snapshot.busy, false);
  assert.equal(snapshot.terminal, 'complete');
});

test('native chat projection applies request and response array mutations', () => {
  const projection = new NativeChatProjection();
  projection.apply({
    kind: 0,
    v: { requests: [{ requestId: 'first', response: [], modelState: { value: 1, completedAt: 1 } }] },
  });
  projection.apply({
    kind: 2,
    k: ['requests'],
    v: [{ requestId: 'second', response: [{ kind: 'planReview', resolveId: 'plan' }], modelState: { value: 4 } }],
  });
  assert.equal(projection.snapshot().requestId, 'second');
  assert.deepEqual([...projection.snapshot().blockers.keys()], ['second:planReview:plan']);

  projection.apply({
    kind: 2,
    k: ['requests', 1, 'response'],
    i: 0,
    v: [{ kind: 'elicitation2', state: 'pending' }],
  });
  assert.deepEqual([...projection.snapshot().blockers.keys()], ['second:elicitation2:position-0']);

  projection.apply({ kind: 2, k: ['requests'], i: 1 });
  assert.equal(projection.snapshot().requestId, 'first');
  assert.equal(projection.snapshot().terminal, 'complete');

  projection.apply({ kind: 3, k: ['requests', 0, 'modelState'] });
  assert.equal(projection.snapshot().active, true);
  assert.equal(projection.snapshot().terminal, null);

  projection.apply({
    kind: 1,
    k: ['requests', 0],
    v: { requestId: 'replacement', response: [], modelState: { value: 2, completedAt: 2 } },
  });
  assert.equal(projection.snapshot().requestId, 'replacement');
  assert.equal(projection.snapshot().terminal, 'cancelled');

  projection.apply({
    kind: 0,
    v: { requests: [{ requestId: 'reset', response: [], modelState: { value: 3, completedAt: 3 } }] },
  });
  assert.equal(projection.snapshot().requestId, 'reset');
  assert.equal(projection.snapshot().terminal, 'failed');
});

test('native chat projection gives parallel blockers stable compound identities', () => {
  const projection = new NativeChatProjection();
  projection.apply({
    kind: 0,
    v: {
      requests: [
        {
          requestId: 'active-request',
          modelState: { value: 4 },
          response: [
            { kind: 'toolInvocation', toolCallId: 'pre-tool', state: { type: 1 } },
            { kind: 'toolInvocation', toolCallId: 'post-tool', state: { type: 3 } },
            { kind: 'toolInvocation', toolCallId: 'auth-tool', state: { type: 6 } },
            { kind: 'confirmation' },
            { kind: 'questionCarousel', resolveId: 'questions' },
            { kind: 'planReview', resolveId: 'plan' },
            { kind: 'elicitation2', state: 'pending' },
          ],
        },
      ],
      pendingRequests: [{ request: { requestId: 'queued-request' } }],
    },
  });

  let snapshot = projection.snapshot();
  assert.equal(snapshot.requestId, 'active-request');
  assert.equal(snapshot.active, true);
  assert.equal(snapshot.busy, false);
  assert.deepEqual(
    [...snapshot.blockers.values()].map(({ sourceId, kind }) => [sourceId, kind]),
    [
      ['pre-tool', 'tool-confirmation'],
      ['post-tool', 'tool-result-confirmation'],
      ['auth-tool', 'tool-authentication'],
      ['position-3', 'confirmation'],
      ['questions', 'question'],
      ['plan', 'plan-review'],
      ['position-6', 'elicitation'],
    ]
  );

  projection.apply({ kind: 1, k: ['requests', 0, 'response', 4, 'isUsed'], v: true });
  snapshot = projection.snapshot();
  assert.equal(snapshot.blockers.has('active-request:questionCarousel:questions'), false);
  assert.equal(snapshot.blockers.has('active-request:planReview:plan'), true);

  projection.apply({ kind: 1, k: ['requests', 0, 'response', 5, 'data'], v: { rejected: false } });
  projection.apply({ kind: 1, k: ['requests', 0, 'response', 5, 'isUsed'], v: true });
  projection.apply({ kind: 1, k: ['requests', 0, 'response', 6, 'state'], v: 'accepted' });
  snapshot = projection.snapshot();
  assert.equal(snapshot.blockers.has('active-request:planReview:plan'), false);
  assert.equal(snapshot.blockers.has('active-request:elicitation2:position-6'), false);
});

test('native chat projection covers every Phase 4 response lifecycle', () => {
  const cases = [
    {
      name: 'pre-tool confirmation',
      waiting: { kind: 'toolInvocation', toolCallId: 'pre-tool', state: { type: 1 } },
      resolved: { kind: 'toolInvocation', toolCallId: 'pre-tool', state: { type: 2 } },
      blockerKind: 'tool-confirmation',
    },
    {
      name: 'post-tool confirmation',
      waiting: { kind: 'toolInvocation', toolCallId: 'post-tool', state: { type: 3 } },
      resolved: { kind: 'toolInvocation', toolCallId: 'post-tool', isComplete: true },
      blockerKind: 'tool-result-confirmation',
    },
    {
      name: 'tool authentication',
      waiting: { kind: 'toolInvocation', toolCallId: 'auth-tool', state: { type: 6 } },
      resolved: { kind: 'toolInvocation', toolCallId: 'auth-tool', state: { type: 2 } },
      blockerKind: 'tool-authentication',
    },
    {
      name: 'legacy confirmation',
      waiting: { kind: 'confirmation', id: 'confirmation' },
      resolved: { kind: 'confirmation', id: 'confirmation', isUsed: true },
      blockerKind: 'confirmation',
    },
    {
      name: 'question carousel',
      waiting: { kind: 'questionCarousel', resolveId: 'questions' },
      resolved: { kind: 'questionCarousel', resolveId: 'questions', isUsed: true },
      blockerKind: 'question',
    },
    {
      name: 'plan review',
      waiting: { kind: 'planReview', resolveId: 'plan' },
      resolved: { kind: 'planReview', resolveId: 'plan', isUsed: true },
      blockerKind: 'plan-review',
    },
    {
      name: 'elicitation accepted',
      waiting: { kind: 'elicitation2', state: 'pending' },
      resolved: { kind: 'elicitation2', state: 'accepted' },
      blockerKind: 'elicitation',
    },
    {
      name: 'elicitation rejected',
      waiting: { kind: 'elicitation2', state: { value: 'pending' } },
      resolved: { kind: 'elicitation2', state: { value: 'rejected' } },
      blockerKind: 'elicitation',
    },
    {
      name: 'modified-files review',
      waiting: {
        kind: 'toolInvocation',
        toolCallId: 'modified-files',
        state: { type: 1 },
        toolSpecificData: { kind: 'modifiedFilesConfirmation' },
      },
      resolved: { kind: 'toolInvocation', toolCallId: 'modified-files', state: { type: 2 } },
      blockerKind: 'tool-confirmation',
    },
    {
      name: 'feedback review',
      waiting: {
        kind: 'toolInvocation',
        toolCallId: 'feedback',
        state: { type: 1 },
        toolSpecificData: { kind: 'agentFeedbackReviewConfirmation' },
      },
      resolved: { kind: 'toolInvocation', toolCallId: 'feedback', state: { type: 2 } },
      blockerKind: 'tool-confirmation',
    },
  ];

  for (const { name, waiting, resolved, blockerKind } of cases) {
    const projection = new NativeChatProjection();
    projection.apply({
      kind: 0,
      v: { requests: [{ requestId: name, response: [waiting], modelState: { value: 4 } }] },
    });
    const waitingBlockers = [...projection.snapshot().blockers.values()];
    assert.deepEqual(waitingBlockers.map(({ kind }) => kind), [blockerKind], name);
    if (name === 'legacy confirmation') {
      assert.equal(waitingBlockers[0].id, `${name}:confirmation:confirmation`);
    }

    projection.apply({ kind: 1, k: ['requests', 0, 'response', 0], v: resolved });
    assert.equal(projection.snapshot().blockers.size, 0, name);
    assert.equal(projection.snapshot().busy, true, name);
  }
});

test('native projection rejects unknown tool state numbers beside resolved input', () => {
  const projection = new NativeChatProjection();
  projection.apply({
    kind: 0,
    v: {
      requests: [{
        requestId: 'future-tool-state',
        response: [
          { kind: 'questionCarousel', resolveId: 'resolved-question', isUsed: true },
          { kind: 'toolInvocation', toolCallId: 'future-tool', state: { type: 999 } },
        ],
        modelState: { value: 4 },
      }],
    },
  });

  assert.deepEqual(projection.snapshot().incompatibilities, [{
    code: 'unknown-native-response',
    source: 'native',
    responsePartKind: 'toolInvocation',
    stateType: '999',
  }]);
});

test('Agent Host chat projection handles protocol input and tool blocker states', () => {
  const projection = new AgentHostChatProjection();
  projection.apply({
    activeTurn: {
      id: 'protocol-turn',
      responseParts: [
        { kind: 'toolCall', toolCall: { toolCallId: 'streaming-tool', status: 'streaming' } },
        { kind: 'inputRequest', request: { id: 'ask', purpose: 'askUser' } },
        { kind: 'inputRequest', request: { id: 'elicit', purpose: 'elicitation' } },
        { kind: 'inputRequest', request: { id: 'plan', planReview: { steps: [] } } },
        { kind: 'inputRequest', request: { id: 'future', purpose: 'futurePurpose' } },
        {
          kind: 'toolCall',
          toolCall: { toolCallId: 'pre-tool', status: 'pending-confirmation', _meta: { autoApproveBySetting: false } },
        },
        {
          kind: 'toolCall',
          toolCall: { toolCallId: 'auto-tool', status: 'pending-confirmation', _meta: { autoApproveBySetting: true } },
        },
        { kind: 'toolCall', toolCall: { toolCallId: 'post-tool', status: 'pending-result-confirmation' } },
        { kind: 'toolCall', toolCall: { toolCallId: 'auth-tool', status: 'auth-required' } },
        {
          kind: 'toolCall',
          toolCall: {
            toolCallId: 'modified-files',
            status: 'pending-confirmation',
            confirmationKind: 'modifiedFilesConfirmation',
          },
        },
        {
          kind: 'toolCall',
          toolCall: {
            toolCallId: 'feedback',
            status: 'pending-confirmation',
            confirmationKind: 'agentFeedbackReviewConfirmation',
          },
        },
      ],
    },
  });

  let snapshot = projection.snapshot();
  assert.equal(snapshot.requestId, 'protocol-turn');
  assert.equal(snapshot.active, true);
  assert.equal(snapshot.busy, false);
  assert.deepEqual(
    [...snapshot.blockers.values()].map(({ sourceId, kind }) => [sourceId, kind]),
    [
      ['ask', 'question'],
      ['elicit', 'elicitation'],
      ['plan', 'plan-review'],
      ['future', 'question'],
      ['pre-tool', 'tool-confirmation'],
      ['post-tool', 'tool-result-confirmation'],
      ['auth-tool', 'tool-authentication'],
      ['modified-files', 'tool-confirmation'],
      ['feedback', 'tool-confirmation'],
    ]
  );

  projection.apply({
    activeTurn: {
      id: 'protocol-turn',
      responseParts: [
        { kind: 'inputRequest', request: { id: 'ask', purpose: 'askUser' }, response: { answers: [] } },
        { kind: 'inputRequest', request: { id: 'elicit', purpose: 'elicitation' }, response: { accepted: true } },
        { kind: 'inputRequest', request: { id: 'plan', planReview: { steps: [] } }, response: { approved: true } },
        { kind: 'inputRequest', request: { id: 'future', purpose: 'futurePurpose' }, response: { cancelled: true } },
        { kind: 'toolCall', toolCall: { toolCallId: 'pre-tool', status: 'running' } },
        { kind: 'toolCall', toolCall: { toolCallId: 'post-tool', status: 'completed' } },
        { kind: 'toolCall', toolCall: { toolCallId: 'auth-tool', status: 'cancelled' } },
      ],
    },
  });
  snapshot = projection.snapshot();
  assert.equal(snapshot.blockers.size, 0);
  assert.equal(snapshot.busy, true);
  assert.deepEqual(snapshot.incompatibilities, []);

  projection.apply({
    activeTurn: {
      id: 'protocol-turn',
      responseParts: [
        { kind: 'toolCall', toolCall: { toolCallId: 'future-tool', status: 'waiting-for-future-review' } },
      ],
    },
  });
  snapshot = projection.snapshot();
  assert.equal(snapshot.busy, false);
  assert.deepEqual(snapshot.incompatibilities, [
    {
      code: 'unknown-agent-host-tool-status',
      source: 'agent-host',
      responsePartKind: 'toolCall',
      toolStatus: 'waiting-for-future-review',
    },
  ]);
  const incompatibleRun = emptyRun();
  reduceNormalizedEvent(incompatibleRun, { type: 'request.started', requestId: snapshot.requestId });
  assert.equal(
    reduceNormalizedEvent(incompatibleRun, {
      type: 'request.incompatible',
      requestId: snapshot.requestId,
      code: snapshot.incompatibilities[0].code,
    }),
    'error'
  );
  assert.equal(incompatibleRun.error, 'incompatible:unknown-agent-host-tool-status');

  projection.apply({
    turns: [{ id: 'protocol-turn', state: 'failed', responseParts: [] }],
  });
  snapshot = projection.snapshot();
  assert.equal(snapshot.active, false);
  assert.equal(snapshot.terminal, 'failed');
});

test('normalized execution events scope parallel blockers to the latest request', () => {
  const run = emptyRun();
  assert.equal(reduceNormalizedEvent(run, { type: 'request.started', requestId: 'latest' }), 'running');
  assert.equal(
    reduceNormalizedEvent(run, {
      type: 'human-input.opened',
      requestId: 'latest',
      blockerId: 'latest:toolInvocation:first',
      kind: 'tool-confirmation',
    }),
    'input'
  );
  reduceNormalizedEvent(run, {
    type: 'human-input.opened',
    requestId: 'latest',
    blockerId: 'latest:questionCarousel:second',
    kind: 'question',
  });
  assert.equal(run.blockers.size, 2);

  assert.equal(
    reduceNormalizedEvent(run, {
      type: 'human-input.closed',
      requestId: 'latest',
      blockerId: 'latest:toolInvocation:first',
      outcome: 'resolved',
    }),
    'input'
  );
  assert.equal(
    reduceNormalizedEvent(run, { type: 'request.finished', requestId: 'older', outcome: 'complete' }),
    'input'
  );
  assert.equal(run.blockers.size, 1);
  assert.equal(
    reduceNormalizedEvent(run, {
      type: 'human-input.closed',
      requestId: 'latest',
      blockerId: 'latest:questionCarousel:second',
      outcome: 'resolved',
    }),
    'running'
  );
  assert.equal(
    reduceNormalizedEvent(run, { type: 'request.finished', requestId: 'latest', outcome: 'complete' }),
    'done'
  );
  assert.equal(reduceNormalizedEvent(run, { type: 'request.started', requestId: 'next' }), 'running');
  assert.equal(run.blockers.size, 0);
});

test('edit and resend request identities cannot retain stale blockers', () => {
  const run = emptyRun();
  reduceNormalizedEvent(run, { type: 'request.started', requestId: 'original' });
  assert.equal(
    reduceNormalizedEvent(run, {
      type: 'human-input.opened',
      requestId: 'original',
      blockerId: 'original:question',
      kind: 'question',
    }),
    'input'
  );

  assert.equal(reduceNormalizedEvent(run, { type: 'request.started', requestId: 'edited' }), 'running');
  assert.equal(run.requestId, 'edited');
  assert.equal(run.blockers.size, 0);
  assert.equal(
    reduceNormalizedEvent(run, { type: 'request.finished', requestId: 'original', outcome: 'complete' }),
    'running'
  );
  assert.equal(
    reduceNormalizedEvent(run, {
      type: 'human-input.closed',
      requestId: 'original',
      blockerId: 'original:question',
      outcome: 'resolved',
    }),
    'running'
  );

  reduceNormalizedEvent(run, {
    type: 'human-input.opened',
    requestId: 'edited',
    blockerId: 'edited:plan',
    kind: 'plan-review',
  });
  assert.equal(reduceNormalizedEvent(run, { type: 'request.started', requestId: 'resent' }), 'running');
  assert.equal(run.requestId, 'resent');
  assert.equal(run.blockers.size, 0);
  assert.equal(
    reduceNormalizedEvent(run, { type: 'request.finished', requestId: 'resent', outcome: 'complete' }),
    'done'
  );
});

test('every blocker family clears on resolution, completion, cancellation, and failure', () => {
  const blockers = [
    ['pre-tool approval', 'tool-confirmation'],
    ['post-tool approval', 'tool-result-confirmation'],
    ['authentication', 'tool-authentication'],
    ['confirmation part', 'confirmation'],
    ['questions', 'question'],
    ['plan review', 'plan-review'],
    ['elicitation', 'elicitation'],
    ['modified-files review', 'tool-confirmation'],
    ['feedback review', 'tool-confirmation'],
  ];
  const transitions = [
    { name: 'resolved then completed', close: true, outcome: 'complete', expected: 'done' },
    { name: 'completed while waiting', close: false, outcome: 'complete', expected: 'done' },
    { name: 'cancelled while waiting', close: false, outcome: 'cancelled', expected: 'done' },
    { name: 'failed while waiting', close: false, outcome: 'failed', expected: 'error' },
  ];

  for (const [blockerName, kind] of blockers) {
    for (const transition of transitions) {
      const label = `${blockerName}: ${transition.name}`;
      const run = emptyRun();
      assert.equal(
        reduceNormalizedEvent(run, { type: 'request.started', requestId: label }),
        'running',
        label
      );
      assert.equal(
        reduceNormalizedEvent(run, {
          type: 'human-input.opened',
          requestId: label,
          blockerId: `${label}:blocker`,
          kind,
        }),
        'input',
        label
      );
      if (transition.close) {
        assert.equal(
          reduceNormalizedEvent(run, {
            type: 'human-input.closed',
            requestId: label,
            blockerId: `${label}:blocker`,
            outcome: 'resolved',
          }),
          'running',
          label
        );
      }
      assert.equal(
        reduceNormalizedEvent(run, {
          type: 'request.finished',
          requestId: label,
          outcome: transition.outcome,
        }),
        transition.expected,
        label
      );
      assert.equal(run.blockers.size, 0, label);
      assert.equal(run.active, false, label);
    }
  }
});

test('normalizes input and latches errors through session end', () => {
  let run = emptyRun();
  ({ run } = reduceEvent(run, event('user.message')));
  assert.equal(reduceEvent(run, event('tool.execution_start', { toolCallId: 'a', toolName: 'ask_user' })).state, 'input');
  run.activeTools.set('a', 'ask_user');
  assert.equal(reduceEvent(run, event('tool.execution_complete', { toolCallId: 'a' })).state, 'running');
  assert.equal(reduceEvent(run, event('turn.error')).state, 'error');
  run.error = 'turn.error';
  assert.equal(reduceEvent(run, event('hook.end', { hookType: 'sessionEnd' })).state, 'error');
});

test('native permissioned tool requests wait for execution approval', () => {
  const run = emptyRun();
  assert.equal(
    reduceEvent(
      run,
      event('assistant.message', {
        toolRequests: [
          {
            toolCallId: 'permissioned-tool',
            arguments: JSON.stringify({ requestUnsandboxedExecution: true }),
          },
        ],
      }),
      'native'
    ).state,
    'input'
  );
  assert.equal(
    reduceEvent(run, event('tool.execution_start', { toolCallId: 'permissioned-tool', toolName: 'run_in_terminal' }), 'native').state,
    'input'
  );
  assert.equal(
    reduceEvent(run, event('tool.execution_complete', { toolCallId: 'permissioned-tool' }), 'native').state,
    'running'
  );

  const batch = emptyRun();
  reduceEvent(
    batch,
    event('assistant.message', {
      toolRequests: [
        { toolCallId: 'first-tool', arguments: { requestUnsandboxedExecution: true } },
        { toolCallId: 'second-tool', arguments: { requestAllowNetwork: true } },
      ],
    }),
    'native'
  );
  assert.equal(
    reduceEvent(batch, event('tool.execution_start', { toolCallId: 'first-tool', toolName: 'run_in_terminal' }), 'native').state,
    'input'
  );
});

test('native external file requests wait for execution approval', () => {
  const cwd = '/workspace/project';
  const outside = emptyRun();
  assert.equal(
    reduceEvent(
      outside,
      event('assistant.message', {
        toolRequests: [{ toolCallId: 'external-read', name: 'read_file', arguments: { filePath: '/private/file' } }],
      }),
      'native',
      cwd
    ).state,
    'input'
  );
  assert.equal(
    reduceEvent(
      outside,
      event('tool.execution_start', { toolCallId: 'external-read', toolName: 'read_file' }),
      'native',
      cwd
    ).state,
    'input'
  );
  assert.equal(
    reduceEvent(outside, event('permission.completed', { requestId: 'external-read' }), 'native', cwd).state,
    'running'
  );

  const inside = emptyRun();
  assert.equal(
    reduceEvent(
      inside,
      event('assistant.message', {
        toolRequests: [{ toolCallId: 'internal-read', name: 'read_file', arguments: { filePath: 'src/vscode.ts' } }],
      }),
      'native',
      cwd
    ).state,
    'running'
  );
});

test('native transcript completion clears a missed question post-hook', () => {
  const run = emptyRun();
  assert.equal(
    reduceEvent(
      run,
      event('tool.execution_start', {
        toolCallId: 'hook-question',
        toolName: 'vscode_askQuestions',
        fromHook: true,
      }),
      'native'
    ).state,
    'input'
  );
  assert.equal(
    reduceEvent(
      run,
      event('tool.execution_start', {
        toolCallId: 'transcript-question',
        toolName: 'vscode_askQuestions',
      }),
      'native'
    ).state,
    'input'
  );
  assert.equal(
    reduceEvent(run, event('tool.execution_complete', { toolCallId: 'transcript-question' }), 'native').state,
    'running'
  );

  const transcriptOnlyRun = emptyRun();
  reduceEvent(
    transcriptOnlyRun,
    event('tool.execution_start', {
      toolCallId: 'first-transcript-question',
      toolName: 'vscode_askQuestions',
    }),
    'native'
  );
  reduceEvent(transcriptOnlyRun, event('tool.execution_complete', { toolCallId: 'first-transcript-question' }), 'native');
  assert.equal(
    reduceEvent(
      transcriptOnlyRun,
      event('tool.execution_start', {
        toolCallId: 'next-transcript-question',
        toolName: 'vscode_askQuestions',
      }),
      'native'
    ).state,
    'input'
  );
});

function blocker(id, requestId, sourceId, kind = 'tool-confirmation') {
  return { id, requestId, responsePartKind: 'toolCall', sourceId, kind };
}

function snapshot(overrides = {}) {
  return {
    requestId: 'req-1',
    active: true,
    busy: false,
    blockers: new Map(),
    observedToolCallIds: new Set(),
    terminal: null,
    incompatibilities: [],
    ...overrides,
  };
}

test('snapshot events order a started run, its blockers, incompatibilities and its outcome', () => {
  const run = emptyRun();
  const opened = blocker('req-1:toolCall:call-1', 'req-1', 'call-1');
  const incompatibility = { type: 'request.incompatible', requestId: 'req-1', code: 'unknown-native-response' };

  const events = snapshotEvents(
    run,
    snapshot({ blockers: new Map([[opened.id, opened]]), terminal: 'complete' }),
    { incompatibilities: [incompatibility] }
  );

  assert.deepEqual(events.map((entry) => entry.type), [
    'request.started',
    'human-input.opened',
    'request.incompatible',
    'request.finished',
  ]);
  assert.equal(events[3].outcome, 'complete');
  assert.deepEqual(snapshotEvents(emptyRun(), snapshot({ requestId: null })), []);
});

test('snapshot events restart a run only when the caller reports a lost feed', () => {
  const run = emptyRun();
  reduceNormalizedEvent(run, { type: 'request.started', requestId: 'req-1' });
  run.error = 'agent-host-state-unavailable';

  assert.deepEqual(snapshotEvents(run, snapshot()), []);
  assert.deepEqual(
    snapshotEvents(run, snapshot(), { restarted: true }).map((entry) => entry.type),
    ['request.started']
  );
});

test('snapshot events defer a pending permission the transcript has not caught up with', () => {
  const run = emptyRun();
  reduceNormalizedEvent(run, { type: 'request.started', requestId: 'req-1' });
  const pending = blocker('req-1:toolCall:call-1', 'req-1', 'call-1');
  run.blockers.set(pending.id, pending);
  run.pendingPermissionIds.add('call-1');

  assert.deepEqual(snapshotEvents(run, snapshot(), { deferPendingPermissions: true }), []);
  assert.equal(run.pendingPermissionIds.has('call-1'), true);

  const observed = snapshotEvents(
    run,
    snapshot({ observedToolCallIds: new Set(['call-1']) }),
    { deferPendingPermissions: true }
  );
  assert.deepEqual(observed, [
    { type: 'human-input.closed', requestId: 'req-1', blockerId: pending.id, outcome: 'resolved' },
  ]);
  assert.equal(run.pendingPermissionIds.has('call-1'), false);
});

test('snapshot events close a permission blocker directly when deferral is off', () => {
  const run = emptyRun();
  reduceNormalizedEvent(run, { type: 'request.started', requestId: 'req-1' });
  const pending = blocker('req-1:toolCall:call-1', 'req-1', 'call-1');
  run.blockers.set(pending.id, pending);
  run.pendingPermissionIds.add('call-1');

  assert.deepEqual(
    snapshotEvents(run, snapshot()).map((entry) => entry.type),
    ['human-input.closed']
  );
  assert.equal(run.pendingPermissionIds.has('call-1'), true);
});

test('snapshot events suppress an outcome the caller already reported', () => {
  const run = emptyRun();
  reduceNormalizedEvent(run, { type: 'request.started', requestId: 'req-1' });

  assert.deepEqual(
    snapshotEvents(run, snapshot({ terminal: 'cancelled' }), { reportTerminal: false }),
    []
  );
  assert.deepEqual(
    snapshotEvents(run, snapshot({ terminal: 'cancelled' }), { reportTerminal: true }).map((entry) => entry.type),
    ['request.finished']
  );
});
