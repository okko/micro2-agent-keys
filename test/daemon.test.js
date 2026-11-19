'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const http = require('node:http');
const { WebSocketServer } = require('ws');

const SESSION_ID = '10000000-0000-4000-8000-000000000000';

function configureKeys(home, keyCount) {
  const configPath = path.join(home, '.local', 'state', 'agentkeys', 'config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ keyCount }));
}

function isolatedVSCodeEnvironment(keyCount = 20) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentkeys-daemon-vscode-'));
  configureKeys(directory, keyCount);
  return {
    directory,
    env: {
      HOME: directory,
      AGENTKEYS_VSCODE_USER_DATA: directory,
      AGENTKEYS_VSCODE_STATE: path.join(directory, 'state.json'),
    },
  };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError ?? new Error('timed out waiting for daemon state');
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
}

for (const keyCount of [1, 6, 20]) {
test(`daemon exposes only the ${keyCount} configured slots`, async (t) => {
  const vscode = isolatedVSCodeEnvironment(keyCount);
  const port = await freePort();
  const child = spawn(process.execPath, ['dist/daemon.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      ...vscode.env,
      AGENTKEYS_NO_DEVICE: '1',
      AGENTKEYS_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    await stop(child);
    fs.rmSync(vscode.directory, { recursive: true, force: true });
  });

  const response = await waitFor(async () => {
    const current = await fetch(`http://127.0.0.1:${port}/build`);
    return current.ok ? current : false;
  });
  const buildId = fs.readFileSync(path.join(__dirname, '..', 'dist', 'build-id'), 'utf8').trim();
  assert.deepEqual(await response.json(), { buildId });

  const stateResponse = await fetch(`http://127.0.0.1:${port}/state`);
  assert.equal(stateResponse.status, 200);
  const state = await stateResponse.json();
  assert.equal(state.connected, false);
  assert.equal(state.deviceVisible, false);
  assert.equal(state.deviceError, null);
  assert.deepEqual(state.slots.map((slot) => slot.index), Array.from({ length: keyCount }, (_, index) => index));

  const setResponse = await fetch(`http://127.0.0.1:${port}/slots/${keyCount - 1}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state: 'running' }),
  });
  assert.equal(setResponse.status, 200);

  const inactive = await fetch(`http://127.0.0.1:${port}/slots/${keyCount}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state: 'running' }),
  });
  assert.equal(inactive.status, 400);

  const bindings = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/integrations/vscode/slots`);
    const body = await response.json();
    return body.slots.length === keyCount ? body.slots : false;
  });
  assert.deepEqual(bindings.map(({ slot }) => slot), state.slots.map(({ index }) => index));
  const vscodeReset = await fetch(`http://127.0.0.1:${port}/integrations/vscode/slots/reset`, { method: 'POST' });
  assert.equal(vscodeReset.status, 200);
  assert.equal((await vscodeReset.json()).slots.length, keyCount);

  const resetResponse = await fetch(`http://127.0.0.1:${port}/reset`, { method: 'POST' });
  assert.equal(resetResponse.status, 200);
  const reset = await resetResponse.json();
  assert.equal(reset.slots.length, keyCount);
  assert.ok(reset.slots.every((slot) => slot.state === 'idle'));
});
}

test('daemon shutdown closes an incomplete HTTP request', async () => {
  const vscode = isolatedVSCodeEnvironment();
  const port = await freePort();
  const child = spawn(process.execPath, ['dist/daemon.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      ...vscode.env,
      AGENTKEYS_NO_DEVICE: '1',
      AGENTKEYS_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let socket;

  try {
    await waitFor(async () => {
      const response = await fetch(`http://127.0.0.1:${port}/state`);
      return response.ok;
    });
    socket = net.createConnection(port, '127.0.0.1');
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.write(
      'POST /slots/0 HTTP/1.1\r\n' +
        `Host: 127.0.0.1:${port}\r\n` +
        'Content-Type: application/json\r\n' +
        'Content-Length: 100\r\n\r\n{}'
    );

    const startedAt = Date.now();
    await stop(child);
    assert.ok(Date.now() - startedAt < 1000, 'daemon shutdown was delayed by an incomplete request');
  } finally {
    socket?.destroy();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    fs.rmSync(vscode.directory, { recursive: true, force: true });
  }
});

test('daemon restart restores AHP subscriptions and authoritative completion', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentkeys-daemon-'));
  configureKeys(directory, 20);
  const cwd = path.join(directory, 'project');
  const statePath = path.join(directory, 'state.json');
  fs.mkdirSync(cwd);
  const socketPath = path.join(os.tmpdir(), `agentkeys-daemon-${process.pid}.sock`);
  const channel = 'ahp-chat:/20000000-0000-4000-8000-000000000000';
  const host = http.createServer();
  const sockets = new WebSocketServer({ server: host });
  const startedAt = '2026-11-17T10:00:00Z';
  let state = { resource: channel, turns: [], activeTurn: { id: 'turn', startedAt, responseParts: [] } };
  sockets.on('connection', (socket) => socket.on('message', (data) => {
    const request = JSON.parse(data.toString());
    let result;
    if (request.method === 'initialize') result = { protocolVersion: '1.0.0', serverSeq: 1, snapshots: [] };
    else if (request.method === 'listSessions') result = { items: [{
      resource: `ahp-session:/${SESSION_ID}`, provider: 'copilotcli', defaultChat: channel,
      workingDirectories: [require('node:url').pathToFileURL(cwd).toString()],
      title: '', status: 8, createdAt: '', modifiedAt: '',
    }] };
    else if (request.method === 'subscribe') result = { snapshot: {
      resource: channel, state, fromSeq: 1,
    } };
    if (result) socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  }));
  await new Promise((resolve) => host.listen(socketPath, resolve));
  const registry = path.join(directory, 'agent-host', 'local-endpoint', 'entries');
  fs.mkdirSync(registry, { recursive: true });
  fs.writeFileSync(path.join(registry, 'host.json'), JSON.stringify({
    type: 'editor', schemaVersion: 2, pid: process.pid, instanceId: 'test',
    protocolVersion: '1.0.0', connectionToken: 'test-token', endpoint: { type: 'socket', path: socketPath },
  }));
  const port = await freePort();
  let child;
  let output = '';

  const start = () => {
    child = spawn(process.execPath, ['dist/daemon.js'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        HOME: directory,
        AGENTKEYS_NO_DEVICE: '1',
        AGENTKEYS_PORT: String(port),
        AGENTKEYS_VSCODE_STATE: statePath,
        AGENTKEYS_VSCODE_USER_DATA: directory,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
  };

  const slots = async () => {
    const response = await fetch(`http://127.0.0.1:${port}/integrations/vscode/slots`);
    assert.equal(response.status, 200);
    return (await response.json()).slots;
  };

  t.after(async () => {
    await stop(child);
    for (const socket of sockets.clients) socket.terminate();
    await new Promise((resolve) => sockets.close(resolve));
    await new Promise((resolve) => host.close(resolve));
    fs.rmSync(socketPath, { force: true });
    fs.rmSync(directory, { recursive: true, force: true });
  });

  start();
  await waitFor(slots);
  await waitFor(async () => (await slots())[0].state === 'running');
  await stop(child);

  state = { ...state, activeTurn: { id: 'turn', startedAt, responseParts: [
    { kind: 'inputRequest', request: { id: 'question', purpose: 'askUser', questions: [] } },
  ] } };
  start();
  await waitFor(async () => (await slots())[0].state === 'input');
  for (const socket of sockets.clients) socket.send(JSON.stringify({
    jsonrpc: '2.0', method: 'action', params: {
      channel, serverSeq: 2, action: { type: 'chat/turnComplete', turnId: 'turn', duration: 100 },
    },
  }));
  await waitFor(async () => (await slots())[0].state === 'done');
  assert.equal(output.includes('uncaught:'), false, output);
});
