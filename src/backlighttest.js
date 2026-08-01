'use strict';

// Do agent keycodes suppress the layer's own backlight? The mixed-layer test left
// the ordinary keys dark, but that only means something if the same layer, written
// the same way, is lit without the agent keycodes. Three phases, identical except
// for the one variable:
//   A  thirteen ordinary keycodes            -> control, should be solid white
//   B  six agent keycodes, threads off       -> do the keycodes alone kill it?
//   C  same keymap, threads coloured         -> the original observation
// Same layer, same lights, same thirteen positions throughout.

const fs = require('fs');
const { Device, assertNoVendorApp } = require('./device');
const { install, withCodexLayer } = require('./keymap');
const { setThreads, EFFECT } = require('./oai');

const LOG = process.env.AGENTKEYS_LOG;
// Appends rather than rewrites so the run can be watched with `tail -f`.
function log(...args) {
  const line = `${new Date().toTimeString().slice(0, 8)} ${args.join(' ')}\n`;
  if (LOG) fs.appendFileSync(LOG, line);
  else process.stdout.write(line);
}

const LAYER = Number(process.env.AGENTKEYS_LAYER ?? 3);
const PHASE_MS = Number(process.env.AGENTKEYS_PHASE_MS ?? 25000);

const COLOURS = [0xff0000, 0xff6a00, 0xffd000, 0x00ff30, 0x0060ff, 0xb000ff];

const CONTROL_KEYMAP = [
  ['KC_H', 'KC_I'],
  ['KC_J', 'KC_A', 'KC_B', 'KC_C'],
  ['KC_D', 'KC_E', 'KC_F', 'KC_K'],
  ['KC_L', 'KC_G', 'KC_M'],
];

const MIXED_KEYMAP = [
  ['KV_OAI_AG03', 'KV_OAI_AG00'],
  ['KV_OAI_AG05', 'KC_A', 'KC_B', 'KC_C'],
  ['KC_D', 'KC_E', 'KC_F', 'KV_OAI_AG01'],
  ['KV_OAI_AG04', 'KC_G', 'KV_OAI_AG02'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const builder = (keymap) => (original, index) => ({
  ...original,
  id: index,
  layout: {
    ...original.layout,
    encoders: [['KC_VOLU', 'KC_VOLD', 'KC_MPLY']],
    buttons: [],
    keymap,
  },
});

const allThreads = (extra) => COLOURS.map((color, id) => ({ id, color, ...extra }));

async function phase(device, name, expectation) {
  log('');
  log(`=== ${name} ===`);
  log(`   layer now: ${(await device.call('device.status')).layer_index}`);
  log(`   EXPECT: ${expectation}`);
  await sleep(PHASE_MS);
}

async function main() {
  assertNoVendorApp();

  const device = await Device.open();
  log('device opened, lock held');

  try {
    const status = await device.call('device.status');
    log(`status before: ${JSON.stringify(status)}`);
    if (status.layer_index !== LAYER) {
      log(`!! you are on layer ${status.layer_index}, switch to ${LAYER} now`);
    }

    // Stale thread colours from an earlier run would confound the control phase.
    await setThreads(device, allThreads({ effect: EFFECT.off, brightness: 0 }));

    const outcome = await withCodexLayer(
      device,
      LAYER,
      async () => {
        await phase(device, 'A - no agent keycodes', 'all 13 keys solid white');

        await install(device, LAYER, builder(MIXED_KEYMAP));
        await phase(
          device,
          'B - agent keycodes present, threads off',
          'if the keycodes alone suppress, all 13 dark; if not, still white'
        );

        await setThreads(device, allThreads({ effect: EFFECT.solid, brightness: 1 }));
        await phase(
          device,
          'C - agent keycodes present, threads coloured',
          '6 agent keys coloured, other 7 dark'
        );

        return 'three phases elapsed';
      },
      builder(CONTROL_KEYMAP)
    );

    log('');
    log(`install: ${JSON.stringify(outcome.installed)}`);
    log(`result:  ${outcome.result}`);
    log(`restore: ${JSON.stringify(outcome.restored)}`);
    log('layer should be back to solid white');
  } finally {
    await device.close();
    log('device closed, lock released');
  }
}

main().catch((err) => {
  log(`FAILED: ${err.message}`);
  process.exitCode = 1;
});
