import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AgentHostChatProjection } from '../dist/vscode.js';

const SUPPORTED_VSCODE_VERSION = '1.131.0';
const FIXTURE_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'vscode-human-input'
);
const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, 'manifest.json'), 'utf8'));
const CASES = [
  { file: 'agent-host-question.json', blockerKind: 'question' },
  { file: 'agent-host-tool-deny.json', blockerKind: 'tool-confirmation' },
  { file: 'agent-host-plan-reject.json', blockerKind: 'plan-review' },
];

test('VS Code 1.131.0 protocol fixtures match the Agent Host projection', () => {
  assert.equal(manifest.capturedFrom.version, SUPPORTED_VSCODE_VERSION);

  for (const { file, blockerKind } of CASES) {
    const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, file), 'utf8'));
    const protocol = fixture.sources.find(({ source }) => source === 'agent-host-protocol');
    const projection = new AgentHostChatProjection();

    assert.equal(fixture.vscodeVersion, SUPPORTED_VSCODE_VERSION, file);
    assert.ok(protocol, `${file}: protocol source`);

    for (const record of protocol.records) {
      projection.apply(record.state);
      const snapshot = projection.snapshot();

      assert.equal(snapshot.active, record.truth.hasActiveRequest, `${file}: ${record.stage}: active`);
      assert.equal(snapshot.busy, record.truth.requestInProgress, `${file}: ${record.stage}: busy`);
      assert.equal(
        snapshot.blockers.size > 0,
        record.truth.awaitsUserInput,
        `${file}: ${record.stage}: awaits input`
      );
      assert.deepEqual(snapshot.incompatibilities, [], `${file}: ${record.stage}: compatibility`);

      if (record.stage === 'waiting') {
        assert.deepEqual(
          [...snapshot.blockers.values()].map(({ kind }) => kind),
          [blockerKind],
          `${file}: blocker kind`
        );
      } else {
        assert.equal(snapshot.blockers.size, 0, `${file}: ${record.stage}: resolved`);
      }
    }
  }
});
