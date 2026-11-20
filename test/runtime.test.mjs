import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentKeysRuntime } from '../dist/runtime.js';
import { readConfig } from '../dist/config.js';
import { STATES } from '../dist/states.js';

const ID = '00000000-0000-4000-8000-000000000001';
const active = (id = 'turn') => ({ turns: [], activeTurn: { id, responseParts: [] } });

async function waitFor(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('runtime did not reach expected state');
}

function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentkeys-runtime-'));
  const sources = [];
  const devices = [];
  const opened = [];
  let removed = 0;
  const options = {
    directory, registryPath: directory, uriScheme: 'vscode-insiders', retryMs: 10,
    log() {},
    credentials: { async load() { return null; }, async save() {}, async remove() { removed++; } },
    launch: async (url) => { opened.push(url); },
    createSource: () => {
      const source = {
        start(handler) { this.handler = handler; }, stop() { this.stopped = true; }, setSessions() {},
        emit: (state) => source.handler(ID, state, {
          id: ID, cwd: directory, resource: `agent-host-copilotcli:/${ID}`, chatResource: `ahp-chat:/${ID}`,
        }),
      };
      sources.push(source);
      return source;
    },
    createDevice: async (options) => {
      const device = {
        options, connected: true, writes: [], refreshed: 0,
        async setLighting(slots) { this.writes.push(slots); },
        refreshLighting() { this.refreshed++; },
        async close() { this.connected = false; },
      };
      devices.push(device);
      return device;
    },
    ...overrides,
  };
  const runtime = new AgentKeysRuntime(options);
  t.after(async () => { await runtime.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { runtime, options, directory, sources, devices, opened, removed: () => removed };
}

test('configure, live states, key opening and reset replace the CLI and persist across ownership changes', async (t) => {
  const f = fixture(t);
  await f.runtime.start();
  assert.equal(f.runtime.snapshot().keyCount, null);
  assert.equal(f.devices.length, 0, 'unconfigured extension must not request Input authorization');
  await f.runtime.execute({ type: 'configure', keyCount: 2 });
  await waitFor(() => f.runtime.snapshot().connected);
  assert.deepEqual(readConfig(path.join(f.directory, 'config.json')), { keyCount: 2 });
  await f.sources[0].emit(active());
  assert.equal(f.runtime.snapshot().slots[0].state, 'running');
  assert.equal(f.devices[0].writes.at(-1)[0].color, STATES.running.color);
  await f.sources[0].emit({ turns: [{ id: 'turn', state: 'complete', responseParts: [] }] });
  f.devices[0].options.onKey(0);
  await waitFor(() => f.runtime.snapshot().slots[0].state === 'idle');
  assert.equal(new URL(f.opened[0]).protocol, 'vscode-insiders:');
  await f.sources[0].emit(active('next'));
  await f.runtime.execute({ type: 'reset' });
  assert.ok(f.runtime.snapshot().slots.every((slot) => slot.state === 'idle' && !slot.sessionId));
  await f.sources[0].emit(active('next'));
  assert.equal(f.runtime.snapshot().slots[0].sessionId, undefined);
  await f.runtime.stop();
  const restored = new AgentKeysRuntime(f.options);
  t.after(() => restored.stop());
  await restored.start();
  await f.sources.at(-1).emit(active('next'));
  assert.equal(restored.snapshot().slots[0].sessionId, undefined);
  await f.sources.at(-1).emit(active('third'));
  assert.equal(restored.snapshot().slots[0].sessionId, ID);
  await restored.stop();
});

test('changing key count clears disabled lights and rejects disabled key commands', async (t) => {
  const f = fixture(t);
  await f.runtime.start();
  await f.runtime.execute({ type: 'configure', keyCount: 6 });
  await waitFor(() => f.runtime.snapshot().connected);
  const original = f.devices[0];
  await f.runtime.execute({ type: 'configure', keyCount: 1 });
  await waitFor(() => f.devices.length === 2);
  assert.equal(original.connected, false);
  const cleared = original.writes.findLast((slots) => slots.length === 6);
  assert.ok(cleared.slice(1).every((slot) => slot.color === STATES.idle.color));
  assert.equal(f.runtime.snapshot().slots.length, 1);
  await assert.rejects(f.runtime.execute({ type: 'open', slot: 1 }), /not activated/);
  await assert.rejects(f.runtime.execute({ type: 'configure', keyCount: 21 }), /keyCount/);
  assert.equal(f.runtime.snapshot().keyCount, 1);
});

test('Input failures reconnect and repaint; restart preserves bindings and forget clears authorization', async (t) => {
  const f = fixture(t);
  await f.runtime.start();
  await f.runtime.execute({ type: 'configure', keyCount: 1 });
  await waitFor(() => f.runtime.snapshot().connected);
  await f.sources[0].emit(active());
  f.devices[0].options.onFailure(new Error('Input disconnected'));
  await waitFor(() => f.devices.length === 2 && f.runtime.snapshot().connected);
  assert.equal(f.devices[1].writes.at(-1)[0].color, STATES.running.color);
  await f.runtime.execute({ type: 'restart' });
  assert.equal(f.sources[0].stopped, true);
  assert.equal(f.runtime.snapshot().slots[0].sessionId, ID);
  assert.equal(f.runtime.snapshot().slots[0].state, 'error');
  await f.sources.at(-1).emit(active());
  assert.equal(f.runtime.snapshot().slots[0].state, 'running');
  await f.runtime.execute({ type: 'forgetAuthorization' });
  assert.equal(f.removed(), 1);
  await f.runtime.stop();
  assert.ok(f.devices.every((device) => !device.connected));
});

test('shutdown cancels an Input connection in progress without terminating the extension host', async (t) => {
  let aborted = false;
  const f = fixture(t, {
    createDevice: ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
    }),
  });
  await f.runtime.start();
  await f.runtime.execute({ type: 'configure', keyCount: 1 });
  await f.runtime.stop();
  assert.equal(aborted, true);
  assert.equal(f.runtime.snapshot().connecting, false);
  await assert.rejects(f.runtime.execute({ type: 'reset' }), /stopping/);
});
