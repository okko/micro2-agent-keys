import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as HID from 'node-hid';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentkeys-device-'));
const lockPath = path.join(directory, 'device.lock');
process.env.AGENTKEYS_DEVICE_LOCK = lockPath;

const { Device } = await import('../dist/device.js');

test('a stale close cannot release a newer device lock', async (t) => {
  const initialExitListeners = process.listenerCount('exit');
  const originalOpen = HID.HIDAsync.open;
  let closeError = null;
  HID.HIDAsync.open = async () => ({
    on() {},
    async close() {
      if (closeError) throw closeError;
    },
  });
  t.after(() => {
    HID.HIDAsync.open = originalOpen;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const info = { path: 'test-device' };
  fs.writeFileSync(lockPath, '');
  await assert.rejects(Device.open(info), /device lock is still being acquired/);
  assert.equal(fs.existsSync(lockPath), true);
  const staleTime = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, staleTime, staleTime);

  const first = await Device.open(info);
  await first.close();

  const second = await Device.open(info);
  const secondOwner = fs.readFileSync(lockPath, 'utf8');
  await first.close();
  assert.equal(fs.readFileSync(lockPath, 'utf8'), secondOwner);

  await second.close();
  assert.equal(fs.existsSync(lockPath), false);

  const third = await Device.open(info);
  closeError = new Error('close failed');
  await assert.rejects(third.close(), closeError);
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(process.listenerCount('exit'), initialExitListeners);
});