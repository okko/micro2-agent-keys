import * as http from 'http';
import * as fs from 'fs';
import { Device, listDevices, type DeviceMessage, type NotifyHandler } from './device.js';
import { setThreads, setZones, EFFECT, type ThreadInput } from './oai.js';
import { STATES, SLOT_COUNT, DEFAULT_STATE, normalizeState } from './states.js';
import { VSCodeIntegration, INTEGRATION_SLOT_COUNT, type VSCodeSlot } from './vscode.js';
import { LocalAgentHostStateSource } from './agent-host.js';

const PORT = Number(process.env.AGENTKEYS_PORT ?? 8787);
const HOST = '127.0.0.1';
const MAX_BODY = 4096;
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

/** One agent key on the keyboard: its lighting state plus the metadata `/state` reports. */
interface Slot {
  /** Zero-based key index, used verbatim as the firmware thread id. */
  index: number;
  /** Key of {@link STATES}; decides colour and effect. */
  state: string;
  /** Human-readable description of what occupies the slot, or null when idle. */
  label: string | null;
  /** ISO timestamp of the last state change, or null if never set. */
  updatedAt: string | null;
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

/** Ends the response with `body` as JSON. */
function send(res: http.ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Buffers the request body as UTF-8.
 * @throws if the body exceeds {@link MAX_BODY} bytes, destroying the request.
 */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Blocks DNS-rebinding: a browser cannot forge a loopback Host header. */
function hostAllowed(req: http.IncomingMessage): boolean {
  const host = req.headers.host ?? '';
  return host === `${HOST}:${PORT}` || host === `localhost:${PORT}`;
}

/** Untrusted JSON body of `POST /slots/:index`; fields are validated before use. */
interface SlotBody {
  /** Desired state name, matched case-insensitively against {@link STATES}. */
  state?: unknown;
  /** Optional label; non-strings are dropped and long strings truncated. */
  label?: unknown;
}

/**
 * Routes one loopback HTTP request: `/build`, `/state`, `/reset`, `POST /slots/:index`, and the
 * `/integrations/vscode/*` endpoints. Always responds, falling through to 404.
 */
async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!hostAllowed(req)) return send(res, 403, { error: 'forbidden host' });

  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/build') {
    return send(res, 200, { buildId: BUILD_ID });
  }

  if (req.method === 'GET' && url.pathname === '/state') {
    return send(res, 200, {
      connected: Boolean(device),
      deviceVisible: visibleDeviceCount > 0,
      deviceError,
      slots,
    });
  }

  if (req.method === 'GET' && url.pathname === '/integrations/vscode/slots') {
    return send(res, 200, { slots: vscode.publicSlots() });
  }

  if (req.method === 'GET' && url.pathname === '/integrations/vscode/doctor') {
    return send(res, 200, vscode.doctor());
  }

  if (req.method === 'POST' && url.pathname === '/integrations/vscode/hooks') {
    let body: unknown;
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch {
      return send(res, 400, { error: 'invalid JSON' });
    }
    return send(res, 202, { ok: true, handled: await vscode.applyHook(body) });
  }

  const vscodeOpen = url.pathname.match(/^\/integrations\/vscode\/slots\/(\d+)\/open$/);
  if (req.method === 'POST' && vscodeOpen) {
    const index = Number(vscodeOpen[1]);
    if (!Number.isInteger(index) || index < 0 || index >= INTEGRATION_SLOT_COUNT) {
      return send(res, 400, { error: `VS Code slot must be 0..${INTEGRATION_SLOT_COUNT - 1}` });
    }
    try {
      return send(res, 200, { ok: true, ...(await vscode.open(index)) });
    } catch (err) {
      return send(res, 409, { error: errorMessage(err) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/reset') {
    for (const slot of slots) {
      slot.state = DEFAULT_STATE;
      slot.label = null;
      slot.updatedAt = new Date().toISOString();
    }
    const resetSlots = slots.map((slot) => ({ ...slot }));
    await push();
    return send(res, 200, { ok: true, slots: resetSlots });
  }

  const match = url.pathname.match(/^\/slots\/(\d+)$/);
  if (req.method === 'POST' && match) {
    const index = Number(match[1]);
    if (!Number.isInteger(index) || index < 0 || index >= SLOT_COUNT) {
      return send(res, 400, { error: `slot must be 0..${SLOT_COUNT - 1}` });
    }

    let body: SlotBody;
    try {
      body = JSON.parse((await readBody(req)) || '{}') as SlotBody;
    } catch {
      return send(res, 400, { error: 'invalid JSON' });
    }

    const state = normalizeState(body.state);
    if (!state) {
      return send(res, 400, { error: `unknown state, expected one of ${Object.keys(STATES).join(', ')}` });
    }

    const slot = slots[index];
    slot.state = state;
    slot.label = typeof body.label === 'string' ? body.label.slice(0, 64) : null;
    slot.updatedAt = new Date().toISOString();
    const updatedSlot = { ...slot };
    await push(updatedSlot);
    return send(res, 200, { ok: true, slot: updatedSlot });
  }

  return send(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    log('request failed:', errorMessage(err));
    if (!res.headersSent) send(res, 500, { error: 'internal error' });
  });
});

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
