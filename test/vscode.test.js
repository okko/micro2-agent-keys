'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  VSCodeIntegration,
  buildSessionUrl,
  emptyRun,
  reduceEvent,
  workspaceMetadata,
} = require('../src/vscode');

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
  fs.mkdirSync(root);
  return {
    directory,
    root,
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
  run.tools.set('a', 'ask_user');
  assert.equal(reduceEvent(run, event('tool.execution_complete', { toolCallId: 'a' })).state, 'running');
  assert.equal(reduceEvent(run, event('turn.error')).state, 'error');
  run.error = 'turn.error';
  assert.equal(reduceEvent(run, event('hook.end', { hookType: 'sessionEnd' })).state, 'error');
});

test('builds an encoded exact-session URL', () => {
  const url = buildSessionUrl('/tmp/Prøject space', IDS[0]);
  assert.match(url, /^vscode:\/\/file\/tmp\/Pr%C3%B8ject%20space\?/);
  assert.equal(new URL(url).searchParams.get('session'), `agent-host-copilotcli:/${IDS[0]}`);
});

test('prompt-gates allocation, fills free slots, then reuses oldest done slot', async (t) => {
  const files = fixture();
  t.after(() => fs.rmSync(files.directory, { recursive: true, force: true }));
  const projects = IDS.map((id, index) => {
    const cwd = path.join(files.directory, `project-${index}`);
    fs.mkdirSync(cwd);
    return createSession(files.root, id, cwd);
  });
  append(projects[0], event('user.message'));

  const integration = new VSCodeIntegration({ ...files, scanIntervalMs: 60_000 });
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

test('opening acknowledges done and missing projects fail visibly', async (t) => {
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
  assert.equal(integration.slots[0].state, 'idle');
  assert.match(launched[0], /Pr%C3%B8ject%20space/);

  fs.rmSync(cwd, { recursive: true });
  await assert.rejects(integration.open(0), /project path does not exist/);
  assert.equal(integration.slots[0].state, 'error');
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
