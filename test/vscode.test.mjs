import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { VSCodeIntegration } from '../dist/vscode.js';
import { buildSessionUrl, exactOpenSupported, nativeSessionResource } from '../dist/vscode-app.js';
import { workspaceMetadata } from '../dist/vscode-session-files.js';
import { EFFECT } from '../dist/oai.js';
import { STATES } from '../dist/states.js';
import { event } from './vscode-event.mjs';

const IDS = [
  '00000000-0000-4000-8000-000000000000',
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000004',
];
const CONFIRMED_EXTERNAL_READ = JSON.parse(
  fs.readFileSync(new URL('./fixtures/vscode-native-confirmed-external-read.json', import.meta.url), 'utf8')
);

test('input state maps to orange breathing lighting', () => {
  assert.equal(STATES.input.color, 0xff6a00);
  assert.equal(STATES.input.effect, EFFECT.breath);
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentkeys-vscode-'));
  const root = path.join(directory, 'sessions');
  const nativeRoot = path.join(directory, 'workspaceStorage');
  fs.mkdirSync(root);
  fs.mkdirSync(nativeRoot);
  return {
    directory,
    root,
    nativeRoot,
    statePath: path.join(directory, 'state', 'vscode.json'),
  };
}

function createSession(root, id, cwd) {
  const directory = path.join(root, id);
  fs.mkdirSync(directory);
  fs.writeFileSync(
    path.join(directory, 'workspace.yaml'),
    `id: ${id}\ncwd: ${JSON.stringify(cwd)}\nclient_name: vscode-agent-host\n`
  );
  fs.writeFileSync(
    path.join(directory, 'events.jsonl'),
    [
      JSON.stringify({
        type: 'session.start',
        data: { producer: 'copilot-agent', version: 1, copilotVersion: '1.0.73' },
        timestamp: '2026-08-01T09:59:57.000Z',
      }),
      JSON.stringify({
        type: 'hook.start',
        data: { hookType: 'userPromptSubmitted' },
        timestamp: '2026-08-01T09:59:58.000Z',
      }),
      JSON.stringify({
        type: 'hook.end',
        data: { hookType: 'sessionEnd' },
        timestamp: '2026-08-01T09:59:59.000Z',
      }),
      '',
    ].join('\n')
  );
  return path.join(directory, 'events.jsonl');
}

function createNativeSession(nativeRoot, id, cwd) {
  const directory = path.join(nativeRoot, 'workspace-id');
  const transcripts = path.join(directory, 'GitHub.copilot-chat', 'transcripts');
  const chatSessions = path.join(directory, 'chatSessions');
  fs.mkdirSync(transcripts, { recursive: true });
  fs.mkdirSync(chatSessions);
  fs.writeFileSync(path.join(directory, 'workspace.json'), JSON.stringify({ folder: new URL(`file://${cwd}`).toString() }));
  const journalPath = path.join(chatSessions, `${id}.jsonl`);
  fs.writeFileSync(
    journalPath,
    [
      JSON.stringify({
        kind: 0,
        v: {
          sessionId: id,
          requests: [
            {
              requestId: 'old-request',
              result: { timings: {} },
              modelState: { value: 1, completedAt: 1785616800000 },
            },
          ],
        },
      }),
      '',
    ].join('\n')
  );
  const eventsPath = path.join(transcripts, `${id}.jsonl`);
  fs.writeFileSync(
    eventsPath,
    [
      JSON.stringify({
        type: 'session.start',
        data: { sessionId: id, producer: 'copilot-agent', version: 1, copilotVersion: '0.59.0' },
        timestamp: '2026-08-01T09:59:57.000Z',
      }),
      JSON.stringify(event('user.message', {}, '2026-08-01T09:59:58.000Z')),
      JSON.stringify(event('assistant.turn_start', { turnId: 'old-turn' }, '2026-08-01T09:59:59.000Z')),
      JSON.stringify(event('assistant.turn_end', { turnId: 'old-turn' }, '2026-08-01T10:00:00.000Z')),
      '',
    ].join('\n')
  );
  return { eventsPath, journalPath };
}

function append(file, ...events) {
  fs.appendFileSync(file, events.map((event) => JSON.stringify(event)).join('\n') + '\n');
}

async function waitFor(predicate, message, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class FakeAgentHostStateSource {
  handler = null;
  unavailableHandler = null;
  sessions = [];
  stopped = false;

  start(handler, unavailableHandler) {
    this.handler = handler;
    this.unavailableHandler = unavailableHandler;
  }

  setSessions(sessionIds) {
    this.sessions = [...sessionIds];
  }

  async emit(sessionId, state) {
    await this.handler(sessionId, state);
  }

  async emitUnavailable(...sessionIds) {
    await this.unavailableHandler(sessionIds);
  }

  stop() {
    this.stopped = true;
  }
}

test('Agent Host unknown tool statuses set a bound slot to incompatible red', async (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const cwd = path.join(files.directory, 'project');
  fs.mkdirSync(cwd);
  const eventsPath = createSession(files.root, IDS[0], cwd);
  const logs = [];
  const integration = new VSCodeIntegration({
    ...files,
    scanIntervalMs: 60_000,
    log: (...values) => logs.push(values.join(' ')),
  });
  await integration.start();
  t.after(() => integration.stop());
  append(eventsPath, event('user.message'));
  await integration.scan();

  assert.equal(
    await integration.applyAgentHostChatState(IDS[0], {
      activeTurn: {
        id: 'protocol-turn',
        responseParts: [
          { kind: 'toolCall', toolCall: { toolCallId: 'future-tool', status: 'waiting-for-future-review' } },
        ],
      },
    }),
    true
  );

  assert.equal(integration.slots[0].state, 'error');
  assert.equal(integration.slots[0].runError, 'incompatible:unknown-agent-host-tool-status');
  assert.equal(STATES[integration.slots[0].state].color, 0xff0000);
  const diagnostic = logs.find((line) => line.startsWith('Incompatible VS Code execution state'));
  assert.match(
    diagnostic,
    new RegExp(
      `session=${IDS[0]} request=protocol-turn source=agent-host ` +
      'responsePart=toolCall toolStatus=waiting-for-future-review vscode='
    )
  );
});

test('Agent Host unexplained waiting response parts set a bound slot to incompatible red', async (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const cwd = path.join(files.directory, 'project');
  fs.mkdirSync(cwd);
  const eventsPath = createSession(files.root, IDS[0], cwd);
  const logs = [];
  const integration = new VSCodeIntegration({
    ...files,
    scanIntervalMs: 60_000,
    log: (...values) => logs.push(values.join(' ')),
  });
  await integration.start();
  t.after(() => integration.stop());
  append(eventsPath, event('user.message'));
  await integration.scan();

  assert.equal(
    await integration.applyAgentHostChatState(IDS[0], {
      status: 24,
      activeTurn: {
        id: 'protocol-turn',
        responseParts: [{ kind: 'futureReviewRequest', state: { phase: 'waiting' } }],
      },
    }),
    true
  );

  assert.equal(integration.slots[0].state, 'error');
  assert.equal(integration.slots[0].runError, 'incompatible:unknown-agent-host-response');
  const diagnostic = logs.find((line) => line.startsWith('Incompatible VS Code execution state'));
  assert.match(
    diagnostic,
    new RegExp(
      `session=${IDS[0]} request=protocol-turn source=agent-host ` +
      'responsePart=futureReviewRequest chatStatus=24 vscode='
    )
  );
});

test('wires bound Agent Host sessions to authoritative protocol state', async (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const cwd = path.join(files.directory, 'project');
  fs.mkdirSync(cwd);
  const eventsPath = createSession(files.root, IDS[0], cwd);
  const source = new FakeAgentHostStateSource();
  const integration = new VSCodeIntegration({
    ...files,
    agentHostSource: source,
    scanIntervalMs: 60_000,
  });
  await integration.start();

  append(eventsPath, event('user.message'));
  await integration.scan();
  assert.deepEqual(source.sessions, [IDS[0]]);

  await source.emit(IDS[0], {
    activeTurn: {
      id: 'protocol-turn',
      responseParts: [
        { kind: 'inputRequest', request: { id: 'question-1', purpose: 'askUser' } },
      ],
    },
  });
  assert.equal(integration.slots[0].state, 'input');

  await source.emitUnavailable(IDS[0]);
  assert.equal(integration.slots[0].state, 'error');
  assert.equal(integration.slots[0].runError, 'agent-host-state-unavailable');
  await source.emit(IDS[0], {
    activeTurn: {
      id: 'protocol-turn',
      responseParts: [
        { kind: 'inputRequest', request: { id: 'question-1', purpose: 'askUser' } },
      ],
    },
  });
  assert.equal(integration.slots[0].state, 'input');
  assert.equal(integration.slots[0].runError, null);

  await source.emit(IDS[0], {
    activeTurn: { id: 'protocol-turn', responseParts: [] },
  });
  assert.equal(integration.slots[0].state, 'running');

  await source.emit(IDS[0], {
    turns: [{ id: 'protocol-turn', state: 'complete', responseParts: [] }],
  });
  assert.equal(integration.slots[0].state, 'done');
  await source.emitUnavailable(IDS[0]);
  assert.equal(integration.slots[0].state, 'done');

  await source.emit(IDS[0], {
    activeTurn: {
      id: 'cancelled-turn',
      responseParts: [
        { kind: 'inputRequest', request: { id: 'question-2', purpose: 'askUser' } },
      ],
    },
  });
  assert.equal(integration.slots[0].state, 'input');
  await source.emit(IDS[0], {
    turns: [{ id: 'cancelled-turn', state: 'cancelled', responseParts: [] }],
  });
  assert.equal(integration.slots[0].state, 'done');
  assert.equal(integration.sessions.get(IDS[0]).run.blockers.size, 0);

  await source.emit(IDS[0], {
    activeTurn: {
      id: 'failed-turn',
      responseParts: [
        { kind: 'toolCall', toolCall: { toolCallId: 'approval-1', status: 'pending-confirmation' } },
      ],
    },
  });
  assert.equal(integration.slots[0].state, 'input');
  await source.emit(IDS[0], {
    turns: [{ id: 'failed-turn', state: 'failed', responseParts: [] }],
  });
  assert.equal(integration.slots[0].state, 'error');
  assert.equal(integration.sessions.get(IDS[0]).run.blockers.size, 0);

  integration.stop();
  assert.equal(source.stopped, true);
});

test('parses quoted workspace metadata', () => {
  assert.deepEqual(
    workspaceMetadata('id: abc\ncwd: "/tmp/project space"\nclient_name: vscode-agent-host\n'),
    { id: 'abc', cwd: '/tmp/project space', clientName: 'vscode-agent-host' }
  );
});

test('native journal tracks permission waits before transcript execution', async (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const cwd = path.join(files.directory, 'Native project');
  fs.mkdirSync(cwd);
  const { eventsPath, journalPath } = createNativeSession(files.nativeRoot, IDS[0], cwd);
  const integration = new VSCodeIntegration({
    ...files,
    scanIntervalMs: 60_000,
  });
  await integration.start();
  t.after(() => integration.stop());

  append(eventsPath, event('user.message'), event('assistant.turn_start', { turnId: 'native-turn' }));
  await integration.scan();
  assert.equal(integration.slots[0].state, 'running');

  append(journalPath, {
    kind: 2,
    k: ['requests'],
    v: [{ requestId: 'native-request', response: [], modelState: { value: 0 } }],
  });
  const pending = {
    kind: 2,
    k: ['requests', 1, 'response'],
    i: 0,
    v: [
      {
        toolCallId: 'permissioned-tool',
        isComplete: true,
        toolSpecificData: { requestUnsandboxedExecution: true },
      },
    ],
  };
  append(journalPath, pending);
  await integration.scan();
  assert.equal(integration.slots[0].state, 'input');

  append(journalPath, {
    ...pending,
    v: [
      {
        toolCallId: 'permissioned-tool',
        isConfirmed: { type: 4 },
        isComplete: true,
        toolSpecificData: {
          requestUnsandboxedExecution: true,
          terminalCommandState: { exitCode: 0 },
        },
      },
    ],
  });
  await integration.scan();
  assert.equal(integration.slots[0].state, 'running');

  append(
    eventsPath,
    event('assistant.message', {
      toolRequests: [
        { toolCallId: 'external-a', name: 'read_file', arguments: { filePath: '/private/a' } },
        { toolCallId: 'external-b', name: 'read_file', arguments: { filePath: '/private/b' } },
      ],
    })
  );
  await integration.scan();
  assert.equal(integration.slots[0].state, 'running');

  append(journalPath, {
    kind: 2,
    k: ['requests'],
    v: [{ requestId: 'external-request', response: [], modelState: { value: 0 } }],
  });
  const externalPending = {
    kind: 2,
    k: ['requests', 2, 'response'],
    i: 0,
    v: [
      { toolCallId: 'external-a', isComplete: true },
      { toolCallId: 'external-b', isComplete: true },
    ],
  };
  append(journalPath, externalPending);
  await integration.scan();
  assert.equal(integration.slots[0].state, 'input');

  append(journalPath, {
    ...externalPending,
    v: [
      { toolCallId: 'external-a', isConfirmed: { type: 4 }, isComplete: true },
      { toolCallId: 'external-b', isComplete: true },
    ],
  });
  await integration.scan();
  assert.equal(integration.slots[0].state, 'input');

  append(journalPath, {
    ...externalPending,
    v: [
      { toolCallId: 'external-a', isConfirmed: { type: 4 }, isComplete: true },
      { toolCallId: 'external-b', isConfirmed: { type: 4 }, isComplete: true },
    ],
  });
  await integration.scan();
  assert.equal(integration.slots[0].state, 'running');
});

test('native confirmed external reads remain running before execution', async (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const cwd = path.join(files.directory, 'Native project');
  fs.mkdirSync(cwd);
  const { eventsPath, journalPath } = createNativeSession(files.nativeRoot, IDS[0], cwd);
  const observed = [];
  const integration = new VSCodeIntegration({
    ...files,
    scanIntervalMs: 60_000,
    onSlot: (slot) => observed.push(slot.state),
  });
  await integration.start();
  t.after(() => integration.stop());

  append(eventsPath, event('user.message'), event('assistant.turn_start', { turnId: 'native-turn' }));
  append(journalPath, {
    kind: 2,
    k: ['requests'],
    v: [{ requestId: 'native-request', response: [], modelState: { value: 0 } }],
  });
  await integration.scan();
  assert.equal(integration.slots[0].state, 'running');

  observed.length = 0;
  append(eventsPath, CONFIRMED_EXTERNAL_READ.transcript[0]);
  await integration.scan();
  assert.equal(integration.slots[0].state, 'running');
  assert.equal(integration.sessions.get(IDS[0]).run.blockers.size, 0);

  append(eventsPath, CONFIRMED_EXTERNAL_READ.transcript[1]);
  append(journalPath, ...CONFIRMED_EXTERNAL_READ.journal);
  await integration.scan();
  assert.equal(integration.slots[0].state, 'running');
  assert.deepEqual(observed, []);

  append(eventsPath, CONFIRMED_EXTERNAL_READ.transcript[2]);
  await integration.scan();
  assert.equal(integration.slots[0].state, 'running');
});

test('native journal edit and resend replacements rebuild the latest request projection', async (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const cwd = path.join(files.directory, 'Native project');
  fs.mkdirSync(cwd);
  const { eventsPath, journalPath } = createNativeSession(files.nativeRoot, IDS[0], cwd);
  const integration = new VSCodeIntegration({ ...files, scanIntervalMs: 60_000 });
  await integration.start();
  t.after(() => integration.stop());

  append(eventsPath, event('user.message'), event('assistant.turn_start', { turnId: 'native-turn' }));
  append(journalPath, {
    kind: 2,
    k: ['requests'],
    v: [
      {
        requestId: 'waiting-request',
        response: [{ kind: 'questionCarousel', resolveId: 'questions' }],
        modelState: { value: 4 },
      },
    ],
  });
  await integration.scan();
  assert.equal(integration.slots[0].state, 'input');

  fs.rmSync(journalPath);
  fs.writeFileSync(
    journalPath,
    `${JSON.stringify({
      kind: 0,
      v: {
        sessionId: IDS[0],
        requests: [{ requestId: 'replacement-request', response: [], modelState: { value: 0 } }],
      },
    })}\n`
  );
  await integration.scan();
  assert.equal(integration.slots[0].state, 'running');
  assert.equal(integration.sessions.get(IDS[0]).nativeSnapshot.requestId, 'replacement-request');
  assert.equal(integration.sessions.get(IDS[0]).nativeSnapshot.blockers.size, 0);

  append(journalPath, {
    kind: 1,
    k: ['requests', 0],
    v: {
      requestId: 'resent-request',
      response: [{ kind: 'planReview', resolveId: 'resent-plan' }],
      modelState: { value: 4 },
    },
  });
  await integration.scan();
  assert.equal(integration.slots[0].state, 'input');
  assert.equal(integration.sessions.get(IDS[0]).run.requestId, 'resent-request');
  assert.deepEqual(
    [...integration.sessions.get(IDS[0]).run.blockers.values()].map(({ kind }) => kind),
    ['plan-review']
  );

  append(journalPath, {
    kind: 1,
    k: ['requests', 0],
    v: {
      requestId: 'resent-request',
      response: [{ kind: 'planReview', resolveId: 'resent-plan', isUsed: true }],
      modelState: { value: 1, completedAt: 1785616803000 },
    },
  });
  await integration.scan();
  assert.equal(integration.slots[0].state, 'done');
  assert.equal(integration.sessions.get(IDS[0]).run.blockers.size, 0);
});

test('native journal survives partial lines, malformed records, and truncation', async (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const cwd = path.join(files.directory, 'Native project');
  fs.mkdirSync(cwd);
  const { eventsPath, journalPath } = createNativeSession(files.nativeRoot, IDS[0], cwd);
  const logs = [];
  const integration = new VSCodeIntegration({
    ...files,
    scanIntervalMs: 60_000,
    log: (...values) => logs.push(values.join(' ')),
  });
  await integration.start();
  t.after(() => integration.stop());

  append(eventsPath, event('user.message'), event('assistant.turn_start', { turnId: 'native-turn' }));
  append(journalPath, {
    kind: 2,
    k: ['requests'],
    v: [{ requestId: 'active-request', response: [], modelState: { value: 0 } }],
  });
  await integration.scan();
  assert.equal(integration.slots[0].state, 'running');

  const waiting = JSON.stringify({
    kind: 1,
    k: ['requests', 1, 'response'],
    v: [{ kind: 'questionCarousel', resolveId: 'questions' }],
  });
  fs.appendFileSync(journalPath, waiting.slice(0, -1));
  await integration.scan();
  assert.equal(integration.slots[0].state, 'running');

  fs.appendFileSync(journalPath, `${waiting.slice(-1)}\n{not-json}\n`);
  append(journalPath, { kind: 1, k: ['requests', 1, 'response', 0, 'isUsed'], v: true });
  await integration.scan();
  assert.equal(integration.slots[0].state, 'running');
  assert.ok(logs.some((line) => line.startsWith('Malformed VS Code journal')));

  fs.writeFileSync(
    journalPath,
    [
      JSON.stringify({
        kind: 0,
        v: {
          requests: [
            {
              requestId: 'stale-full-record',
              response: [{ kind: 'questionCarousel', resolveId: 'stale-questions' }],
              modelState: { value: 4 },
            },
          ],
        },
      }),
      JSON.stringify({
        kind: 0,
        v: {
          requests: [{ requestId: 'latest-full-record', response: [], modelState: { value: 0 } }],
        },
      }),
      '',
    ].join('\n')
  );
  await integration.scan();
  assert.equal(integration.slots[0].state, 'running');
  assert.equal(integration.sessions.get(IDS[0]).nativeSnapshot.requestId, 'latest-full-record');
  assert.equal(integration.sessions.get(IDS[0]).nativeSnapshot.blockers.size, 0);
});

test('native journal reconciles an optimistic question hook authoritatively', async (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const cwd = path.join(files.directory, 'Native project');
  fs.mkdirSync(cwd);
  const { eventsPath, journalPath } = createNativeSession(files.nativeRoot, IDS[0], cwd);
  const integration = new VSCodeIntegration({ ...files, scanIntervalMs: 60_000 });
  await integration.start();
  t.after(() => integration.stop());

  append(eventsPath, event('user.message'), event('assistant.turn_start', { turnId: 'native-turn' }));
  await integration.scan();
  await integration.applyHook({
    hookEventName: 'PreToolUse',
    sessionId: IDS[0],
    toolName: 'vscode_askQuestions',
    toolUseId: 'optimistic-question',
  });
  assert.equal(integration.slots[0].state, 'input');

  append(journalPath, {
    kind: 2,
    k: ['requests'],
    v: [{ requestId: 'authoritative-request', response: [], modelState: { value: 0 } }],
  });
  await integration.scan();
  assert.equal(integration.slots[0].state, 'running');
  assert.equal(integration.sessions.get(IDS[0]).run.requestId, 'authoritative-request');
  assert.equal(integration.sessions.get(IDS[0]).run.blockers.size, 0);
});

test('native journal reconciles stale hook-only blockers without new journal bytes', async (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const cwd = path.join(files.directory, 'Native project');
  fs.mkdirSync(cwd);
  const { eventsPath, journalPath } = createNativeSession(files.nativeRoot, IDS[0], cwd);
  const integration = new VSCodeIntegration({ ...files, scanIntervalMs: 60_000 });
  await integration.start();
  t.after(() => integration.stop());

  append(eventsPath, event('user.message'), event('assistant.turn_start', { turnId: 'native-turn' }));
  append(journalPath, {
    kind: 2,
    k: ['requests'],
    v: [{ requestId: 'authoritative-request', response: [], modelState: { value: 0 } }],
  });
  await integration.scan();
  assert.equal(integration.slots[0].state, 'running');

  await integration.applyHook({
    hookEventName: 'PreToolUse',
    sessionId: IDS[0],
    toolName: 'vscode_askQuestions',
    toolUseId: 'optimistic-question',
  });
  assert.equal(integration.slots[0].state, 'input');

  await integration.scan();
  assert.equal(integration.slots[0].state, 'running');
  assert.equal(integration.sessions.get(IDS[0]).run.blockers.size, 0);
});

test('marks unknown native waiting states as incompatible and releases them when opened', async (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const cwd = path.join(files.directory, 'Private project name');
  fs.mkdirSync(cwd);
  const { eventsPath, journalPath } = createNativeSession(files.nativeRoot, IDS[0], cwd);
  const logs = [];
  const integration = new VSCodeIntegration({
    ...files,
    scanIntervalMs: 60_000,
    launch: async () => {},
    log: (...values) => logs.push(values.join(' ')),
  });
  await integration.start();
  t.after(() => integration.stop());

  append(eventsPath, event('user.message'), event('assistant.turn_start', { turnId: 'native-turn' }));
  append(journalPath, {
    kind: 2,
    k: ['requests'],
    v: [
      {
        requestId: 'unknown-waiting-request',
        response: [
          { kind: 'questionCarousel', resolveId: 'resolved-question', isUsed: true },
          { kind: 'futureHumanInput', state: { type: 999 } },
        ],
        modelState: { value: 4 },
      },
    ],
  });
  await integration.scan();

  assert.equal(integration.slots[0].state, 'error');
  assert.equal(integration.slots[0].runError, 'incompatible:unknown-native-response');
  assert.equal(STATES[integration.slots[0].state].color, 0xff0000);
  const diagnostic = logs.find((line) => line.startsWith('Incompatible VS Code execution state'));
  assert.match(
    diagnostic,
    new RegExp(
      `session=${IDS[0]} request=unknown-waiting-request source=native ` +
      'responsePart=futureHumanInput stateType=999 vscode='
    )
  );
  assert.doesNotMatch(diagnostic, /Private project name/);

  await integration.open(0);
  assert.equal(integration.publicSlots()[0].state, 'idle');
  assert.equal(integration.slots[0], null);
  assert.equal(integration.sessions.get(IDS[0]).boundSlot, null);

  await integration.scan();
  assert.equal(integration.publicSlots()[0].state, 'idle');
});

test('native journal ignores an old completion until the prompted request is inserted', async (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const cwd = path.join(files.directory, 'Native project');
  fs.mkdirSync(cwd);
  const { eventsPath, journalPath } = createNativeSession(files.nativeRoot, IDS[0], cwd);
  const integration = new VSCodeIntegration({ ...files, scanIntervalMs: 60_000 });
  await integration.start();
  t.after(() => integration.stop());

  append(eventsPath, event('user.message'), event('assistant.turn_start', { turnId: 'new-turn' }));
  append(journalPath, {
    kind: 1,
    k: ['requests', 0, 'modelState'],
    v: { value: 1, completedAt: 1785616801000 },
  });
  await integration.scan();
  assert.equal(integration.slots[0].state, 'running');

  append(journalPath, {
    kind: 2,
    k: ['requests'],
    v: [{ requestId: 'new-request', response: [], modelState: { value: 0 } }],
  });
  await integration.scan();
  assert.equal(integration.slots[0].state, 'running');

  append(journalPath, {
    kind: 1,
    k: ['requests', 1, 'modelState'],
    v: { value: 1, completedAt: 1785616802000 },
  });
  await integration.scan();
  assert.equal(integration.slots[0].state, 'done');
});

test('builds an encoded exact-session URL', () => {
  const url = buildSessionUrl('/tmp/Prøject space', IDS[0]);
  assert.match(url, /^vscode:\/\/file\/tmp\/Pr%C3%B8ject%20space\?/);
  assert.equal(new URL(url).searchParams.get('session'), `agent-host-copilotcli:/${IDS[0]}`);
});

test('enables exact-session opening for every VS Code version', () => {
  for (const version of ['1.131.0', '1.132.0', '2.0.0', null]) {
    assert.equal(exactOpenSupported(version, true), true, String(version));
    assert.equal(exactOpenSupported(version, false), false, String(version));
  }
});

test('tracks and opens a native VS Code Chat session', async (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const cwd = path.join(files.directory, 'Native project');
  fs.mkdirSync(cwd);
  const { eventsPath, journalPath } = createNativeSession(files.nativeRoot, IDS[0], cwd);
  const launched = [];
  const integration = new VSCodeIntegration({
    ...files,
    scanIntervalMs: 60_000,
    launch: async (url) => launched.push(url),
  });
  await integration.start();
  t.after(() => integration.stop());

  append(
    eventsPath,
    event('user.message', {}, '2026-08-01T10:00:01.000Z'),
    event('assistant.turn_start', { turnId: 'native-turn' }, '2026-08-01T10:00:02.000Z')
  );
  await integration.scan();
  assert.equal(integration.slots[0].state, 'running');
  assert.equal(integration.slots[0].source, 'native');

  assert.equal(
    await integration.applyHook({
      hookEventName: 'PreToolUse',
      sessionId: IDS[0],
      toolName: 'vscode_askQuestions',
      toolUseId: 'hook-question',
      timestamp: '2026-08-01T10:00:03.000Z',
    }),
    true
  );
  assert.equal(integration.slots[0].state, 'input');
  assert.equal(
    await integration.applyHook({
      hookEventName: 'PostToolUse',
      sessionId: IDS[0],
      toolName: 'vscode_askQuestions',
      toolUseId: 'hook-question',
      timestamp: '2026-08-01T10:00:04.000Z',
    }),
    true
  );
  assert.equal(integration.slots[0].state, 'running');

  append(
    eventsPath,
    event(
      'assistant.message',
      {
        toolRequests: [
          { toolCallId: 'external-read', name: 'read_file', arguments: { filePath: '/private/external-file' } },
        ],
      },
      '2026-08-01T10:00:04.100Z'
    ),
    event(
      'tool.execution_start',
      { toolCallId: 'external-read', toolName: 'read_file' },
      '2026-08-01T10:00:04.200Z'
    )
  );
  await integration.scan();
  assert.equal(integration.slots[0].state, 'running');
  assert.equal(
    await integration.applyHook({
      hookEventName: 'PreToolUse',
      sessionId: IDS[0],
      toolName: 'read_file',
      toolUseId: 'external-read__vscode-1785759144224',
      timestamp: '2026-08-01T10:00:04.300Z',
    }),
    false
  );
  assert.equal(integration.slots[0].state, 'running');
  assert.equal(
    await integration.applyHook({
      hookEventName: 'PostToolUse',
      sessionId: IDS[0],
      toolName: 'read_file',
      toolUseId: 'external-read__vscode-1785759144224',
      timestamp: '2026-08-01T10:00:04.350Z',
    }),
    true
  );
  assert.equal(integration.slots[0].state, 'running');
  assert.equal(
    await integration.applyHook({
      hookEventName: 'PreToolUse',
      sessionId: IDS[0],
      toolName: 'read_file',
      toolUseId: 'ordinary-read__vscode-1785759144225',
      timestamp: '2026-08-01T10:00:04.400Z',
    }),
    false
  );

  append(
    eventsPath,
    event('assistant.message', {
      toolRequests: [
        { toolCallId: 'denied-external-read', name: 'read_file', arguments: { filePath: '/private/denied-file' } },
      ],
    })
  );
  await integration.scan();
  assert.equal(integration.slots[0].state, 'running');
  assert.equal(
    await integration.applyHook({
      hookEventName: 'PermissionDenied',
      sessionId: IDS[0],
      toolName: 'read_file',
      toolUseId: 'denied-external-read__vscode-1785759144225',
      timestamp: '2026-08-01T10:00:04.450Z',
    }),
    true
  );
  assert.equal(integration.slots[0].state, 'running');

  const requestId = `terminal-confirmation:${'a'.repeat(64)}`;
  assert.equal(
    await integration.applyHook({
      hookEventName: 'PermissionRequest',
      sessionId: IDS[0],
      toolName: 'vscode_get_terminal_confirmation',
      requestId,
      timestamp: '2026-08-01T10:00:05.000Z',
    }),
    true
  );
  assert.equal(integration.slots[0].state, 'input');
  assert.equal(
    await integration.applyHook({
      hookEventName: 'PermissionDenied',
      sessionId: IDS[0],
      toolName: 'vscode_get_terminal_confirmation',
      requestId,
      timestamp: '2026-08-01T10:00:06.000Z',
    }),
    true
  );
  assert.equal(integration.slots[0].state, 'running');

  append(
    eventsPath,
    event(
      'tool.execution_start',
      { toolCallId: 'transcript-question', toolName: 'vscode_askQuestions' },
      '2026-08-01T10:00:03.000Z'
    )
  );
  await integration.scan();
  assert.equal(integration.slots[0].state, 'running');

  append(journalPath, {
    kind: 2,
    k: ['requests'],
    v: [{ requestId: 'native-turn-request', response: [], modelState: { value: 0 } }],
  });
  append(journalPath, { kind: 1, k: ['requests', 1, 'result'], v: { timings: {} } });
  await integration.scan();
  assert.equal(integration.slots[0].state, 'done');

  await integration.open(0);
  assert.equal(integration.publicSlots()[0].state, 'idle');
  assert.equal(integration.sessions.get(IDS[0]).boundSlot, 0);
  assert.equal(new URL(launched[0]).searchParams.get('session'), nativeSessionResource(IDS[0]));
});

test('prefers Agent Host telemetry when VS Code mirrors the same session natively', async (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const cwd = path.join(files.directory, 'project');
  fs.mkdirSync(cwd);
  const eventsPath = createSession(files.root, IDS[0], cwd);
  createNativeSession(files.nativeRoot, IDS[0], cwd);
  const observed = [];
  const integration = new VSCodeIntegration({
    ...files,
    scanIntervalMs: 60_000,
    onSlot: (slot) => observed.push(slot.state),
  });
  await integration.start();
  t.after(() => integration.stop());

  append(
    eventsPath,
    event('user.message', {}, '2026-08-01T10:00:01.000Z'),
    event('assistant.turn_start', { turnId: 'turn-1' }, '2026-08-01T10:00:02.000Z')
  );
  await integration.scan();
  assert.equal(integration.sessions.get(IDS[0]).source, 'copilot-cli');
  assert.equal(integration.slots[0].state, 'running');
  assert.deepEqual(observed, ['running']);

  observed.length = 0;
  await integration.scan();
  assert.deepEqual(observed, []);
  assert.equal(integration.slots[0].state, 'running');
});

test('coalesces transcript and journal updates into one authoritative slot change', async (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const cwd = path.join(files.directory, 'Native project');
  fs.mkdirSync(cwd);
  const { eventsPath, journalPath } = createNativeSession(files.nativeRoot, IDS[0], cwd);
  const observed = [];
  const integration = new VSCodeIntegration({
    ...files,
    scanIntervalMs: 60_000,
    onSlot: (slot) => observed.push(slot.state),
  });
  await integration.start();
  t.after(() => integration.stop());

  append(
    eventsPath,
    event('user.message'),
    event('assistant.turn_start', { turnId: 'native-turn' }),
    event('assistant.message', {
      toolRequests: [
        { toolCallId: 'optimistic-tool', arguments: { requestUnsandboxedExecution: true } },
      ],
    })
  );
  append(journalPath, {
    kind: 2,
    k: ['requests'],
    v: [{ requestId: 'authoritative-request', response: [], modelState: { value: 0 } }],
  });

  await integration.scan();
  assert.equal(integration.slots[0].state, 'running');
  assert.deepEqual(observed, ['running']);
});

test('polling interval stays within the Phase 5 operating bounds', () => {
  const files = fixture();
  try {
    const defaultIntegration = new VSCodeIntegration(files);
    const clampedIntegration = new VSCodeIntegration({ ...files, scanIntervalMs: 20 });
    const finiteIntegration = new VSCodeIntegration({ ...files, scanIntervalMs: Number.POSITIVE_INFINITY });
    assert.ok(defaultIntegration.scanIntervalMs >= 100 && defaultIntegration.scanIntervalMs <= 300);
    assert.equal(clampedIntegration.scanIntervalMs, 100);
    assert.equal(finiteIntegration.scanIntervalMs, defaultIntegration.scanIntervalMs);
  } finally {
    fs.rmSync(files.directory, { recursive: true, force: true });
  }
});

test('persisted event writes reach onSlot within 300 ms', async (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const cwd = path.join(files.directory, 'project');
  fs.mkdirSync(cwd);
  const eventsPath = createSession(files.root, IDS[0], cwd);
  const observed = [];
  const integration = new VSCodeIntegration({
    ...files,
    scanIntervalMs: 100,
    onSlot: (slot) => observed.push(slot.state),
  });
  await integration.start();
  t.after(() => integration.stop());

  const measureWrite = async (write, expected) => {
    const startedAt = Date.now();
    write();
    await waitFor(
      () => observed.at(-1) === expected,
      `persisted state did not reach onSlot as ${expected}`
    );
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs <= 300, `${expected} propagation took ${elapsedMs} ms`);
    return elapsedMs;
  };

  await measureWrite(
    () => append(eventsPath, event('user.message'), event('assistant.turn_start', { turnId: 'turn-1' })),
    'running'
  );
  await measureWrite(
    () => append(eventsPath, event('permission.requested', { requestId: 'permission-1' })),
    'input'
  );
  await measureWrite(
    () => append(eventsPath, event('permission.completed', { requestId: 'permission-1' })),
    'running'
  );
  await measureWrite(
    () => append(eventsPath, event('hook.end', { hookType: 'sessionEnd' })),
    'done'
  );
  assert.deepEqual(observed, ['running', 'input', 'running', 'done']);
});

test('lifecycle hooks leave bound slots intact', async (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const cwd = path.join(files.directory, 'project');
  fs.mkdirSync(cwd);
  const eventsPath = createSession(files.root, IDS[0], cwd);

  const observed = [];
  const integration = new VSCodeIntegration({
    ...files,
    scanIntervalMs: 60_000,
    onSlot: (slot) => observed.push(slot),
  });
  await integration.start();
  t.after(() => integration.stop());

  append(eventsPath, event('user.message', {}, '2026-08-01T10:00:00.000Z'));
  await integration.scan();
  assert.equal(integration.slots[0].state, 'running');

  assert.equal(
    await integration.applyHook({ hookEventName: 'SessionStart', timestamp: '2026-08-01T10:00:01.000Z' }),
    false
  );
  assert.equal(integration.publicSlots()[0].state, 'running');
  assert.equal(observed.at(-1).state, 'running');
});

test('reset frees persisted VS Code slots and sends idle key states', async (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const cwd = path.join(files.directory, 'project');
  fs.mkdirSync(cwd);
  const eventsPath = createSession(files.root, IDS[0], cwd);
  const source = new FakeAgentHostStateSource();
  const observed = [];
  const integration = new VSCodeIntegration({
    ...files,
    agentHostSource: source,
    scanIntervalMs: 60_000,
    onSlot: (slot) => observed.push(slot),
  });
  await integration.start();
  t.after(() => integration.stop());

  append(eventsPath, event('user.message', {}, '2026-08-01T10:00:00.000Z'));
  await integration.scan();
  assert.equal(integration.slots[0].sessionId, IDS[0]);
  assert.deepEqual(source.sessions, [IDS[0]]);

  const reset = await integration.resetSlots();
  assert.deepEqual(reset, [0, 1, 2, 3].map((slot) => ({ slot, state: 'idle' })));
  assert.ok(integration.slots.every((slot) => slot === null));
  assert.equal(integration.sessions.get(IDS[0]).boundSlot, null);
  assert.deepEqual(source.sessions, []);
  assert.deepEqual(
    observed.slice(-4),
    [0, 1, 2, 3].map((slot) => ({ slot, state: 'idle', stateChangedAt: observed.at(-1).stateChangedAt }))
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(files.statePath, 'utf8')).slots, [null, null, null, null]);

  append(eventsPath, event('user.message', {}, '2026-08-01T10:01:00.000Z'));
  await integration.scan();
  assert.equal(integration.slots[0].sessionId, IDS[0]);
});

test('prompt-gates allocation and reuses the oldest acknowledged slot', async (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const projects = IDS.map((id, index) => {
    const cwd = path.join(files.directory, `project-${index}`);
    fs.mkdirSync(cwd);
    return createSession(files.root, id, cwd);
  });
  append(projects[0], event('user.message'));

  const integration = new VSCodeIntegration({
    ...files,
    scanIntervalMs: 60_000,
    launch: async () => {},
  });
  await integration.start();
  t.after(() => integration.stop());
  assert.ok(integration.publicSlots().every((slot) => slot.state === 'idle'));

  for (let index = 0; index < 4; index++) {
    append(
      projects[index],
      event('hook.start', { hookType: 'userPromptSubmitted' }, `2026-08-01T10:00:0${index}.000Z`),
      event('hook.end', { hookType: 'sessionEnd' }, `2026-08-01T10:00:1${index}.000Z`)
    );
    await integration.scan();
  }
  assert.deepEqual(integration.slots.map((slot) => slot.sessionId), IDS.slice(0, 4));
  await integration.open(0);
  assert.equal(integration.slots[0].state, 'idle');
  assert.equal(integration.slots[0].sessionId, IDS[0]);

  append(projects[4], event('user.message', {}, '2026-08-01T10:01:00.000Z'));
  await integration.scan();
  assert.equal(integration.slots[0].sessionId, IDS[4]);
  assert.deepEqual(integration.slots.slice(1).map((slot) => slot.sessionId), IDS.slice(1, 4));
});

test('restart replay reconstructs outstanding input for a bound session', async (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const cwd = path.join(files.directory, 'project');
  fs.mkdirSync(cwd);
  const eventsPath = createSession(files.root, IDS[0], cwd);
  const first = new VSCodeIntegration({ ...files, scanIntervalMs: 60_000 });
  await first.start();
  append(eventsPath, event('user.message'), event('assistant.turn_start', { turnId: 'turn-1' }));
  await first.scan();
  first.stop();

  append(eventsPath, event('permission.requested', { requestId: 'permission-1' }));
  const observed = [];
  const second = new VSCodeIntegration({
    ...files,
    scanIntervalMs: 60_000,
    onSlot: (slot) => observed.push(slot.state),
  });
  await second.start();
  t.after(() => second.stop());
  assert.equal(second.slots[0].state, 'input');
  assert.ok(observed.includes('input'));

  append(
    eventsPath,
    event('permission.completed', { requestId: 'permission-1' }),
    event('hook.end', { hookType: 'sessionEnd' })
  );
  await second.scan();
  assert.equal(second.slots[0].state, 'done');
});

test('native restart reconstructs blocked and newly resolved journals', async (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const cwd = path.join(files.directory, 'Native project');
  fs.mkdirSync(cwd);
  const { eventsPath, journalPath } = createNativeSession(files.nativeRoot, IDS[0], cwd);
  const first = new VSCodeIntegration({ ...files, scanIntervalMs: 60_000 });
  await first.start();
  append(eventsPath, event('user.message'), event('assistant.turn_start', { turnId: 'native-turn' }));
  append(journalPath, {
    kind: 2,
    k: ['requests'],
    v: [
      {
        requestId: 'native-request',
        response: [{ kind: 'questionCarousel', resolveId: 'questions' }],
        modelState: { value: 4 },
      },
    ],
  });
  await first.scan();
  assert.equal(first.slots[0].state, 'input');
  first.stop();

  const second = new VSCodeIntegration({ ...files, scanIntervalMs: 60_000 });
  await second.start();
  assert.equal(second.slots[0].state, 'input');
  second.stop();

  append(
    journalPath,
    { kind: 1, k: ['requests', 1, 'response', 0, 'isUsed'], v: true },
    {
      kind: 1,
      k: ['requests', 1, 'modelState'],
      v: { value: 1, completedAt: 1785616803000 },
    }
  );
  const third = new VSCodeIntegration({ ...files, scanIntervalMs: 60_000 });
  await third.start();
  t.after(() => third.stop());
  assert.equal(third.slots[0].state, 'done');
  assert.equal(third.sessions.get(IDS[0]).run.blockers.size, 0);
});

test('restart preserves an acknowledged completed session as idle', async (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const cwd = path.join(files.directory, 'project');
  fs.mkdirSync(cwd);
  const eventsPath = createSession(files.root, IDS[0], cwd);
  const first = new VSCodeIntegration({
    ...files,
    scanIntervalMs: 60_000,
    launch: async () => {},
  });
  await first.start();
  append(eventsPath, event('user.message'), event('hook.end', { hookType: 'sessionEnd' }));
  await first.scan();
  await first.open(0);
  assert.equal(first.slots[0].state, 'idle');
  first.stop();

  const second = new VSCodeIntegration({ ...files, scanIntervalMs: 60_000 });
  await second.start();
  t.after(() => second.stop());
  assert.equal(second.slots[0].state, 'idle');
});

test('restart clears a completed session when no new events arrived', async (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const cwd = path.join(files.directory, 'project');
  fs.mkdirSync(cwd);
  const eventsPath = createSession(files.root, IDS[0], cwd);
  const first = new VSCodeIntegration({ ...files, scanIntervalMs: 60_000 });
  await first.start();
  append(eventsPath, event('user.message'), event('hook.end', { hookType: 'sessionEnd' }));
  await first.scan();
  assert.equal(first.slots[0].state, 'done');
  first.stop();

  const second = new VSCodeIntegration({ ...files, scanIntervalMs: 60_000 });
  await second.start();
  t.after(() => second.stop());
  assert.equal(second.slots[0].state, 'idle');
});

test('restart releases a binding whose event stream disappeared', async (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const cwd = path.join(files.directory, 'project');
  fs.mkdirSync(cwd);
  const eventsPath = createSession(files.root, IDS[0], cwd);
  const first = new VSCodeIntegration({ ...files, scanIntervalMs: 60_000 });
  await first.start();
  append(eventsPath, event('user.message'));
  await first.scan();
  first.stop();
  fs.rmSync(path.dirname(eventsPath), { recursive: true });

  const observed = [];
  const second = new VSCodeIntegration({
    ...files,
    scanIntervalMs: 60_000,
    onSlot: (slot) => observed.push(slot),
  });
  await second.start();
  t.after(() => second.stop());
  assert.equal(second.slots[0], null);
  assert.deepEqual(observed.map(({ slot, state }) => ({ slot, state })), [{ slot: 0, state: 'idle' }]);
});

test('restart releases a native binding no longer active in VS Code', async (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const cwd = path.join(files.directory, 'native-project');
  fs.mkdirSync(cwd);
  const { eventsPath } = createNativeSession(files.nativeRoot, IDS[0], cwd);
  const first = new VSCodeIntegration({ ...files, scanIntervalMs: 60_000 });
  await first.start();
  append(eventsPath, event('user.message'), event('assistant.turn_start', { turnId: 'turn-1' }));
  await first.scan();
  first.stop();

  const observed = [];
  const second = new VSCodeIntegration({
    ...files,
    scanIntervalMs: 60_000,
    nativeSessionActive: () => false,
    onSlot: (slot) => observed.push(slot),
  });
  await second.start();
  t.after(() => second.stop());
  assert.equal(second.slots[0], null);
  assert.deepEqual(observed.map(({ slot, state }) => ({ slot, state })), [{ slot: 0, state: 'idle' }]);
});

test('restart preserves the exact native session resource', async (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const cwd = path.join(files.directory, 'native-project');
  fs.mkdirSync(cwd);
  const { eventsPath } = createNativeSession(files.nativeRoot, IDS[0], cwd);
  const first = new VSCodeIntegration({ ...files, scanIntervalMs: 60_000 });
  await first.start();
  append(eventsPath, event('user.message'), event('hook.end', { hookType: 'sessionEnd' }));
  await first.scan();
  first.stop();

  const launched = [];
  const second = new VSCodeIntegration({
    ...files,
    scanIntervalMs: 60_000,
    launch: async (url) => launched.push(url),
  });
  await second.start();
  t.after(() => second.stop());
  await second.open(0);
  assert.equal(new URL(launched[0]).searchParams.get('session'), nativeSessionResource(IDS[0]));
});

test('keeps an incomplete JSONL record for the next scan', async (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const cwd = path.join(files.directory, 'project');
  fs.mkdirSync(cwd);
  const eventsPath = createSession(files.root, IDS[0], cwd);
  const integration = new VSCodeIntegration({ ...files, scanIntervalMs: 60_000 });
  await integration.start();
  t.after(() => integration.stop());

  fs.appendFileSync(eventsPath, '{"type":"user.message","data":{}');
  await integration.scan();
  assert.equal(integration.slots[0], null);
  fs.appendFileSync(eventsPath, '}\n');
  await integration.scan();
  assert.equal(integration.slots[0].sessionId, IDS[0]);
});

test('opening acknowledges a completed session without forgetting it', async (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const cwd = path.join(files.directory, 'Prøject space');
  fs.mkdirSync(cwd);
  const eventsPath = createSession(files.root, IDS[0], cwd);
  const launched = [];
  const integration = new VSCodeIntegration({
    ...files,
    scanIntervalMs: 60_000,
    launch: async (url) => launched.push(url),
  });
  await integration.start();
  t.after(() => integration.stop());
  append(eventsPath, event('user.message'), event('hook.end', { hookType: 'sessionEnd' }));
  await integration.scan();

  await integration.open(0);
  assert.equal(integration.slots[0].sessionId, IDS[0]);
  assert.equal(integration.sessions.get(IDS[0]).boundSlot, 0);
  assert.equal(integration.publicSlots()[0].state, 'idle');
  assert.match(launched[0], /Pr%C3%B8ject%20space/);

  await integration.open(0);
  assert.equal(launched.length, 2);
  assert.equal(integration.slots[0].sessionId, IDS[0]);
  assert.equal(integration.publicSlots()[0].state, 'idle');

  fs.rmSync(cwd, { recursive: true });
  await assert.rejects(integration.open(0), /project path does not exist/);
  assert.equal(integration.publicSlots()[0].state, 'error');
});

test('recovers when the session-state root appears after startup', async (t) => {
  const files = fixture();
  fs.rmSync(files.root, { recursive: true });
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const integration = new VSCodeIntegration({ ...files, scanIntervalMs: 20 });
  await integration.start();
  t.after(() => integration.stop());
  assert.equal(integration.doctor().ready, false);

  fs.mkdirSync(files.root);
  const cwd = path.join(files.directory, 'project');
  fs.mkdirSync(cwd);
  const eventsPath = createSession(files.root, IDS[0], cwd);
  append(eventsPath, event('user.message'));
  const deadline = Date.now() + 1000;
  while (!integration.slots[0] && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(integration.slots[0].sessionId, IDS[0]);
  assert.equal(integration.doctor().ready, true);
});

test('stop during the initial scan does not start the polling timer', async (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const integration = new VSCodeIntegration({ ...files, scanIntervalMs: 60_000 });
  let finishScan;
  integration.scan = () => new Promise((resolve) => (finishScan = resolve));

  const starting = integration.start();
  while (!finishScan) await new Promise((resolve) => setImmediate(resolve));
  integration.stop();
  finishScan();
  await starting;

  assert.equal(integration.started, false);
  assert.equal(integration.timer, null);
});

test('an obsolete initial scan cannot replace a restarted polling timer', async (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const integration = new VSCodeIntegration({ ...files, scanIntervalMs: 60_000 });
  const finishScans = [];
  integration.scan = () => new Promise((resolve) => finishScans.push(resolve));

  const firstStart = integration.start();
  while (finishScans.length < 1) await new Promise((resolve) => setImmediate(resolve));
  integration.stop();
  const secondStart = integration.start();
  while (finishScans.length < 2) await new Promise((resolve) => setImmediate(resolve));
  finishScans[1]();
  await secondStart;
  const restartedTimer = integration.timer;

  finishScans[0]();
  await firstStart;
  assert.equal(integration.timer, restartedTimer);
  integration.stop();
});

test('resets an unbound offset when the event file was replaced while stopped', async (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const cwd = path.join(files.directory, 'project');
  fs.mkdirSync(cwd);
  const eventsPath = createSession(files.root, IDS[0], cwd);
  const first = new VSCodeIntegration({ ...files, scanIntervalMs: 60_000 });
  await first.start();
  first.stop();

  fs.rmSync(eventsPath);
  fs.writeFileSync(
    eventsPath,
    [
      JSON.stringify({
        type: 'session.start',
        data: { producer: 'copilot-agent', version: 1, copilotVersion: '1.0.73' },
      }),
      JSON.stringify({
        type: 'hook.start',
        data: { hookType: 'userPromptSubmitted' },
      }),
      JSON.stringify({
        type: 'hook.end',
        data: { hookType: 'sessionEnd' },
      }),
      JSON.stringify(event('user.message')),
      `${' '.repeat(500)}\n`,
    ].join('\n')
  );
  const second = new VSCodeIntegration({ ...files, scanIntervalMs: 60_000 });
  await second.start();
  t.after(() => second.stop());
  assert.equal(second.slots[0].sessionId, IDS[0]);
});

test('marks a missing bound event stream as error after retries', async (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const cwd = path.join(files.directory, 'project');
  fs.mkdirSync(cwd);
  const eventsPath = createSession(files.root, IDS[0], cwd);
  const integration = new VSCodeIntegration({ ...files, scanIntervalMs: 60_000 });
  await integration.start();
  t.after(() => integration.stop());
  append(eventsPath, event('user.message'));
  await integration.scan();
  fs.rmSync(path.dirname(eventsPath), { recursive: true });
  await integration.scan();
  await integration.scan();
  await integration.scan();
  assert.equal(integration.slots[0].state, 'error');
  assert.equal(integration.slots[0].runError, 'event-stream-missing');
});

test('retains the last state and logs a sanitized transient read diagnostic', async (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const cwd = path.join(files.directory, 'Native project');
  fs.mkdirSync(cwd);
  const { eventsPath, journalPath } = createNativeSession(files.nativeRoot, IDS[0], cwd);
  const logs = [];
  const integration = new VSCodeIntegration({
    ...files,
    scanIntervalMs: 60_000,
    log: (...values) => logs.push(values.join(' ')),
  });
  await integration.start();
  t.after(() => integration.stop());
  append(
    eventsPath,
    event('user.message'),
    event('assistant.turn_start', { turnId: 'native-turn' })
  );
  append(journalPath, {
    kind: 2,
    k: ['requests'],
    v: [
      {
        requestId: 'native-request',
        response: [{ kind: 'questionCarousel', resolveId: 'questions' }],
        modelState: { value: 4 },
      },
    ],
  });
  await integration.scan();
  assert.equal(integration.slots[0].state, 'input');

  append(eventsPath, event('request.completed'));
  const readJournalAppended = integration.readJournalAppended;
  integration.readJournalAppended = async () => {
    const error = new Error('read failed for /private/secret/session.jsonl');
    error.code = 'EIO';
    throw error;
  };
  try {
    await integration.scan();
  } finally {
    integration.readJournalAppended = readJournalAppended;
  }

  assert.equal(integration.slots[0].state, 'input');
  const diagnostic = logs.find((line) => line.startsWith('VS Code stream read failed'));
  assert.match(diagnostic, new RegExp(`session=${IDS[0]} source=native code=EIO`));
  assert.doesNotMatch(diagnostic, /private|secret|session\.jsonl/);
});

test('does not acknowledge a slot that was rebound while opening', async (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const projects = IDS.map((id, index) => {
    const cwd = path.join(files.directory, `project-${index}`);
    fs.mkdirSync(cwd);
    return createSession(files.root, id, cwd);
  });
  let finishLaunch;
  const integration = new VSCodeIntegration({
    ...files,
    scanIntervalMs: 60_000,
    launch: () => new Promise((resolve) => (finishLaunch = resolve)),
  });
  await integration.start();
  t.after(() => integration.stop());
  for (let index = 0; index < 4; index++) {
    append(projects[index], event('user.message'), event('hook.end', { hookType: 'sessionEnd' }));
    await integration.scan();
  }

  const opening = integration.open(0);
  append(projects[4], event('user.message'));
  await integration.scan();
  assert.equal(integration.slots[0].sessionId, IDS[4]);
  finishLaunch();
  await opening;
  assert.equal(integration.slots[0].state, 'running');
});
