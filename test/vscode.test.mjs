import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { VSCodeIntegration } from '../dist/vscode.js';
import { buildSessionUrl } from '../dist/session-url.js';

const IDS = Array.from({ length: 21 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);

class FakeAgentHostStateSource {
  sessions = [];
  start(handler, unavailable) { this.handler = handler; this.unavailable = unavailable; }
  setSessions(ids) { this.sessions = [...ids]; }
  stop() { this.stopped = true; }
  async emit(id, state, descriptor) { await this.handler(id, state, descriptor); }
}

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentkeys-vscode-'));
  const source = new FakeAgentHostStateSource();
  const observed = [];
  const launched = [];
  const logs = [];
  const config = {
    statePath: path.join(directory, 'state.json'), agentHostSource: source,
    onSlot: async (slot) => observed.push(slot), launch: async (url) => launched.push(url),
    log: (...args) => logs.push(args.join(' ')), ...options,
  };
  const integration = new VSCodeIntegration(config);
  t.after(() => { integration.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  const descriptor = (index = 0, resource = `agent-host-copilotcli:/${IDS[index]}`) => ({
    id: IDS[index], cwd: directory, resource, chatResource: `ahp-chat:/${IDS[index + 1]}`,
  });
  return { directory, source, observed, launched, logs, config, integration, descriptor };
}

const active = (id = 'turn', responseParts = []) => ({ turns: [], activeTurn: { id, responseParts } });
const question = { kind: 'inputRequest', request: { id: 'question', purpose: 'askUser' } };
const terminal = (state = 'complete', id = 'turn') => ({ turns: [{ id, state, responseParts: [] }] });

test('AHP alone discovers, tracks and opens the exact advertised host resource', async (t) => {
  const f = fixture(t);
  await f.integration.start();
  const descriptor = f.descriptor();
  await f.source.emit(IDS[0], { turns: [] }, descriptor);
  assert.equal(f.integration.slots[0], null);
  await f.source.emit(IDS[0], active(), descriptor);
  assert.equal(f.integration.slots[0].state, 'running');
  assert.equal(f.observed.at(-1).state, 'running');
  assert.deepEqual(f.source.sessions, [IDS[0]]);
  await f.source.emit(IDS[0], active('turn', [question]), descriptor);
  assert.equal(f.integration.slots[0].state, 'input');
  await f.source.emit(IDS[0], active(), descriptor);
  assert.equal(f.integration.slots[0].state, 'running');
  await f.source.emit(IDS[0], terminal(), descriptor);
  assert.equal(f.integration.slots[0].state, 'done');
  await f.integration.open(0);
  await f.source.emit(IDS[0], terminal(), descriptor);
  assert.equal(f.integration.slots[0].state, 'idle', 'duplicate completion must not undo acknowledgement');
  await f.integration.open(0);
  assert.equal(f.launched.length, 2);
  assert.equal(new URL(f.launched[0]).searchParams.get('session'), descriptor.resource);
  assert.equal(f.integration.status().observation, 'ahp');
  assert.equal(f.integration.status().availableSessions, 1);
});

test('unsupported saved state fails explicitly rather than migrating daemon data', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.config.statePath, JSON.stringify({
    schemaVersion: 1,
    sessions: [
      { ...f.descriptor(), observation: 'ahp', extraMetadata: 'unused' },
      { id: IDS[1], cwd: f.directory, observation: 'unknown' },
    ],
    slots: [
      { slot: 0, sessionId: IDS[0], observation: 'ahp', state: 'done' },
      { slot: 1, sessionId: IDS[1], state: 'input' },
    ],
  }));
  await assert.rejects(f.integration.start(), /unsupported VS Code integration state schema 1/);
});

test('opening preserves advertised provider and chat fragments with encoded project paths', async (t) => {
  const f = fixture(t);
  const resource = `agent-host-claude:/${IDS[0]}#${IDS[2]}`;
  const url = new URL(buildSessionUrl('/tmp/Prøject space', IDS[0], resource));
  assert.equal(url.pathname, '/tmp/Pr%C3%B8ject%20space');
  assert.equal(url.searchParams.get('session'), resource);
  assert.equal(url.hash, '');
  assert.equal(new URL(buildSessionUrl('/tmp', IDS[0], resource, 'vscode-insiders')).protocol, 'vscode-insiders:');
  await f.integration.start();
  await f.source.emit(IDS[0], active(), f.descriptor(0, resource));
  await f.integration.open(0);
  assert.equal(new URL(f.launched[0]).searchParams.get('session'), resource);
  assert.throws(() => buildSessionUrl('relative', IDS[0], resource), /not absolute/);
  assert.throws(() => buildSessionUrl('/tmp', 'bad', resource), /invalid VS Code session id/);
});

test('source loss fails active slots closed, preserves completed slots and recovers from snapshots', async (t) => {
  const f = fixture(t);
  await f.integration.start();
  await f.source.emit(IDS[0], active('turn', [question]), f.descriptor());
  await f.source.unavailable([IDS[0]]);
  assert.equal(f.integration.slots[0].state, 'error');
  assert.equal(f.integration.slots[0].runError, 'agent-host-state-unavailable');
  assert.equal(f.integration.status().availableSessions, 0);
  await f.source.emit(IDS[0], active('turn', [question]), f.descriptor());
  assert.equal(f.integration.slots[0].state, 'input');
  assert.equal(f.integration.slots[0].runError, null);
  await f.source.emit(IDS[0], terminal('cancelled'), f.descriptor());
  await f.source.unavailable([IDS[0]]);
  assert.equal(f.integration.slots[0].state, 'done');
});

test('restart retains slot identities and waits for authoritative AHP state', async (t) => {
  const f = fixture(t);
  await f.integration.start();
  await f.source.emit(IDS[0], active(), f.descriptor());
  f.integration.stop();
  const source = new FakeAgentHostStateSource();
  const restarted = new VSCodeIntegration({ ...f.config, agentHostSource: source });
  t.after(() => restarted.stop());
  await restarted.start();
  assert.equal(restarted.slots[0].state, 'error');
  assert.equal(restarted.slots[0].runError, 'agent-host-state-unavailable');
  assert.deepEqual(source.sessions, [IDS[0]]);
  await source.emit(IDS[0], active('turn', [question]), f.descriptor());
  assert.equal(restarted.slots[0].state, 'input');
  await source.emit(IDS[0], { turns: [] }, f.descriptor());
  assert.equal(restarted.slots[0].state, 'idle');
  restarted.stop();
});

test('reset and error acknowledgement suppress the same run but allow a new request', async (t) => {
  const f = fixture(t);
  await f.integration.start();
  await f.source.emit(IDS[0], terminal(), f.descriptor());
  assert.equal(f.integration.slots[0], null, 'catalog history must not allocate');
  await f.source.emit(IDS[0], active('next'), f.descriptor());
  await f.integration.resetSlots();
  await f.source.emit(IDS[0], active('next'), f.descriptor());
  assert.equal(f.integration.slots[0], null);
  await f.source.emit(IDS[0], active('third'), f.descriptor());
  await f.source.emit(IDS[0], terminal('failed', 'third'), f.descriptor());
  assert.equal(f.integration.slots[0].state, 'error');
  await f.integration.open(0);
  await f.source.emit(IDS[0], terminal('failed', 'third'), f.descriptor());
  assert.equal(f.integration.slots[0], null);
  await f.source.emit(IDS[0], active('fourth'), f.descriptor());
  assert.equal(f.integration.slots[0].state, 'running');
});

test('reset request checkpoints survive extension restarts', async (t) => {
  const f = fixture(t);
  await f.integration.start();
  await f.source.emit(IDS[0], active(), f.descriptor());
  await f.integration.resetSlots();
  f.integration.stop();
  const source = new FakeAgentHostStateSource();
  const restarted = new VSCodeIntegration({ ...f.config, agentHostSource: source });
  t.after(() => restarted.stop());
  await restarted.start();
  await source.emit(IDS[0], active(), f.descriptor());
  assert.equal(restarted.slots[0], null);
  await source.emit(IDS[0], active('next'), f.descriptor());
  assert.equal(restarted.slots[0].state, 'running');
  restarted.stop();
});

test('completed and acknowledged bindings retain their state after restart and terminal replay', async (t) => {
  const f = fixture(t);
  await f.integration.start();
  for (let index = 0; index < 2; index++) {
    await f.source.emit(IDS[index], active(), f.descriptor(index));
    await f.source.emit(IDS[index], terminal(), f.descriptor(index));
  }
  await f.integration.open(0);
  f.integration.stop();
  const source = new FakeAgentHostStateSource();
  const restarted = new VSCodeIntegration({ ...f.config, agentHostSource: source });
  t.after(() => restarted.stop());
  await restarted.start();
  for (let index = 0; index < 2; index++) {
    await source.emit(IDS[index], terminal(), f.descriptor(index));
  }
  assert.equal(restarted.slots[0].state, 'idle');
  assert.equal(restarted.slots[1].state, 'done');
  await source.emit(IDS[0], active('next'), f.descriptor());
  assert.equal(restarted.slots[0].state, 'running');
  restarted.stop();
});

test('missing project paths fail explicitly without launching or releasing a binding', async (t) => {
  const f = fixture(t);
  await f.integration.start();
  await f.source.emit(IDS[0], active(), { ...f.descriptor(), cwd: path.join(f.directory, 'missing') });
  await assert.rejects(f.integration.open(0), /project path does not exist/);
  assert.equal(f.launched.length, 0);
  assert.equal(f.integration.slots[0].runError, 'project-path-missing');
  assert.equal(f.integration.slots[0].sessionId, IDS[0]);
});

test('sparse slots never evict active work and reuse inactive bindings', async (t) => {
  const f = fixture(t, { enabledSlots: [2, 19] });
  await f.integration.start();
  for (let index = 0; index < 3; index++) await f.source.emit(IDS[index], active(), f.descriptor(index));
  assert.equal(f.integration.slots[2].sessionId, IDS[0]);
  assert.equal(f.integration.slots[19].sessionId, IDS[1]);
  assert.equal(f.integration.sessions.get(IDS[2]).boundSlot, null);
  await f.source.emit(IDS[0], terminal(), f.descriptor());
  await f.source.emit(IDS[2], active('next'), f.descriptor(2));
  assert.equal(f.integration.slots[2].sessionId, IDS[2]);
  await f.integration.setEnabledSlots([19]);
  assert.equal(f.integration.slots[2], null);
  assert.deepEqual(f.source.sessions, [IDS[1]]);
  await assert.rejects(f.integration.open(2), /not activated/);
});

test('configured slots limit session allocation and reset lighting', async (t) => {
  const f = fixture(t, { enabledSlots: [0, 1] });
  await f.integration.start();
  for (let index = 0; index < 3; index++) await f.source.emit(IDS[index], active(), f.descriptor(index));
  assert.equal(f.integration.sessions.get(IDS[2]).boundSlot, null);
  f.observed.length = 0;
  await f.integration.resetSlots();
  assert.deepEqual(f.observed.map(({ slot }) => slot), [0, 1]);
  assert.ok(f.observed.every(({ state }) => state === 'idle'));
});

test('unknown waiting states fail closed and remain acknowledged until a new turn', async (t) => {
  const f = fixture(t);
  await f.integration.start();
  const state = active('turn', [{ kind: 'toolCall', toolCall: { toolCallId: 'tool', status: 'future-wait' } }]);
  await f.source.emit(IDS[0], state, f.descriptor());
  assert.equal(f.integration.slots[0].state, 'error');
  assert.equal(f.integration.slots[0].runError, 'incompatible:unknown-agent-host-tool-status');
  assert.match(f.logs.at(-1), /Incompatible AHP execution state/);
  await f.integration.open(0);
  await f.source.emit(IDS[0], state, f.descriptor());
  assert.equal(f.integration.slots[0], null);
});

test('launch failures keep the binding and completion acknowledgement intact', async (t) => {
  const f = fixture(t, { launch: async () => { throw new Error('launch failed'); } });
  await f.integration.start();
  await f.source.emit(IDS[0], active(), f.descriptor());
  await f.source.emit(IDS[0], terminal(), f.descriptor());
  await assert.rejects(f.integration.open(0), /launch failed/);
  assert.equal(f.integration.slots[0].state, 'done');
  assert.equal(f.integration.slots[0].sessionId, IDS[0]);
});

test('stopped integration ignores queued source callbacks', async (t) => {
  const f = fixture(t);
  await f.integration.start();
  f.integration.stop();
  await f.source.emit(IDS[0], active(), f.descriptor());
  assert.equal(f.integration.slots[0], null);
});
