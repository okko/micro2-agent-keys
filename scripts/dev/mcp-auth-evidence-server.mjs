import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 38471;
const PROTOCOL_VERSIONS = new Set(['2025-11-25', '2025-06-18', '2025-03-26']);
const READ_SCOPE = 'agentkeys:read';
const WRITE_SCOPE = 'agentkeys:write';

function json(response, status, value, headers = {}) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  });
  response.end(JSON.stringify(value));
}

function text(response, status, value, headers = {}) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'text/html; charset=utf-8',
    ...headers,
  });
  response.end(value);
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function scopes(value) {
  return new Set(String(value ?? '').split(/\s+/).filter(Boolean));
}

function tokenFrom(request) {
  const match = /^Bearer (\S+)$/i.exec(request.headers.authorization ?? '');
  return match?.[1];
}

function pkceChallenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

function mcpResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function oauthError(response, status, error, description) {
  json(response, status, { error, error_description: description });
}

export function createEvidenceServer(options = {}) {
  const clients = new Map();
  const authorizationRequests = new Map();
  const authorizationCodes = new Map();
  const accessTokens = new Map();
  const refreshTokens = new Map();
  let origin = options.origin;

  const resource = () => `${origin}/mcp`;
  const metadataUrl = () => `${origin}/.well-known/oauth-protected-resource`;
  const challenge = (response, status, requiredScope, error) => {
    const fields = [
      `resource_metadata="${metadataUrl()}"`,
      `scope="${requiredScope}"`,
      ...(error ? [`error="${error}"`] : []),
    ];
    json(response, status, { error: error ?? 'unauthorized' }, {
      'www-authenticate': `Bearer ${fields.join(', ')}`,
    });
  };

  const handleMetadata = (_request, response) => {
    json(response, 200, {
      resource: resource(),
      authorization_servers: [origin],
      scopes_supported: [READ_SCOPE, WRITE_SCOPE],
      bearer_methods_supported: ['header'],
    });
  };

  const handleAuthorizationServerMetadata = (_request, response) => {
    json(response, 200, {
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      registration_endpoint: `${origin}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [READ_SCOPE, WRITE_SCOPE],
    });
  };

  const handleRegistration = async (request, response) => {
    let registration;
    try {
      registration = JSON.parse(await body(request));
    } catch {
      oauthError(response, 400, 'invalid_client_metadata', 'Registration must be JSON');
      return;
    }
    const redirectUris = registration.redirect_uris;
    if (
      !Array.isArray(redirectUris) ||
      redirectUris.length === 0 ||
      redirectUris.some((value) => {
        try {
          const redirect = new URL(value);
          return !['127.0.0.1', 'localhost'].includes(redirect.hostname);
        } catch {
          return true;
        }
      })
    ) {
      oauthError(response, 400, 'invalid_redirect_uri', 'Only loopback redirects are allowed');
      return;
    }
    const clientId = `evidence-client-${randomUUID()}`;
    clients.set(clientId, { redirectUris: new Set(redirectUris) });
    json(response, 201, {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  };

  const validateAuthorization = (url) => {
    const clientId = url.searchParams.get('client_id');
    const redirectUri = url.searchParams.get('redirect_uri');
    const responseType = url.searchParams.get('response_type');
    const challengeValue = url.searchParams.get('code_challenge');
    const challengeMethod = url.searchParams.get('code_challenge_method');
    const requestedResource = url.searchParams.get('resource');
    const client = clients.get(clientId);
    if (
      responseType !== 'code' ||
      !client?.redirectUris.has(redirectUri) ||
      challengeMethod !== 'S256' ||
      !challengeValue ||
      requestedResource !== resource()
    ) {
      return null;
    }
    return {
      clientId,
      redirectUri,
      challenge: challengeValue,
      state: url.searchParams.get('state'),
      resource: requestedResource,
      scope: [...scopes(url.searchParams.get('scope'))].join(' '),
    };
  };

  const handleAuthorizationPage = (request, response, url) => {
    const pending = validateAuthorization(url);
    if (!pending) {
      oauthError(response, 400, 'invalid_request', 'Invalid authorization request');
      return;
    }
    const requestId = randomUUID();
    authorizationRequests.set(requestId, pending);
    text(response, 200, `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>AgentKeys evidence authorization</title></head>
<body><main><h1>Disposable evidence identity</h1>
<p>This local server stores no account data. Approve only for the AgentKeys evidence capture.</p>
<form method="post" action="/authorize">
<input type="hidden" name="request_id" value="${requestId}">
<button name="decision" value="approve" type="submit">Authorize</button>
<button name="decision" value="deny" type="submit">Cancel</button>
</form></main></body></html>`);
  };

  const handleAuthorizationDecision = async (request, response) => {
    const form = new URLSearchParams(await body(request));
    const pending = authorizationRequests.get(form.get('request_id'));
    if (!pending) {
      oauthError(response, 400, 'invalid_request', 'Authorization request expired');
      return;
    }
    authorizationRequests.delete(form.get('request_id'));
    const redirect = new URL(pending.redirectUri);
    if (pending.state) redirect.searchParams.set('state', pending.state);
    if (form.get('decision') !== 'approve') {
      redirect.searchParams.set('error', 'access_denied');
      response.writeHead(302, { location: redirect.href, 'cache-control': 'no-store' });
      response.end();
      return;
    }
    const code = `evidence-code-${randomUUID()}`;
    authorizationCodes.set(code, pending);
    redirect.searchParams.set('code', code);
    response.writeHead(302, { location: redirect.href, 'cache-control': 'no-store' });
    response.end();
  };

  const issueToken = (scopeValue) => {
    const accessToken = `evidence-access-${randomUUID()}`;
    const refreshToken = `evidence-refresh-${randomUUID()}`;
    const grantedScopes = scopes(scopeValue);
    accessTokens.set(accessToken, { resource: resource(), scopes: grantedScopes });
    refreshTokens.set(refreshToken, { resource: resource(), scopes: grantedScopes });
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 300,
      refresh_token: refreshToken,
      scope: [...grantedScopes].join(' '),
    };
  };

  const handleToken = async (request, response) => {
    const form = new URLSearchParams(await body(request));
    if (form.get('resource') !== resource()) {
      oauthError(response, 400, 'invalid_target', 'Token resource does not match');
      return;
    }
    if (form.get('grant_type') === 'authorization_code') {
      const code = form.get('code');
      const pending = authorizationCodes.get(code);
      if (
        !pending ||
        form.get('client_id') !== pending.clientId ||
        form.get('redirect_uri') !== pending.redirectUri ||
        pkceChallenge(form.get('code_verifier') ?? '') !== pending.challenge
      ) {
        oauthError(response, 400, 'invalid_grant', 'Authorization code is invalid');
        return;
      }
      authorizationCodes.delete(code);
      json(response, 200, issueToken(pending.scope));
      return;
    }
    if (form.get('grant_type') === 'refresh_token') {
      const previous = refreshTokens.get(form.get('refresh_token'));
      if (!previous) {
        oauthError(response, 400, 'invalid_grant', 'Refresh token is invalid');
        return;
      }
      const requested = scopes(form.get('scope'));
      const granted = requested.size > 0 ? requested : previous.scopes;
      json(response, 200, issueToken([...granted].join(' ')));
      return;
    }
    oauthError(response, 400, 'unsupported_grant_type', 'Unsupported token grant');
  };

  const tools = [
    {
      name: 'agentkeys_auth_read',
      description: 'Return harmless fixed evidence after disposable authentication.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'agentkeys_auth_step_up',
      description: 'Return harmless fixed evidence after disposable step-up authorization.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ];

  const handleMcp = async (request, response) => {
    if (request.method === 'GET') {
      response.writeHead(405, { allow: 'POST, DELETE' });
      response.end();
      return;
    }
    if (request.method === 'DELETE') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST, DELETE' });
      response.end();
      return;
    }
    let message;
    try {
      message = JSON.parse(await body(request));
    } catch {
      json(response, 400, { error: 'invalid_json' });
      return;
    }
    if (message.id === undefined) {
      response.writeHead(202);
      response.end();
      return;
    }
    if (message.method === 'initialize') {
      const requested = message.params?.protocolVersion;
      const protocolVersion = PROTOCOL_VERSIONS.has(requested) ? requested : '2025-06-18';
      json(response, 200, mcpResult(message.id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'agentkeys-auth-evidence', version: '0.1.0' },
      }));
      return;
    }
    if (message.method === 'ping') {
      json(response, 200, mcpResult(message.id, {}));
      return;
    }
    if (message.method === 'tools/list') {
      json(response, 200, mcpResult(message.id, { tools }));
      return;
    }
    if (message.method !== 'tools/call') {
      json(response, 200, {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'Method not found' },
      });
      return;
    }
    const requiredScope = message.params?.name === 'agentkeys_auth_step_up'
      ? WRITE_SCOPE
      : READ_SCOPE;
    const token = accessTokens.get(tokenFrom(request));
    if (!token) {
      challenge(response, 401, requiredScope);
      return;
    }
    if (token.resource !== resource() || !token.scopes.has(requiredScope)) {
      challenge(response, 403, requiredScope, 'insufficient_scope');
      return;
    }
    json(response, 200, mcpResult(message.id, {
      content: [{ type: 'text', text: 'Disposable authentication evidence complete.' }],
    }));
  };

  const handleRequest = async (request, response) => {
    const requestOrigin = request.headers.origin;
    if (requestOrigin && ![origin, 'vscode-file://vscode-app'].includes(requestOrigin)) {
      response.writeHead(403);
      response.end();
      return;
    }
    const url = new URL(request.url, origin);
    try {
      if (request.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource') {
        handleMetadata(request, response);
      } else if (
        request.method === 'GET' &&
        ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration'].includes(url.pathname)
      ) {
        handleAuthorizationServerMetadata(request, response);
      } else if (request.method === 'POST' && url.pathname === '/register') {
        await handleRegistration(request, response);
      } else if (request.method === 'GET' && url.pathname === '/authorize') {
        handleAuthorizationPage(request, response, url);
      } else if (request.method === 'POST' && url.pathname === '/authorize') {
        await handleAuthorizationDecision(request, response);
      } else if (request.method === 'POST' && url.pathname === '/token') {
        await handleToken(request, response);
      } else if (url.pathname === '/mcp') {
        await handleMcp(request, response);
      } else {
        response.writeHead(404);
        response.end();
      }
    } catch {
      json(response, 500, { error: 'internal_error' });
    }
  };
  const server = http.createServer((request, response) => {
    void handleRequest(request, response);
  });

  return {
    server,
    handleRequest,
    listen(port = DEFAULT_PORT) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, HOST, () => {
          const address = server.address();
          origin = `http://${HOST}:${address.port}`;
          resolve(origin);
        });
      });
    },
  };
}

export async function main() {
  const port = Number(process.env.AGENTKEYS_AUTH_EVIDENCE_PORT ?? DEFAULT_PORT);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error('AGENTKEYS_AUTH_EVIDENCE_PORT must be a valid port');
  }
  const evidence = createEvidenceServer();
  const origin = await evidence.listen(port);
  process.stdout.write(`${origin}/mcp\n`);
  const close = () => evidence.server.close();
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();