import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import { Coordinator } from '../dist/coordinator.js';

async function waitFor(check) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('coordinator did not reach expected state');
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentkeys-coordinator-'));
  const coordinators = [];
  const runtimes = [];
  const states = [];
  let live = 0;
  let maxLive = 0;
  const create = (port = 0) => {
    const index = coordinators.length;
    const coordinator = new Coordinator({
      directory, port, retryMs: 20, log() {},
      onChange(state) { states[index] = state; },
      createRuntime() {
        const runtime = {
          count: 2, commands: [], stopped: false,
          async start() { live++; maxLive = Math.max(maxLive, live); },
          async stop() { if (!this.stopped) live--; this.stopped = true; },
          snapshot() {
            return {
              keyCount: this.count, connected: true, connecting: false, inputError: null,
              registryPath: directory, availableSessions: 0, trackedSessions: 0, logs: [],
              slots: Array.from({ length: this.count }, (_, slot) => ({ slot, state: 'idle' })),
            };
          },
          async execute(command) {
            this.commands.push(command);
            if (command.type === 'configure') this.count = command.keyCount;
            if (command.type === 'open') throw new Error('test opening failed');
          },
        };
        runtimes.push(runtime);
        return runtime;
      },
    });
    coordinators.push(coordinator);
    coordinator.start();
    return coordinator;
  };
  t.after(async () => {
    for (const coordinator of coordinators) await coordinator.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { create, states, runtimes, directory, maxLive: () => maxLive };
}

test('windows share one runtime, forward commands and errors, and transfer ownership on close', async (t) => {
  const f = fixture(t);
  const owner = f.create();
  await waitFor(() => f.states[0]?.role === 'owner');
  const follower = f.create(owner.port);
  await waitFor(() => f.states[1]?.role === 'follower');
  assert.equal(f.runtimes.length, 1);
  assert.equal(f.states[1].snapshot.slots.length, 2);
  await follower.execute({ type: 'configure', keyCount: 6 });
  await waitFor(() => f.states[1].snapshot.keyCount === 6);
  await assert.rejects(follower.execute({ type: 'open', slot: 0 }), /test opening failed/);
  await follower.execute({ type: 'reset' });
  assert.equal(f.runtimes[0].commands.at(-1).type, 'reset');
  await owner.stop();
  await waitFor(() => f.states[1].role === 'owner');
  assert.equal(f.runtimes.length, 2);
  assert.equal(f.maxLive(), 1, 'Input must never have two extension owners');
});

test('coordination rejects unauthenticated clients and does not expose a public HTTP API', async (t) => {
  const f = fixture(t);
  const owner = f.create();
  await waitFor(() => f.states[0]?.role === 'owner');
  assert.equal(fs.statSync(path.join(f.directory, 'coordinator-token')).mode & 0o777, 0o600);
  assert.equal((await fetch(`http://127.0.0.1:${owner.port}/state`)).status, 404);
  const client = new WebSocket(`ws://127.0.0.1:${owner.port}/eu.okko.agentkeys/v1`);
  const error = await new Promise((resolve) => client.once('error', resolve));
  assert.match(error.message, /403/);
  client.terminate();
  assert.equal(f.runtimes[0].commands.length, 0);
});
