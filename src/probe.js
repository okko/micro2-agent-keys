'use strict';

const fs = require('fs');
const HID = require('node-hid');
const { Device, listDevices, WL_VID } = require('./device');

// When launched via LaunchServices stdout is discarded, so mirror it to a file.
const LOG = process.env.AGENTKEYS_LOG;
const lines = [];
function log(...args) {
  const line = args.join(' ');
  lines.push(line);
  if (LOG) fs.writeFileSync(LOG, lines.join('\n') + '\n');
  else console.log(line);
}

async function main() {
  const all = HID.devices().filter((d) => d.vendorId === WL_VID);
  log(`Work Louder HID interfaces (VID 0x${WL_VID.toString(16)}): ${all.length}`);
  for (const d of all) {
    log(
      `  pid=0x${d.productId.toString(16)} usagePage=0x${(d.usagePage ?? 0).toString(16)} ` +
        `usage=0x${(d.usage ?? 0).toString(16)} iface=${d.interface} product=${d.product ?? '?'}`
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

main().catch((err) => {
  log('FAILED: ' + err.message);
  process.exitCode = 1;
});
