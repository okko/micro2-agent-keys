import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  VSCodeIntegration,
  buildSessionUrl,
  emptyRun,
  nativeSessionResource,
  reduceEvent,
  workspaceMetadata,
} from '../dist/vscode.js';

const IDS = [
  '00000000-0000-4000-8000-000000000000',
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000004',
];

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
          requests: [{ result: { timings: {} }, modelState: { completedAt: 1785616800000 } }],
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

function event(type, data = {}, timestamp = '2026-08-01T10:00:00.000Z') {
  return { type, data, timestamp };
}

test('parses quoted workspace metadata', () => {
  assert.deepEqual(
    workspaceMetadata('id: abc\ncwd: "/tmp/project space"\nclient_name: vscode-agent-host\n'),
    { id: 'abc', cwd: '/tmp/project space', clientName: 'vscode-agent-host' }
  );
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

  const pending = {
    kind: 2,
    k: ['requests', 1, 'response'],
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
  assert.equal(integration.slots[0].state, 'input');

  const externalPending = {
    kind: 2,
    k: ['requests', 2, 'response'],
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

test('builds an encoded exact-session URL', () => {
  const url = buildSessionUrl('/tmp/Prøject space', IDS[0]);
  assert.match(url, /^vscode:\/\/file\/tmp\/Pr%C3%B8ject%20space\?/);
  assert.equal(new URL(url).searchParams.get('session'), `agent-host-copilotcli:/${IDS[0]}`);
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
  assert.equal(integration.slots[0].state, 'input');
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
  assert.equal(integration.slots[0].state, 'input');
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
  assert.equal(integration.slots[0].state, 'input');
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
