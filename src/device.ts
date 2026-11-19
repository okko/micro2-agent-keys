import {
  InputClient,
  InputApiError,
  type DeviceSummary,
} from '@worklouder/input-kit';
import { keychainCredentials, type CredentialStore } from './input-credentials.js';
import { slotForIdentifier, slotIdentifier, type SlotLighting } from './lighting.js';

const SUPPORTED_DEVICES = new Set(['creator_micro_v2_base', 'creator_micro_v2_pro', 'codex_micro']);
let lastAuthorizationAttempt = -Infinity;

interface DeviceOptions {
  client?: InputClient;
  credentials?: CredentialStore;
  log: (...args: unknown[]) => void;
  onKey: (slot: number) => void;
  onFailure: (error: Error) => void;
}

export class Device {
  readonly #client: InputClient;
  readonly #options: DeviceOptions;
  #selected: number | undefined;
  #devicesRevision = 0;
  #lightingRevision = 0;
  #closed = false;
  #ready = false;
  #desired = new Map<number, SlotLighting>();
  #pending = new Map<number, SlotLighting>();
  #applied = new Map<number, string>();
  #missing = new Set<number>();
  #draining: Promise<void> | null = null;

  private constructor(options: DeviceOptions) {
    this.#options = options;
    this.#client = options.client ?? new InputClient({ applicationName: 'AgentKeys' });
    this.#client.on('devicesUpdated', ({ devices }) => {
      this.#devicesRevision++;
      this.#replaceDevices(devices);
    });
    this.#client.on('deviceInfoChanged', ({ deviceId }) => {
      if (deviceId === this.#selected) this.refreshLighting();
    });
    this.#client.on('keyTriggered', ({ deviceId, identifier, action }) => {
      if (!this.connected || deviceId !== this.#selected || action === 'release') return;
      const slot = slotForIdentifier(identifier);
      if (slot !== null) options.onKey(slot);
    });
    this.#client.on('disconnected', () => {
      this.#selected = undefined;
      if (!this.#closed) options.onFailure(new Error('Input disconnected; keep Input.app running'));
    });
    this.#client.on('transportError', (error) => options.log('Input transport error:', error.message));
    this.#client.on('protocolError', (error) => options.log('Input protocol error:', error.message));
  }

  get connected(): boolean {
    return this.#ready && !this.#closed && this.#client.connected && this.#selected !== undefined;
  }

  static async open(options: DeviceOptions): Promise<Device> {
    const device = new Device(options);
    const store = options.credentials ?? keychainCredentials;
    try {
      // Load before connecting: Input allows only 30 seconds to authenticate.
      let credentials = await store.load();
      await device.#client.connect();
      if (credentials) {
        try {
          await device.#client.authenticate(credentials);
        } catch (error) {
          if (!(error instanceof InputApiError) || error.code !== -32001) throw error;
          await store.remove();
          credentials = null;
          options.log('Input authorization revoked; requesting approval again');
        }
      }
      if (!credentials) {
        if (Date.now() - lastAuthorizationAttempt < 60_000) {
          throw new Error('Input approval pending or denied; retrying authorization after one minute');
        }
        lastAuthorizationAttempt = Date.now();
        options.log('Approve AgentKeys in Input within 30 seconds; credentials are saved in macOS Keychain');
        credentials = await device.#client.requestAuthorization();
        await store.save(credentials);
      }
      const revision = device.#devicesRevision;
      const devices = await device.#client.getDevices();
      if (revision === device.#devicesRevision) device.#replaceDevices(devices);
      if (!device.#client.connected) throw new Error('Input disconnected during setup');
      device.#ready = true;
      return device;
    } catch (error) {
      try {
        await device.close();
      } catch (closeError) {
        options.log('Input close failed:', closeError instanceof Error ? closeError.message : String(closeError));
      }
      throw error;
    }
  }

  #replaceDevices(devices: DeviceSummary[]): void {
    if (this.#closed) return;
    const available = devices.filter(({ deviceType }) => SUPPORTED_DEVICES.has(deviceType));
    const selected = available.find(({ id }) => id === this.#selected) ?? available[0];
    this.#selected = selected?.id;
    this.#options.log(selected
      ? `Input device selected: ${selected.deviceType} (${selected.id})`
      : 'No supported device ready in Input; connect the keyboard and wait for Input to load it');
    this.refreshLighting();
  }

  /** Repaint after a profile/layer change or an explicit reset, including newly mapped keys. */
  refreshLighting(): void {
    this.#lightingRevision++;
    this.#applied.clear();
    this.#missing.clear();
    this.#pending = new Map(this.#desired);
    void this.#flush().catch((error: unknown) => {
      if (!this.#closed) this.#options.onFailure(error instanceof Error ? error : new Error(String(error)));
    });
  }

  setLighting(slots: SlotLighting[]): Promise<void> {
    for (const slot of slots) {
      slotIdentifier(slot.id);
      const snapshot = { ...slot };
      this.#desired.set(slot.id, snapshot);
      this.#pending.set(slot.id, snapshot);
    }
    return this.#flush();
  }

  #flush(): Promise<void> {
    if (!this.#draining) {
      this.#draining = this.#render().finally(() => { this.#draining = null; });
    }
    return this.#draining.then(() => {
      // Notifications can enqueue a repaint while the previous drain is settling.
      if (this.connected && this.#pending.size) return this.#flush();
      return undefined;
    });
  }

  async #render(): Promise<void> {
    while (this.connected && this.#pending.size) {
      const [id, slot] = this.#pending.entries().next().value!;
      this.#pending.delete(id);
      const signature = JSON.stringify(slot);
      if (this.#applied.get(id) === signature || this.#missing.has(id)) continue;
      const revision = this.#lightingRevision;
      const deviceId = this.#selected!;
      for (let attempt = 0; ; attempt++) {
        if (!this.connected || revision !== this.#lightingRevision) break;
        try {
          await this.#client.setKeyLighting({
            deviceId,
            identifier: slotIdentifier(id),
            isRegex: false,
            color: slot.color,
            brightness: 1,
            effect: slot.effect,
            speed: slot.speed ?? 0.5,
          });
          if (revision === this.#lightingRevision) this.#applied.set(id, signature);
          break;
        } catch (error) {
          if (revision !== this.#lightingRevision) break;
          if (error instanceof InputApiError && error.code === -32009) {
            this.#missing.add(id);
            this.#options.log(`Input API Smart Action ${slotIdentifier(id)} is not mapped; skipping lighting until a layer change or slot reset`);
            break;
          }
          if (error instanceof InputApiError && error.code === -32017 && attempt < 5) {
            const delay = 250 * 2 ** attempt;
            this.#options.log(`Input device rate limit; retrying lighting in ${delay}ms`);
            await new Promise<void>((resolve) => setTimeout(resolve, delay));
            // A newer state supersedes this retry.
            if (this.#pending.has(id)) break;
            continue;
          }
          throw error;
        }
      }
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#ready = false;
    this.#selected = undefined;
    this.#pending.clear();
    await this.#client.close();
  }
}
