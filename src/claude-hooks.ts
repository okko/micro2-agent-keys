import * as fs from 'node:fs';
import * as path from 'node:path';
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
export const CLAUDE_SESSION_ID = /^[a-zA-Z0-9_-]{1,128}$/;

export const CLAUDE_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'Notification', 'Elicitation', 'ElicitationResult', 'Stop', 'StopFailure', 'SessionEnd',
] as const;

export interface ClaudeHookEvent {
  session_id: string;
  cwd: string;
  hook_event_name: typeof CLAUDE_EVENTS[number];
  notification_type?: string;
  tool_name?: string;
  tool_use_id?: string;
  prompt_id?: string;
  agent_id?: string;
  elicitation_id?: string;
  mcp_server_name?: string;
}

export function parseClaudeHook(value: unknown): ClaudeHookEvent {
  if (!value || typeof value !== 'object') throw new Error('Invalid Claude hook');
  const event = value as Record<string, unknown>;
  if (typeof event.session_id !== 'string' || !CLAUDE_SESSION_ID.test(event.session_id) ||
      typeof event.cwd !== 'string' || !path.isAbsolute(event.cwd) ||
      !CLAUDE_EVENTS.some((name) => name === event.hook_event_name)) {
    throw new Error('Invalid Claude hook identity or event');
  }
  for (const key of ['notification_type', 'tool_name', 'tool_use_id', 'prompt_id', 'agent_id', 'elicitation_id', 'mcp_server_name']) {
    if (event[key] !== undefined && (typeof event[key] !== 'string' || event[key].length > 256)) {
      throw new Error('Invalid Claude hook field');
    }
  }
  return {
    session_id: event.session_id, cwd: event.cwd,
    hook_event_name: event.hook_event_name as ClaudeHookEvent['hook_event_name'],
    notification_type: event.notification_type as string | undefined,
    tool_name: event.tool_name as string | undefined,
    tool_use_id: event.tool_use_id as string | undefined,
    prompt_id: event.prompt_id as string | undefined,
    agent_id: event.agent_id as string | undefined,
    elicitation_id: event.elicitation_id as string | undefined,
    mcp_server_name: event.mcp_server_name as string | undefined,
  };
}

export class ClaudeHooksReceiver {
  private server: Server | undefined;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    private readonly directory: string,
    private readonly handler: (event: ClaudeHookEvent) => Promise<void>,
    private readonly log: (message: string) => void,
  ) {}

  async start(scriptPath: string): Promise<void> {
    const token = randomBytes(32).toString('hex');
    const server = createServer((request, response) => {
      if (request.method !== 'POST' || request.url !== '/event' ||
          request.headers.authorization !== `Bearer ${token}` || request.headers.origin) {
        response.writeHead(403).end();
        request.resume();
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 16_384) {
          response.writeHead(413).end();
          request.destroy();
        } else chunks.push(chunk);
      });
      request.on('error', () => this.log('Claude hook request interrupted'));
      request.on('end', () => {
        let event: ClaudeHookEvent;
        try { event = parseClaudeHook(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch {
          this.log('Rejected invalid Claude hook');
          response.writeHead(400).end();
          return;
        }
        this.pending = this.pending.then(() => this.handler(event)).then(() => {
          response.writeHead(204).end();
        }).catch((error: unknown) => {
          this.log(`Claude hook failed: ${error instanceof Error ? error.message : String(error)}`);
          response.writeHead(500).end();
        });
      });
    });
    server.requestTimeout = 5000;
    server.headersTimeout = 5000;
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
      });
      server.on('error', (error) => this.log(`Claude hook receiver failed: ${error.message}`));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing Claude hook receiver address');
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const helper = path.join(this.directory, 'claude-hook.cjs');
      fs.copyFileSync(scriptPath, helper);
      fs.chmodSync(helper, 0o600);
      const command = `node '${helper.replaceAll("'", "'\\''")}'`;
      fs.writeFileSync(path.join(this.directory, 'claude-hooks-settings.json'), JSON.stringify({
        hooks: Object.fromEntries(CLAUDE_EVENTS.map((event) => [event, [{
          hooks: [{ type: 'command', command, timeout: 5 }],
        }]])),
      }, null, 2), { mode: 0o600 });
      const endpoint = path.join(this.directory, 'claude-hooks-endpoint.json');
      fs.writeFileSync(`${endpoint}.tmp`, JSON.stringify({ port: address.port, token }), { mode: 0o600 });
      fs.renameSync(`${endpoint}.tmp`, endpoint);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    fs.rmSync(path.join(this.directory, 'claude-hooks-endpoint.json'), { force: true });
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await this.pending;
  }
}
