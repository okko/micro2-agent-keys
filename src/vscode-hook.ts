import * as http from 'http';
import { createHash } from 'crypto';

const PORT = Number(process.env.AGENTKEYS_PORT ?? 8787);
const HOST = '127.0.0.1';
const RESET_HOOK_EVENTS = new Set(['SessionStart', 'SessionEnd']);
const TERMINAL_CONFIRMATION_TOOL = 'vscode_get_terminal_confirmation';
const TERMINAL_CONFIRMATION_EVENTS = new Set(['PermissionRequest', 'PostToolUse', 'PermissionDenied']);

interface HookPayload {
  hookEventName?: string;
  sessionId?: string;
  toolName?: string;
  toolUseId?: string;
  requestId?: string;
  timestamp?: string;
}

function post(payload: HookPayload): Promise<void> {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const request = http.request(
      {
        host: HOST,
        port: PORT,
        path: '/integrations/vscode/hooks',
        method: 'POST',
        headers: {
          host: `${HOST}:${PORT}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
        timeout: 500,
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve());
      }
    );
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve());
    request.end(body);
  });
}

interface HookEvent {
  tool_name?: string;
  hook_event_name?: string;
  session_id?: string;
  tool_input?: {
    command?: unknown;
    sandboxBypass?: unknown;
  };
  tool_use_id?: string;
  timestamp?: string;
}

function terminalConfirmationId(event: HookEvent): string | null {
  if (
    event.tool_name !== TERMINAL_CONFIRMATION_TOOL ||
    !TERMINAL_CONFIRMATION_EVENTS.has(event.hook_event_name ?? '') ||
    event.tool_input?.sandboxBypass !== true ||
    typeof event.tool_input.command !== 'string'
  ) return null;
  return `terminal-confirmation:${createHash('sha256').update(event.tool_input.command).digest('hex')}`;
}

async function main(): Promise<void> {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += String(chunk);

  try {
    const event = JSON.parse(input) as HookEvent;
    const requestId = terminalConfirmationId(event);
    if (
      event.tool_name === 'vscode_askQuestions' &&
      (event.hook_event_name === 'PreToolUse' || event.hook_event_name === 'PostToolUse')
    ) {
      await post({
        hookEventName: event.hook_event_name,
        sessionId: event.session_id,
        toolName: event.tool_name,
        toolUseId: event.tool_use_id,
        timestamp: event.timestamp,
      });
    } else if (requestId) {
      await post({
        hookEventName: event.hook_event_name,
        sessionId: event.session_id,
        toolName: event.tool_name,
        requestId,
        timestamp: event.timestamp,
      });
    } else if (
      event.tool_name !== TERMINAL_CONFIRMATION_TOOL &&
      (event.hook_event_name === 'PostToolUse' || event.hook_event_name === 'PermissionDenied') &&
      typeof event.tool_use_id === 'string' &&
      event.tool_use_id
    ) {
      await post({
        hookEventName: event.hook_event_name,
        sessionId: event.session_id,
        toolName: event.tool_name,
        toolUseId: event.tool_use_id,
        timestamp: event.timestamp,
      });
    } else if (event.hook_event_name && RESET_HOOK_EVENTS.has(event.hook_event_name)) {
      await post({
        hookEventName: event.hook_event_name,
        sessionId: event.session_id,
        timestamp: event.timestamp,
      });
    }
  } catch {
    // Malformed or unexpected hook payload; still acknowledge below.
  }

  process.stdout.write('{"continue":true}\n');
}

main();
