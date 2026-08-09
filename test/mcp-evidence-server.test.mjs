import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('serves a spec-shaped form elicitation over newline-delimited stdio', async (t) => {
  const child = spawn(process.execPath, ['scripts/dev/mcp-evidence-server.mjs'], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(async () => {
    child.stdin.end();
    await once(child, 'exit');
  });
  const lines = readline.createInterface({ input: child.stdout });
  const messages = [];
  const waiters = [];
  lines.on('line', (line) => {
    const message = JSON.parse(line);
    messages.push(message);
    waiters.splice(0).forEach((resolve) => resolve());
  });
  const next = async (predicate) => {
    while (true) {
      const found = messages.find(predicate);
      if (found) return found;
      await Promise.race([
        new Promise((resolve) => waiters.push(resolve)),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`Timed out waiting for MCP message: ${JSON.stringify(messages)}`)), 2_000).unref();
        }),
      ]);
    }
  };
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: { elicitation: {} },
      clientInfo: { name: 'test', version: '1' },
    },
  });
  const initialized = await next(({ id }) => id === 1);
  assert.equal(initialized.result.protocolVersion, '2025-06-18');
  assert.deepEqual(initialized.result.capabilities, { tools: {} });

  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const listed = await next(({ id }) => id === 2);
  assert.deepEqual(
    listed.result.tools.map(({ name }) => name),
    ['agentkeys_elicitation_form']
  );

  send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'agentkeys_elicitation_form', arguments: {} },
  });
  const elicitation = await next(({ method }) => method === 'elicitation/create');
  assert.equal(elicitation.params.requestedSchema.type, 'object');
  assert.deepEqual(elicitation.params.requestedSchema.required, ['answer']);
  send({ jsonrpc: '2.0', id: elicitation.id, result: { action: 'decline' } });

  const completed = await next(({ id }) => id === 3);
  assert.deepEqual(completed.result, {
    content: [{ type: 'text', text: 'Elicitation decline.' }],
  });
});

test('serves URL elicitation only when the 2025-11-25 capability is negotiated', async (t) => {
  const child = spawn(process.execPath, ['scripts/dev/mcp-evidence-server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      AGENTKEYS_ELICITATION_EVIDENCE_URL: 'http://127.0.0.1:1/evidence',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(async () => {
    child.stdin.end();
    await once(child, 'exit');
  });
  const lines = readline.createInterface({ input: child.stdout });
  const messages = [];
  const waiters = [];
  lines.on('line', (line) => {
    messages.push(JSON.parse(line));
    waiters.splice(0).forEach((resolve) => resolve());
  });
  const next = async (predicate) => {
    while (true) {
      const found = messages.find(predicate);
      if (found) return found;
      await Promise.race([
        new Promise((resolve) => waiters.push(resolve)),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`Timed out waiting for MCP message: ${JSON.stringify(messages)}`)), 2_000).unref();
        }),
      ]);
    }
  };
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: { elicitation: { form: {}, url: {} } },
      clientInfo: { name: 'test', version: '1' },
    },
  });
  const initialized = await next(({ id }) => id === 1);
  assert.equal(initialized.result.protocolVersion, '2025-11-25');

  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const listed = await next(({ id }) => id === 2);
  assert.deepEqual(
    listed.result.tools.map(({ name }) => name),
    ['agentkeys_elicitation_form', 'agentkeys_elicitation_url']
  );

  send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'agentkeys_elicitation_url', arguments: {} },
  });
  const elicitation = await next(({ method }) => method === 'elicitation/create');
  assert.equal(elicitation.params.mode, 'url');
  assert.match(elicitation.params.elicitationId, /^url-\d+$/);
  assert.match(elicitation.params.url, /^http:\/\/127\.0\.0\.1:\d+\/evidence$/);
  send({ jsonrpc: '2.0', id: elicitation.id, result: { action: 'cancel' } });

  const completed = await next(({ id }) => id === 3);
  assert.deepEqual(completed.result, {
    content: [{ type: 'text', text: 'Elicitation cancel.' }],
  });
});