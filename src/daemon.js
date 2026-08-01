'use strict';

const http = require('http');
const { Device, listDevices } = require('./device');
const { setThreads, setZones, EFFECT } = require('./oai');
const keymap = require('./keymap');
const { STATES, SLOT_COUNT, DEFAULT_STATE, normalizeState } = require('./states');

const PORT = Number(process.env.AGENTKEYS_PORT ?? 8787);
const HOST = '127.0.0.1';
const MAX_BODY = 4096;
const RECONNECT_MS = 3000;

// 1-based, matching the layer button's own numbering and device.status.layer_index.
const LAYER = Number(process.env.AGENTKEYS_LAYER ?? 1);

// LaunchServices discards stdout, so the app-bundle launch needs a real file.
if (process.env.AGENTKEYS_LOG) {
  const stream = require('fs').createWriteStream(process.env.AGENTKEYS_LOG, { flags: 'a' });
  const write = (...args) => stream.write(args.map(String).join(' ') + '\n');
  console.log = write;
  console.error = write;
  process.on('uncaughtException', (err) => write('uncaught:', err.stack));
}

const slots = Array.from({ length: SLOT_COUNT }, (_, index) => ({
  index,
  state: DEFAULT_STATE,
  label: null,
  updatedAt: null,
}));

let device = null;
let reconnectTimer = null;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function threadFor(slot) {
  const spec = STATES[slot.state];
  return { id: slot.index, color: spec.color, effect: spec.effect, speed: spec.speed ?? 0.5 };
}

async function push(changed) {
  if (!device) return;
  const targets = changed ? [changed] : slots;
  try {
    await setThreads(device, targets.map(threadFor));
  } catch (err) {
    log('push failed:', err.message);
    await dropDevice();
  }
}

async function dropDevice() {
  const current = device;
  device = null;
  if (current) {
    try {
      await current.close();
    } catch {}
  }
  scheduleReconnect();
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    await connect().catch(() => scheduleReconnect());
  }, RECONNECT_MS);
}

async function connect() {
  if (device) return;
  if (!listDevices().length) {
    scheduleReconnect();
    return;
  }

  device = await Device.open();
  log('device connected');

  const result = await keymap.install(device, LAYER);
  log(`layer ${LAYER}:`, result.installed ? `installed (backup ${result.backup})` : result.reason);

  await setZones(device, {
    keys: { color: 0x000000, effect: EFFECT.off, brightness: 0 },
    ambient: { color: 0x101010, effect: EFFECT.solid, brightness: 0.3 },
  });
  await push();
}

function send(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
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
function hostAllowed(req) {
  const host = req.headers.host ?? '';
  return host === `${HOST}:${PORT}` || host === `localhost:${PORT}`;
}

async function handle(req, res) {
  if (!hostAllowed(req)) return send(res, 403, { error: 'forbidden host' });

  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/state') {
    return send(res, 200, { connected: Boolean(device), layer: LAYER, slots });
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

    let body;
    try {
      body = JSON.parse((await readBody(req)) || '{}');
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
  handle(req, res).catch((err) => {
    log('request failed:', err.message);
    if (!res.headersSent) send(res, 500, { error: 'internal error' });
  });
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal}, restoring keyboard`);

  clearTimeout(reconnectTimer);
  server.close();

  if (device) {
    try {
      const result = await keymap.restore(device);
      log('keymap restore:', JSON.stringify(result));
      await device.close();
    } catch (err) {
      log('restore failed:', err.message);
    }
  }
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown(signal));

server.listen(PORT, HOST, () => log(`listening on http://${HOST}:${PORT}`));
connect().catch((err) => {
  log('connect failed:', err.message);
  scheduleReconnect();
});
