import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import test, { after } from 'node:test';

async function freePort() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  probe.close();
  await once(probe, 'close');
  return port;
}

// hostAllowed compares against the port captured at import, so bind that exact port.
process.env.AGENTKEYS_PORT = String(await freePort());
const { createServer, HOST, PORT } = await import('../dist/daemon-http.js');

const STAMP = '2026-08-09T00:00:00.000Z';

function slot(index, state, label = null) {
  return { index, state, label, updatedAt: STAMP };
}

function fakeApi({ vscode, ...overrides } = {}) {
  const calls = [];
  return {
    calls,
    buildId: 'test-build',
    log: (...args) => calls.push(['log', ...args]),
    status: () => ({ connected: true, deviceVisible: true, deviceError: null }),
    slots: () => [slot(0, 'running', 'one'), slot(1, 'idle')],
    setSlot: async (index, state, label) => {
      calls.push(['setSlot', index, state, label]);
      return slot(index, state, label);
    },
    reset: async () => {
      calls.push(['reset']);
      return [slot(0, 'idle'), slot(1, 'idle')];
    },
    ...overrides,
    vscode: {
      publicSlots: () => [{ slot: 0, state: 'running' }],
      resetSlots: async () => {
        calls.push(['resetSlots']);
        return [{ slot: 0, state: 'idle' }];
      },
      doctor: () => ({ ok: true }),
      applyHook: async (body) => {
        calls.push(['applyHook', body]);
        return true;
      },
      open: async (index) => {
        calls.push(['open', index]);
        return { slot: { slot: index }, url: `vscode://window/${index}` };
      },
      ...vscode,
    },
  };
}

let api = fakeApi();

// One server for the whole file: the port is fixed, and reopening it strands undici's pooled
// sockets, so the api is swapped behind a stable delegate instead.
const server = createServer({
  get buildId() {
    return api.buildId;
  },
  get vscode() {
    return api.vscode;
  },
  log: (...args) => api.log(...args),
  status: () => api.status(),
  slots: () => api.slots(),
  setSlot: (...args) => api.setSlot(...args),
  reset: () => api.reset(),
});
server.listen(PORT, HOST);
await once(server, 'listening');
const base = `http://${HOST}:${PORT}`;

after(async () => {
  server.closeAllConnections();
  server.close();
  await once(server, 'close');
});

async function post(path, body) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
  });
}

test('GET /build and /state report the api view', async () => {
  api = fakeApi();

  assert.deepEqual(await (await fetch(`${base}/build`)).json(), { buildId: 'test-build' });
  assert.deepEqual(await (await fetch(`${base}/state`)).json(), {
    connected: true,
    deviceVisible: true,
    deviceError: null,
    slots: [slot(0, 'running', 'one'), slot(1, 'idle')],
  });
});

test('POST /slots/:index normalizes the state alias and truncates the label', async () => {
  api = fakeApi();

  const response = await post('/slots/19', { state: ' BUSY ', label: 'x'.repeat(80) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, slot: slot(19, 'running', 'x'.repeat(64)) });
  assert.deepEqual(api.calls, [['setSlot', 19, 'running', 'x'.repeat(64)]]);
});

test('POST /slots/:index drops a non-string label', async () => {
  api = fakeApi();

  await post('/slots/0', { state: 'done', label: { evil: true } });
  assert.deepEqual(api.calls, [['setSlot', 0, 'done', null]]);
});

test('POST /slots/:index rejects a bad index, state or body without touching the api', async () => {
  api = fakeApi();

  const outOfRange = await post('/slots/20', { state: 'idle' });
  assert.equal(outOfRange.status, 400);
  assert.deepEqual(await outOfRange.json(), { error: 'slot must be 0..19' });

  const unknownState = await post('/slots/0', { state: 'sideways' });
  assert.equal(unknownState.status, 400);
  assert.deepEqual(await unknownState.json(), {
    error: 'unknown state, expected one of idle, running, done, input, error',
  });

  const malformed = await post('/slots/0', '{oops');
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: 'invalid JSON' });

  assert.deepEqual(api.calls, []);
});

test('POST /reset returns the slots the api recorded', async () => {
  api = fakeApi();

  const response = await post('/reset');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, slots: [slot(0, 'idle'), slot(1, 'idle')] });
  assert.deepEqual(api.calls, [['reset']]);
});

test('VS Code routes delegate to the integration', async () => {
  api = fakeApi();

  assert.deepEqual(await (await fetch(`${base}/integrations/vscode/slots`)).json(), {
    slots: [{ slot: 0, state: 'running' }],
  });
  assert.deepEqual(await (await fetch(`${base}/integrations/vscode/doctor`)).json(), { ok: true });

  const hook = await post('/integrations/vscode/hooks', { kind: 'stop' });
  assert.equal(hook.status, 202);
  assert.deepEqual(await hook.json(), { ok: true, handled: true });

  const reset = await post('/integrations/vscode/slots/reset');
  assert.equal(reset.status, 200);
  assert.deepEqual(await reset.json(), { ok: true, slots: [{ slot: 0, state: 'idle' }] });

  const opened = await post('/integrations/vscode/slots/1/open');
  assert.equal(opened.status, 200);
  assert.deepEqual(await opened.json(), { ok: true, slot: { slot: 1 }, url: 'vscode://window/1' });

  assert.deepEqual(api.calls, [
    ['applyHook', { kind: 'stop' }],
    ['resetSlots'],
    ['open', 1],
  ]);
});

test('a failed VS Code open answers 409 and an out-of-range slot answers 400', async () => {
  api = fakeApi({
    vscode: {
      open: async (index) => {
        throw new Error(`slot ${index} is unbound`);
      },
    },
  });

  const conflict = await post('/integrations/vscode/slots/0/open');
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: 'slot 0 is unbound' });

  const lastSlot = await post('/integrations/vscode/slots/19/open');
  assert.equal(lastSlot.status, 409);
  assert.deepEqual(await lastSlot.json(), { error: 'slot 19 is unbound' });

  const outOfRange = await post('/integrations/vscode/slots/20/open');
  assert.equal(outOfRange.status, 400);
  assert.deepEqual(await outOfRange.json(), { error: 'VS Code slot must be 0..19' });
});

test('an unknown route answers 404', async () => {
  api = fakeApi();

  const response = await fetch(`${base}/nope`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'not found' });
});

test('a foreign Host header is rejected before any routing', async () => {
  api = fakeApi();

  const request = http.request({
    host: HOST,
    port: PORT,
    path: '/reset',
    method: 'POST',
    headers: { host: 'attacker.example' },
  });
  request.end();
  const [response] = await once(request, 'response');
  let payload = '';
  response.setEncoding('utf8');
  response.on('data', (chunk) => (payload += chunk));
  await once(response, 'end');

  assert.equal(response.statusCode, 403);
  assert.deepEqual(JSON.parse(payload), { error: 'forbidden host' });
  assert.deepEqual(api.calls, []);
});

test('an api failure answers 500 and logs once', async () => {
  api = fakeApi({
    reset: async () => {
      throw new Error('device write failed');
    },
  });

  const response = await post('/reset');
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'internal error' });
  assert.deepEqual(api.calls, [['log', 'request failed:', 'device write failed']]);
});
