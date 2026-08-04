import * as fs from 'node:fs';
import { Device, assertNoVendorApp } from '../device.js';
import {
  deviceLayerIndex,
  install,
  withCodexLayer,
  type KeymapLayer,
  type LayerBuilder,
} from './keymap.js';
import { setThreads, EFFECT, type ThreadInput } from '../oai.js';

// Three phases compare identical layouts with and without agent keycodes and colours.

const LOG = process.env.AGENTKEYS_LOG;

function log(...args: unknown[]): void {
  const line = `${new Date().toTimeString().slice(0, 8)} ${args.map(String).join(' ')}\n`;
  if (LOG) fs.appendFileSync(LOG, line);
  else process.stdout.write(line);
}

const LAYER = Number(process.env.AGENTKEYS_TEST_LAYER ?? 3);
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const builder =
  (keymap: string[][]): LayerBuilder =>
  (original: KeymapLayer, index: number): KeymapLayer => ({
    ...original,
    id: index,
    layout: {
      ...original.layout,
      encoders: [['KC_VOLU', 'KC_VOLD', 'KC_MPLY']],
      buttons: [],
      keymap,
    },
  });

const allThreads = (extra: Partial<ThreadInput>): ThreadInput[] =>
  COLOURS.map((color, id) => ({ id, color, ...extra }));

async function phase(device: Device, name: string, expectation: string): Promise<void> {
  log('');
  log(`=== ${name} ===`);
  log(`   layer now: ${deviceLayerIndex(await device.call('device.status')) ?? 'unknown'}`);
  log(`   EXPECT: ${expectation}`);
  await sleep(PHASE_MS);
}

async function main(): Promise<void> {
  assertNoVendorApp();

  const device = await Device.open();
  log('device opened, lock held');

  try {
    const status = await device.call('device.status');
    log(`status before: ${JSON.stringify(status)}`);
    const currentLayer = deviceLayerIndex(status);
    if (currentLayer !== LAYER) log(`!! you are on layer ${currentLayer ?? 'unknown'}, switch to ${LAYER} now`);

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
        await phase(device, 'C - agent keycodes present, threads coloured', '6 agent keys coloured, other 7 dark');

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

main().catch((err: unknown) => {
  log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
