'use strict';

const http = require('http');

const PORT = Number(process.env.AGENTKEYS_PORT ?? 8787);
const HOST = '127.0.0.1';
const RESET_HOOK_EVENTS = new Set(['SessionStart', 'SessionEnd']);

function post(payload) {
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
        response.on('end', resolve);
      }
    );
    request.on('timeout', () => request.destroy());
    request.on('error', resolve);
    request.end(body);
  });
}

async function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;

  try {
    const event = JSON.parse(input);
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
    } else if (RESET_HOOK_EVENTS.has(event.hook_event_name)) {
      await post({
        hookEventName: event.hook_event_name,
        sessionId: event.session_id,
        timestamp: event.timestamp,
      });
    }
  } catch {}

  process.stdout.write('{"continue":true}\n');
}

main();