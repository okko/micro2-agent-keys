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
    protocolVersion: '0.9.0',
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
    protocolVersion: '0.9.0',
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

async function hostFixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentkeys-agent-host-source-'));
  const socketPath = path.join(os.tmpdir(), `agentkeys-ahp-${process.pid}-${Date.now()}.sock`);
  const token = 'source-test-token';
  const server = http.createServer();
  const webSockets = new WebSocketServer({ noServer: true });
  const requests = [];
  const states = [];
  const unavailable = [];
  const logs = [];
  const channel = agentHostChatResource(SESSION_ID);
  let state = {
    resource: channel, title: '', modifiedAt: '2026-10-14T09:00:00Z', status: 8,
    activeTurn: { id: 'turn-1', responseParts: [] }, turns: [],
  };
  let catalog = options.catalog ?? [];
  let replay = [];
  let seq = 10;

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
          result: { protocolVersion: '0.9.0', serverSeq: seq, snapshots: [] },
        }));
      } else if (request.method === 'reconnect') {
        webSocket.send(JSON.stringify({
          jsonrpc: '2.0', id: request.id,
          result: options.snapshotReconnect
            ? { type: 'snapshot', snapshots: [
                { resource: 'ahp-root://', fromSeq: seq, state: { agents: [] } },
                { resource: channel, fromSeq: seq, state },
              ] }
            : { type: 'replay', actions: replay, missing: [] },
        }));
      } else if (request.method === 'listSessions') {
        const first = !request.params.cursor;
        webSocket.send(JSON.stringify({
          jsonrpc: '2.0', id: request.id,
          result: options.paginated && first
            ? { items: [], nextCursor: 'page-2' } : { items: catalog },
        }));
      } else if (request.method === 'subscribe') {
        if (options.actionDuringSubscribe) {
          webSocket.send(JSON.stringify({
            jsonrpc: '2.0', method: 'action',
            params: { channel, serverSeq: seq + 1, action: questionAction() },
          }));
        }
        webSocket.send(JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            snapshot: { resource: request.params.channel, state: { ...state, resource: request.params.channel }, fromSeq: seq },
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
    log: (...values) => logs.push(values.join(' ')),
  });
  t.after(async () => {
    source.stop();
    for (const client of webSockets.clients) client.terminate();
    await new Promise((resolve) => webSockets.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
    fs.rmSync(socketPath, { force: true });
  });
  source.start(
    (sessionId, state, descriptor) => states.push({ sessionId, state, descriptor }),
    (sessionIds) => unavailable.push(...sessionIds)
  );
  if (!options.discoveryOnly) source.setSessions([SESSION_ID]);
  return {
    source, requests, states, unavailable, logs, channel, webSockets,
    action(action, serverSeq = ++seq) {
      for (const client of webSockets.clients) client.send(JSON.stringify({
        jsonrpc: '2.0', method: 'action', params: { channel, serverSeq, action },
      }));
    },
    setReplay(actions) { replay = actions; },
    setState(value) { state = { ...state, ...value }; },
    setCatalog(value) {
      catalog = value;
      for (const client of webSockets.clients) client.send(JSON.stringify({
        jsonrpc: '2.0', method: 'root/sessionAdded',
        params: { channel: 'ahp-root://', summary: value[0] },
      }));
    },
    summaryChanged(session, changes) {
      for (const client of webSockets.clients) client.send(JSON.stringify({
        jsonrpc: '2.0', method: 'root/sessionSummaryChanged',
        params: { channel: 'ahp-root://', session, changes },
      }));
    },
  };
}

function questionAction() {
  return {
    type: 'chat/inputRequested',
    request: { id: 'question-1', purpose: 'askUser', questions: [] },
  };
}

test('subscribes once and applies ordered actions using the shared chat reducer', async (t) => {
  const host = await hostFixture(t);
  const { requests, states, source, channel } = host;
  await waitFor(() => states.length === 1, 'initial snapshot was not delivered');
  const initialize = requests.find((request) => request.method === 'initialize');
  assert.deepEqual(initialize.params, {
    channel: 'ahp-root://',
    protocolVersions: ['0.9.0', '1.0.0'],
    clientId: initialize.params.clientId,
    initialSubscriptions: ['ahp-root://'],
  });
  assert.equal(requests.find((request) => request.method === 'subscribe').params.channel, channel);
  assert.equal(states[0].sessionId, SESSION_ID);
  assert.equal(states[0].state.activeTurn.id, 'turn-1');

  host.action(questionAction());
  host.action(questionAction(), 10);
  host.action(questionAction(), 11);
  await waitFor(() => states.length === 2, 'action was not reduced');
  assert.equal(requests.filter((request) => request.method === 'subscribe').length, 1);
  assert.equal(states[1].state.activeTurn.responseParts[0].request.id, 'question-1');
  assert.equal(states[1].state.status, 24);
  host.action({ type: 'chat/inputCompleted', requestId: 'question-1', response: 'cancel' });
  await waitFor(() => states.length === 3, 'input completion was not reduced');
  assert.equal(states[2].state.status, 8);

  source.setSessions([]);
  await waitFor(
    () => requests.some((request) => request.method === 'unsubscribe'),
    'removing a bound session did not unsubscribe its chat channel'
  );
  assert.equal(
    requests.find((request) => request.method === 'unsubscribe').params.channel,
    channel
  );
});

test('buffers actions arriving before the subscription snapshot response', async (t) => {
  const host = await hostFixture(t, { actionDuringSubscribe: true });
  await waitFor(() => host.states.length === 2, 'buffered action was lost');
  assert.equal(host.states[0].state.status, 8);
  assert.equal(host.states[1].state.status, 24);
});

test('reconnects with the same client identity and replays missed actions', async (t) => {
  const host = await hostFixture(t);
  await waitFor(() => host.states.length === 1, 'initial snapshot missing');
  host.setReplay([{ channel: host.channel, serverSeq: 11, action: questionAction() }]);
  for (const client of host.webSockets.clients) client.terminate();
  await waitFor(() => host.states.length === 2, 'reconnect replay missing');
  assert.ok(host.unavailable.includes(SESSION_ID));
  assert.equal(host.states[1].state.status, 24);
  const reconnect = host.requests.find((request) => request.method === 'reconnect');
  assert.equal(reconnect.params.clientId, host.requests[0].params.clientId);
  assert.equal(reconnect.params.lastSeenServerSeq, 10);
  assert.deepEqual(reconnect.params.subscriptions, ['ahp-root://', host.channel]);
  assert.equal(host.requests.filter((request) => request.method === 'subscribe').length, 1);
});

test('accepts authoritative reconnect snapshots when replay is unavailable', async (t) => {
  const host = await hostFixture(t, { snapshotReconnect: true });
  await waitFor(() => host.states.length === 1, 'initial snapshot missing');
  host.setState({ status: 24, activeTurn: {
    id: 'turn-1', responseParts: [{ kind: 'inputRequest', request: questionAction().request }],
  } });
  for (const client of host.webSockets.clients) client.terminate();
  await waitFor(() => host.states.length === 2, 'reconnect snapshot missing');
  assert.equal(host.states[1].state.status, 24);
});

test('discovers catalog sessions without filesystem targets and follows root notifications', async (t) => {
  const host = await hostFixture(t, { discoveryOnly: true, paginated: true });
  await waitFor(() => host.requests.some((request) => request.params.cursor === 'page-2'), 'catalog pagination missing');
  host.setCatalog([{
    resource: `copilotcli:/${SESSION_ID}`, provider: 'copilotcli',
    workingDirectories: ['file:///tmp/agentkeys-project'], defaultChat: host.channel,
    title: '', status: 8, createdAt: '', modifiedAt: '',
  }]);
  await waitFor(() => host.states.length === 1, 'catalog session was not subscribed');
  assert.deepEqual(host.states[0].descriptor, {
    id: SESSION_ID, cwd: '/tmp/agentkeys-project',
    resource: `agent-host-copilotcli:/${SESSION_ID}`, chatResource: host.channel,
  });
  assert.equal(host.requests.filter((request) => request.method === 'listSessions').length, 2);
});

test('idle catalog entries subscribe only when activity starts and advertised chat URIs are used', async (t) => {
  const resource = `ahp-session:/${SESSION_ID}`;
  const catalog = [{
    resource, provider: 'claude', workingDirectories: ['file:///tmp/agentkeys-project'],
    defaultChat: 'ahp-chat:/advertised-chat', title: '', status: 1, createdAt: '', modifiedAt: '',
  }];
  const host = await hostFixture(t, { discoveryOnly: true, catalog });
  await waitFor(() => host.requests.some((request) => request.method === 'listSessions'), 'catalog request missing');
  assert.equal(host.requests.filter((request) => request.method === 'subscribe').length, 0);
  host.summaryChanged(resource, { status: 8 });
  await waitFor(() => host.states.length === 1, 'active catalog entry missing');
  assert.equal(host.requests.find((request) => request.method === 'subscribe').params.channel, 'ahp-chat:/advertised-chat');
  assert.equal(host.states[0].descriptor.resource, `agent-host-claude:/${SESSION_ID}`);
  host.summaryChanged(resource, { workingDirectories: ['file:///tmp/new-project'] });
  await waitFor(() => host.states.length === 2, 'working-directory update missing');
  assert.equal(host.states[1].descriptor.cwd, '/tmp/new-project');
  assert.equal(host.requests.filter((request) => request.method === 'listSessions').length, 1);
});

test('unknown chat actions fail closed without logging payloads or endpoint credentials', async (t) => {
  const host = await hostFixture(t);
  await waitFor(() => host.states.length === 1, 'initial snapshot missing');
  host.action({ type: 'chat/futureState', secret: 'private-input' });
  await waitFor(() => host.unavailable.includes(SESSION_ID), 'unknown action did not invalidate state');
  assert.ok(host.logs.some((line) => line.includes('state failed')));
  assert.ok(host.logs.every((line) => !line.includes('private-input') && !line.includes('source-test-token')));
});
