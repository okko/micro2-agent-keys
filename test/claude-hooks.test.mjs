import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { ClaudeHooksReceiver, parseClaudeHook } from '../dist/claude-hooks.js';
import { VSCodeIntegration } from '../dist/vscode.js';

const ID = '00000000-0000-4000-8000-000000000001';
const hook = (name, cwd, extra = {}) => ({ session_id: ID, cwd, hook_event_name: name, ...extra });

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentkeys-claude-'));
  const targets = [];
  const opened = [];
  const options = {
    statePath: path.join(directory, 'sessions.json'), enabledSlots: [0, 1],
    agentHostSource: { start() {}, stop() {}, setSessions(ids) { targets.push(ids); } },
    launch: async (url) => { opened.push(url); },
  };
  const integration = new VSCodeIntegration(options);
  await integration.start();
  t.after(() => { integration.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, integration, options, targets, opened };
}

test('Claude lifecycle shares slots with AHP, tracks input and terminal states, and retires sessions', async (t) => {
  const { directory, integration: i, targets, opened } = await fixture(t);
  const emit = (name, extra) => i.applyClaudeHook(hook(name, directory, extra));
  await i.applyAgentHostChatState(ID, { turns: [], activeTurn: { id: 'ahp-turn', responseParts: [] } }, {
    id: ID, cwd: directory, resource: `agent-host-copilotcli:/${ID}`, chatResource: `ahp-chat:/${ID}`,
  });
  await emit('SessionStart');
  assert.equal(i.slots[1], null);
  await emit('UserPromptSubmit');
  assert.equal(i.slots[1].state, 'running');
  assert.equal(i.slots[1].observation, 'claude-hooks');
  assert.equal(i.slots[1].sessionId, `claude:${ID}`);
  assert.ok(targets.every((ids) => ids.every((id) => !id.startsWith('claude:'))));
  await emit('PermissionRequest', { tool_name: 'Bash' });
  assert.equal(i.slots[1].state, 'input', 'permission requests must signal immediately without a notification');
  await emit('PostToolUse');
  assert.equal(i.slots[1].state, 'running');
  await emit('PermissionRequest', { tool_name: 'Bash' });
  await emit('PostToolUseFailure');
  assert.equal(i.slots[1].state, 'running');
  await emit('Notification', { notification_type: 'permission_prompt' });
  assert.equal(i.slots[1].state, 'input');
  await emit('PostToolUse');
  assert.equal(i.slots[1].state, 'running');
  await emit('PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'question-1' });
  await emit('PostToolUse', { tool_use_id: 'unrelated' });
  assert.equal(i.slots[1].state, 'input');
  await emit('PostToolUseFailure', { tool_use_id: 'question-1' });
  assert.equal(i.slots[1].state, 'running');
  await emit('Elicitation');
  assert.equal(i.slots[1].state, 'input');
  await emit('ElicitationResult');
  assert.equal(i.slots[1].state, 'running');
  await emit('Stop');
  assert.equal(i.slots[1].state, 'done');
  await i.open(1);
  assert.equal(i.slots[1].state, 'idle');
  assert.equal(new URL(opened[0]).search, '');
  await emit('Stop');
  assert.equal(i.slots[1].state, 'idle');
  await emit('UserPromptSubmit');
  await emit('StopFailure');
  assert.equal(i.slots[1].state, 'error');
  assert.equal(i.slots[1].runError, 'request.failed');
  await emit('SessionEnd');
  assert.equal(i.slots[1], null);
  assert.equal(i.sessions.has(`claude:${ID}`), false);
  assert.equal(i.slots[0].state, 'running');
});

test('reset suppresses ongoing hooks and restart does not invent a live Claude snapshot', async (t) => {
  const { directory, integration: i, options } = await fixture(t);
  await i.applyClaudeHook(hook('UserPromptSubmit', directory));
  await i.resetSlots();
  await i.applyClaudeHook(hook('PreToolUse', directory));
  assert.equal(i.slots[0], null);
  await i.applyClaudeHook(hook('UserPromptSubmit', directory));
  i.stop();
  const restored = new VSCodeIntegration(options);
  await restored.start();
  t.after(() => restored.stop());
  assert.equal(restored.slots[0].state, 'error');
  assert.equal(restored.slots[0].runError, 'claude-hook-state-unavailable');
  await restored.applyClaudeHook(hook('UserPromptSubmit', directory));
  assert.equal(restored.slots[0].state, 'running');
  restored.stop();
});

test('prompt correlation rejects stale completion, deduplicates reset prompts, and isolates subagents', async (t) => {
  const { directory, integration: i } = await fixture(t);
  const emit = (name, extra = {}) => i.applyClaudeHook(hook(name, directory, { prompt_id: 'p1', ...extra }));
  await emit('UserPromptSubmit');
  await emit('Stop', { agent_id: 'subagent' });
  assert.equal(i.slots[0].state, 'running');
  await emit('Stop', { prompt_id: 'old' });
  assert.equal(i.slots[0].state, 'running');
  await emit('Elicitation', { elicitation_id: 'e1', mcp_server_name: 'server' });
  await emit('Elicitation', { elicitation_id: 'e2', mcp_server_name: 'server' });
  await emit('ElicitationResult', { elicitation_id: 'e1' });
  assert.equal(i.slots[0].state, 'input');
  await emit('PostToolUse', { tool_name: 'mcp__server__tool' });
  assert.equal(i.slots[0].state, 'running');
  await emit('Stop');
  await emit('PreToolUse');
  assert.equal(i.slots[0].state, 'running', 'a Stop hook can continue work');
  await i.resetSlots();
  await emit('UserPromptSubmit');
  assert.equal(i.slots[0], null);
  await emit('UserPromptSubmit', { prompt_id: 'p2' });
  assert.equal(i.slots[0].state, 'running');
});

function runHelper(directory, event) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(directory, 'claude-hook.cjs')]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(event));
  });
}

test('receiver authenticates, validates, redacts helper payloads and cleans up for ownership transfer', async (t) => {
  const { directory } = await fixture(t);
  const events = [];
  const receiver = new ClaudeHooksReceiver(directory, async (event) => { events.push(event); }, () => {});
  const script = path.resolve('scripts/claude-hook.cjs');
  await receiver.start(script);
  t.after(() => receiver.stop());
  const endpointPath = path.join(directory, 'claude-hooks-endpoint.json');
  const endpoint = JSON.parse(fs.readFileSync(endpointPath));
  assert.equal(fs.statSync(endpointPath).mode & 0o777, 0o600);
  const url = `http://127.0.0.1:${endpoint.port}/event`;
  assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 403);
  const headers = { authorization: `Bearer ${endpoint.token}` };
  assert.equal((await fetch(url, { method: 'POST', headers, body: '{}' })).status, 400);
  assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, origin: 'https://example.com' } })).status, 403);
  const result = await runHelper(directory, hook('UserPromptSubmit', directory, { prompt: 'private', tool_input: 'private' }));
  assert.deepEqual(result, { code: 0, stdout: '', stderr: '' });
  assert.equal(events.length, 1);
  assert.equal(events[0].prompt, undefined);
  assert.equal(events[0].tool_input, undefined);
  const settings = JSON.parse(fs.readFileSync(path.join(directory, 'claude-hooks-settings.json')));
  assert.ok(settings.hooks.PermissionRequest[0].hooks[0].command.includes('claude-hook.cjs'));
  assert.equal((await runHelper(directory, hook('PermissionRequest', directory, { tool_name: 'Bash' }))).code, 0);
  assert.equal(events.at(-1).hook_event_name, 'PermissionRequest');
  assert.throws(() => parseClaudeHook(hook('UnsupportedEvent', directory)), /Invalid/);
  assert.throws(() => parseClaudeHook(hook('Stop', 'relative')), /Invalid/);
  await receiver.stop();
  assert.equal(fs.existsSync(endpointPath), false);
  const unavailable = await runHelper(directory, hook('Stop', directory));
  assert.equal(unavailable.code, 1);
  assert.equal(unavailable.stdout, '');
  assert.match(unavailable.stderr, /Agent Keys:/);
  await receiver.start(script);
  const next = JSON.parse(fs.readFileSync(endpointPath));
  assert.notEqual(next.token, endpoint.token);
  assert.equal((await runHelper(directory, hook('Stop', directory))).code, 0);
  await receiver.stop();
});
