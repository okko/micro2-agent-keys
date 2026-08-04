import * as fs from 'node:fs';
import { Device, assertNoVendorApp } from '../device.js';
import { withCodexLayer } from './keymap.js';
import { setThreads, EFFECT } from '../oai.js';

const LOG = process.env.AGENTKEYS_LOG;
const lines: string[] = [];

function log(...args: unknown[]): void {
  const line = `${new Date().toTimeString().slice(0, 8)} ${args.map(String).join(' ')}`;
  lines.push(line);
  if (LOG) fs.writeFileSync(LOG, lines.join('\n') + '\n');
  else console.log(line);
}

const LAYER = Number(process.env.AGENTKEYS_TEST_LAYER ?? 2);
const HOLD_MS = Number(process.env.AGENTKEYS_HOLD_MS ?? 45000);
const COLOURS = [0xff0000, 0xff6a00, 0xffd000, 0x00ff30, 0x0060ff, 0xb000ff];
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
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

main().catch((err: unknown) => {
  log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
