import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import * as HID from 'node-hid';

export const WL_VID = 0x303a;
export const CM2_PID = 0x8298;

// The RPC endpoint is exposed on a vendor-defined usage page, separate from the
// keyboard interfaces the OS owns.
export const VENDOR_USAGE_PAGE = 0xff00;

const REPORT_ID = 0x06;
const CHANNEL_DEBUG = 1;
const CHANNEL_RPC = 2;
const REPORT_SIZE = 64;
const MAX_CHUNK = REPORT_SIZE - 3;

const REQUEST_TIMEOUT_MS = 10000;
const COOLDOWN_MS = 50;
const INCOMPLETE_LOCK_STALE_MS = 30000;

/** Ids outside [0, 999) are not accepted. */
const MAX_RPC_ID = 999;

const LOCK_PATH =
  process.env.AGENTKEYS_DEVICE_LOCK ?? path.join(os.homedir(), '.local', 'state', 'agentkeys', 'device.lock');

export class DeviceError extends Error {}

/** Shape of any message the device sends: either an RPC reply (correlated by `id`)
 * or an unsolicited notification (`m`/`p`), never both. */
export interface DeviceMessage {
  id?: string | number;
  result?: unknown;
  error?: { message?: string };
  m?: string;
  p?: { k?: string; act?: number } & Record<string, unknown>;
}

export type NotifyHandler = (message: DeviceMessage) => void;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function releaseLock(token: string): void {
  try {
    if (fs.readFileSync(LOCK_PATH, 'utf8').trim() === `${process.pid} ${token}`) {
      fs.rmSync(LOCK_PATH, { force: true });
    }
  } catch {
    // Already released, or never taken.
  }
}

/**
 * A non-exclusive HID open lets several processes drive the device at once.
 * Concurrent use, in particular overlapping fs.write calls, has left the device
 * unresponsive and needing physical access to recover, so single access is
 * enforced here. See docs/hardware-safety.md.
 */
function acquireLock(): string {
  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    let created = false;
    try {
      const fd = fs.openSync(LOCK_PATH, 'wx', 0o600);
      created = true;
      try {
        fs.writeSync(fd, `${process.pid} ${token}`);
      } finally {
        fs.closeSync(fd);
      }
      return token;
    } catch (err) {
      if (created) {
        fs.rmSync(LOCK_PATH, { force: true });
        throw err;
      }
      const errno = err as NodeJS.ErrnoException;
      if (errno.code !== 'EEXIST') throw err;
      const ownerText = fs.readFileSync(LOCK_PATH, 'utf8').trim();
      const owner = Number(ownerText.split(/\s+/, 1)[0]);
      if (Number.isInteger(owner) && owner > 0 && isAlive(owner)) {
        throw new DeviceError(
          `device is already in use by pid ${owner}. Concurrent access can leave the ` +
            `keyboard unresponsive; stop that process first, or delete ${LOCK_PATH} if it is stale.`
        );
      }
      if (
        (!Number.isInteger(owner) || owner <= 0) &&
        Date.now() - fs.statSync(LOCK_PATH).mtimeMs < INCOMPLETE_LOCK_STALE_MS
      ) {
        throw new DeviceError(`device lock is still being acquired at ${LOCK_PATH}`);
      }
      fs.rmSync(LOCK_PATH, { force: true });
    }
  }
  throw new DeviceError('could not acquire the device lock');
}

function escapeUnicode(str: string): string {
  return str.replace(/[\u0080-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

export function listDevices(): HID.Device[] {
  return HID.devices().filter(
    (d) => d.vendorId === WL_VID && d.usagePage === VENDOR_USAGE_PAGE && d.path
  );
}

const VENDOR_APP = '/Applications/input.app/';

/**
 * The device lock only coordinates our own processes; the vendor app opens the
 * same interface and can write keymap.json at the same time, and concurrent
 * writes have left the device unresponsive. Matches on the executable path
 * rather than `pgrep -f`, which also matches any process merely mentioning the
 * path in its arguments.
 */
export function assertNoVendorApp(): void {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,comm='], { encoding: 'utf8' });
  const pids = out
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(.+)$/))
    .filter((m): m is RegExpMatchArray => m !== null && m[2].startsWith(VENDOR_APP))
    .map((m) => m[1]);

  if (pids.length) {
    throw new DeviceError(
      `input.app is running (pids ${pids.join(', ')}). Quit it before writing to the device.`
    );
  }
}

interface PendingRequest {
  settle: (msg: DeviceMessage) => void;
  fail: (err: Error) => void;
}

export class Device {
  #hid: HID.HIDAsync | null = null;
  #lockToken: string | null = null;
  #lockExitHandler: (() => void) | null = null;
  #buffers: Record<number, string> = { [CHANNEL_DEBUG]: '', [CHANNEL_RPC]: '' };
  #pending = new Map<string, PendingRequest>();
  #nextId = 1;
  #tail: Promise<unknown> = Promise.resolve();

  /** Set to receive device-initiated messages, which carry no request id. */
  onNotify: NotifyHandler | null = null;

  info: HID.Device;

  constructor(info: HID.Device) {
    this.info = info;
  }

  static async open(info?: HID.Device): Promise<Device> {
    const target = info ?? listDevices()[0];
    if (!target) throw new DeviceError('no Work Louder device found');
    if (!target.path) throw new DeviceError('device has no HID path');

    const lockToken = acquireLock();
    const device = new Device(target);
    device.#lockToken = lockToken;
    device.#lockExitHandler = () => releaseLock(lockToken);
    process.once('exit', device.#lockExitHandler);
    try {
      // Non-exclusive keeps the OS's own claim intact so typing still works.
      device.#hid =
        process.platform === 'darwin'
          ? await HID.HIDAsync.open(target.path, { nonExclusive: true })
          : await HID.HIDAsync.open(target.path);
    } catch (err) {
      device.#lockToken = null;
      process.off('exit', device.#lockExitHandler);
      device.#lockExitHandler = null;
      releaseLock(lockToken);
      throw err;
    }

    device.#hid.on('data', (data: Buffer) => device.#onData(data));
    device.#hid.on('error', (err: Error) => device.#failAll(err));
    return device;
  }

  #onData(data: Buffer): void {
    const channel = data[1];
    const length = data[2];
    const payload = data.slice(3, 3 + length).toString('utf8');
    if (this.#buffers[channel] === undefined) this.#buffers[channel] = '';

    this.#buffers[channel] += payload;
    const lines = this.#buffers[channel].split(/\r?\n/);
    this.#buffers[channel] = lines.pop() ?? '';

    if (channel !== CHANNEL_RPC) return;
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg: DeviceMessage;
      try {
        msg = JSON.parse(line) as DeviceMessage;
      } catch {
        continue;
      }
      const entry = this.#pending.get(String(msg.id));
      if (entry) entry.settle(msg);
      // A non-exclusive open also sees other processes' replies; skip those.
      else if (msg.result === undefined && msg.error === undefined) this.onNotify?.(msg);
    }
  }

  #failAll(err: Error): void {
    for (const entry of this.#pending.values()) entry.fail(err);
    this.#pending.clear();
  }

  async #writeMessage(message: string): Promise<void> {
    if (!this.#hid) throw new DeviceError('device is not open');
    const buf = Buffer.from(message, 'utf8');
    for (let offset = 0; offset < buf.length; offset += MAX_CHUNK) {
      const size = Math.min(MAX_CHUNK, buf.length - offset);
      const report = Buffer.alloc(REPORT_SIZE);
      report[0] = REPORT_ID;
      report[1] = CHANNEL_RPC;
      report[2] = size;
      buf.copy(report, 3, offset, offset + size);
      await this.#hid.write(report);
    }
  }

  /**
   * Requests are serialized: the device handles one at a time and replies are
   * correlated only by id.
   */
  call(method: string, params: unknown = null): Promise<unknown> {
    const run = (): Promise<unknown> => this.#call(method, params);
    const result = this.#tail.then(run, run);
    this.#tail = result.then(
      () => new Promise<void>((r) => setTimeout(r, COOLDOWN_MS)),
      () => new Promise<void>((r) => setTimeout(r, COOLDOWN_MS))
    );
    return result;
  }

  #call(method: string, params: unknown): Promise<unknown> {
    if (!this.#hid) throw new DeviceError('device is not open');

    const id = this.#nextId;
    this.#nextId = (this.#nextId % (MAX_RPC_ID - 1)) + 1;
    const key = String(id);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(key);
        reject(new DeviceError(`${method} timed out`));
      }, REQUEST_TIMEOUT_MS);

      this.#pending.set(key, {
        settle: (msg) => {
          clearTimeout(timer);
          this.#pending.delete(key);
          if (msg.error) reject(new DeviceError(msg.error.message ?? 'rpc error'));
          else resolve(msg.result);
        },
        fail: (err) => {
          clearTimeout(timer);
          this.#pending.delete(key);
          reject(err);
        },
      });

      this.#writeMessage(escapeUnicode(JSON.stringify({ method, params, id }))).catch((err: unknown) => {
        this.#pending.get(key)?.fail(err instanceof Error ? err : new DeviceError(String(err)));
      });
    });
  }

  async close(): Promise<void> {
    const hid = this.#hid;
    const lockToken = this.#lockToken;
    const lockExitHandler = this.#lockExitHandler;
    this.#hid = null;
    this.#lockToken = null;
    this.#lockExitHandler = null;
    if (lockExitHandler) process.off('exit', lockExitHandler);
    this.#failAll(new DeviceError('device closed'));
    try {
      if (hid) await hid.close();
    } finally {
      if (lockToken) releaseLock(lockToken);
    }
  }
}
