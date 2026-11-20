import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { errorMessage, type RuntimeCommand, type RuntimeService, type RuntimeSnapshot } from './runtime.js';

const HOST = '127.0.0.1';
export const COORDINATOR_PORT = 19148;
const PROTOCOL = 1;

export interface CoordinatorState {
  role: 'connecting' | 'owner' | 'follower';
  snapshot: RuntimeSnapshot | null;
  error: string | null;
}

interface CoordinatorOptions {
  directory: string;
  createRuntime: () => RuntimeService;
  onChange: (state: CoordinatorState) => void;
  log: (message: string) => void;
  port?: number;
  retryMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCommand(value: unknown): value is RuntimeCommand {
  if (!isRecord(value)) return false;
  if (value.type === 'configure') return Number.isInteger(value.keyCount) && Number(value.keyCount) >= 1 && Number(value.keyCount) <= 20;
  if (value.type === 'open') return Number.isInteger(value.slot) && Number(value.slot) >= 0 && Number(value.slot) < 20;
  return value.type === 'reset' || value.type === 'restart' || value.type === 'forgetAuthorization';
}

function isSnapshot(value: unknown): value is RuntimeSnapshot {
  if (!isRecord(value)) return false;
  return (value.keyCount === null || (Number.isInteger(value.keyCount) && Number(value.keyCount) >= 1 && Number(value.keyCount) <= 20)) &&
    typeof value.connected === 'boolean' && typeof value.connecting === 'boolean' &&
    (value.inputError === null || typeof value.inputError === 'string') &&
    typeof value.registryPath === 'string' && typeof value.availableSessions === 'number' &&
    typeof value.trackedSessions === 'number' && Array.isArray(value.logs) && value.logs.every((line) => typeof line === 'string') &&
    Array.isArray(value.slots) && value.slots.length <= 20 && value.slots.every((slot: unknown) =>
      isRecord(slot) && Number.isInteger(slot.slot) && Number(slot.slot) >= 0 && Number(slot.slot) < 20 &&
      ['idle', 'running', 'input', 'done', 'error'].includes(String(slot.state)) &&
      ['sessionId', 'cwd', 'resource', 'label', 'stateChangedAt'].every((field) => slot[field] === undefined || typeof slot[field] === 'string') &&
      (slot.runError === undefined || slot.runError === null || typeof slot.runError === 'string'));
}

/** The listening socket is the lock: only one extension host may own Input and AHP. */
export class Coordinator {
  private server: Server | null = null;
  private peers: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private runtime: RuntimeService | null = null;
  private timer: NodeJS.Timeout | null = null;
  private attempt: Promise<void> | null = null;
  private stopped = false;
  private sequence = 0;
  private lastState = '';
  private lastMessageAt = 0;
  private stopping: Promise<void> | null = null;
  private readonly pending = new Map<number, { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private state: CoordinatorState = { role: 'connecting', snapshot: null, error: null };
  private readonly tokenPath: string;

  constructor(private readonly options: CoordinatorOptions) {
    this.tokenPath = path.join(options.directory, 'coordinator-token');
  }

  get port(): number {
    const address = this.server?.address();
    return address && typeof address !== 'string' ? address.port : this.options.port ?? COORDINATOR_PORT;
  }

  start(): void {
    this.timer = setInterval(() => {
      if (this.runtime) this.publish();
      else if (this.client && Date.now() - this.lastMessageAt > 10_000) {
        this.setError('AgentKeys owner is not responding; waiting for its extension host to recover');
        this.client.terminate();
      } else if (!this.client) this.tryConnect();
    }, this.options.retryMs ?? 500);
    this.tryConnect();
  }

  private tryConnect(): void {
    if (this.stopped || this.attempt || this.server) return;
    this.attempt = this.connect().catch((error: unknown) => this.setError(errorMessage(error)))
      .finally(() => { this.attempt = null; });
  }

  private async connect(): Promise<void> {
    const server = createServer((_request, response) => { response.writeHead(404).end(); });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.options.port ?? COORDINATOR_PORT, HOST, () => {
          server.off('error', reject);
          resolve();
        });
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      if (!this.stopped) this.follow();
      return;
    }
    this.server = server;
    server.on('error', (error) => this.setError(`AgentKeys coordination failed: ${error.message}`));
    if (this.stopped) return;
    try {
      fs.mkdirSync(this.options.directory, { recursive: true, mode: 0o700 });
      const token = randomBytes(32).toString('hex');
      fs.writeFileSync(this.tokenPath, token, { mode: 0o600 });
      const peers = new WebSocketServer({ noServer: true, maxPayload: 262144 });
      this.peers = peers;
      server.on('upgrade', (request, socket, head) => {
        if (this.stopped || request.headers.authorization !== `Bearer ${token}` || request.url !== '/eu.okko.agentkeys/v1') {
          socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
          return;
        }
        peers.handleUpgrade(request, socket, head, (peer) => peers.emit('connection', peer, request));
      });
      peers.on('connection', (peer) => {
        peer.on('error', (error) => this.options.log(`AgentKeys peer error: ${error.message}`));
        peer.on('message', (data) => { void this.handleCommand(peer, data.toString()); });
        this.send(peer, { protocol: PROTOCOL, snapshot: this.runtime?.snapshot() ?? null, error: this.state.error });
      });
      this.runtime = this.options.createRuntime();
      this.state = { role: 'owner', snapshot: null, error: null };
      try { await this.runtime.start(); }
      catch (error) { this.setError(`AgentKeys startup failed: ${errorMessage(error)}`); }
      this.publish();
    } catch (error) {
      // Retain the lock on startup failure; don't let every window repeat a broken startup.
      this.setError(errorMessage(error));
    }
  }

  private follow(): void {
    const token = fs.readFileSync(this.tokenPath, 'utf8');
    if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('Invalid AgentKeys coordination token');
    const client = new WebSocket(`ws://${HOST}:${this.port}/eu.okko.agentkeys/v1`, {
      headers: { authorization: `Bearer ${token}` }, handshakeTimeout: 3000, maxPayload: 262144,
    });
    this.client = client;
    this.lastMessageAt = Date.now();
    client.on('message', (data) => {
      try {
        const message: unknown = JSON.parse(data.toString());
        if (!isRecord(message) || message.protocol !== PROTOCOL) throw new Error('Incompatible AgentKeys extension in another window; reload all windows');
        this.lastMessageAt = Date.now();
        if ('snapshot' in message) {
          if (message.snapshot !== null && !isSnapshot(message.snapshot)) throw new Error('Invalid AgentKeys status from owner');
          if (message.error !== null && typeof message.error !== 'string') throw new Error('Invalid AgentKeys owner error');
          this.state = { role: 'follower', snapshot: message.snapshot, error: message.error };
          this.notify();
        } else if (typeof message.id === 'number') {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(message.id);
          if (message.error === null) pending.resolve();
          else pending.reject(new Error(typeof message.error === 'string' ? message.error : 'Invalid command response'));
        }
      } catch (error) {
        this.setError(errorMessage(error));
        client.terminate();
      }
    });
    client.on('error', () => this.setError('Cannot reach the AgentKeys owner. Check for a port 19148 conflict or reload the owning window.'));
    client.on('close', () => {
      if (this.client !== client) return;
      this.client = null;
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error('AgentKeys owner disconnected; command outcome is unknown. Check status before retrying.'));
      }
      this.pending.clear();
      this.state = { role: 'connecting', snapshot: null, error: 'Waiting for an AgentKeys owner' };
      if (!this.stopped) this.notify();
    });
  }

  private async handleCommand(peer: WebSocket, text: string): Promise<void> {
    let id: number | undefined;
    try {
      const request: unknown = JSON.parse(text);
      if (!isRecord(request) || request.protocol !== PROTOCOL || !Number.isSafeInteger(request.id) || !isCommand(request.command)) {
        throw new Error('Invalid AgentKeys command');
      }
      id = Number(request.id);
      await this.execute(request.command);
      this.send(peer, { protocol: PROTOCOL, id, error: null });
    } catch (error) {
      this.options.log(`AgentKeys command failed: ${errorMessage(error)}`);
      if (id !== undefined) this.send(peer, { protocol: PROTOCOL, id, error: errorMessage(error) });
      else peer.close(1008, 'Invalid command');
    }
  }

  async execute(command: RuntimeCommand): Promise<void> {
    if (this.stopped) throw new Error('AgentKeys is stopping');
    if (this.runtime) {
      await this.runtime.execute(command);
      this.state.error = null;
      this.publish();
      return;
    }
    if (this.client?.readyState !== WebSocket.OPEN) throw new Error('AgentKeys owner is not connected yet');
    const id = ++this.sequence;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('AgentKeys command timed out; check status before retrying'));
      }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.send(this.client!, { protocol: PROTOCOL, id, command });
    });
  }

  private send(peer: WebSocket, message: object): void {
    if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify(message));
  }

  private publish(): void {
    if (this.stopped || !this.runtime) return;
    this.state = { ...this.state, role: 'owner', snapshot: this.runtime.snapshot() };
    for (const peer of this.peers?.clients ?? []) {
      this.send(peer, { protocol: PROTOCOL, snapshot: this.state.snapshot, error: this.state.error });
    }
    this.notify();
  }

  private setError(message: string): void {
    if (this.stopped) return;
    if (message !== this.state.error) this.options.log(message);
    this.state = { ...this.state, error: message };
    this.notify();
  }

  private notify(): void {
    const text = JSON.stringify(this.state);
    if (text === this.lastState) return;
    this.lastState = text;
    this.options.onChange(this.state);
  }

  stop(): Promise<void> {
    this.stopping ??= this.shutdown();
    return this.stopping;
  }

  private async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.client?.terminate();
    await this.attempt;
    try { await this.runtime?.stop(); }
    finally {
      for (const peer of this.peers?.clients ?? []) peer.terminate();
      this.peers?.close();
      if (this.server) {
        await new Promise<void>((resolve, reject) => {
          this.server!.close((error) => error ? reject(error) : resolve());
          this.server!.closeAllConnections();
        });
      }
    }
  }
}
