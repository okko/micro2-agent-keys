'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const HID = require('node-hid');

const WL_VID = 0x303a;
const CM2_PID = 0x8298;

// The RPC endpoint is exposed on a vendor-defined usage page, separate from the
// keyboard interfaces the OS owns.
const VENDOR_USAGE_PAGE = 0xff00;

const REPORT_ID = 0x06;
const CHANNEL_DEBUG = 1;
const CHANNEL_RPC = 2;
const REPORT_SIZE = 64;
const MAX_CHUNK = REPORT_SIZE - 3;

const REQUEST_TIMEOUT_MS = 10000;
const COOLDOWN_MS = 50;

/** Ids outside [0, 999) are not accepted. */
const MAX_RPC_ID = 999;

const LOCK_PATH = path.join(os.homedir(), '.local', 'state', 'agentkeys', 'device.lock');

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function releaseLock() {
  try {
    if (Number(fs.readFileSync(LOCK_PATH, 'utf8').trim()) === process.pid) {
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
function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(LOCK_PATH, 'wx', 0o600);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      process.once('exit', releaseLock);
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const owner = Number(fs.readFileSync(LOCK_PATH, 'utf8').trim());
      if (Number.isInteger(owner) && owner > 0 && isAlive(owner)) {
        throw new DeviceError(
          `device is already in use by pid ${owner}. Concurrent access can leave the ` +
            `keyboard unresponsive; stop that process first, or delete ${LOCK_PATH} if it is stale.`
        );
      }
      fs.rmSync(LOCK_PATH, { force: true });
    }
  }
  throw new DeviceError('could not acquire the device lock');
}

function escapeUnicode(str) {
  return str.replace(/[\u0080-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

function listDevices() {
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
function assertNoVendorApp() {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,comm='], { encoding: 'utf8' });
  const pids = out
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(.+)$/))
    .filter((m) => m && m[2].startsWith(VENDOR_APP))
    .map((m) => m[1]);

  if (pids.length) {
    throw new DeviceError(
      `input.app is running (pids ${pids.join(', ')}). Quit it before writing to the device.`
    );
  }
}

class DeviceError extends Error {}

class Device {
  #hid = null;
  #buffers = { [CHANNEL_DEBUG]: '', [CHANNEL_RPC]: '' };
  #pending = new Map();
  #nextId = 1;
  #tail = Promise.resolve();

  /** Set to receive device-initiated messages, which carry no request id. */
  onNotify = null;

  constructor(info) {
    this.info = info;
  }

  static async open(info) {
    const target = info ?? listDevices()[0];
    if (!target) throw new DeviceError('no Work Louder device found');

    acquireLock();
    const device = new Device(target);
    try {
      // Non-exclusive keeps the OS's own claim intact so typing still works.
      device.#hid =
        process.platform === 'darwin'
          ? await HID.HIDAsync.open(target.path, { nonExclusive: true })
          : await HID.HIDAsync.open(target.path);
    } catch (err) {
      releaseLock();
      throw err;
    }

    device.#hid.on('data', (data) => device.#onData(data));
    device.#hid.on('error', (err) => device.#failAll(err));
    return device;
  }

  #onData(data) {
    const channel = data[1];
    const length = data[2];
    const payload = data.slice(3, 3 + length).toString('utf8');
    if (this.#buffers[channel] === undefined) this.#buffers[channel] = '';

    this.#buffers[channel] += payload;
    const lines = this.#buffers[channel].split(/\r?\n/);
    this.#buffers[channel] = lines.pop();

    if (channel !== CHANNEL_RPC) return;
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = this.#pending.get(String(msg.id));
      if (entry) entry.settle(msg);
      // A non-exclusive open also sees other processes' replies; skip those.
      else if (msg.result === undefined && msg.error === undefined) this.onNotify?.(msg);
    }
  }

  #failAll(err) {
    for (const entry of this.#pending.values()) entry.fail(err);
    this.#pending.clear();
  }

  async #writeMessage(message) {
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
  call(method, params = null) {
    const run = () => this.#call(method, params);
    const result = this.#tail.then(run, run);
    this.#tail = result.then(
      () => new Promise((r) => setTimeout(r, COOLDOWN_MS)),
      () => new Promise((r) => setTimeout(r, COOLDOWN_MS))
    );
    return result;
  }

  #call(method, params) {
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

      this.#writeMessage(escapeUnicode(JSON.stringify({ method, params, id }))).catch((err) => {
        this.#pending.get(key)?.fail(err);
      });
    });
  }

  async close() {
    const hid = this.#hid;
    this.#hid = null;
    if (hid) await hid.close();
    releaseLock();
  }
}

module.exports = {
  Device,
  DeviceError,
  listDevices,
  assertNoVendorApp,
  WL_VID,
  CM2_PID,
  VENDOR_USAGE_PAGE,
};
