'use strict';

const fs = require('fs');
const { Device, assertNoVendorApp } = require('./device');
const { withCodexLayer } = require('./keymap');
const { setThreads, EFFECT } = require('./oai');

// When launched via LaunchServices stdout is discarded, so mirror it to a file.
const LOG = process.env.AGENTKEYS_LOG;
const lines = [];
function log(...args) {
  const line = `${new Date().toTimeString().slice(0, 8)} ${args.join(' ')}`;
  lines.push(line);
  if (LOG) fs.writeFileSync(LOG, lines.join('\n') + '\n');
  else console.log(line);
}

const LAYER = Number(process.env.AGENTKEYS_LAYER ?? 2);
const HOLD_MS = Number(process.env.AGENTKEYS_HOLD_MS ?? 45000);

const COLOURS = [0xff0000, 0xff6a00, 0xffd000, 0x00ff30, 0x0060ff, 0xb000ff];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  assertNoVendorApp();

  const device = await Device.open();
  log('device opened, lock held');
  try {
    log(`status before: ${JSON.stringify(await device.call('device.status'))}`);

    const outcome = await withCodexLayer(device, LAYER, async () => {
      log(`Codex layer installed at layer ${LAYER}`);
      await setThreads(
        device,
        COLOURS.map((color, id) => ({ id, color, effect: EFFECT.solid, brightness: 1 }))
      );
      log(`set ${COLOURS.length} thread colours`);
      log(`status after: ${JSON.stringify(await device.call('device.status'))}`);
      log(`holding ${HOLD_MS} ms - switch layers now and watch the keys`);
      await sleep(HOLD_MS);
      return 'observation window elapsed';
    });

    log(`install: ${JSON.stringify(outcome.installed)}`);
    log(`result:  ${outcome.result}`);
    log(`restore: ${JSON.stringify(outcome.restored)}`);
  } finally {
    await device.close();
    log('device closed, lock released');
  }
}

main().catch((err) => {
  log(`FAILED: ${err.message}`);
  process.exitCode = 1;
});
