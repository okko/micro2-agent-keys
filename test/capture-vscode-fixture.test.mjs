import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { captureFixture, sanitizeCapture } from '../scripts/dev/capture-vscode-fixture.mjs';

const SESSION_ID = '00000000-0000-4000-8000-000000000000';

function captureOptions(t, records) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentkeys-capture-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const agentHostProtocolPath = path.join(directory, 'protocol.jsonl');
  const vscodePackage = path.join(directory, 'package.json');
  fs.writeFileSync(agentHostProtocolPath, records.map((record) => JSON.stringify(record)).join('\n'));
  fs.writeFileSync(vscodePackage, JSON.stringify({ version: '1.131.0' }));
  return { sessionId: SESSION_ID, agentHostProtocolPath, vscodePackage };
}

test('captures sanitized AHP state, correlated actions and relative timing', (t) => {
  const options = captureOptions(t, [{
    type: 'agent-host.snapshot',
    timestamp: '2026-08-06T12:00:00.000Z',
    stage: 'waiting',
    truth: { hasActiveRequest: true, requestInProgress: false, awaitsUserInput: true },
    state: {
      status: 24,
      activeTurn: {
        id: 'private-turn-id',
        state: 'in-progress',
        responseParts: [{
          kind: 'inputRequest',
          request: { id: 'private-request-id', purpose: 'askUser', prompt: 'private prompt' },
        }],
      },
    },
  }, {
    type: 'agent-host.action',
    timestamp: '2026-08-06T12:00:02.000Z',
    action: {
      type: 'chat/inputCompleted', requestId: 'private-request-id',
      responseKind: 'accept', answer: 42, accepted: true,
    },
  }]);
  const fixture = captureFixture({ ...options, label: 'waiting' });
  const [waiting, action] = fixture.sources[0].records;
  assert.equal(fixture.vscodeVersion, '1.131.0');
  assert.deepEqual(fixture.sources.map(({ source }) => source), ['agent-host-protocol']);
  assert.deepEqual(waiting.truth, { hasActiveRequest: true, requestInProgress: false, awaitsUserInput: true });
  assert.equal(waiting.state.activeTurn.responseParts[0].request.purpose, 'askUser');
  assert.equal(waiting.state.activeTurn.responseParts[0].request.id, action.action.requestId);
  assert.equal(action.action.answer, '<redacted>');
  assert.equal(action.action.accepted, '<redacted>');
  assert.deepEqual(waiting._capture, { sourceLine: 1, offsetMs: 0 });
  assert.deepEqual(action._capture, { sourceLine: 2, offsetMs: 2000 });
  assert.doesNotMatch(JSON.stringify(fixture), /private-turn-id|private-request-id|private prompt|2026-08-06/);
});

test('keeps IDs correlatable across structural field names', () => {
  const sanitized = sanitizeCapture({ id: 'shared-id', requestId: 'shared-id', toolCallId: 'shared-id' });
  assert.match(sanitized.id, /^<id:[0-9a-f]{12}>$/);
  assert.equal(sanitized.id, sanitized.requestId);
  assert.equal(sanitized.id, sanitized.toolCallId);
});

test('preserves verified confirmation kind enums', () => {
  const input = {
    confirmationKind: 'modifiedFilesConfirmation', contributorKind: 'mcp',
    reasonKind: 'insufficientScope', requiredScopeCount: 2,
  };
  assert.deepEqual(sanitizeCapture(input), input);
});

test('selects exact AHP source lines', (t) => {
  const options = captureOptions(t, [
    { type: 'agent-host.snapshot', stage: 'waiting' },
    { type: 'agent-host.action', stage: 'resolution-action' },
    { type: 'agent-host.snapshot', stage: 'terminal' },
  ]);
  const fixture = captureFixture({
    ...options, lineSelections: { 'agent-host-protocol': new Set([2]) },
  });
  assert.equal(fixture.sources[0].records.length, 1);
  assert.equal(fixture.sources[0].records[0].stage, 'resolution-action');
  assert.equal(fixture.sources[0].records[0]._capture.sourceLine, 2);
});

test('rejects missing, empty and malformed AHP capture input explicitly', (t) => {
  const options = captureOptions(t, []);
  assert.throws(() => captureFixture({ ...options, agentHostProtocolPath: undefined }), /path is required/);
  assert.throws(() => captureFixture(options), /no selected AHP records/);
  fs.writeFileSync(options.agentHostProtocolPath, '{"private":');
  assert.throws(() => captureFixture(options), /invalid capture JSON at line 1/);
  fs.writeFileSync(options.agentHostProtocolPath, '{"type":"unexpected"}');
  assert.throws(() => captureFixture(options), /expected an AHP capture record/);
  fs.unlinkSync(options.agentHostProtocolPath);
  assert.throws(() => captureFixture(options), { code: 'ENOENT' });
});
