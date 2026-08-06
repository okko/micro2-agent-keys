import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { captureFixture } from '../scripts/capture-vscode-fixture.mjs';

const SESSION_ID = '00000000-0000-4000-8000-000000000000';

test('captures blocker structure without private content', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentkeys-capture-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const workspaceStorage = path.join(directory, 'workspaceStorage');
  const transcriptDirectory = path.join(workspaceStorage, 'workspace-id', 'GitHub.copilot-chat', 'transcripts');
  const journalDirectory = path.join(workspaceStorage, 'workspace-id', 'chatSessions');
  const agentHostDirectory = path.join(directory, 'copilot', 'session-state', SESSION_ID);
  fs.mkdirSync(transcriptDirectory, { recursive: true });
  fs.mkdirSync(journalDirectory, { recursive: true });
  fs.mkdirSync(agentHostDirectory, { recursive: true });

  fs.writeFileSync(
    path.join(transcriptDirectory, `${SESSION_ID}.jsonl`),
    `${JSON.stringify({
      type: 'tool.execution_start',
      timestamp: '2026-08-06T12:00:00.000Z',
      data: {
        toolName: 'vscode_askQuestions',
        toolCallId: 'private-tool-id',
        prompt: 'private prompt',
        filePath: '/Users/private/project',
      },
    })}\n`
  );
  fs.writeFileSync(
    path.join(journalDirectory, `${SESSION_ID}.jsonl`),
    `${JSON.stringify({
      kind: 1,
      k: ['requests', 0, 'response'],
      v: [{ kind: 'questionCarousel', resolveId: 'private-resolve-id', isUsed: false, answer: 'private answer' }],
      map: { 'file:///Users/private/project/file.ts': { status: 'pending' } },
    })}\n`
  );
  fs.writeFileSync(
    path.join(agentHostDirectory, 'events.jsonl'),
    [
      JSON.stringify({
        type: 'input_request',
        purpose: 'askUser',
        requestId: 'private-request-id',
        timestamp: '2026-08-06T12:00:02.000Z',
      }),
      JSON.stringify({
        type: 'permission.requested',
        timestamp: '2026-08-06T12:00:03.000Z',
        data: {
          requestId: 'private-read-id',
          permissionRequest: { kind: 'read', path: path.join(directory, 'outside', 'file.ts') },
        },
      }),
      '',
    ].join('\n')
  );
  fs.writeFileSync(
    path.join(agentHostDirectory, 'workspace.yaml'),
    `cwd: ${JSON.stringify(path.join(directory, 'project'))}\n`
  );
  const vscodePackage = path.join(directory, 'package.json');
  fs.writeFileSync(vscodePackage, JSON.stringify({ version: '1.131.0' }));

  const fixture = captureFixture({
    sessionId: SESSION_ID,
    label: 'waiting',
    workspaceStorage,
    copilotHome: path.join(directory, 'copilot'),
    vscodePackage,
  });
  const serialized = JSON.stringify(fixture);

  assert.equal(fixture.vscodeVersion, '1.131.0');
  assert.equal(fixture.formatVersion, 2);
  assert.equal(fixture.label, 'waiting');
  assert.deepEqual(fixture.timing, { basis: 'relative-to-first-captured-event', unit: 'ms' });
  assert.deepEqual(fixture.sources.map(({ source }) => source), [
    'native-transcript',
    'native-journal',
    'agent-host-events',
  ]);
  assert.match(serialized, /vscode_askQuestions/);
  assert.match(serialized, /questionCarousel/);
  assert.match(serialized, /askUser/);
  assert.match(serialized, /"k":\["requests",0,"response"\]/);
  assert.match(serialized, /<id:[0-9a-f]{12}>/);
  assert.equal(fixture.sources[0].records[0]._capture.sourceLine, 1);
  assert.equal(fixture.sources[0].records[0]._capture.offsetMs, 0);
  assert.equal(fixture.sources[2].records[0]._capture.offsetMs, 2000);
  assert.equal(fixture.sources[2].records[1]._capture.pathScope, 'outside-working-directory');
  assert.doesNotMatch(serialized, /2026-08-06T12:00/);
  assert.doesNotMatch(serialized, /file:\/\/|file\.ts/);
  assert.doesNotMatch(
    serialized,
    /private prompt|private answer|private-tool-id|private-resolve-id|private-request-id|\/Users\/private/
  );
});

test('redacts non-structural scalar answers', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentkeys-capture-scalars-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const journalDirectory = path.join(directory, 'chatSessions');
  fs.mkdirSync(journalDirectory);
  fs.writeFileSync(
    path.join(journalDirectory, `${SESSION_ID}.jsonl`),
    `${JSON.stringify({
      kind: 1,
      k: ['requests', 0, 'response'],
      v: [{ kind: 'questionCarousel', isUsed: true, answer: 42, accepted: true }],
    })}\n`
  );

  const fixture = captureFixture({
    sessionId: SESSION_ID,
    workspaceStorage: directory,
    copilotHome: path.join(directory, 'copilot'),
    vscodePackage: path.join(directory, 'missing-package.json'),
  });
  const part = fixture.sources[0].records[0].v[0];

  assert.equal(part.kind, 'questionCarousel');
  assert.equal(part.isUsed, true);
  assert.equal(part.answer, '<redacted>');
  assert.equal(part.accepted, '<redacted>');
});

test('selects exact source lines', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentkeys-capture-lines-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const journalDirectory = path.join(directory, 'chatSessions');
  fs.mkdirSync(journalDirectory);
  fs.writeFileSync(
    path.join(journalDirectory, `${SESSION_ID}.jsonl`),
    [
      JSON.stringify({ kind: 1, k: ['requests', 0, 'result'], v: { type: 'before' } }),
      JSON.stringify({ kind: 1, k: ['requests', 0, 'response'], v: { kind: 'questionCarousel' } }),
      JSON.stringify({ kind: 1, k: ['requests', 0, 'result'], v: { type: 'after' } }),
      '',
    ].join('\n')
  );

  const fixture = captureFixture({
    sessionId: SESSION_ID,
    workspaceStorage: directory,
    copilotHome: path.join(directory, 'copilot'),
    lineSelections: { 'native-journal': new Set([2]) },
  });

  assert.equal(fixture.sources[0].records.length, 1);
  assert.equal(fixture.sources[0].records[0].v.kind, 'questionCarousel');
});

test('limits captured rows from each Agent Host state table', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentkeys-capture-state-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const agentHostDirectory = path.join(directory, 'copilot', 'session-state', SESSION_ID);
  const database = path.join(agentHostDirectory, 'session.db');
  fs.mkdirSync(agentHostDirectory, { recursive: true });
  execFileSync('/usr/bin/sqlite3', [
    database,
    "CREATE TABLE sample (id TEXT, status TEXT); INSERT INTO sample VALUES ('one', 'pending'), ('two', 'done');",
  ]);

  const fixture = captureFixture({
    sessionId: SESSION_ID,
    workspaceStorage: directory,
    copilotHome: path.join(directory, 'copilot'),
    agentHostStateRowLimit: 1,
  });
  const state = fixture.sources.find(({ source }) => source === 'agent-host-state');

  assert.equal(state.tables.length, 1);
  assert.equal(state.tables[0].name, 'sample');
  assert.deepEqual(state.tables[0].columns, [
    { name: 'id', type: 'TEXT', notNull: false, primaryKey: false },
    { name: 'status', type: 'TEXT', notNull: false, primaryKey: false },
  ]);
  assert.equal(state.tables[0].rows.length, 1);
  assert.deepEqual(Object.keys(state.tables[0].rows[0]), ['id', 'status']);
  assert.match(state.tables[0].rows[0].id, /^<id:[0-9a-f]{12}>$/);
  assert.equal(state.tables[0].rows[0].status, 'pending');
});