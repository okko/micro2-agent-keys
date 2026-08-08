import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AgentHostChatProjection,
  emptyRun,
  reduceNormalizedEvent,
} from '../dist/vscode.js';

const SUPPORTED_VSCODE_VERSION = '1.131.0';
const FIXTURE_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'vscode-human-input'
);
const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, 'manifest.json'), 'utf8'));
const protocolFixtures = manifest.fixtures.filter(({ sources }) =>
  sources.includes('agent-host-protocol')
);

function expectedKeyState(truth, label) {
  if (truth.hasActiveRequest && !truth.requestInProgress && truth.awaitsUserInput) {
    return 'input';
  }
  if (truth.hasActiveRequest && truth.requestInProgress && !truth.awaitsUserInput) {
    return 'running';
  }
  if (!truth.hasActiveRequest && !truth.requestInProgress && !truth.awaitsUserInput) {
    return 'done';
  }
  assert.fail(`${label}: unsupported VS Code truth combination`);
}

function reduceSnapshot(run, snapshot, label) {
  assert.ok(snapshot.requestId, `${label}: request id`);
  const events = [];
  if (run.requestId !== snapshot.requestId) {
    events.push({ type: 'request.started', requestId: snapshot.requestId });
  }
  for (const blocker of run.blockers.values()) {
    if (blocker.requestId === snapshot.requestId && !snapshot.blockers.has(blocker.id)) {
      events.push({
        type: 'human-input.closed',
        requestId: snapshot.requestId,
        blockerId: blocker.id,
        outcome: 'resolved',
      });
    }
  }
  for (const blocker of snapshot.blockers.values()) {
    events.push({
      type: 'human-input.opened',
      requestId: snapshot.requestId,
      blockerId: blocker.id,
      kind: blocker.kind,
      responsePartKind: blocker.responsePartKind,
      sourceId: blocker.sourceId,
    });
  }
  for (const incompatibility of snapshot.incompatibilities) {
    events.push({
      type: 'request.incompatible',
      requestId: snapshot.requestId,
      code: incompatibility.code,
    });
  }
  if (snapshot.terminal) {
    events.push({
      type: 'request.finished',
      requestId: snapshot.requestId,
      outcome: snapshot.terminal,
    });
  }

  assert.ok(events.length > 0, `${label}: normalized events`);
  let state;
  for (const event of events) state = reduceNormalizedEvent(run, event);
  return state;
}

test('VS Code 1.131.0 protocol fixtures match projection and reducer state', () => {
  assert.equal(manifest.capturedFrom.version, SUPPORTED_VSCODE_VERSION);
  assert.ok(protocolFixtures.length > 0, 'manifest has authoritative protocol fixtures');

  for (const { file } of protocolFixtures) {
    const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, file), 'utf8'));
    const protocol = fixture.sources.find(({ source }) => source === 'agent-host-protocol');
    const projection = new AgentHostChatProjection();
    const run = emptyRun();

    assert.equal(fixture.vscodeVersion, SUPPORTED_VSCODE_VERSION, file);
    assert.ok(protocol, `${file}: protocol source`);
    assert.ok(protocol.records.length > 0, `${file}: protocol records`);
    const keyStates = new Set();
    const expectedLifecycle = new Set(['input', 'done']);

    for (const record of protocol.records.filter(({ type }) => type === 'agent-host.snapshot')) {
      const label = `${file}: ${record.stage}`;
      assert.ok(record.truth, `${label}: captured truth`);
      projection.apply(record.state);
      const snapshot = projection.snapshot();

      assert.equal(snapshot.active, record.truth.hasActiveRequest, `${label}: active`);
      assert.equal(snapshot.busy, record.truth.requestInProgress, `${label}: busy`);
      assert.equal(
        snapshot.blockers.size > 0,
        record.truth.awaitsUserInput,
        `${label}: awaits input`
      );
      assert.deepEqual(snapshot.incompatibilities, [], `${label}: compatibility`);
      const keyState = reduceSnapshot(run, snapshot, label);
      assert.equal(keyState, expectedKeyState(record.truth, label), `${label}: key state`);
      keyStates.add(keyState);
      if (record.truth.requestInProgress) expectedLifecycle.add('running');
    }
    assert.deepEqual(keyStates, expectedLifecycle, `${file}: key lifecycle`);
  }
});
