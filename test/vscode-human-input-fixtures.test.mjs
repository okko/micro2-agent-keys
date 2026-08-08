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
  'questions.agent-host.waiting',
  'questions.agent-host.cancel',
  'plan-review.agent-host.waiting',
  'plan-review.agent-host.reject',
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
  assert.deepEqual(manifest.blockers.map(({ id }) => id), BLOCKER_FAMILIES);

  for (const blocker of manifest.blockers) {
    assert.ok(['partial', 'unsupported'].includes(blocker.status));
    assert.ok(blocker.observed.length > 0 || blocker.unsupported.length > 0);
    if (blocker.status === 'unsupported') assert.equal(blocker.observed.length, 0);
  }

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
      readPath(start, measurement.correlationPath),
      readPath(end, measurement.correlationPath),
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