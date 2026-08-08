import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import {
  LocalAgentHostStateSource,
  agentHostChatResource,
  readLocalAgentHostEndpoints,
} from '../dist/agent-host.js';

const SESSION_ID = '00000000-0000-4000-8000-000000000000';

async function waitFor(predicate, message) {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function endpoint(overrides = {}) {
  return {
    type: 'editor',
    schemaVersion: 1,
    pid: process.pid,
    instanceId: 'test-instance',
    endpointPath: path.join(os.tmpdir(), 'agentkeys-unused.sock'),
    connectionToken: 'test-token',
    protocolVersion: '0.7.0',
    ...overrides,
  };
}

test('reads live legacy and per-instance Agent Host endpoint metadata', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentkeys-agent-host-registry-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const entries = path.join(directory, 'entries');
  fs.mkdirSync(entries);
  fs.writeFileSync(path.join(directory, 'metadata.json'), JSON.stringify([
    endpoint({ instanceId: 'legacy' }),
    endpoint({ instanceId: 'dead', pid: 999_999_999 }),
    { schemaVersion: 1, type: 'editor', pid: process.pid },
  ]));
  fs.writeFileSync(path.join(entries, 'current.json'), JSON.stringify({
    type: 'editor',
    schemaVersion: 2,
    pid: process.pid,
    instanceId: 'current',
    endpoint: { type: 'socket', path: path.join(os.tmpdir(), 'agentkeys-current.sock') },
    connectionToken: 'current-token',
    protocolVersion: '0.7.0',
  }));

  assert.deepEqual(
    readLocalAgentHostEndpoints(directory).map(({ instanceId }) => instanceId).sort(),
    ['current', 'legacy']
  );
});

test('builds the default AHP chat channel from the backend session URI', () => {
  assert.equal(
    agentHostChatResource(SESSION_ID),
    `ahp-chat://default/${Buffer.from(`copilotcli:/${SESSION_ID}`).toString('base64url')}`
  );
});

test('subscribes to live Agent Host chat state and refreshes after actions', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentkeys-agent-host-source-'));
  const socketPath = path.join(os.tmpdir(), `agentkeys-ahp-${process.pid}-${Date.now()}.sock`);
  const token = 'source-test-token';
  const server = http.createServer();
  const webSockets = new WebSocketServer({ noServer: true });
  const requests = [];
  let subscribeCount = 0;
  const states = [];

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.searchParams.get('tkn') !== token) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      webSockets.emit('connection', webSocket, request);
    });
  });
  webSockets.on('connection', (webSocket) => {
    webSocket.on('message', (data) => {
      const request = JSON.parse(data.toString());
      requests.push(request);
      if (request.method === 'initialize') {
        webSocket.send(JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: { protocolVersion: '0.7.0', serverSeq: 0, snapshots: [] },
        }));
      } else if (request.method === 'subscribe') {
        subscribeCount++;
        const state = subscribeCount === 1
          ? { activeTurn: { id: 'turn-1', responseParts: [] }, turns: [] }
          : {
              activeTurn: {
                id: 'turn-1',
                responseParts: [
                  { kind: 'inputRequest', request: { id: 'question-1', purpose: 'askUser' } },
                ],
              },
              turns: [],
            };
        webSocket.send(JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            snapshot: { resource: request.params.channel, state, fromSeq: subscribeCount },
          },
        }));
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  fs.writeFileSync(path.join(directory, 'metadata.json'), JSON.stringify([
    endpoint({ endpointPath: socketPath, connectionToken: token }),
  ]));

  const source = new LocalAgentHostStateSource({
    registryPath: directory,
    retryMs: 20,
    requestTimeoutMs: 1_000,
  });
  source.start((sessionId, state) => states.push({ sessionId, state }));
  source.setSessions([SESSION_ID]);

  await waitFor(() => states.length === 1, 'initial Agent Host snapshot was not delivered');
  const initialize = requests.find((request) => request.method === 'initialize');
  assert.deepEqual(initialize.params, {
    channel: 'ahp-root://',
    protocolVersions: ['0.7.0'],
    clientId: initialize.params.clientId,
    clientInfo: { name: 'AgentKeys', version: '0.1.0' },
    initialSubscriptions: [],
  });
  assert.equal(requests.find((request) => request.method === 'subscribe').params.channel, agentHostChatResource(SESSION_ID));
  assert.equal(states[0].sessionId, SESSION_ID);
  assert.equal(states[0].state.activeTurn.id, 'turn-1');

  for (const client of webSockets.clients) {
    client.send(JSON.stringify({
      jsonrpc: '2.0',
      method: 'action',
      params: {
        channel: agentHostChatResource(SESSION_ID),
        serverSeq: 1,
        action: { type: 'chat/inputRequested' },
      },
    }));
  }
  await waitFor(() => states.length === 2, 'Agent Host action did not trigger a fresh snapshot');
  assert.equal(subscribeCount, 2);
  assert.equal(states[1].state.activeTurn.responseParts[0].request.id, 'question-1');

  for (const client of webSockets.clients) client.terminate();
  await waitFor(
    () => requests.filter((request) => request.method === 'initialize').length === 2 && states.length === 3,
    'Agent Host transport closure did not produce a fresh snapshot after reconnect'
  );
  assert.equal(subscribeCount, 3);

  source.setSessions([]);
  await waitFor(
    () => requests.some((request) => request.method === 'unsubscribe'),
    'removing a bound session did not unsubscribe its chat channel'
  );
  assert.equal(
    requests.find((request) => request.method === 'unsubscribe').params.channel,
    agentHostChatResource(SESSION_ID)
  );

  source.stop();
  await new Promise((resolve) => webSockets.close(resolve));
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(directory, { recursive: true, force: true });
  fs.rmSync(socketPath, { force: true });

  t.after(() => {
    source.stop();
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(socketPath, { force: true });
  });
});
