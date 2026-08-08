import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createEvidenceServer } from '../scripts/mcp-auth-evidence-server.mjs';

const ORIGIN = 'http://127.0.0.1:38471';
const REDIRECT_URI = 'http://127.0.0.1:48123/callback';

function invoke(evidence, { method = 'GET', path = '/', headers = {}, body = '' }) {
  const request = Readable.from(body ? [Buffer.from(body)] : []);
  request.method = method;
  request.url = path;
  request.headers = headers;
  return new Promise((resolve, reject) => {
    const chunks = [];
    const response = {
      statusCode: 200,
      headers: {},
      writeHead(statusCode, responseHeaders = {}) {
        this.statusCode = statusCode;
        this.headers = responseHeaders;
      },
      write(chunk) {
        chunks.push(Buffer.from(chunk));
      },
      end(chunk) {
        if (chunk) chunks.push(Buffer.from(chunk));
        resolve({
          status: this.statusCode,
          headers: this.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        });
      },
    };
    evidence.handleRequest(request, response).catch(reject);
  });
}

function jsonBody(response) {
  return JSON.parse(response.text);
}

test('serves disposable OAuth and scope-aware MCP evidence flows', async () => {
  const evidence = createEvidenceServer({ origin: ORIGIN });
  const mcp = async (id, method, params, authorization) => invoke(evidence, {
    method: 'POST',
    path: '/mcp',
    headers: authorization ? { authorization: `Bearer ${authorization}` } : {},
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });

  const initialized = await mcp(1, 'initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  });
  assert.equal(initialized.status, 200);
  assert.equal(jsonBody(initialized).result.protocolVersion, '2025-11-25');

  const listed = await mcp(2, 'tools/list', {});
  assert.deepEqual(
    jsonBody(listed).result.tools.map(({ name }) => name),
    ['agentkeys_auth_read', 'agentkeys_auth_step_up']
  );

  const unauthorized = await mcp(3, 'tools/call', {
    name: 'agentkeys_auth_read',
    arguments: {},
  });
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.headers['www-authenticate'], /resource_metadata=/);
  assert.match(unauthorized.headers['www-authenticate'], /scope="agentkeys:read"/);

  const resourceMetadata = await invoke(evidence, {
    path: '/.well-known/oauth-protected-resource',
  });
  assert.deepEqual(jsonBody(resourceMetadata), {
    resource: `${ORIGIN}/mcp`,
    authorization_servers: [ORIGIN],
    scopes_supported: ['agentkeys:read', 'agentkeys:write'],
    bearer_methods_supported: ['header'],
  });

  const authorizationMetadata = await invoke(evidence, {
    path: '/.well-known/oauth-authorization-server',
  });
  assert.equal(jsonBody(authorizationMetadata).issuer, ORIGIN);
  assert.deepEqual(jsonBody(authorizationMetadata).code_challenge_methods_supported, ['S256']);

  const registered = await invoke(evidence, {
    method: 'POST',
    path: '/register',
    body: JSON.stringify({ redirect_uris: [REDIRECT_URI] }),
  });
  assert.equal(registered.status, 201);
  const clientId = jsonBody(registered).client_id;
  assert.match(clientId, /^evidence-client-/);

  const verifier = 'evidence-verifier-with-more-than-forty-three-characters';
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorize = new URL('/authorize', ORIGIN);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('client_id', clientId);
  authorize.searchParams.set('redirect_uri', REDIRECT_URI);
  authorize.searchParams.set('code_challenge', challenge);
  authorize.searchParams.set('code_challenge_method', 'S256');
  authorize.searchParams.set('resource', `${ORIGIN}/mcp`);
  authorize.searchParams.set('scope', 'agentkeys:read');
  authorize.searchParams.set('state', 'test-state');
  const page = await invoke(evidence, { path: `${authorize.pathname}${authorize.search}` });
  assert.equal(page.status, 200);
  const requestId = /name="request_id" value="([0-9a-f-]+)"/.exec(page.text)?.[1];
  assert.ok(requestId);

  const decision = await invoke(evidence, {
    method: 'POST',
    path: '/authorize',
    body: new URLSearchParams({ request_id: requestId, decision: 'approve' }).toString(),
  });
  assert.equal(decision.status, 302);
  const redirect = new URL(decision.headers.location);
  assert.equal(redirect.origin + redirect.pathname, REDIRECT_URI);
  assert.equal(redirect.searchParams.get('state'), 'test-state');

  const tokenResponse = await invoke(evidence, {
    method: 'POST',
    path: '/token',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: redirect.searchParams.get('code'),
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      resource: `${ORIGIN}/mcp`,
    }).toString(),
  });
  assert.equal(tokenResponse.status, 200);
  const accessToken = jsonBody(tokenResponse).access_token;
  assert.match(accessToken, /^evidence-access-/);

  const completed = await mcp(4, 'tools/call', {
    name: 'agentkeys_auth_read',
    arguments: {},
  }, accessToken);
  assert.equal(completed.status, 200);
  assert.equal(jsonBody(completed).result.content[0].type, 'text');

  const insufficient = await mcp(5, 'tools/call', {
    name: 'agentkeys_auth_step_up',
    arguments: {},
  }, accessToken);
  assert.equal(insufficient.status, 403);
  assert.match(insufficient.headers['www-authenticate'], /error="insufficient_scope"/);
  assert.match(insufficient.headers['www-authenticate'], /scope="agentkeys:write"/);
});