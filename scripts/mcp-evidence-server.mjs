import http from 'node:http';
import readline from 'node:readline';

const PROTOCOL_VERSIONS = new Set(['2025-11-25', '2025-06-18', '2025-03-26']);
const pendingElicitations = new Map();
let clientElicitationCapabilities = null;
let protocolVersion = '2025-06-18';
let nextRequestId = 1;
let localhost;

async function localhostUrl() {
  if (process.env.AGENTKEYS_ELICITATION_EVIDENCE_URL) {
    const configured = new URL(process.env.AGENTKEYS_ELICITATION_EVIDENCE_URL);
    if (configured.protocol !== 'http:' || configured.hostname !== '127.0.0.1') {
      throw new Error('Evidence URL must use loopback HTTP');
    }
    return configured.href;
  }
  localhost ??= http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('AgentKeys elicitation evidence page.');
  });
  if (!localhost.listening) {
    await new Promise((resolve, reject) => {
      localhost.once('error', reject);
      localhost.listen(0, '127.0.0.1', resolve);
    });
  }
  const address = localhost.address();
  return `http://127.0.0.1:${address.port}/evidence`;
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value });
}

function error(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function tools() {
  const available = [
    {
      name: 'agentkeys_elicitation_form',
      description: 'Request one harmless fixed-choice value for evidence capture.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'agentkeys_elicitation_url',
      description: 'Request opening an inert localhost page for evidence capture.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ];
  return protocolVersion === '2025-11-25' && clientElicitationCapabilities?.url
    ? available
    : available.slice(0, 1);
}

async function elicitationParams(toolName) {
  if (toolName === 'agentkeys_elicitation_form') {
    return {
      message: 'Choose the harmless evidence value.',
      requestedSchema: {
        type: 'object',
        properties: {
          answer: {
            type: 'string',
            title: 'Evidence value',
            enum: ['continue'],
            enumNames: ['Continue'],
          },
        },
        required: ['answer'],
      },
    };
  }
  if (toolName === 'agentkeys_elicitation_url') {
    return {
      message: 'Open the inert localhost evidence page.',
      mode: 'url',
      elicitationId: `url-${nextRequestId}`,
      url: await localhostUrl(),
    };
  }
  return null;
}

async function handleRequest(message) {
  if (message.method === 'initialize') {
    const requestedVersion = message.params?.protocolVersion;
    protocolVersion = PROTOCOL_VERSIONS.has(requestedVersion)
      ? requestedVersion
      : '2025-06-18';
    clientElicitationCapabilities = message.params?.capabilities?.elicitation ?? null;
    result(message.id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'agentkeys-elicitation-evidence', version: '0.1.0' },
    });
    return;
  }
  if (message.method === 'ping') {
    result(message.id, {});
    return;
  }
  if (message.method === 'tools/list') {
    result(message.id, { tools: tools() });
    return;
  }
  if (message.method === 'tools/call') {
    if (!clientElicitationCapabilities) {
      error(message.id, -32600, 'Client does not support elicitation');
      return;
    }
    if (
      message.params?.name === 'agentkeys_elicitation_url' &&
      (protocolVersion !== '2025-11-25' || !clientElicitationCapabilities.url)
    ) {
      error(message.id, -32602, 'Client does not support URL elicitation');
      return;
    }
    const params = await elicitationParams(message.params?.name);
    if (!params) {
      error(message.id, -32602, 'Unknown evidence tool');
      return;
    }
    const elicitationId = `elicitation-${nextRequestId++}`;
    pendingElicitations.set(elicitationId, message.id);
    send({ jsonrpc: '2.0', id: elicitationId, method: 'elicitation/create', params });
    return;
  }
  error(message.id, -32601, 'Method not found');
}

function handleResponse(message) {
  const toolCallId = pendingElicitations.get(message.id);
  if (toolCallId === undefined) return;
  pendingElicitations.delete(message.id);
  const action = ['accept', 'decline', 'cancel'].includes(message.result?.action)
    ? message.result.action
    : 'cancel';
  result(toolCallId, {
    content: [{ type: 'text', text: `Elicitation ${action}.` }],
  });
}

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof message.method === 'string' && message.id !== undefined) {
    void handleRequest(message).catch(() => error(message.id, -32603, 'Internal error'));
  } else if (message.id !== undefined) {
    handleResponse(message);
  }
});
lines.on('close', () => localhost?.close());