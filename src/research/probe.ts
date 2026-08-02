import * as fs from 'node:fs';
import * as HID from 'node-hid';
import { Device, listDevices, WL_VID } from '../device.js';

const LOG = process.env.AGENTKEYS_LOG;
const lines: string[] = [];

function log(...args: unknown[]): void {
  const line = args.map(String).join(' ');
  lines.push(line);
  if (LOG) fs.writeFileSync(LOG, lines.join('\n') + '\n');
  else console.log(line);
}

async function main(): Promise<void> {
  const all = HID.devices().filter((device) => device.vendorId === WL_VID);
  log(`Work Louder HID interfaces (VID 0x${WL_VID.toString(16)}): ${all.length}`);
  for (const device of all) {
    log(
      `  pid=0x${device.productId.toString(16)} usagePage=0x${(device.usagePage ?? 0).toString(16)} ` +
        `usage=0x${(device.usage ?? 0).toString(16)} iface=${device.interface} product=${device.product ?? '?'}`
    );
  }

  const candidates = listDevices();
  log(`\nvendor-page (0xFF00) candidates: ${candidates.length}`);
  if (!candidates.length) {
    log('no RPC interface found');
    return;
  }

  const device = await Device.open(candidates[0]);
  log('opened OK (non-exclusive)');
  try {
    log('sys.version    ->', JSON.stringify(await device.call('sys.version')));
    log('device.status  ->', JSON.stringify(await device.call('device.status')));
  } finally {
    await device.close();
  }
  log('closed');
}

main().catch((err: unknown) => {
  log('FAILED: ' + (err instanceof Error ? err.message : String(err)));
  process.exitCode = 1;
});
