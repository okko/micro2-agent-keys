import * as http from 'http';
import { STATES, SLOT_COUNT, normalizeState } from './states.js';
import { SLOT_COUNT, type VSCodeIntegration, type VSCodeSlot } from './vscode.js';
import type { DeviceStatus, Slot } from './daemon-interfaces.js';

export const PORT = Number(process.env.AGENTKEYS_PORT ?? 8787);
export const HOST = '127.0.0.1';
const MAX_BODY = 4096;
const MAX_LABEL = 64;

/** The subset of the VS Code integration the routes reach for. */
type VSCodeRoutes = Pick<VSCodeIntegration, 'publicSlots' | 'doctor' | 'applyHook' | 'open'>;

/**
 * Everything the routes may touch. The daemon keeps the HID handle and the slot array to itself
 * and exposes them only through this port, so routing stays testable without a device.
 */
export interface DaemonApi {
  buildId: string;
  vscode: VSCodeRoutes;
  log(...args: unknown[]): void;
  status(): DeviceStatus;
  slots(): Slot[];
  /** `state` is already normalized; resolves to the slot as recorded, once the lighting is sent. */
  setSlot(index: number, state: string, label: string | null): Promise<Slot>;
  reset(): Promise<Slot[]>;
  resetVSCodeSlots(): Promise<VSCodeSlot[]>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
async function handle(api: DaemonApi, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!hostAllowed(req)) return send(res, 403, { error: 'forbidden host' });

  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/build') {
    return send(res, 200, { buildId: api.buildId });
  }

  if (req.method === 'GET' && url.pathname === '/state') {
    return send(res, 200, { ...api.status(), slots: api.slots() });
  }

  if (req.method === 'GET' && url.pathname === '/integrations/vscode/slots') {
    return send(res, 200, { slots: api.vscode.publicSlots() });
  }

  if (req.method === 'GET' && url.pathname === '/integrations/vscode/doctor') {
    return send(res, 200, api.vscode.doctor());
  }

  if (req.method === 'POST' && url.pathname === '/integrations/vscode/hooks') {
    let body: unknown;
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch {
      return send(res, 400, { error: 'invalid JSON' });
    }
    return send(res, 202, { ok: true, handled: await api.vscode.applyHook(body) });
  }

  if (req.method === 'POST' && url.pathname === '/integrations/vscode/slots/reset') {
    return send(res, 200, { ok: true, slots: await api.resetVSCodeSlots() });
  }

  const vscodeOpen = url.pathname.match(/^\/integrations\/vscode\/slots\/(\d+)\/open$/);
  if (req.method === 'POST' && vscodeOpen) {
    const index = Number(vscodeOpen[1]);
    if (!Number.isInteger(index) || index < 0 || index >= SLOT_COUNT) {
      return send(res, 400, { error: `VS Code slot must be 0..${SLOT_COUNT - 1}` });
    }
    try {
      return send(res, 200, { ok: true, ...(await api.vscode.open(index)) });
    } catch (err) {
      return send(res, 409, { error: errorMessage(err) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/reset') {
    return send(res, 200, { ok: true, slots: await api.reset() });
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

    const label = typeof body.label === 'string' ? body.label.slice(0, MAX_LABEL) : null;
    return send(res, 200, { ok: true, slot: await api.setSlot(index, state, label) });
  }

  return send(res, 404, { error: 'not found' });
}

/** Builds the loopback API server; the caller owns listening and closing it. */
export function createServer(api: DaemonApi): http.Server {
  return http.createServer((req, res) => {
    handle(api, req, res).catch((err: unknown) => {
      api.log('request failed:', errorMessage(err));
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
    });
  });
}
