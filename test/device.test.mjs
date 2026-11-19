import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { InputApiError, InputClient } from '@worklouder/input-kit';
import { WebSocketServer } from 'ws';
import { Device } from '../dist/device.js';

const credentials = { applicationId: 'test-app', token: 'test-token' };
const summary = { id: 1, deviceType: 'creator_micro_v2_pro' };
const running = { id: 0, color: 0x0060ff, effect: 4, speed: 0.55 };

class Client extends EventEmitter {
  connected = false;
  devices = [summary];
  writes = [];
  authenticated = [];
  authorizations = 0;
  async connect() { this.connected = true; }
  async close() { this.connected = false; this.emit('disconnected', {}); }
  async authenticate(value) { this.authenticated.push(value); }
  async requestAuthorization() { this.authorizations++; return credentials; }
  async getDevices() { return this.devices; }
  async setKeyLighting(value) { this.writes.push(value); return { applied: true }; }
}

function setup(client = new Client(), saved = credentials) {
  const logs = [];
  const keys = [];
  const failures = [];
  const stored = { value: saved, saves: 0, removals: 0 };
  return {
    client, logs, keys, failures, stored,
    options: {
      client,
      log: (...args) => logs.push(args.join(' ')),
      onKey: (slot) => keys.push(slot),
      onFailure: (error) => failures.push(error),
      credentials: {
        async load() { return stored.value; },
        async save(value) { stored.value = value; stored.saves++; },
        async remove() { stored.value = null; stored.removals++; },
      },
    },
  };
}

async function waitFor(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('timed out waiting for Input events');
}

test('authorizes once, persists credentials, reauthenticates, and replaces revoked credentials', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const state = setup(new Client(), null);
  const first = await Device.open(state.options);
  assert.equal(state.client.authorizations, 1);
  assert.equal(state.stored.saves, 1);
  await first.close();
  assert.deepEqual(state.failures, []);

  const secondClient = new Client();
  const second = await Device.open({ ...state.options, client: secondClient });
  assert.deepEqual(secondClient.authenticated, [credentials]);
  assert.equal(secondClient.authorizations, 0);
  await second.close();

  now += 60_001;
  const revoked = new Client();
  revoked.authenticate = async () => { throw new InputApiError(-32001, 'revoked'); };
  const third = await Device.open({ ...state.options, client: revoked });
  assert.equal(state.stored.removals, 1);
  assert.equal(revoked.authorizations, 1);
  assert.equal(state.stored.saves, 2);
  assert.ok(state.logs.every((line) => !line.includes(credentials.token)));
  await third.close();
});

test('authorization failures close the socket and do not repeatedly prompt', async (t) => {
  const now = Date.now() + 120_001;
  t.mock.method(Date, 'now', () => now);
  const state = setup(new Client(), null);
  state.client.requestAuthorization = async () => {
    state.client.authorizations++;
    throw new InputApiError(-32003, 'authorization denied');
  };
  await assert.rejects(Device.open(state.options), /authorization denied/);
  assert.equal(state.client.connected, false);
  await assert.rejects(Device.open(state.options), /after one minute/);
  assert.equal(state.client.authorizations, 1);
  assert.equal(state.stored.saves, 0);
});

test('only exact vscode00..vscode19 press/click events from the selected device open slots', async () => {
  const state = setup();
  const device = await Device.open(state.options);
  for (const identifier of ['vscode00', 'vscode19', 'vscode20', 'vscode0', 'VSCODE01', 'vscode01extra']) {
    state.client.emit('keyTriggered', { deviceId: 1, identifier, action: 'press' });
  }
  state.client.emit('keyTriggered', { deviceId: 1, identifier: 'vscode02', action: 'click' });
  state.client.emit('keyTriggered', { deviceId: 1, identifier: 'vscode00', action: 'release' });
  state.client.emit('keyTriggered', { deviceId: 2, identifier: 'vscode01', action: 'press' });
  assert.deepEqual(state.keys, [0, 19, 2]);
  await device.close();
});

test('lighting is acknowledged, deduplicated and coalesced to the latest pending state', async () => {
  const state = setup();
  const device = await Device.open(state.options);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  state.client.setKeyLighting = async (value) => {
    state.client.writes.push(value);
    if (state.client.writes.length === 1) await gate;
    return { applied: true };
  };
  const initial = device.setLighting([running]);
  const intermediate = device.setLighting([{ ...running, color: 0xff0000 }]);
  const final = device.setLighting([{ ...running, color: 0x00ff30, effect: 1 }]);
  release();
  await Promise.all([initial, intermediate, final]);
  assert.deepEqual(state.client.writes, [
    { deviceId: 1, identifier: 'vscode00', isRegex: false, color: 0x0060ff, brightness: 1, effect: 4, speed: 0.55 },
    { deviceId: 1, identifier: 'vscode00', isRegex: false, color: 0x00ff30, brightness: 1, effect: 1, speed: 0.55 },
  ]);
  await device.setLighting([{ ...running, color: 0x00ff30, effect: 1 }]);
  assert.equal(state.client.writes.length, 2);
  await device.close();
});

test('shared device rate limits back off and missing mappings are diagnosed without losing other slots', async () => {
  const state = setup();
  const device = await Device.open(state.options);
  let attempts = 0;
  const times = [];
  state.client.setKeyLighting = async (value) => {
    if (value.identifier === 'vscode00') {
      times.push(Date.now());
      if (++attempts < 3) throw new InputApiError(-32017, 'rate limit');
    }
    if (value.identifier === 'vscode18') throw new InputApiError(-32009, 'identifier not found');
    state.client.writes.push(value);
  };
  await device.setLighting([running, { ...running, id: 18 }, { ...running, id: 19 }]);
  assert.equal(attempts, 3);
  assert.ok(times[1] - times[0] >= 240);
  assert.ok(times[2] - times[1] >= 490);
  assert.deepEqual(state.client.writes.map((value) => value.identifier), ['vscode00', 'vscode19']);
  assert.match(state.logs.join('\n'), /vscode18 is not mapped/);
  await device.setLighting([{ ...running, id: 18 }]);
  assert.equal(state.logs.filter((line) => line.includes('not mapped')).length, 1);

  state.client.setKeyLighting = async (value) => { state.client.writes.push(value); };
  device.refreshLighting();
  await device.setLighting([]);
  assert.ok(state.client.writes.some((value) => value.identifier === 'vscode18'));
  state.client.setKeyLighting = async () => { throw new InputApiError(-32007, 'lighting unavailable'); };
  await assert.rejects(device.setLighting([{ ...running, color: 0xffffff }]), /lighting unavailable/);
  await device.close();
});

test('device notifications rediscover runtime IDs and repaint on layer changes', async () => {
  const state = setup();
  state.client.devices = [];
  const device = await Device.open(state.options);
  assert.equal(device.connected, false);
  await device.setLighting([running]);
  assert.equal(state.client.writes.length, 0);
  state.client.emit('devicesUpdated', { devices: [summary] });
  await device.setLighting([]);
  assert.equal(device.connected, true);
  assert.equal(state.client.writes.length, 1);
  state.client.emit('devicesUpdated', { devices: [] });
  assert.equal(device.connected, false);
  state.client.emit('devicesUpdated', { devices: [{ ...summary, id: 42 }] });
  await device.setLighting([]);
  assert.equal(state.client.writes.at(-1).deviceId, 42);
  state.client.emit('deviceInfoChanged', { deviceId: 42 });
  await device.setLighting([]);
  assert.equal(state.client.writes.length, 3);
  state.client.connected = false;
  state.client.emit('disconnected', {});
  assert.equal(device.connected, false);
  assert.match(state.failures[0].message, /Input disconnected/);
  await device.close();
});

test('real InputKit uses WebSocket authentication, notifications and setKeyLighting after reconnect', async (t) => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/input' });
  await new Promise((resolve) => server.once('listening', resolve));
  const requests = [];
  let socket;
  let deviceId = 7;
  server.on('connection', (current) => {
    socket = current;
    current.on('message', (data) => {
      const request = JSON.parse(data.toString());
      requests.push(request);
      const result = request.method === 'authenticate' ? { authenticated: true }
        : request.method === 'getDevices' ? [{ ...summary, id: deviceId }]
          : { applied: true };
      current.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
    });
  });
  t.after(async () => {
    for (const connection of server.clients) connection.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  const state = setup();
  const open = () => Device.open({
    ...state.options,
    client: new InputClient({ applicationName: 'AgentKeys Test', port: server.address().port }),
  });
  const first = await open();
  t.after(() => first.close());
  socket.send(JSON.stringify({
    jsonrpc: '2.0', method: 'keyTriggered',
    params: { deviceId, identifier: 'vscode19', action: 'press' },
  }));
  await waitFor(() => state.keys.length === 1);
  assert.deepEqual(state.keys, [19]);
  await first.setLighting([{ ...running, id: 19 }]);
  assert.equal(requests.at(-1).method, 'setKeyLighting');
  assert.equal(requests.at(-1).params.identifier, 'vscode19');
  assert.equal(requests.at(-1).params.deviceId, 7);
  socket.close();
  await waitFor(() => state.failures.length === 1);
  await first.close();
  deviceId = 8;
  const second = await open();
  t.after(() => second.close());
  await second.setLighting([running]);
  assert.equal(requests.at(-1).params.deviceId, 8);
  assert.equal(requests.filter(({ method }) => method === 'authenticate').length, 2);
  assert.equal(requests.filter(({ method }) => method === 'getDevices').length, 2);
});
