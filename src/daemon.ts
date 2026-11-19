import * as fs from 'fs';
import { Device } from './device.js';
import { type SlotLighting } from './lighting.js';
import { STATES, DEFAULT_STATE } from './states.js';
import { readConfig } from './config.js';
import { VSCodeIntegration, type VSCodeSlot } from './vscode.js';
import { LocalAgentHostStateSource } from './agent-host.js';
import { createServer, HOST, PORT, type DaemonApi } from './daemon-http.js';
import type { Slot } from './daemon-interfaces.js';

const RECONNECT_MS = 3000;
const SHUTDOWN_TIMEOUT_MS = 4000;
const BUILD_ID = fs.readFileSync(new URL('./build-id', import.meta.url), 'utf8').trim();

// LaunchServices discards stdout, so the app-bundle launch needs a real file.
if (process.env.AGENTKEYS_LOG) {
  const stream = fs.createWriteStream(process.env.AGENTKEYS_LOG, { flags: 'a' });
  const write = (...args: unknown[]): void => {
    stream.write(args.map(String).join(' ') + '\n');
  };
  console.log = write;
  console.error = write;
  process.on('uncaughtException', (err) => write('uncaught:', err.stack));
}

const config = readConfig();
if (!config) throw new Error('AgentKeys key count is not configured; run node dist/configure.js or scripts/install-agent.sh');

const slots: Slot[] = Array.from({ length: config.keyCount }, (_, index) => ({
  index,
  state: DEFAULT_STATE,
  label: null,
  updatedAt: null,
}));

let device: Device | null = null;
let connecting: Promise<void> | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconnectDelay = RECONNECT_MS;
const pendingPushes = new Set<Promise<void>>();
let shuttingDown = false;
let deviceError: string | null = null;

/** Writes an ISO-timestamped line to the daemon log. */
function log(...args: unknown[]): void {
  console.log(new Date().toISOString(), ...args);
}

/** Extracts a message from an unknown throw value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function lightingFor(slot: Slot): SlotLighting {
  const spec = STATES[slot.state];
  return { id: slot.index, color: spec.color, effect: spec.effect, speed: spec.speed ?? 0.5 };
}

/** The device coalesces pending states and waits for Input's lighting acknowledgements. */
function push(changed?: Slot): Promise<void> {
  const current = device;
  if (!current) return Promise.resolve();
  const targets = changed ? [changed] : slots;
  const write = current.setLighting(targets.map(lightingFor));
  const operation = write.then(
    () => {},
    async (err: unknown) => {
      log('push failed:', errorMessage(err));
      deviceError = errorMessage(err);
      await dropDevice(current);
    }
  );
  pendingPushes.add(operation);
  void operation.finally(() => pendingPushes.delete(operation));
  return operation;
}

const vscode = new VSCodeIntegration({
  log,
  enabledSlots: slots.map(({ index }) => index),
  agentHostSource: new LocalAgentHostStateSource({ log }),
  onSlot: async (binding: VSCodeSlot) => {
    if (shuttingDown) return;
    const slot = slots[binding.slot];
    slot.state = binding.state;
    slot.label = binding.label ?? null;
    slot.updatedAt = binding.stateChangedAt ?? null;
    await push(slot);
  },
});

/** Closes a failed handle and starts reconnecting; ignores handles already replaced. */
async function dropDevice(current: Device): Promise<void> {
  if (device !== current) return;
  device = null;
  try {
    await current.close();
  } catch (err) {
    log('Input close failed:', errorMessage(err));
  }
  scheduleReconnect();
}

/** Back off while Input is unavailable instead of repeatedly opening its socket. */
function scheduleReconnect(): void {
  if (shuttingDown || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect().catch((err: unknown) => {
      log('Input connection failed:', errorMessage(err), '- keep Input.app running');
      scheduleReconnect();
    });
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 60_000);
}

/** Connects unless already connected, sharing one in-flight attempt among concurrent callers. */
async function connect(): Promise<void> {
  if (shuttingDown || device) return;
  if (connecting) return connecting;
  connecting = connectDevice();
  try {
    await connecting;
  } finally {
    connecting = null;
  }
}

async function connectDevice(): Promise<void> {
  let candidate: Device | null = null;
  try {
    candidate = await Device.open({
      log,
      onKey: (slot) => {
        if (shuttingDown) return;
        void vscode.open(slot).catch((err: unknown) => log(`key vscode${String(slot).padStart(2, '0')} open failed: ${errorMessage(err)}`));
      },
      onFailure: (err) => {
        deviceError = errorMessage(err);
        log('Input connection failed:', deviceError);
        if (candidate) void dropDevice(candidate);
      },
    });
    if (shuttingDown) {
      await candidate.close();
      return;
    }
    device = candidate;
    deviceError = null;
    reconnectDelay = RECONNECT_MS;
    log('Input connected');
    await push();
  } catch (err) {
    deviceError = errorMessage(err);
    if (device === candidate) device = null;
    try {
      await candidate?.close();
    } catch (closeError) {
      log('Input close failed:', errorMessage(closeError));
    }
    throw err;
  }
}

/** Records a validated slot change and lights it. */
async function setSlot(index: number, state: string, label: string | null): Promise<Slot> {
  const slot = slots[index];
  slot.state = state;
  slot.label = label;
  slot.updatedAt = new Date().toISOString();
  const updatedSlot = { ...slot };
  await push(updatedSlot);
  return updatedSlot;
}

/** Returns every slot to {@link DEFAULT_STATE} and repaints the keyboard. */
async function reset(): Promise<Slot[]> {
  for (const slot of slots) {
    slot.state = DEFAULT_STATE;
    slot.label = null;
    slot.updatedAt = new Date().toISOString();
  }
  const resetSlots = slots.map((slot) => ({ ...slot }));
  await push();
  return resetSlots;
}

/** Retry newly mapped API keys and free every VS Code binding. */
async function resetVSCodeSlots(): Promise<VSCodeSlot[]> {
  device?.refreshLighting();
  return vscode.resetSlots();
}

const api: DaemonApi = {
  buildId: BUILD_ID,
  vscode,
  log,
  status: () => ({
    connected: device?.connected ?? false,
    deviceVisible: device?.connected ?? false,
    deviceError: device && !device.connected
      ? 'No supported keyboard ready in Input; connect it and wait for Input to load it'
      : deviceError,
  }),
  slots: () => slots,
  setSlot,
  reset,
  resetVSCodeSlots,
};

const server = createServer(api);

/**
 * Stops accepting requests, drains pushes, and closes Input. Lighting is restored on reconnect.
 * A deadline prevents an unresponsive connection from delaying launchd.
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal}, shutting down`);
  const shutdownTimer = setTimeout(() => {
    log('shutdown timed out; forcing exit');
    process.exit(0);
  }, SHUTDOWN_TIMEOUT_MS);

  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  vscode.stop();

  await new Promise<void>((resolve) => {
    server.close((err) => {
      if (err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
        log('server close failed:', errorMessage(err));
      }
      resolve();
    });
    server.closeAllConnections();
  });

  if (connecting) {
    try {
      await connecting;
    } catch {
      // A failed connection has no live handle to close.
    }
  }
  while (pendingPushes.size) await Promise.allSettled([...pendingPushes]);

  const current = device;
  device = null;
  if (current) {
    try {
      await current.close();
    } catch (err) {
      log('close failed:', errorMessage(err));
    }
  }
  clearTimeout(shutdownTimer);
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => shutdown(signal));

server.listen(PORT, HOST, () => log(`listening on http://${HOST}:${PORT}`));
void (async () => {
  if (process.env.AGENTKEYS_NO_DEVICE !== '1') {
    try {
      await connect();
    } catch (err) {
      log('Input connection failed:', errorMessage(err), '- keep Input.app running');
      scheduleReconnect();
    }
  }
  await vscode.start();
})().catch((err: unknown) => log(`VS Code integration disabled: ${errorMessage(err)}`));
