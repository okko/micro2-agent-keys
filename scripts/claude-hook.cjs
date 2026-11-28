const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 1024 * 1024) throw new Error('Hook input exceeds 1 MiB');
  }
  const event = JSON.parse(input);
  // Forward identity and lifecycle only, never prompts, tool inputs, or transcripts.
  const body = JSON.stringify(Object.fromEntries([
    'session_id', 'cwd', 'hook_event_name', 'notification_type', 'tool_name', 'tool_use_id',
    'prompt_id', 'agent_id', 'elicitation_id', 'mcp_server_name',
  ].filter((key) => event[key] !== undefined).map((key) => [key, event[key]])));
  const endpoint = JSON.parse(fs.readFileSync(path.join(__dirname, 'claude-hooks-endpoint.json'), 'utf8'));
  if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 ||
      !/^[a-f0-9]{64}$/.test(endpoint.token)) throw new Error('Invalid Agent Keys endpoint');
  await new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port: endpoint.port, path: '/event', method: 'POST',
      headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
      timeout: 2000,
    }, (response) => {
      response.resume();
      response.on('end', () => response.statusCode === 204 ? resolve() :
        reject(new Error(`Receiver returned ${response.statusCode}`)));
    });
    request.on('timeout', () => request.destroy(new Error('Receiver timed out')));
    request.on('error', reject);
    request.end(body);
  });
}

// Exit 1 reports a non-blocking hook error; never emit a Claude permission decision.
main().catch((error) => { console.error(`Agent Keys: ${error.message}`); process.exitCode = 1; });
