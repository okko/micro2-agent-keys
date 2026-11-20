import * as path from 'node:path';
import { readConfig, validateConfig, writeConfig } from './config.js';
import { Device, type DeviceOptions } from './device.js';
import type { CredentialStore } from './input-credentials.js';
import { LocalAgentHostStateSource, type AgentHostStateSource } from './agent-host.js';
import { STATES } from './states.js';
import { VSCodeIntegration, type VSCodeSlot } from './vscode.js';

export interface RuntimeSnapshot {
  keyCount: number | null;
  connected: boolean;
  connecting: boolean;
  inputError: string | null;
  registryPath: string;
  availableSessions: number;
  trackedSessions: number;
  slots: VSCodeSlot[];
  logs: string[];
}

export type RuntimeCommand =
  | { type: 'configure'; keyCount: number }
  | { type: 'open'; slot: number }
  | { type: 'reset' | 'restart' | 'forgetAuthorization' };

export interface RuntimeService {
  start(): Promise<void>;
  stop(): Promise<void>;
  snapshot(): RuntimeSnapshot;
  execute(command: RuntimeCommand): Promise<void>;
}

interface InputConnection {
  readonly connected: boolean;
  setLighting: Device['setLighting'];
  refreshLighting(): void;
  close(): Promise<void>;
}

interface RuntimeOptions {
  directory: string;
  registryPath: string;
  uriScheme: string;
  credentials: CredentialStore;
  launch: (url: string) => Promise<void>;
  log: (message: string) => void;
  createDevice?: (options: DeviceOptions) => Promise<InputConnection>;
  createSource?: () => AgentHostStateSource;
  retryMs?: number;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AgentKeysRuntime implements RuntimeService {
  private integration: VSCodeIntegration | null = null;
  private device: InputConnection | null = null;
  private connecting: Promise<void> | null = null;
  private connectionAbort: AbortController | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private retryDelay: number;
  private inputError: string | null = null;
  private stopped = true;
  private readonly logs: string[] = [];
  private readonly configPath: string;
  private operations: Promise<void> = Promise.resolve();

  constructor(private readonly options: RuntimeOptions) {
    this.configPath = path.join(options.directory, 'config.json');
    this.retryDelay = options.retryMs ?? 3000;
  }

  private log = (...args: unknown[]): void => {
    const message = `${new Date().toISOString()} ${args.map(String).join(' ')}`;
    this.logs.push(message);
    if (this.logs.length > 30) this.logs.shift();
    this.options.log(message);
  };

  async start(): Promise<void> {
    this.stopped = false;
    const config = readConfig(this.configPath);
    if (config) await this.startIntegration(config.keyCount);
    else this.log('Choose AgentKeys: Configure Keys to begin (1-20 consecutive API Smart Actions).');
  }

  private async startIntegration(keyCount: number): Promise<void> {
    const integration = new VSCodeIntegration({
      statePath: path.join(this.options.directory, 'sessions.json'),
      uriScheme: this.options.uriScheme,
      enabledSlots: Array.from({ length: keyCount }, (_, index) => index),
      agentHostSource: this.options.createSource?.() ??
        new LocalAgentHostStateSource({ registryPath: this.options.registryPath, log: this.log }),
      launch: this.options.launch,
      log: this.log,
      onSlot: async () => {
        if (!this.stopped) await this.push();
      },
    });
    this.integration = integration;
    await integration.start();
    this.beginConnect();
  }

  snapshot(): RuntimeSnapshot {
    const status = this.integration?.status();
    return {
      keyCount: this.integration?.enabledSlots.size ?? null,
      connected: this.device?.connected ?? false,
      connecting: this.connecting !== null,
      inputError: this.device && !this.device.connected
        ? 'No supported keyboard ready in Input; connect it and wait for Input to load it'
        : this.inputError,
      registryPath: this.options.registryPath,
      availableSessions: status?.availableSessions ?? 0,
      trackedSessions: status?.trackedSessions ?? 0,
      slots: status?.bindings ?? [],
      logs: [...this.logs],
    };
  }

  execute(command: RuntimeCommand): Promise<void> {
    const operation = this.operations.then(async () => {
      if (this.stopped) throw new Error('AgentKeys is stopping; retry in another VS Code window');
      if (command.type === 'configure') {
        const config = validateConfig({ keyCount: command.keyCount });
        writeConfig(config, this.configPath);
        if (!this.integration) await this.startIntegration(config.keyCount);
        else {
          const previousKeyCount = this.integration.enabledSlots.size;
          await this.integration.setEnabledSlots(Array.from({ length: config.keyCount }, (_, index) => index));
          // Clear disabled keys before dropping them from the device's desired-state cache.
          const device = this.device;
          if (device) {
            const slots = Array.from({ length: 20 }, (_, id) => ({
              id, ...STATES[this.integration?.slots[id]?.state ?? 'idle'],
            }));
            try {
              await device.setLighting(slots.slice(0, Math.max(config.keyCount, previousKeyCount)));
            } catch (error) {
              await this.dropDevice(device, error);
              throw error;
            }
          }
          await this.restartInput();
        }
      } else if (command.type === 'restart' || command.type === 'forgetAuthorization') {
        await this.disconnect();
        if (command.type === 'forgetAuthorization') await this.options.credentials.remove();
        if (this.integration) {
          this.integration.stop();
          await this.startIntegration(this.integration.enabledSlots.size);
        }
      } else {
        if (!this.integration) throw new Error('Choose AgentKeys: Configure Keys first');
        if (command.type === 'open') await this.integration.open(command.slot);
        else {
          await this.integration.resetSlots();
          this.device?.refreshLighting();
          await this.push();
          this.log('Reset keys: bindings cleared; existing turns remain suppressed until new work starts.');
        }
      }
    });
    this.operations = operation.catch((error: unknown) => this.log('Command failed:', errorMessage(error)));
    return operation;
  }

  private beginConnect(): void {
    if (this.stopped || this.connecting || this.device) return;
    const abort = new AbortController();
    this.connectionAbort = abort;
    this.connecting = this.connect(abort.signal).catch((error: unknown) => {
      if (abort.signal.aborted || this.stopped) return;
      this.inputError = errorMessage(error);
      this.log('Input connection failed:', this.inputError);
      this.scheduleReconnect();
    }).finally(() => { this.connecting = null; });
  }

  private async connect(signal: AbortSignal): Promise<void> {
    let candidate: InputConnection | null = null;
    candidate = await (this.options.createDevice ?? Device.open)({
      credentials: this.options.credentials,
      signal,
      log: this.log,
      onKey: (slot) => {
        if (this.stopped || !this.integration?.enabledSlots.has(slot)) return;
        void this.execute({ type: 'open', slot }).catch((error: unknown) => {
          this.log(`Key ${slot} could not open its session:`, errorMessage(error));
        });
      },
      onFailure: (error) => {
        if (!this.stopped && candidate) void this.dropDevice(candidate, error);
      },
    });
    if (this.stopped || signal.aborted) {
      await candidate.close();
      return;
    }
    this.device = candidate;
    this.inputError = null;
    this.retryDelay = this.options.retryMs ?? 3000;
    this.log('Input connected');
    await this.push();
  }

  private async push(): Promise<void> {
    const device = this.device;
    if (!device || !this.integration) return;
    try {
      await device.setLighting(this.integration.publicSlots().map((slot) => ({
        id: slot.slot, ...STATES[slot.state],
      })));
    } catch (error) {
      await this.dropDevice(device, error);
    }
  }

  private async dropDevice(device: InputConnection, error: unknown): Promise<void> {
    if (this.device !== device) return;
    this.device = null;
    this.inputError = errorMessage(error);
    this.log('Input connection failed:', this.inputError);
    try { await device.close(); }
    catch (closeError) { this.log('Input close failed:', errorMessage(closeError)); }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.beginConnect();
    }, this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 60_000);
  }

  private async disconnect(): Promise<void> {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.connectionAbort?.abort();
    await this.connecting;
    const device = this.device;
    this.device = null;
    if (device) await device.close();
  }

  private async restartInput(): Promise<void> {
    await this.disconnect();
    this.retryDelay = this.options.retryMs ?? 3000;
    this.beginConnect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.operations;
    try { this.integration?.stop(); }
    finally { await this.disconnect(); }
  }
}
