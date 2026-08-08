import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const FIXTURE_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'vscode-human-input'
);
const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, 'manifest.json'), 'utf8'));
const BLOCKER_FAMILIES = [
  'pre-tool-approval',
  'post-tool-approval',
  'authentication',
  'confirmation-part',
  'questions',
  'plan-review',
  'elicitation',
  'modified-files-review',
  'feedback-review',
];
const REQUIRED_OBSERVATIONS = [
  'pre-tool-approval.terminal.waiting',
  'pre-tool-approval.network.waiting',
  'pre-tool-approval.external-file.waiting',
  'pre-tool-approval.generic-contributed-tool.waiting',
  'pre-tool-approval.approve',
  'pre-tool-approval.deny',
  'pre-tool-approval.confirmation-not-needed',
  'questions.native.waiting',
  'questions.native.submit',
  'questions.native.skip',
  'questions.agent-host.waiting',
  'questions.agent-host.cancel',
  'questions.agent-host.submit',
  'plan-review.agent-host.waiting',
  'plan-review.agent-host.reject',
  'plan-review.agent-host.approve',
  'plan-review.agent-host.feedback',
  'modified-files-review.agent-host.waiting',
  'modified-files-review.agent-host.approve',
  'modified-files-review.agent-host.reject',
  'feedback-review.agent-host.waiting',
  'feedback-review.agent-host.approve',
  'feedback-review.agent-host.reject',
  'elicitation.agent-host.form.waiting',
  'elicitation.agent-host.form.decline',
  'elicitation.agent-host.url.waiting',
  'elicitation.agent-host.url.decline',
  'elicitation.agent-host.url.cancel',
  'authentication.agent-host.expired.waiting',
  'authentication.agent-host.cancel',
  'confirmation-part.resolved',
  'elicitation.accepted',
  'elicitation.rejected',
];

function readFixture(file) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, file), 'utf8'));
}

function findRecord(fixture, selector) {
  const source = fixture.sources.find((candidate) => candidate.source === selector.source);
  return source?.records?.find((record) => record._capture?.sourceLine === selector.sourceLine);
}

function readPath(value, dottedPath) {
  return dottedPath.split('.').reduce((current, key) => current?.[key], value);
}

test('accounts for every human-input blocker family', () => {
  assert.equal(manifest.formatVersion, 2);
  assert.equal(manifest.capturedFrom.version, '1.131.0');
  assert.match(manifest.capturedFrom.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(manifest.coveragePolicy, {
    scope: 'externally-observable-production-states',
    unsupported: 'documented-without-synthetic-evidence',
    unknown: 'fail-closed',
  });
  assert.deepEqual(manifest.blockers.map(({ id }) => id), BLOCKER_FAMILIES);

  for (const blocker of manifest.blockers) {
    assert.ok(['complete', 'partial', 'unsupported'].includes(blocker.status));
    if (blocker.status === 'complete') {
      assert.ok(blocker.observed.length > 0, `${blocker.id}: complete observations`);
      assert.equal(blocker.unsupported.length, 0, `${blocker.id}: complete unsupported`);
    } else if (blocker.status === 'partial') {
      assert.ok(blocker.observed.length > 0, `${blocker.id}: partial observations`);
      assert.ok(blocker.unsupported.length > 0, `${blocker.id}: partial unsupported`);
    } else {
      assert.equal(blocker.observed.length, 0, `${blocker.id}: unsupported observations`);
      assert.ok(blocker.unsupported.length > 0, `${blocker.id}: unsupported outcomes`);
    }
  }

  const manifestFiles = manifest.fixtures.map(({ file }) => file);
  assert.equal(new Set(manifestFiles).size, manifestFiles.length, 'unique manifest fixture files');
  assert.deepEqual(
    manifestFiles.toSorted(),
    fs.readdirSync(FIXTURE_ROOT)
      .filter((file) => file.endsWith('.json') && file !== 'manifest.json')
      .toSorted(),
    'every fixture file is declared exactly once'
  );

  const observed = new Set(manifest.fixtures.flatMap((fixture) => fixture.observed));
  for (const required of REQUIRED_OBSERVATIONS) assert.ok(observed.has(required), required);
});

test('keeps every real fixture bounded and sanitized', () => {
  for (const entry of manifest.fixtures) {
    const file = path.join(FIXTURE_ROOT, entry.file);
    const contents = fs.readFileSync(file, 'utf8');
    const fixture = JSON.parse(contents);

    assert.equal(fixture.formatVersion, 2, entry.file);
    assert.equal(fixture.vscodeVersion, manifest.capturedFrom.version, entry.file);
    assert.match(fixture.sessionId, /^<id:[0-9a-f]{12}>$/, entry.file);
    assert.ok(Buffer.byteLength(contents) < 100_000, entry.file);
    assert.doesNotMatch(contents, /\/(?:Users|home)\//, entry.file);
    assert.doesNotMatch(contents, /file:\/\//, entry.file);
    assert.doesNotMatch(contents, /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i, entry.file);
    assert.doesNotMatch(contents, /eyJ[A-Za-z0-9_-]{40}/, entry.file);
    assert.doesNotMatch(contents, /20\d\d-\d\d-\d\dT\d\d:/, entry.file);

    const sources = new Set(fixture.sources.map(({ source }) => source));
    for (const source of entry.sources) assert.ok(sources.has(source), `${entry.file}: ${source}`);
    for (const source of fixture.sources) {
      for (const record of source.records ?? []) {
        assert.ok(Number.isInteger(record._capture?.sourceLine), `${entry.file}: source line`);
        if (record._capture.offsetMs !== undefined) {
          assert.ok(Number.isSafeInteger(record._capture.offsetMs), `${entry.file}: offset`);
          assert.ok(record._capture.offsetMs >= 0, `${entry.file}: nonnegative offset`);
        }
      }
    }
  }
});

test('recomputes every documented lifecycle measurement', () => {
  for (const measurement of manifest.measurements) {
    const fixture = readFixture(measurement.fixture);
    assert.deepEqual(fixture.timing, {
      basis: 'relative-to-first-captured-event',
      unit: 'ms',
    }, measurement.id);
    const start = findRecord(fixture, measurement.start);
    const end = findRecord(fixture, measurement.end);

    assert.ok(start, `${measurement.id}: start`);
    assert.ok(end, `${measurement.id}: end`);
    assert.equal(start.type, measurement.start.type, `${measurement.id}: start type`);
    assert.equal(end.type, measurement.end.type, `${measurement.id}: end type`);
    assert.equal(
      readPath(start, measurement.startCorrelationPath ?? measurement.correlationPath),
      readPath(end, measurement.endCorrelationPath ?? measurement.correlationPath),
      `${measurement.id}: correlation`
    );
    assert.equal(
      end._capture.offsetMs - start._capture.offsetMs,
      measurement.elapsedMs,
      `${measurement.id}: elapsed`
    );
    assert.ok(
      [
        'observed-human-wait',
        'immediate-approval-control',
        'immediate-protocol-control',
      ].includes(measurement.classification),
      `${measurement.id}: classification`
    );
  }
});

test('retains authoritative Agent Host question model truth', () => {
  const fixture = readFixture('agent-host-question.json');
  const protocol = fixture.sources.find(({ source }) => source === 'agent-host-protocol');
  const [waiting, resolved, terminal] = protocol.records;

  assert.deepEqual(protocol.records.map(({ stage }) => stage), ['waiting', 'resolved', 'terminal']);
  assert.deepEqual(protocol.records.map(({ state }) => state.status), [24, 8, 1]);
  assert.deepEqual(waiting.truth, {
    hasActiveRequest: true,
    requestInProgress: false,
    awaitsUserInput: true,
  });
  assert.deepEqual(resolved.truth, {
    hasActiveRequest: true,
    requestInProgress: true,
    awaitsUserInput: false,
  });
  assert.deepEqual(terminal.truth, {
    hasActiveRequest: false,
    requestInProgress: false,
    awaitsUserInput: false,
  });

  const waitingInput = waiting.state.activeTurn.responseParts.find(({ kind }) => kind === 'inputRequest');
  const resolvedInput = resolved.state.activeTurn.responseParts.find(({ kind }) => kind === 'inputRequest');
  const terminalInput = terminal.state.turns[0].responseParts.find(({ kind }) => kind === 'inputRequest');
  assert.equal(waiting.state.activeTurn.id, resolved.state.activeTurn.id);
  assert.equal(waiting.state.activeTurn.id, terminal.state.turns[0].id);
  assert.equal(waitingInput.request.id, resolvedInput.request.id);
  assert.equal(waitingInput.request.id, terminalInput.request.id);
  assert.equal('response' in waitingInput, false);
  assert.equal('response' in resolvedInput, true);
  assert.equal('response' in terminalInput, true);
});

test('retains a correlated native question skip', () => {
  const fixture = readFixture('native-question-skip.json');
  const transcript = fixture.sources.find(({ source }) => source === 'native-transcript');
  const journal = fixture.sources.find(({ source }) => source === 'native-journal');
  const [started, completed] = transcript.records;
  const [tool, question] = journal.records[0].v;

  assert.equal(started.type, 'tool.execution_start');
  assert.equal(completed.type, 'tool.execution_complete');
  assert.equal(started.data.toolName, 'vscode_askQuestions');
  assert.equal(started.data.toolCallId, completed.data.toolCallId);
  assert.equal(started.data.toolCallId, tool.toolCallId);
  assert.equal(tool.toolCallId, question.resolveId);
  assert.equal(question.kind, 'questionCarousel');
  assert.equal(question.allowSkip, true);
  assert.equal(question.isUsed, true);
  assert.deepEqual(question.data, {});
});

test('correlates authoritative Agent Host tool denial with persisted events', () => {
  const fixture = readFixture('agent-host-tool-deny.json');
  const protocol = fixture.sources.find(({ source }) => source === 'agent-host-protocol');
  const events = fixture.sources.find(({ source }) => source === 'agent-host-events');
  const [waiting, resolved, terminal] = protocol.records;

  assert.deepEqual(protocol.records.map(({ stage }) => stage), ['waiting', 'resolved', 'terminal']);
  assert.deepEqual(protocol.records.map(({ state }) => state.status), [24, 8, 1]);
  assert.deepEqual(protocol.records.map(({ truth }) => truth), [
    { hasActiveRequest: true, requestInProgress: false, awaitsUserInput: true },
    { hasActiveRequest: true, requestInProgress: true, awaitsUserInput: false },
    { hasActiveRequest: false, requestInProgress: false, awaitsUserInput: false },
  ]);

  const waitingTool = waiting.state.activeTurn.responseParts[0].toolCall;
  const resolvedTool = resolved.state.activeTurn.responseParts[0].toolCall;
  const terminalTool = terminal.state.turns[0].responseParts[0].toolCall;
  assert.equal(waiting.state.activeTurn.id, resolved.state.activeTurn.id);
  assert.equal(waiting.state.activeTurn.id, terminal.state.turns[0].id);
  assert.equal(waitingTool.toolCallId, resolvedTool.toolCallId);
  assert.equal(waitingTool.toolCallId, terminalTool.toolCallId);
  assert.deepEqual(
    [waitingTool.status, resolvedTool.status, terminalTool.status],
    ['pending-confirmation', 'cancelled', 'cancelled']
  );

  const requested = events.records.find(({ type }) => type === 'permission.requested');
  const completed = events.records.find(({ type }) => type === 'permission.completed');
  assert.equal(requested.data.permissionRequest.toolCallId, waitingTool.toolCallId);
  assert.equal(completed.data.toolCallId, waitingTool.toolCallId);
  assert.equal(requested.data.requestId, completed.data.requestId);
  assert.equal(completed.data.result.kind, 'denied-interactively-by-user');
  assert.equal(requested._capture.pathScope, 'outside-working-directory');
});

test('retains authoritative Agent Host plan-review model truth', () => {
  const fixture = readFixture('agent-host-plan-reject.json');
  const protocol = fixture.sources.find(({ source }) => source === 'agent-host-protocol');
  const [waiting, resolved, terminal] = protocol.records;

  assert.deepEqual(protocol.records.map(({ stage }) => stage), ['waiting', 'resolved', 'terminal']);
  assert.deepEqual(protocol.records.map(({ state }) => state.status), [24, 8, 1]);
  assert.deepEqual(protocol.records.map(({ truth }) => truth), [
    { hasActiveRequest: true, requestInProgress: false, awaitsUserInput: true },
    { hasActiveRequest: true, requestInProgress: true, awaitsUserInput: false },
    { hasActiveRequest: false, requestInProgress: false, awaitsUserInput: false },
  ]);

  const waitingInput = waiting.state.activeTurn.responseParts.find(({ kind }) => kind === 'inputRequest');
  const resolvedInput = resolved.state.activeTurn.responseParts.find(({ kind }) => kind === 'inputRequest');
  const terminalInput = terminal.state.turns[0].responseParts.find(({ kind }) => kind === 'inputRequest');
  const waitingTool = waiting.state.activeTurn.responseParts.find(({ kind }) => kind === 'toolCall');
  assert.equal(waitingTool.toolCall.toolName, 'exit_plan_mode');
  assert.equal(waitingInput.request.planReview, true);
  assert.equal(waitingInput.request.id, resolvedInput.request.id);
  assert.equal(waitingInput.request.id, terminalInput.request.id);
  assert.equal('response' in waitingInput, false);
  assert.equal('response' in resolvedInput, true);
  assert.equal('response' in terminalInput, true);
});

test('retains correlated Agent Host question submit structure', () => {
  const fixture = readFixture('agent-host-question-submit.json');
  const protocol = fixture.sources.find(({ source }) => source === 'agent-host-protocol');
  const [waiting, action, resolved, terminal] = protocol.records;
  const waitingInput = waiting.state.activeTurn.responseParts.find(({ kind }) =>
    kind === 'inputRequest'
  );

  assert.deepEqual(protocol.records.map(({ type }) => type), [
    'agent-host.snapshot',
    'agent-host.action',
    'agent-host.snapshot',
    'agent-host.snapshot',
  ]);
  assert.deepEqual([waiting.state.status, resolved.state.status, terminal.state.status], [24, 8, 1]);
  assert.equal(action.action.type, 'chat/inputCompleted');
  assert.equal(action.action.requestId, waitingInput.request.id);
  assert.equal(action.action.responseKind, 'accept');
  assert.equal(action.action.answerCount, 1);
  assert.deepEqual(action.action.answers, [{
    state: 'submitted',
    valueKind: 'selected',
    hasFreeformValues: false,
  }]);
});

test('retains correlated Agent Host plan approval structure', () => {
  const fixture = readFixture('agent-host-plan-approve.json');
  const protocol = fixture.sources.find(({ source }) => source === 'agent-host-protocol');
  const [waiting, action, resolved, terminal] = protocol.records;
  const waitingInput = waiting.state.activeTurn.responseParts.find(({ kind }) =>
    kind === 'inputRequest'
  );

  assert.equal(waitingInput.request.planReview, true);
  assert.equal(action.action.requestId, waitingInput.request.id);
  assert.equal(action.action.responseKind, 'accept');
  assert.deepEqual(action.action.answers, [{
    state: 'submitted',
    valueKind: 'selected',
    hasFreeformValues: false,
  }]);
  assert.deepEqual([waiting.state.status, resolved.state.status, terminal.state.status], [24, 8, 1]);
});

test('retains plan feedback and its replacement review', () => {
  const fixture = readFixture('agent-host-plan-feedback.json');
  const protocol = fixture.sources.find(({ source }) => source === 'agent-host-protocol');
  const [waiting, feedback, resolved, replacement, approve, replacementResolved, terminal] =
    protocol.records;
  const firstInput = waiting.state.activeTurn.responseParts.find(({ kind }) =>
    kind === 'inputRequest'
  );
  const unresolvedInputs = replacement.state.activeTurn.responseParts.filter(({ kind, response }) =>
    kind === 'inputRequest' && response === undefined
  );
  const secondInput = unresolvedInputs[0];

  assert.equal(feedback.action.requestId, firstInput.request.id);
  assert.equal(feedback.action.answers[0].hasFreeformValues, true);
  assert.equal(approve.action.requestId, secondInput.request.id);
  assert.equal(approve.action.answers[0].hasFreeformValues, false);
  assert.notEqual(firstInput.request.id, secondInput.request.id);
  assert.equal(waiting.state.activeTurn.id, replacement.state.activeTurn.id);
  assert.deepEqual(
    [waiting, resolved, replacement, replacementResolved, terminal].map(({ state }) => state.status),
    [24, 8, 24, 8, 1]
  );
});

test('retains authoritative modified-files review outcomes', () => {
  const cases = [
    ['agent-host-modified-files-deny.json', false, 'cancelled', 'cancelled'],
    ['agent-host-modified-files-approve.json', true, 'running', 'completed'],
  ];

  for (const [file, approved, resolvedStatus, terminalStatus] of cases) {
    const fixture = readFixture(file);
    const protocol = fixture.sources.find(({ source }) => source === 'agent-host-protocol');
    const [waiting, action, resolved, terminal] = protocol.records;
    const waitingTool = waiting.state.activeTurn.responseParts.find(({ toolCall }) =>
      toolCall?.confirmationKind === 'modifiedFilesConfirmation'
    ).toolCall;
    const resolvedTool = resolved.state.activeTurn.responseParts.find(({ toolCall }) =>
      toolCall?.toolCallId === waitingTool.toolCallId
    ).toolCall;
    const terminalTool = terminal.state.turns[0].responseParts.find(({ toolCall }) =>
      toolCall?.toolCallId === waitingTool.toolCallId
    ).toolCall;

    assert.deepEqual([waiting.state.status, resolved.state.status, terminal.state.status], [24, 8, 1]);
    assert.equal(action.action.type, 'chat/toolCallConfirmed');
    assert.equal(action.action.toolCallId, waitingTool.toolCallId);
    assert.equal(action.action.approved, approved);
    assert.equal(action.action.hasEditedToolInput, false);
    assert.equal(resolvedTool.status, resolvedStatus);
    assert.equal(terminalTool.status, terminalStatus);
  }
});

test('retains authoritative feedback review outcomes', () => {
  const cases = [
    ['agent-host-feedback-review-deny.json', false, 'cancelled', 'cancelled'],
    ['agent-host-feedback-review-approve.json', true, 'running', 'completed'],
  ];

  for (const [file, approved, resolvedStatus, terminalStatus] of cases) {
    const fixture = readFixture(file);
    const protocol = fixture.sources.find(({ source }) => source === 'agent-host-protocol');
    const [waiting, action, resolved, terminal] = protocol.records;
    const waitingTool = waiting.state.activeTurn.responseParts.find(({ toolCall }) =>
      toolCall?.confirmationKind === 'agentFeedbackReviewConfirmation'
    ).toolCall;
    const resolvedTool = resolved.state.activeTurn.responseParts.find(({ toolCall }) =>
      toolCall?.toolCallId === waitingTool.toolCallId
    ).toolCall;
    const terminalTool = terminal.state.turns[0].responseParts.find(({ toolCall }) =>
      toolCall?.toolCallId === waitingTool.toolCallId
    ).toolCall;

    assert.deepEqual([waiting.state.status, resolved.state.status, terminal.state.status], [24, 8, 1]);
    assert.equal(waitingTool.toolName, 'viewUnreviewedComments');
    assert.equal(action.action.type, 'chat/toolCallConfirmed');
    assert.equal(action.action.toolCallId, waitingTool.toolCallId);
    assert.equal(action.action.approved, approved);
    assert.equal(action.action.hasEditedToolInput, false);
    assert.equal(resolvedTool.status, resolvedStatus);
    assert.equal(terminalTool.status, terminalStatus);
  }
});

test('retains authoritative Agent Host form elicitation decline', () => {
  const fixture = readFixture('agent-host-elicitation-form-decline.json');
  const protocol = fixture.sources.find(({ source }) => source === 'agent-host-protocol');
  const [waiting, action, resolved, terminal] = protocol.records;
  const waitingTool = waiting.state.activeTurn.responseParts.find(({ kind }) =>
    kind === 'toolCall'
  ).toolCall;
  const waitingInput = waiting.state.activeTurn.responseParts.find(({ kind }) =>
    kind === 'inputRequest'
  );
  const resolvedInput = resolved.state.activeTurn.responseParts.find(({ kind }) =>
    kind === 'inputRequest'
  );
  const terminalParts = terminal.state.turns[0].responseParts;
  const terminalTool = terminalParts.find(({ kind }) => kind === 'toolCall').toolCall;
  const terminalInput = terminalParts.find(({ kind }) => kind === 'inputRequest');

  assert.deepEqual([waiting.state.status, resolved.state.status, terminal.state.status], [24, 8, 1]);
  assert.equal(waitingTool.status, 'running');
  assert.equal(waitingTool.contributorKind, 'mcp');
  assert.equal(action.action.type, 'chat/inputCompleted');
  assert.equal(action.action.requestId, waitingInput.request.id);
  assert.equal(action.action.responseKind, 'decline');
  assert.equal(action.action.answerCount, 0);
  assert.equal(resolvedInput.request.id, waitingInput.request.id);
  assert.equal(resolvedInput.response.kind, 'decline');
  assert.equal(terminalInput.request.id, waitingInput.request.id);
  assert.equal(terminalInput.response.kind, 'decline');
  assert.equal(terminalTool.toolCallId, waitingTool.toolCallId);
  assert.equal(terminalTool.status, 'completed');
});

test('retains authoritative and redacted Agent Host URL elicitation decline', () => {
  const fixture = readFixture('agent-host-elicitation-url-decline.json');
  const protocol = fixture.sources.find(({ source }) => source === 'agent-host-protocol');
  const [waiting, action, resolved, terminal] = protocol.records;
  const waitingTool = waiting.state.activeTurn.responseParts.find(({ kind }) =>
    kind === 'toolCall'
  ).toolCall;
  const waitingInput = waiting.state.activeTurn.responseParts.find(({ kind }) =>
    kind === 'inputRequest'
  );
  const resolvedInput = resolved.state.activeTurn.responseParts.find(({ kind }) =>
    kind === 'inputRequest'
  );
  const terminalParts = terminal.state.turns[0].responseParts;
  const terminalTool = terminalParts.find(({ kind }) => kind === 'toolCall').toolCall;
  const terminalInput = terminalParts.find(({ kind }) => kind === 'inputRequest');

  assert.deepEqual([waiting.state.status, resolved.state.status, terminal.state.status], [24, 8, 1]);
  assert.equal(waitingTool.status, 'running');
  assert.equal(waitingTool.contributorKind, 'mcp');
  assert.equal(waitingInput.request.url, '<redacted>');
  assert.equal(action.action.type, 'chat/inputCompleted');
  assert.equal(action.action.requestId, waitingInput.request.id);
  assert.equal(action.action.responseKind, 'decline');
  assert.equal(action.action.answerCount, 0);
  assert.equal(resolvedInput.request.id, waitingInput.request.id);
  assert.equal(resolvedInput.response.kind, 'decline');
  assert.equal(terminalInput.request.id, waitingInput.request.id);
  assert.equal(terminalInput.response.kind, 'decline');
  assert.equal(terminalTool.toolCallId, waitingTool.toolCallId);
  assert.equal(terminalTool.status, 'completed');
});

test('retains authoritative Agent Host URL elicitation turn cancellation', () => {
  const fixture = readFixture('agent-host-elicitation-url-cancel.json');
  const protocol = fixture.sources.find(({ source }) => source === 'agent-host-protocol');
  const [waiting, turnCancelled, inputCancelled, terminal] = protocol.records;
  const waitingTool = waiting.state.activeTurn.responseParts.find(({ kind }) =>
    kind === 'toolCall'
  ).toolCall;
  const waitingInput = waiting.state.activeTurn.responseParts.find(({ kind }) =>
    kind === 'inputRequest'
  );
  const terminalParts = terminal.state.turns[0].responseParts;
  const terminalTool = terminalParts.find(({ kind }) => kind === 'toolCall').toolCall;
  const terminalInput = terminalParts.find(({ kind }) => kind === 'inputRequest');

  assert.deepEqual([waiting.state.status, terminal.state.status], [24, 1]);
  assert.equal(waitingInput.request.url, '<redacted>');
  assert.equal(waitingTool.status, 'running');
  assert.equal(waitingTool.contributorKind, 'mcp');
  assert.equal(turnCancelled.action.type, 'chat/turnCancelled');
  assert.equal(turnCancelled.action.turnId, waiting.state.activeTurn.id);
  assert.equal(inputCancelled.action.type, 'chat/inputCompleted');
  assert.equal(inputCancelled.action.requestId, waitingInput.request.id);
  assert.equal(inputCancelled.action.responseKind, 'cancel');
  assert.equal(inputCancelled.action.answerCount, 0);
  assert.equal(terminal.state.turns[0].state, 'cancelled');
  assert.equal(terminalInput.request.id, waitingInput.request.id);
  assert.equal('response' in terminalInput, false);
  assert.equal(terminalTool.toolCallId, waitingTool.toolCallId);
  assert.equal(terminalTool.status, 'cancelled');
});

test('retains authoritative expired-auth turn cancellation', () => {
  const fixture = readFixture('agent-host-auth-expired-cancel.json');
  const protocol = fixture.sources.find(({ source }) => source === 'agent-host-protocol');
  const [waiting, turnCancelled, terminal] = protocol.records;
  const waitingTool = waiting.state.activeTurn.responseParts.find(({ kind }) =>
    kind === 'toolCall'
  ).toolCall;
  const terminalTool = terminal.state.turns[0].responseParts.find(({ kind }) =>
    kind === 'toolCall'
  ).toolCall;

  assert.deepEqual([waiting.state.status, terminal.state.status], [24, 1]);
  assert.equal(waitingTool.status, 'auth-required');
  assert.equal(waitingTool.contributorKind, 'mcp');
  assert.deepEqual(waitingTool.auth, {
    reasonKind: 'expired',
    requiredScopeCount: 0,
  });
  assert.equal(turnCancelled.action.type, 'chat/turnCancelled');
  assert.equal(turnCancelled.action.turnId, waiting.state.activeTurn.id);
  assert.equal(terminal.state.turns[0].id, waiting.state.activeTurn.id);
  assert.equal(terminal.state.turns[0].state, 'cancelled');
  assert.equal(terminalTool.toolCallId, waitingTool.toolCallId);
  assert.equal(terminalTool.status, 'cancelled');
  assert.equal('auth' in terminalTool, false);
});

test('retains privacy-safe evidence for derived facts', () => {
  const pathFact = manifest.derivedFacts.find(({ id }) => id.endsWith('outside-working-directory'));
  const pathFixture = readFixture(pathFact.fixture);
  const pathRecord = findRecord(pathFixture, pathFact.record);
  assert.equal(pathRecord.type, pathFact.record.type);
  assert.equal(pathRecord._capture[pathFact.captureField], pathFact.expected);

  const tableFact = manifest.derivedFacts.find(({ id }) => id.endsWith('table-inventory'));
  const tableFixture = readFixture(tableFact.fixture);
  const state = tableFixture.sources.find(({ source }) => source === tableFact.source);
  assert.deepEqual(state.tables.map(({ name }) => name), tableFact.expectedTables);
  for (const table of state.tables) {
    assert.ok(table.columns.length > 0, table.name);
    assert.ok(table.columns.every((column) => typeof column.name === 'string'), table.name);
  }
});