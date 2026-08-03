import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';

async function runHook(event) {
  let resolvePayload;
  const payload = new Promise((resolve) => {
    resolvePayload = resolve;
  });
  const server = http.createServer((request, response) => {
    let input = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => (input += chunk));
    request.on('end', () => {
      response.end();
      resolvePayload(JSON.parse(input));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  assert.equal(typeof address, 'object');
  const child = spawn(process.execPath, ['dist/vscode-hook.js'], {
    env: { ...process.env, AGENTKEYS_PORT: String(address.port) },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stdin.end(JSON.stringify(event));

  const [[exitCode], forwarded] = await Promise.all([once(child, 'exit'), payload]);
  server.close();
  await once(server, 'close');
  assert.equal(exitCode, 0);
  assert.equal(output, '{"continue":true}\n');
  return forwarded;
}

test('terminal confirmation hooks correlate without forwarding commands', async () => {
  const command = 'printf private-command';
  const base = {
    session_id: '00000000-0000-4000-8000-000000000000',
    tool_name: 'vscode_get_terminal_confirmation',
    tool_input: { command, sandboxBypass: true },
  };
  const requested = await runHook({ ...base, hook_event_name: 'PermissionRequest' });
  const denied = await runHook({ ...base, hook_event_name: 'PermissionDenied', tool_use_id: 'ignored' });
  const requestId = `terminal-confirmation:${createHash('sha256').update(command).digest('hex')}`;

  assert.deepEqual(requested, {
    hookEventName: 'PermissionRequest',
    sessionId: base.session_id,
    toolName: base.tool_name,
    requestId,
  });
  assert.deepEqual(denied, {
    hookEventName: 'PermissionDenied',
    sessionId: base.session_id,
    toolName: base.tool_name,
    requestId,
  });
  assert.equal(JSON.stringify(requested).includes(command), false);
});

test('generic completion clears permission without forwarding tool input', async () => {
  const event = {
    session_id: '00000000-0000-4000-8000-000000000000',
    tool_name: 'read_file',
    hook_event_name: 'PostToolUse',
    tool_input: { filePath: '/private/external-file' },
    tool_use_id: 'call_external_read',
  };
  const forwarded = await runHook(event);

  assert.deepEqual(forwarded, {
    hookEventName: 'PostToolUse',
    sessionId: event.session_id,
    toolName: event.tool_name,
    toolUseId: event.tool_use_id,
  });
  assert.equal(JSON.stringify(forwarded).includes('/private/external-file'), false);

  const denied = await runHook({ ...event, hook_event_name: 'PermissionDenied' });
  assert.equal(denied.hookEventName, 'PermissionDenied');
});
