'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const SESSION_ID = '10000000-0000-4000-8000-000000000000';

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
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
}

test('daemon restart replays a permission wait and subsequent completion', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentkeys-daemon-'));
  const copilotHome = path.join(directory, 'copilot');
  const sessionDirectory = path.join(copilotHome, 'session-state', SESSION_ID);
  const cwd = path.join(directory, 'project');
  const statePath = path.join(directory, 'state.json');
  const eventsPath = path.join(sessionDirectory, 'events.jsonl');
  fs.mkdirSync(sessionDirectory, { recursive: true });
  fs.mkdirSync(cwd);
  fs.writeFileSync(
    path.join(sessionDirectory, 'workspace.yaml'),
    `id: ${SESSION_ID}\ncwd: ${cwd}\nclient_name: vscode-agent-host\n`
  );
  fs.writeFileSync(
    eventsPath,
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
  const port = await freePort();
  let child;
  let output = '';

  const start = () => {
    child = spawn(process.execPath, ['src/daemon.js'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        AGENTKEYS_NO_DEVICE: '1',
        AGENTKEYS_PORT: String(port),
        AGENTKEYS_VSCODE_STATE: statePath,
        COPILOT_HOME: copilotHome,
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
    fs.rmSync(directory, { recursive: true, force: true });
  });

  start();
  await waitFor(slots);
  fs.appendFileSync(
    eventsPath,
    [
      JSON.stringify({ type: 'user.message', data: {}, timestamp: '2026-08-01T10:00:00.000Z' }),
      JSON.stringify({
        type: 'assistant.turn_start',
        data: { turnId: 'turn-1' },
        timestamp: '2026-08-01T10:00:01.000Z',
      }),
      '',
    ].join('\n')
  );
  await waitFor(async () => (await slots())[0].state === 'running');
  await stop(child);

  fs.appendFileSync(
    eventsPath,
    JSON.stringify({
      type: 'permission.requested',
      data: { requestId: 'permission-1' },
      timestamp: '2026-08-01T10:00:02.000Z',
    }) + '\n'
  );
  start();
  await waitFor(async () => (await slots())[0].state === 'input');

  fs.appendFileSync(
    eventsPath,
    [
      JSON.stringify({
        type: 'permission.completed',
        data: { requestId: 'permission-1' },
        timestamp: '2026-08-01T10:00:03.000Z',
      }),
      JSON.stringify({
        type: 'hook.end',
        data: { hookType: 'sessionEnd' },
        timestamp: '2026-08-01T10:00:04.000Z',
      }),
      '',
    ].join('\n')
  );
  await waitFor(async () => (await slots())[0].state === 'done');
  assert.equal(output.includes('uncaught:'), false, output);
});
