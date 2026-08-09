import * as fs from 'fs';
import { Device, listDevices, type DeviceMessage, type NotifyHandler } from './device.js';
import { setThreads, setZones, EFFECT, type ThreadInput } from './oai.js';
import { STATES, SLOT_COUNT, DEFAULT_STATE } from './states.js';
import { VSCodeIntegration, type VSCodeSlot } from './vscode.js';
import { LocalAgentHostStateSource } from './agent-host.js';
import { createServer, HOST, PORT, type DaemonApi } from './daemon-http.js';
import type { Slot } from './daemon-interfaces.js';

const RECONNECT_MS = 3000;
const RECONCILE_MS = 250;
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

const slots: Slot[] = Array.from({ length: SLOT_COUNT }, (_, index) => ({
  index,
  state: DEFAULT_STATE,
  label: null,
  updatedAt: null,
}));

let device: Device | null = null;
let connecting: Promise<void> | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconcileTimer: NodeJS.Timeout | null = null;
let pushGeneration = 0;
const pendingPushes = new Set<Promise<void>>();
let shuttingDown = false;
let visibleDeviceCount = 0;
let deviceVisibilityKnown = false;
let deviceError: string | null = null;

/** Writes an ISO-timestamped line to the daemon log. */
function log(...args: unknown[]): void {
  console.log(new Date().toISOString(), ...args);
}

/** Extracts a message from an unknown throw value. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Translates a slot's state into the firmware thread payload that lights its key. */
function threadFor(slot: Slot): ThreadInput {
  const spec = STATES[slot.state];
  return { id: slot.index, color: spec.color, effect: spec.effect, speed: spec.speed ?? 0.5 };
}

/**
 * Sends slot lighting to the device: `changed` alone for latency, or every slot when omitted.
 * A successful partial write schedules a full re-send {@link RECONCILE_MS} later so a dropped
 * report cannot leave a key stale; a newer push or a device swap cancels it. Write failures are
 * logged and drop the device rather than rejecting, so callers never need to catch.
 * @returns a promise that settles once the write (and its error handling) is done.
 */
function push(changed?: Slot): Promise<void> {
  const current = device;
  if (!current) return Promise.resolve();
  const generation = ++pushGeneration;
  if (reconcileTimer) clearTimeout(reconcileTimer);
  reconcileTimer = null;
  const targets = changed ? [changed] : slots;
  const write = setThreads(current, targets.map(threadFor));
  const operation = write.then(
    () => {},
    async (err: unknown) => {
      log('push failed:', errorMessage(err));
      await dropDevice(current);
    }
  );
  void write.then(
    () => {
      if (shuttingDown || device !== current || generation !== pushGeneration) return;
      reconcileTimer = setTimeout(() => {
        reconcileTimer = null;
        if (shuttingDown || device !== current || generation !== pushGeneration) return;
        const reconciliation = setThreads(current, slots.map(threadFor)).then(
          () => {},
          async (err: unknown) => {
            log('reconciliation failed:', errorMessage(err));
            await dropDevice(current);
          }
        );
        pendingPushes.add(reconciliation);
        void reconciliation.finally(() => pendingPushes.delete(reconciliation));
      }, RECONCILE_MS);
    },
    () => {}
  );
  pendingPushes.add(operation);
  void operation.finally(() => pendingPushes.delete(operation));
  return operation;
}

const vscode = new VSCodeIntegration({
  log,
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
  pushGeneration++;
  if (reconcileTimer) clearTimeout(reconcileTimer);
  reconcileTimer = null;
  try {
    await current.close();
  } catch {
    // best effort close
  }
  scheduleReconnect();
}

/** Queues a single reconnect attempt {@link RECONNECT_MS} out; repeat calls are no-ops. */
function scheduleReconnect(): void {
  if (shuttingDown || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect().catch(() => scheduleReconnect());
  }, RECONNECT_MS);
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

/**
 * Opens the vendor HID interface, subscribes to AG00..AG03 key presses so they open the matching
 * VS Code window, blacks out the base lighting, and pushes current slot colours. Absence of the
 * device is not an error: it records {@link deviceError} and retries later.
 * @throws if opening the device or the initial lighting write fails.
 */
async function connectDevice(): Promise<void> {
  const candidates = listDevices();
  const wasVisible = visibleDeviceCount > 0;
  visibleDeviceCount = candidates.length;
  const isVisible = visibleDeviceCount > 0;
  if (!deviceVisibilityKnown || wasVisible !== isVisible) {
    log(
      isVisible
        ? `vendor HID interface visible (${visibleDeviceCount})`
        : 'vendor HID interface not visible; check USB and Input Monitoring permission'
    );
    deviceVisibilityKnown = true;
  }
  if (!candidates.length) {
    deviceError = 'vendor HID interface not visible';
    scheduleReconnect();
    return;
  }

  let candidate: Device;
  try {
    candidate = await Device.open(candidates[0]);
  } catch (err) {
    deviceError = errorMessage(err);
    throw err;
  }
  const onNotify: NotifyHandler = (message: DeviceMessage) => {
    const key = message?.m === 'v.oai.hid' ? message.p?.k ?? null : null;
    const pressed = message?.p?.act === 1;
    const match = typeof key === 'string' ? key.match(/^AG0([0-3])$/) : null;
    if (!pressed || !match) return;
    vscode.open(Number(match[1])).catch((err: unknown) => log(`key ${key} open failed: ${errorMessage(err)}`));
  };
  candidate.onNotify = onNotify;
  try {
    await setZones(candidate, {
      keys: { color: 0x000000, effect: EFFECT.off, brightness: 0 },
      ambient: { color: 0x101010, effect: EFFECT.solid, brightness: 0.3 },
    });
    if (shuttingDown) {
      await candidate.close();
      return;
    }
    device = candidate;
    deviceError = null;
    log('device connected');
    await push();
  } catch (err) {
    if (device === candidate) device = null;
    try {
      await candidate.close();
    } catch {
      // best effort close
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

const api: DaemonApi = {
  buildId: BUILD_ID,
  vscode,
  log,
  status: () => ({
    connected: Boolean(device),
    deviceVisible: visibleDeviceCount > 0,
    deviceError,
  }),
  slots: () => slots,
  setSlot,
  reset,
};

const server = createServer(api);

/**
 * Stops accepting requests, drains in-flight pushes, and closes the device so the firmware keeps
 * no stale lighting, then exits. Runs once per process; a {@link SHUTDOWN_TIMEOUT_MS} timer forces
 * exit if a HID write hangs.
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
  if (reconcileTimer) clearTimeout(reconcileTimer);
  reconcileTimer = null;
  pushGeneration++;
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
vscode.start().catch((err: unknown) => log(`VS Code integration disabled: ${errorMessage(err)}`));
if (process.env.AGENTKEYS_NO_DEVICE !== '1') {
  connect().catch((err: unknown) => {
    log('connect failed:', errorMessage(err));
    scheduleReconnect();
  });
}
