import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';
import {
  SUPPORTED_PROTOCOL_VERSIONS,
  ACTION_INTRODUCED_IN,
  chatReducer,
  type ChatAction,
  type ChatState,
  type SessionSummary,
  type Snapshot,
  type StateAction,
} from '@microsoft/agent-host-protocol';
import {
  AhpClient,
  RpcError,
  TransportError,
  type AhpTransport,
  type JsonRpcMessage,
  type Subscription,
  type TransportFrame,
} from '@microsoft/agent-host-protocol/client';

const ROOT_CHANNEL = 'ahp-root://';
const DEFAULT_RETRY_MS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LocalAgentHostEndpoint {
  key: string;
  pid: number;
  instanceId: string;
  protocolVersion: string;
  connectionToken: string;
  socketPath: string;
}

export interface AgentHostSession {
  id: string;
  cwd: string;
  resource: string;
  chatResource: string;
}

export type AgentHostStateHandler = (
  sessionId: string, state: unknown, session?: AgentHostSession
) => void | Promise<void>;
export type AgentHostUnavailableHandler = (sessionIds: readonly string[]) => void | Promise<void>;

export interface AgentHostStateSource {
  start(handler: AgentHostStateHandler, unavailableHandler?: AgentHostUnavailableHandler): void;
  setSessions(sessionIds: readonly string[]): void;
  stop(): void;
}

export interface LocalAgentHostStateSourceOptions {
  userDataPath?: string;
  registryPath?: string;
  retryMs?: number;
  requestTimeoutMs?: number;
  log?: (...args: unknown[]) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function errorDiagnostic(error: unknown): string {
  if (error instanceof RpcError) return `protocolCode=${error.code}`;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)) return `code=${code}`;
  const name = error instanceof Error ? error.name : typeof error;
  return `type=${/^[A-Za-z]+$/.test(name) ? name : 'unknown'}`;
}

function parseEndpoint(value: unknown): LocalAgentHostEndpoint | null {
  if (!isRecord(value) || value.type !== 'editor') return null;
  const { schemaVersion, pid, instanceId, protocolVersion, connectionToken, endpoint } = value;
  const socketPath = schemaVersion === 1
    ? value.endpointPath
    : schemaVersion === 2 && isRecord(endpoint) && endpoint.type === 'socket' ? endpoint.path : null;
  if (
    (schemaVersion !== 1 && schemaVersion !== 2) ||
    typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 ||
    typeof instanceId !== 'string' || !instanceId ||
    typeof protocolVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(protocolVersion) ||
    typeof connectionToken !== 'string' || !connectionToken ||
    typeof socketPath !== 'string' || !path.isAbsolute(socketPath) || /[:?]/.test(socketPath)
  ) return null;
  return { key: `editor:${pid}:${instanceId}`, pid, instanceId, protocolVersion, connectionToken, socketPath };
}

function readJsonFile(filePath: string): unknown | null {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function readLocalAgentHostEndpoints(registryPath: string): LocalAgentHostEndpoint[] {
  const endpoints = new Map<string, LocalAgentHostEndpoint>();
  const legacy = readJsonFile(path.join(registryPath, 'metadata.json'));
  for (const value of Array.isArray(legacy) ? legacy : legacy ? [legacy] : []) {
    const endpoint = parseEndpoint(value);
    if (endpoint && isPidAlive(endpoint.pid)) endpoints.set(endpoint.key, endpoint);
  }
  const entriesPath = path.join(registryPath, 'entries');
  let files: string[];
  try {
    files = fs.readdirSync(entriesPath).filter((file) => file.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    files = [];
  }
  for (const file of files) {
    const endpoint = parseEndpoint(readJsonFile(path.join(entriesPath, file)));
    if (endpoint && isPidAlive(endpoint.pid)) endpoints.set(endpoint.key, endpoint);
  }
  return [...endpoints.values()].sort((left, right) => left.key.localeCompare(right.key));
}

export function agentHostChatResource(sessionId: string): string {
  return `ahp-chat://default/${Buffer.from(`copilotcli:/${sessionId}`).toString('base64url')}`;
}

// The browser transport cannot open VS Code's authenticated Unix sockets.
class UnixSocketTransport implements AhpTransport {
  private readonly frames: TransportFrame[] = [];
  private waiter: ((frame: TransportFrame | null) => void) | null = null;
  private closed = false;

  constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) => {
      const text = Array.isArray(data) ? Buffer.concat(data).toString('utf8')
        : data instanceof ArrayBuffer ? Buffer.from(data).toString('utf8') : data.toString('utf8');
      const frame: TransportFrame = { kind: 'text', text };
      if (this.waiter) {
        const resolve = this.waiter;
        this.waiter = null;
        resolve(frame);
      } else this.frames.push(frame);
    });
    socket.on('close', () => this.finish());
  }

  send(message: JsonRpcMessage | string): void {
    if (this.socket.readyState !== WebSocket.OPEN) throw new TransportError('closed', 'Agent Host socket closed');
    this.socket.send(typeof message === 'string' ? message : JSON.stringify(message));
  }

  recv(): Promise<TransportFrame | null> {
    const frame = this.frames.shift();
    if (frame) return Promise.resolve(frame);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => { this.waiter = resolve; });
  }

  close(): void {
    this.finish();
    this.socket.terminate();
  }

  private finish(): void {
    this.closed = true;
    this.waiter?.(null);
    this.waiter = null;
  }
}

interface ChatObservation {
  sessionId: string;
  descriptor?: AgentHostSession;
  state: ChatState | null;
  fromSeq: number;
  subscription?: Subscription;
}

function chatState(snapshot: Snapshot, channel: string): ChatState {
  const state = snapshot.state;
  if (snapshot.resource !== channel || !Number.isSafeInteger(snapshot.fromSeq) || snapshot.fromSeq < 0 ||
      !state || !('turns' in state) || !Array.isArray(state.turns) || state.resource !== channel) {
    throw new Error('Invalid Agent Host chat snapshot');
  }
  return state;
}

function catalogSession(summary: SessionSummary): AgentHostSession | null {
  const resource = summary.resource;
  let id = resource.slice(resource.lastIndexOf('/') + 1);
  if (resource.startsWith('vscode-chat-session://local/')) id = Buffer.from(id, 'base64url').toString();
  if (!SESSION_ID.test(id)) return null;
  const cwdUri = summary.workingDirectories?.[0] ?? summary.project?.uri;
  if (!cwdUri || !cwdUri.startsWith('file:')) return null;
  const cwd = fileURLToPath(cwdUri);
  if (!path.isAbsolute(cwd)) return null;
  const openResource = resource.startsWith('vscode-chat-session:') || resource.startsWith('agent-host-')
    ? resource
    : resource.startsWith('ahp-session:')
      ? `agent-host-${summary.provider}:/${id}`
      : `agent-host-${resource}`;
  const chatResource = summary.defaultChat ??
    `ahp-chat://default/${Buffer.from(resource).toString('base64url')}`;
  return { id, cwd, resource: openResource, chatResource };
}

class EndpointConnection {
  private client: AhpClient | null = null;
  private socket: WebSocket | null = null;
  private ready = false;
  private connecting = false;
  private stopped = false;
  private retryAt = 0;
  private initialized = false;
  private lastSeenServerSeq = 0;
  private targets = new Set<string>();
  private readonly catalog = new Map<string, AgentHostSession>();
  private readonly summaries = new Map<string, SessionSummary>();
  private readonly activeCatalog = new Set<string>();
  private readonly observations = new Map<string, ChatObservation>();
  private readonly pendingChannels = new Set<string>();
  private readonly nextAttempt = new Map<string, number>();
  private readonly clientId = `agentkeys-${process.pid}-${randomUUID()}`;

  constructor(
    readonly endpoint: LocalAgentHostEndpoint,
    private readonly retryMs: number,
    private readonly requestTimeoutMs: number,
    private readonly onState: (sessionId: string, state: ChatState, session?: AgentHostSession) => Promise<void>,
    private readonly onUnavailable: (sessionIds: readonly string[]) => void,
    private readonly log: (...args: unknown[]) => void
  ) {}

  setSessions(sessionIds: ReadonlySet<string>): void {
    this.targets = new Set(sessionIds);
    this.tick();
  }

  tick(): void {
    if (this.stopped) return;
    if (!this.ready) {
      if (!this.connecting && Date.now() >= this.retryAt) void this.connect();
      return;
    }
    const wanted = new Map<string, { id: string; descriptor?: AgentHostSession }>();
    for (const session of this.catalog.values()) {
      if (this.activeCatalog.has(session.id) || this.targets.has(session.id) ||
          this.observations.has(session.chatResource)) {
        wanted.set(session.chatResource, { id: session.id, descriptor: session });
      }
    }
    for (const id of this.targets) {
      if (!this.catalog.has(id)) wanted.set(agentHostChatResource(id), { id });
    }
    for (const [channel, observation] of this.observations) {
      if (wanted.has(channel)) continue;
      this.observations.delete(channel);
      void this.client?.unsubscribe(channel).catch((error) => this.report('unsubscribe', error));
      this.onUnavailable([observation.sessionId]);
    }
    for (const [channel, { id, descriptor }] of wanted) {
      const existing = this.observations.get(channel);
      if (existing) {
        const changed = descriptor && (
          existing.descriptor?.cwd !== descriptor.cwd || existing.descriptor.resource !== descriptor.resource
        );
        existing.descriptor = descriptor;
        if (changed) void this.publish(existing).catch((error) => this.report('state handler', error));
        continue;
      }
      if (this.pendingChannels.has(channel) || Date.now() < (this.nextAttempt.get(channel) ?? 0)) continue;
      void this.subscribe(channel, id, descriptor);
    }
  }

  stop(): void {
    this.stopped = true;
    this.ready = false;
    this.socket?.terminate();
    void this.client?.shutdown().catch((error) => this.report('shutdown', error));
    this.client = null;
  }

  republish(sessionIds: readonly string[]): void {
    if (!this.ready || this.stopped) return;
    for (const observation of this.observations.values()) {
      if (sessionIds.includes(observation.sessionId)) {
        void this.publish(observation).catch((error) => this.report('state handler', error));
      }
    }
  }

  private async connect(): Promise<void> {
    this.connecting = true;
    const socket = new WebSocket(
      `ws+unix:${this.endpoint.socketPath}:/?tkn=${encodeURIComponent(this.endpoint.connectionToken)}`,
      { handshakeTimeout: this.requestTimeoutMs }
    );
    this.socket = socket;
    const transport = new UnixSocketTransport(socket);
    socket.on('error', (error) => this.report('transport', error));
    const client = new AhpClient(transport, { requestTimeoutMs: this.requestTimeoutMs });
    this.client = client;
    socket.on('close', () => {
      if (this.client !== client || this.stopped) return;
      this.ready = false;
      this.retryAt = Date.now() + this.retryMs;
      this.onUnavailable([...this.observations.values()].map((observation) => observation.sessionId));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
        socket.once('close', () => reject(new Error('Agent Host socket closed during upgrade')));
      });
      if (this.stopped || this.client !== client) return;
      client.connect();
      const root = client.attachSubscription(ROOT_CHANNEL);
      if (this.initialized) {
        for (const [channel, observation] of this.observations) {
          observation.subscription = client.attachSubscription(channel);
        }
        const result = await client.reconnect({
          clientId: this.clientId,
          lastSeenServerSeq: this.observations.size
            ? Math.min(...[...this.observations.values()].map((observation) => observation.fromSeq))
            : this.lastSeenServerSeq,
          subscriptions: [ROOT_CHANNEL, ...this.observations.keys()],
        });
        if (result.type === 'snapshot') {
          for (const snapshot of result.snapshots) {
            const observation = this.observations.get(snapshot.resource);
            if (observation) {
              observation.state = chatState(snapshot, snapshot.resource);
              observation.fromSeq = snapshot.fromSeq;
            }
          }
          const resources = new Set(result.snapshots.map((snapshot) => snapshot.resource));
          for (const channel of this.observations.keys()) {
            if (!resources.has(channel)) this.drop(channel);
          }
        } else {
          for (const channel of result.missing) this.drop(channel);
          for (const envelope of result.actions) this.applyAction(envelope.channel, envelope.serverSeq, envelope.action);
        }
        for (const [channel, observation] of this.observations) {
          await this.publish(observation);
          void this.consume(client, channel, observation);
        }
      } else {
        const versions = [this.endpoint.protocolVersion, ...SUPPORTED_PROTOCOL_VERSIONS];
        const result = await client.initialize({
          clientId: this.clientId, protocolVersions: [...new Set(versions)], initialSubscriptions: [ROOT_CHANNEL],
        });
        if (!versions.includes(result.protocolVersion)) throw new Error('Unexpected Agent Host protocol version');
        this.lastSeenServerSeq = result.serverSeq;
        this.initialized = true;
      }
      if (this.stopped || this.client !== client || client.connectionState.status !== 'connected') return;
      this.ready = true;
      this.retryAt = 0;
      await this.loadCatalog(client);
      void this.consumeRoot(client, root);
      this.tick();
    } catch (error) {
      this.report('connection', error);
      this.ready = false;
      this.initialized = false;
      this.onUnavailable([...this.observations.values()].map((observation) => observation.sessionId));
      this.observations.clear();
      await client.shutdown();
    } finally {
      this.connecting = false;
      if (this.client === client && !this.ready) this.retryAt = Date.now() + this.retryMs;
    }
  }

  private async loadCatalog(client: AhpClient): Promise<void> {
    const summaries = new Map<string, SessionSummary>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await client.request('listSessions', { channel: ROOT_CHANNEL, limit: 100, cursor });
      for (const summary of result.items) {
        summaries.set(summary.resource, summary);
      }
      cursor = result.nextCursor;
      if (cursor) {
        if (cursors.has(cursor)) throw new Error('Agent Host repeated a catalog cursor');
        cursors.add(cursor);
      }
    } while (cursor && this.client === client && this.ready);
    if (this.client !== client || !this.ready) return;
    this.summaries.clear();
    for (const [resource, summary] of summaries) this.summaries.set(resource, summary);
    this.updateCatalog();
  }

  private updateCatalog(): void {
    this.catalog.clear();
    this.activeCatalog.clear();
    for (const summary of this.summaries.values()) {
      const session = catalogSession(summary);
      if (!session) continue;
      this.catalog.set(session.id, session);
      if (summary.status & 8) this.activeCatalog.add(session.id);
    }
  }

  private async consumeRoot(client: AhpClient, subscription: Subscription): Promise<void> {
    try {
      for await (const event of subscription) {
        if (this.client !== client || !this.ready) return;
        if (event.type === 'sessionAdded') this.summaries.set(event.params.summary.resource, event.params.summary);
        else if (event.type === 'sessionRemoved') this.summaries.delete(event.params.session);
        else if (event.type === 'sessionSummaryChanged') {
          const previous = this.summaries.get(event.params.session);
          if (previous) this.summaries.set(event.params.session, {
            ...previous, ...event.params.changes, resource: previous.resource,
            provider: previous.provider, createdAt: previous.createdAt,
          });
        } else continue;
        this.updateCatalog();
        this.tick();
      }
    } catch (error) {
      this.report('catalog', error);
      this.ready = false;
      this.retryAt = Date.now() + this.retryMs;
      await client.shutdown();
    }
  }

  private async subscribe(channel: string, sessionId: string, descriptor?: AgentHostSession): Promise<void> {
    const client = this.client;
    if (!client) return;
    this.pendingChannels.add(channel);
    try {
      const { result, subscription } = await client.subscribe(channel);
      if (client !== this.client || !this.ready || this.stopped) return;
      if (!this.targets.has(sessionId) && !this.catalog.has(sessionId)) {
        await client.unsubscribe(channel);
        return;
      }
      if (!result.snapshot) throw new Error('Missing Agent Host chat snapshot');
      const observation: ChatObservation = {
        sessionId, descriptor, state: chatState(result.snapshot, channel),
        fromSeq: result.snapshot.fromSeq, subscription,
      };
      this.observations.set(channel, observation);
      this.lastSeenServerSeq = Math.max(this.lastSeenServerSeq, observation.fromSeq);
      await this.publish(observation);
      void this.consume(client, channel, observation);
    } catch (error) {
      this.drop(channel);
      this.nextAttempt.set(channel, Date.now() + this.retryMs);
      this.report('subscription', error);
    } finally { this.pendingChannels.delete(channel); }
  }

  private async consume(client: AhpClient, channel: string, observation: ChatObservation): Promise<void> {
    try {
      if (!observation.subscription) return;
      for await (const event of observation.subscription) {
        if (client !== this.client || this.observations.get(channel) !== observation || this.stopped) return;
        if (event.type !== 'action') continue;
        if (this.applyAction(channel, event.params.serverSeq, event.params.action)) await this.publish(observation);
      }
    } catch (error) {
      this.report('state', error);
      this.onUnavailable([observation.sessionId]);
      this.drop(channel);
      this.nextAttempt.set(channel, Date.now() + this.retryMs);
    }
  }

  private applyAction(channel: string, serverSeq: number, action: StateAction): boolean {
    if (!Number.isSafeInteger(serverSeq) || serverSeq < 0) throw new Error('Invalid Agent Host action sequence');
    const observation = this.observations.get(channel);
    if (!observation?.state || serverSeq <= observation.fromSeq) return false;
    if (!action || typeof action.type !== 'string' || !action.type.startsWith('chat/') ||
        !Object.hasOwn(ACTION_INTRODUCED_IN, action.type)) {
      throw new Error('Unexpected action on Agent Host chat channel');
    }
    // Channel routing narrows the SDK's cross-channel action union.
    observation.state = chatReducer(observation.state, action as ChatAction, () => {
      this.log(`Agent Host reducer diagnostic pid=${this.endpoint.pid}`);
    });
    observation.fromSeq = serverSeq;
    this.lastSeenServerSeq = Math.max(this.lastSeenServerSeq, serverSeq);
    return true;
  }

  private async publish(observation: ChatObservation): Promise<void> {
    if (observation.state && !this.stopped) await this.onState(observation.sessionId, observation.state, observation.descriptor);
  }

  private drop(channel: string): void {
    const observation = this.observations.get(channel);
    if (!observation) return;
    this.observations.delete(channel);
    void observation.subscription?.close();
    this.onUnavailable([observation.sessionId]);
  }

  private report(operation: string, error: unknown): void {
    this.log(`Agent Host ${operation} failed pid=${this.endpoint.pid} ${errorDiagnostic(error)}`);
  }
}

export class LocalAgentHostStateSource implements AgentHostStateSource {
  readonly registryPath: string;
  private readonly retryMs: number;
  private readonly requestTimeoutMs: number;
  private readonly log: (...args: unknown[]) => void;
  private readonly connections = new Map<string, EndpointConnection>();
  private readonly owners = new Map<string, string>();
  private desiredSessions = new Set<string>();
  private handler: AgentHostStateHandler | null = null;
  private unavailableHandler: AgentHostUnavailableHandler | null = null;
  private timer: NodeJS.Timeout | null = null;
  private updates: Promise<void> = Promise.resolve();

  constructor(options: LocalAgentHostStateSourceOptions = {}) {
    const userDataPath = options.userDataPath ?? process.env.AGENTKEYS_VSCODE_USER_DATA ??
      path.join(os.homedir(), 'Library', 'Application Support', 'Code');
    this.registryPath = options.registryPath ?? path.join(userDataPath, 'agent-host', 'local-endpoint');
    this.retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.log = options.log ?? (() => {});
  }

  start(handler: AgentHostStateHandler, unavailableHandler?: AgentHostUnavailableHandler): void {
    if (this.handler) return;
    this.handler = handler;
    this.unavailableHandler = unavailableHandler ?? null;
    this.reconcileEndpoints();
    this.timer = setInterval(() => this.reconcileEndpoints(), Math.max(100, this.retryMs));
    this.timer.unref();
  }

  setSessions(sessionIds: readonly string[]): void {
    this.desiredSessions = new Set(sessionIds);
    if (this.handler) this.reconcileEndpoints();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.handler = null;
    this.unavailableHandler = null;
    this.owners.clear();
    for (const connection of this.connections.values()) connection.stop();
    this.connections.clear();
  }

  private reconcileEndpoints(): void {
    let endpoints: LocalAgentHostEndpoint[];
    try { endpoints = readLocalAgentHostEndpoints(this.registryPath); }
    catch (error) {
      this.log(`Agent Host registry read failed ${errorDiagnostic(error)}`);
      return;
    }
    const live = new Map(endpoints.map((endpoint) => [endpoint.key, endpoint]));
    for (const [key, connection] of this.connections) {
      const current = live.get(key);
      if (current && current.socketPath === connection.endpoint.socketPath &&
          current.connectionToken === connection.endpoint.connectionToken) continue;
      connection.stop();
      this.connections.delete(key);
      this.release(key);
    }
    for (const endpoint of endpoints) {
      if (this.connections.has(endpoint.key)) continue;
      this.connections.set(endpoint.key, new EndpointConnection(
        endpoint, this.retryMs, this.requestTimeoutMs,
        async (id, state, session) => {
          if (this.connections.get(endpoint.key)?.endpoint !== endpoint) return;
          const owner = this.owners.get(id);
          if (owner && owner !== endpoint.key) return;
          this.owners.set(id, endpoint.key);
          await this.enqueue(() => this.handler?.(id, state, session));
        },
        (ids) => {
          const released = ids.filter((id) => this.owners.get(id) === endpoint.key);
          for (const id of released) this.owners.delete(id);
          this.notifyUnavailable(released);
          for (const [key, connection] of this.connections) {
            if (key !== endpoint.key) connection.republish(released);
          }
        },
        this.log
      ));
    }
    for (const connection of this.connections.values()) connection.setSessions(this.desiredSessions);
  }

  private release(key: string): void {
    const ids = [...this.owners].filter(([, owner]) => owner === key).map(([id]) => id);
    for (const id of ids) this.owners.delete(id);
    this.notifyUnavailable(ids);
    for (const connection of this.connections.values()) connection.republish(ids);
  }

  private notifyUnavailable(ids: readonly string[]): void {
    if (!ids.length || !this.unavailableHandler) return;
    void this.enqueue(() => this.unavailableHandler?.(ids));
  }

  private enqueue(update: () => void | Promise<void>): Promise<void> {
    const pending = this.updates.then(update);
    this.updates = pending.catch((error) => {
      this.log(`Agent Host state handler failed ${errorDiagnostic(error)}`);
    });
    return pending;
  }
}
