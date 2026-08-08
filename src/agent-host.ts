import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import WebSocket, { type RawData } from 'ws';

const ROOT_CHANNEL = 'ahp-root://';
const DEFAULT_RETRY_MS = 2_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const CLIENT_VERSION = '0.1.0';

interface JsonRpcError {
  code?: unknown;
  message?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface LocalAgentHostEndpoint {
  key: string;
  pid: number;
  instanceId: string;
  protocolVersion: string;
  connectionToken: string;
  socketPath: string;
}

export type AgentHostStateHandler = (sessionId: string, state: unknown) => void | Promise<void>;
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

class ProtocolRequestError extends Error {
  constructor(
    message: string,
    readonly code: number | null
  ) {
    super(message);
  }
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
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]+$/.test(code)) return `code=${code}`;
  if (error instanceof ProtocolRequestError && error.code !== null) return `protocolCode=${error.code}`;
  const name = error instanceof Error ? error.name : typeof error;
  return `type=${/^[A-Za-z]+$/.test(name) ? name : 'unknown'}`;
}

function parseEndpoint(value: unknown): LocalAgentHostEndpoint | null {
  if (!isRecord(value) || value.type !== 'editor') return null;
  const schemaVersion = value.schemaVersion;
  const pid = value.pid;
  const instanceId = value.instanceId;
  const protocolVersion = value.protocolVersion;
  const connectionToken = value.connectionToken;
  const endpoint = value.endpoint;
  const socketPath = schemaVersion === 1
    ? value.endpointPath
    : schemaVersion === 2 && isRecord(endpoint) && endpoint.type === 'socket'
      ? endpoint.path
      : null;
  if (
    (schemaVersion !== 1 && schemaVersion !== 2) ||
    typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 ||
    typeof instanceId !== 'string' || !instanceId ||
    typeof protocolVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(protocolVersion) ||
    typeof connectionToken !== 'string' || !connectionToken ||
    typeof socketPath !== 'string' || !path.isAbsolute(socketPath) || /[:?]/.test(socketPath)
  ) {
    return null;
  }
  return {
    key: `editor:${pid}:${instanceId}`,
    pid,
    instanceId,
    protocolVersion,
    connectionToken,
    socketPath,
  };
}

function readJsonFile(filePath: string): unknown | null {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

export function readLocalAgentHostEndpoints(registryPath: string): LocalAgentHostEndpoint[] {
  const endpoints = new Map<string, LocalAgentHostEndpoint>();
  const legacy = readJsonFile(path.join(registryPath, 'metadata.json'));
  const legacyEntries = Array.isArray(legacy) ? legacy : legacy ? [legacy] : [];
  for (const value of legacyEntries) {
    const endpoint = parseEndpoint(value);
    if (endpoint && isPidAlive(endpoint.pid)) endpoints.set(endpoint.key, endpoint);
  }

  const entriesPath = path.join(registryPath, 'entries');
  let entryFiles: string[] = [];
  try {
    entryFiles = fs.readdirSync(entriesPath).filter((file) => file.endsWith('.json')).sort();
  } catch {
    // The per-instance registry was introduced after the legacy metadata file.
  }
  for (const file of entryFiles) {
    const endpoint = parseEndpoint(readJsonFile(path.join(entriesPath, file)));
    if (endpoint && isPidAlive(endpoint.pid)) endpoints.set(endpoint.key, endpoint);
  }
  return [...endpoints.values()].sort((left, right) => left.key.localeCompare(right.key));
}

export function agentHostChatResource(sessionId: string): string {
  const backendSession = `copilotcli:/${sessionId}`;
  return `ahp-chat://default/${Buffer.from(backendSession).toString('base64url')}`;
}

function rawDataText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

class EndpointConnection {
  private socket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private ready = false;
  private stopped = false;
  private retryAt = 0;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private targets = new Set<string>();
  private readonly subscriptions = new Map<string, string>();
  private readonly refreshing = new Set<string>();
  private readonly refreshAgain = new Set<string>();
  private readonly nextSessionAttempt = new Map<string, number>();
  private readonly clientId = `agentkeys-${process.pid}-${randomUUID()}`;

  constructor(
    readonly endpoint: LocalAgentHostEndpoint,
    private readonly retryMs: number,
    private readonly requestTimeoutMs: number,
    private readonly onState: (endpointKey: string, sessionId: string, state: unknown) => Promise<void>,
    private readonly onDisconnect: (endpointKey: string) => void,
    private readonly log: (...args: unknown[]) => void
  ) {}

  setSessions(sessionIds: ReadonlySet<string>): void {
    this.targets = new Set(sessionIds);
    for (const [sessionId, channel] of this.subscriptions) {
      if (this.targets.has(sessionId)) continue;
      this.subscriptions.delete(sessionId);
      this.nextSessionAttempt.delete(sessionId);
      if (this.ready) this.sendNotification('unsubscribe', { channel });
    }
    if (!this.targets.size) return;
    void this.ensureConnected();
    if (!this.ready) return;
    const now = Date.now();
    for (const sessionId of this.targets) {
      if (
        !this.subscriptions.has(sessionId) &&
        !this.refreshing.has(sessionId) &&
        now >= (this.nextSessionAttempt.get(sessionId) ?? 0)
      ) {
        this.queueRefresh(sessionId, false);
      }
    }
  }

  stop(): void {
    this.stopped = true;
    this.ready = false;
    this.targets.clear();
    this.subscriptions.clear();
    this.rejectPending(new Error('Agent Host connection stopped'));
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
  }

  private async ensureConnected(): Promise<void> {
    if (this.stopped || this.ready || this.connectPromise || Date.now() < this.retryAt) return;
    this.connectPromise = this.connect().finally(() => {
      this.connectPromise = null;
    });
    try {
      await this.connectPromise;
    } catch (error) {
      this.retryAt = Date.now() + this.retryMs;
      this.ready = false;
      const socket = this.socket;
      this.socket = null;
      this.rejectPending(new Error('Agent Host protocol handshake failed'));
      socket?.terminate();
      this.log(`Agent Host protocol connection failed pid=${this.endpoint.pid} ${errorDiagnostic(error)}`);
    }
  }

  private async connect(): Promise<void> {
    const address = `ws+unix:${this.endpoint.socketPath}:/?tkn=${encodeURIComponent(this.endpoint.connectionToken)}`;
    const socket = new WebSocket(address);
    this.socket = socket;
    socket.on('message', (data) => this.handleMessage(data));
    socket.on('close', () => this.handleClose(socket));
    socket.on('error', () => {});
    await new Promise<void>((resolve, reject) => {
      const opened = (): void => {
        socket.off('error', failed);
        socket.off('close', closed);
        resolve();
      };
      const failed = (error: Error): void => {
        socket.off('open', opened);
        socket.off('close', closed);
        reject(error);
      };
      const closed = (): void => {
        socket.off('open', opened);
        socket.off('error', failed);
        reject(new Error('socket closed during WebSocket upgrade'));
      };
      socket.once('open', opened);
      socket.once('error', failed);
      socket.once('close', closed);
    });

    const result = await this.sendRequest('initialize', {
      channel: ROOT_CHANNEL,
      protocolVersions: [this.endpoint.protocolVersion],
      clientId: this.clientId,
      clientInfo: { name: 'AgentKeys', version: CLIENT_VERSION },
      initialSubscriptions: [],
    });
    if (!isRecord(result) || result.protocolVersion !== this.endpoint.protocolVersion) {
      throw new Error('Agent Host selected an unexpected protocol version');
    }
    if (this.socket !== socket || this.stopped) return;
    this.ready = true;
    this.retryAt = 0;
    this.setSessions(this.targets);
  }

  private handleClose(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    const wasReady = this.ready;
    this.ready = false;
    this.subscriptions.clear();
    this.refreshing.clear();
    this.refreshAgain.clear();
    this.rejectPending(new Error('Agent Host protocol connection closed'));
    if (wasReady) this.onDisconnect(this.endpoint.key);
  }

  private handleMessage(data: RawData): void {
    let message: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawDataText(data)) as unknown;
      if (!isRecord(parsed)) return;
      message = parsed;
    } catch {
      return;
    }

    if (typeof message.id === 'number' && !('method' in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (isRecord(message.error)) {
        const rpcError = message.error as JsonRpcError;
        pending.reject(new ProtocolRequestError(
          typeof rpcError.message === 'string' ? rpcError.message : 'Agent Host protocol request failed',
          typeof rpcError.code === 'number' ? rpcError.code : null
        ));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method === 'action' && isRecord(message.params)) {
      const channel = message.params.channel;
      if (typeof channel !== 'string') return;
      for (const [sessionId, subscribedChannel] of this.subscriptions) {
        if (channel === subscribedChannel) this.queueRefresh(sessionId, true);
      }
      return;
    }

    if (typeof message.id === 'number' && typeof message.method === 'string') {
      this.sendRaw({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'Method not supported by read-only observer' },
      });
    }
  }

  private queueRefresh(sessionId: string, afterCurrent: boolean): void {
    if (!this.targets.has(sessionId) || !this.ready) return;
    if (this.refreshing.has(sessionId)) {
      if (afterCurrent) this.refreshAgain.add(sessionId);
      return;
    }
    this.refreshing.add(sessionId);
    void this.refreshLoop(sessionId).finally(() => this.refreshing.delete(sessionId));
  }

  private async refreshLoop(sessionId: string): Promise<void> {
    do {
      this.refreshAgain.delete(sessionId);
      if (!this.targets.has(sessionId) || !this.ready) return;
      const channel = agentHostChatResource(sessionId);
      try {
        this.subscriptions.set(sessionId, channel);
        const result = await this.sendRequest('subscribe', { channel });
        const snapshot = isRecord(result) && isRecord(result.snapshot) ? result.snapshot : null;
        if (!snapshot || snapshot.resource !== channel || !('state' in snapshot)) {
          throw new Error('Agent Host subscribe returned an invalid chat snapshot');
        }
        this.subscriptions.set(sessionId, channel);
        this.nextSessionAttempt.delete(sessionId);
        await this.onState(this.endpoint.key, sessionId, snapshot.state);
      } catch (error) {
        this.subscriptions.delete(sessionId);
        this.refreshAgain.delete(sessionId);
        this.nextSessionAttempt.set(sessionId, Date.now() + this.retryMs);
        if (!(error instanceof ProtocolRequestError)) {
          this.log(`Agent Host chat subscription failed pid=${this.endpoint.pid} ${errorDiagnostic(error)}`);
        }
        return;
      }
    } while (this.refreshAgain.has(sessionId));
  }

  private sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Agent Host ${method} request timed out`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      if (!this.sendRaw({ jsonrpc: '2.0', id, method, params })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('Agent Host protocol socket is not open'));
      }
    });
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    this.sendRaw({ jsonrpc: '2.0', method, params });
  }

  private sendRaw(message: Record<string, unknown>): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
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
  private started = false;

  constructor(options: LocalAgentHostStateSourceOptions = {}) {
    const userDataPath = options.userDataPath ??
      process.env.AGENTKEYS_VSCODE_USER_DATA ??
      path.join(os.homedir(), 'Library', 'Application Support', 'Code');
    this.registryPath = options.registryPath ?? path.join(userDataPath, 'agent-host', 'local-endpoint');
    this.retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.log = options.log ?? (() => {});
  }

  start(handler: AgentHostStateHandler, unavailableHandler?: AgentHostUnavailableHandler): void {
    if (this.started) return;
    this.handler = handler;
    this.unavailableHandler = unavailableHandler ?? null;
    this.started = true;
    this.reconcileEndpoints();
  }

  setSessions(sessionIds: readonly string[]): void {
    this.desiredSessions = new Set(sessionIds);
    for (const sessionId of this.owners.keys()) {
      if (!this.desiredSessions.has(sessionId)) this.owners.delete(sessionId);
    }
    if (!this.started) return;
    this.reconcileEndpoints();
    this.assignSessions();
  }

  stop(): void {
    this.started = false;
    this.handler = null;
    this.unavailableHandler = null;
    this.desiredSessions.clear();
    this.owners.clear();
    for (const connection of this.connections.values()) connection.stop();
    this.connections.clear();
  }

  private reconcileEndpoints(): void {
    const endpoints = readLocalAgentHostEndpoints(this.registryPath);
    const liveKeys = new Set(endpoints.map((endpoint) => endpoint.key));
    for (const [key, connection] of this.connections) {
      if (liveKeys.has(key)) continue;
      connection.stop();
      this.connections.delete(key);
      this.notifyUnavailable(this.releaseOwners(key));
    }
    for (const endpoint of endpoints) {
      if (this.connections.has(endpoint.key)) continue;
      this.connections.set(endpoint.key, new EndpointConnection(
        endpoint,
        this.retryMs,
        this.requestTimeoutMs,
        (endpointKey, sessionId, state) => this.handleState(endpointKey, sessionId, state),
        (endpointKey) => {
          this.notifyUnavailable(this.releaseOwners(endpointKey));
          this.assignSessions();
        },
        this.log
      ));
    }
  }

  private assignSessions(): void {
    for (const [key, connection] of this.connections) {
      const sessions = new Set<string>();
      for (const sessionId of this.desiredSessions) {
        const owner = this.owners.get(sessionId);
        if (!owner || owner === key) sessions.add(sessionId);
      }
      connection.setSessions(sessions);
    }
  }

  private async handleState(endpointKey: string, sessionId: string, state: unknown): Promise<void> {
    if (!this.desiredSessions.has(sessionId)) return;
    const owner = this.owners.get(sessionId);
    if (owner && owner !== endpointKey) return;
    if (!owner) {
      this.owners.set(sessionId, endpointKey);
      this.assignSessions();
    }
    await this.handler?.(sessionId, state);
  }

  private releaseOwners(endpointKey: string): string[] {
    const released: string[] = [];
    for (const [sessionId, owner] of this.owners) {
      if (owner !== endpointKey) continue;
      this.owners.delete(sessionId);
      released.push(sessionId);
    }
    return released;
  }

  private notifyUnavailable(sessionIds: readonly string[]): void {
    if (sessionIds.length === 0 || !this.unavailableHandler) return;
    void Promise.resolve(this.unavailableHandler(sessionIds)).catch((error) => {
      this.log(`Agent Host unavailable handler failed ${errorDiagnostic(error)}`);
    });
  }
}
