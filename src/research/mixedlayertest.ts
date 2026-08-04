import * as fs from 'node:fs';
import { Device, assertNoVendorApp } from '../device.js';
import { withCodexLayer, type KeymapLayer } from './keymap.js';
import { setThreads, EFFECT } from '../oai.js';

// Does a layer have to be all-agent? Installs a layer with six agent keycodes
// scattered among ordinary ones, so agent and ordinary key behavior can be checked.

const LOG = process.env.AGENTKEYS_LOG;
const lines: string[] = [];

function log(...args: unknown[]): void {
  const line = `${new Date().toTimeString().slice(0, 8)} ${args.map(String).join(' ')}`;
  lines.push(line);
  if (LOG) fs.writeFileSync(LOG, lines.join('\n') + '\n');
  else console.log(line);
}

const LAYER = Number(process.env.AGENTKEYS_TEST_LAYER ?? 3);
const HOLD_MS = Number(process.env.AGENTKEYS_HOLD_MS ?? 120000);
const COLOURS = [0xff0000, 0xff6a00, 0xffd000, 0x00ff30, 0x0060ff, 0xb000ff];
const COLOUR_NAMES = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'];

const MIXED_KEYMAP = [
  ['KV_OAI_AG03', 'KV_OAI_AG00'],
  ['KV_OAI_AG05', 'KC_A', 'KC_B', 'KC_C'],
  ['KC_D', 'KC_E', 'KC_F', 'KV_OAI_AG01'],
  ['KV_OAI_AG04', 'KC_G', 'KV_OAI_AG02'],
];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function mixedLayer(original: KeymapLayer, index: number): KeymapLayer {
  return {
    ...original,
    id: index,
    layout: {
      ...original.layout,
      encoders: [['KC_VOLU', 'KC_VOLD', 'KC_MPLY']],
      buttons: [],
      keymap: MIXED_KEYMAP,
    },
  };
}

function logExpectations(): void {
  log('expected, by row and column:');
  MIXED_KEYMAP.forEach((row, rowIndex) => {
    row.forEach((code, columnIndex) => {
      const agent = code.match(/^KV_OAI_AG(\d\d)$/);
      const expectation = agent
        ? `lights ${COLOUR_NAMES[Number(agent[1])]}, types nothing, should emit v.oai.hid`
        : `types '${code.slice(-1).toLowerCase()}', no notification`;
      log(`  [${rowIndex}][${columnIndex}] ${code.padEnd(13)} ${expectation}`);
    });
  });
  log('  encoder: volume up / down / play-pause');
}

async function main(): Promise<void> {
  assertNoVendorApp();

  const device = await Device.open();
  log('device opened, lock held');
  device.onNotify = (message) => log(`NOTIFY ${JSON.stringify(message)}`);

  try {
    log(`status before: ${JSON.stringify(await device.call('device.status'))}`);

    const outcome = await withCodexLayer(
      device,
      LAYER,
      async () => {
        log(`mixed layer installed at layer ${LAYER}`);
        await setThreads(
          device,
          COLOURS.map((color, id) => ({ id, color, effect: EFFECT.solid, brightness: 1 }))
        );
        log(`set ${COLOURS.length} thread colours`);
        logExpectations();
        log(`holding ${HOLD_MS} ms - switch to layer ${LAYER}, look, then press every key`);
        await sleep(HOLD_MS);
        return 'observation window elapsed';
      },
      mixedLayer
    );

    log(`install: ${JSON.stringify(outcome.installed)}`);
    log(`result:  ${outcome.result}`);
    log(`restore: ${JSON.stringify(outcome.restored)}`);
  } finally {
    await device.close();
    log('device closed, lock released');
  }
}

main().catch((err: unknown) => {
  log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
