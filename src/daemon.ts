import * as http from 'http';
import * as fs from 'fs';
import { Device, listDevices, type DeviceMessage, type NotifyHandler } from './device.js';
import { setThreads, setZones, EFFECT, type ThreadInput } from './oai.js';
import { STATES, SLOT_COUNT, DEFAULT_STATE, normalizeState } from './states.js';
import { VSCodeIntegration, INTEGRATION_SLOT_COUNT, type VSCodeSlot } from './vscode.js';

const PORT = Number(process.env.AGENTKEYS_PORT ?? 8787);
const HOST = '127.0.0.1';
const MAX_BODY = 4096;
const RECONNECT_MS = 3000;

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

interface Slot {
  index: number;
  state: string;
  label: string | null;
  updatedAt: string | null;
}

const slots: Slot[] = Array.from({ length: SLOT_COUNT }, (_, index) => ({
  index,
  state: DEFAULT_STATE,
  label: null,
  updatedAt: null,
}));

let device: Device | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;

function log(...args: unknown[]): void {
  console.log(new Date().toISOString(), ...args);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function threadFor(slot: Slot): ThreadInput {
  const spec = STATES[slot.state];
  return { id: slot.index, color: spec.color, effect: spec.effect, speed: spec.speed ?? 0.5 };
}

async function push(changed?: Slot): Promise<void> {
  if (!device) return;
  const targets = changed ? [changed] : slots;
  try {
    await setThreads(device, targets.map(threadFor));
  } catch (err) {
    log('push failed:', errorMessage(err));
    await dropDevice();
  }
}

const vscode = new VSCodeIntegration({
  log,
  onSlot: async (binding: VSCodeSlot) => {
    const slot = slots[binding.slot];
    slot.state = binding.state;
    slot.label = binding.label ?? null;
    slot.updatedAt = binding.stateChangedAt ?? null;
    await push(slot);
  },
});

async function dropDevice(): Promise<void> {
  const current = device;
  device = null;
  if (current) {
    try {
      await current.close();
    } catch {
      // best effort close
    }
  }
  scheduleReconnect();
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect().catch(() => scheduleReconnect());
  }, RECONNECT_MS);
}

async function connect(): Promise<void> {
  if (device) return;
  if (!listDevices().length) {
    scheduleReconnect();
    return;
  }

  device = await Device.open();
  const onNotify: NotifyHandler = (message: DeviceMessage) => {
    const key = message?.m === 'v.oai.hid' ? message.p?.k ?? null : null;
    const pressed = message?.p?.act === 1;
    const match = typeof key === 'string' ? key.match(/^AG0([0-3])$/) : null;
    if (!pressed || !match) return;
    vscode.open(Number(match[1])).catch((err: unknown) => log(`key ${key} open failed: ${errorMessage(err)}`));
  };
  device.onNotify = onNotify;
  log('device connected');

  await setZones(device, {
    keys: { color: 0x000000, effect: EFFECT.off, brightness: 0 },
    ambient: { color: 0x101010, effect: EFFECT.solid, brightness: 0.3 },
  });
  await push();
}

function send(res: http.ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

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

interface SlotBody {
  state?: unknown;
  label?: unknown;
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!hostAllowed(req)) return send(res, 403, { error: 'forbidden host' });

  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/state') {
    return send(res, 200, { connected: Boolean(device), slots });
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
    await push();
    return send(res, 200, { ok: true, slots });
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
    await push(slot);
    return send(res, 200, { ok: true, slot });
  }

  return send(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    log('request failed:', errorMessage(err));
    if (!res.headersSent) send(res, 500, { error: 'internal error' });
  });
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal}, shutting down`);

  if (reconnectTimer) clearTimeout(reconnectTimer);
  vscode.stop();
  server.close();

  if (device) {
    try {
      await device.close();
    } catch (err) {
      log('close failed:', errorMessage(err));
    }
  }
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
