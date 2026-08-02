import * as fs from 'node:fs';
import * as readline from 'node:readline/promises';
import { Device, assertNoVendorApp } from '../device.js';
import { deviceLayerIndex, withCodexLayer, type KeymapLayer } from './keymap.js';
import { setThreads, EFFECT, type ThreadInput } from '../oai.js';

// Verifies that the two highest agent IDs have both lighting and input support.
// AG18 and AG19 are installed on the two leftmost switches of the second row.

const LOG = process.env.AGENTKEYS_LOG;
const PHASE_MS = Number(process.env.AGENTKEYS_PHASE_MS ?? 30000);

const TEST_KEYMAP = [
  ['KC_H', 'KC_I'],
  ['KV_OAI_AG18', 'KV_OAI_AG19', 'KC_B', 'KC_C'],
  ['KC_D', 'KC_E', 'KC_F', 'KC_J'],
  ['KC_K', 'KC_L', 'KC_M'],
];

const AG18_COLOR = 0xff0000;
const AG19_COLOR = 0x0060ff;

interface KeyEvent {
  key: 'AG18' | 'AG19';
  action: 0 | 1;
}

function log(message: string): void {
  const line = `${new Date().toTimeString().slice(0, 8)} ${message}`;
  if (LOG) fs.appendFileSync(LOG, `${line}\n`);
  else console.log(line);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function testLayer(original: KeymapLayer, index: number): KeymapLayer {
  return {
    ...original,
    id: index,
    layout: {
      ...original.layout,
      encoders: [['KC_VOLU', 'KC_VOLD', 'KC_MPLY']],
      buttons: [],
      keymap: TEST_KEYMAP,
    },
  };
}

function off(id: number): ThreadInput {
  return { id, color: 0, effect: EFFECT.off, brightness: 0 };
}

function solid(id: number, color: number): ThreadInput {
  return { id, color, effect: EFFECT.solid, brightness: 1 };
}

async function confirm(terminal: readline.Interface | null, question: string): Promise<boolean> {
  if (!terminal) {
    log(`${question} Observe for ${PHASE_MS} ms.`);
    await sleep(PHASE_MS);
    return true;
  }
  const answer = (await terminal.question(`${question} [y/N] `)).trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

function eventSummary(events: KeyEvent[], key: KeyEvent['key']): string {
  const actions = events.filter((event) => event.key === key).map((event) => event.action);
  return `${key}: ${actions.length ? actions.join(', ') : 'none'}`;
}

async function main(): Promise<void> {
  assertNoVendorApp();

  if (!Number.isFinite(PHASE_MS) || PHASE_MS <= 0) {
    throw new Error(`invalid AGENTKEYS_PHASE_MS: ${process.env.AGENTKEYS_PHASE_MS}`);
  }

  const terminal = process.stdin.isTTY
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : null;
  const device = await Device.open();
  const events: KeyEvent[] = [];

  device.onNotify = (message) => {
    const key = message.m === 'v.oai.hid' ? message.p?.k : null;
    const action = message.p?.act;
    if ((key === 'AG18' || key === 'AG19') && (action === 0 || action === 1)) {
      events.push({ key, action });
      log(`EVENT ${key} ${action === 1 ? 'press' : 'release'}`);
    }
  };

  log('Device opened; exclusive lock held.');

  try {
    const status = await device.call('device.status');
    const layer = process.env.AGENTKEYS_LAYER ? Number(process.env.AGENTKEYS_LAYER) : deviceLayerIndex(status);

    if (!Number.isInteger(layer) || layer === null || layer < 1) {
      throw new Error(`invalid layer: ${process.env.AGENTKEYS_LAYER ?? JSON.stringify(status)}`);
    }

    log(`Installing the test on layer ${layer}.`);
    log('Second row: AG18, AG19, B, C (left to right).');

    const outcome = await withCodexLayer(
      device,
      layer,
      async () => {
        await setThreads(device, [solid(18, AG18_COLOR), off(19)]);
        if (!(await confirm(terminal, 'Is only the leftmost key on row 2 lit red (AG18)?'))) {
          throw new Error('AG18 lighting was not confirmed');
        }

        await setThreads(device, [off(18), solid(19, AG19_COLOR)]);
        if (!(await confirm(terminal, 'Is only the second key on row 2 lit blue (AG19)?'))) {
          throw new Error('AG19 lighting was not confirmed');
        }

        await setThreads(device, [solid(18, AG18_COLOR), solid(19, AG19_COLOR)]);
        if (!(await confirm(terminal, 'Are the first two keys on row 2 now red and blue?'))) {
          throw new Error('combined AG18/AG19 lighting was not confirmed');
        }

        events.length = 0;
        log('Press and release both lit keys.');
        if (terminal) {
          await terminal.question('Press Enter after both keys have been tested. ');
        } else {
          log(`Listening for events for ${PHASE_MS} ms.`);
          await sleep(PHASE_MS);
        }

        const missing = (['AG18', 'AG19'] as const).filter(
          (key) =>
            !events.some((event) => event.key === key && event.action === 1) ||
            !events.some((event) => event.key === key && event.action === 0)
        );
        if (missing.length) {
          throw new Error(
            `missing press/release events for ${missing.join(', ')} (${[
              eventSummary(events, 'AG18'),
              eventSummary(events, 'AG19'),
            ].join('; ')})`
          );
        }

        await setThreads(device, [off(18), off(19)]);
        return 'AG18 and AG19 lighting and input events verified';
      },
      testLayer
    );

    log(`PASS: ${outcome.result}`);
    log(`Restore: ${JSON.stringify(outcome.restored)}`);
  } finally {
    terminal?.close();
    await device.close();
    log('Device closed; lock released.');
  }
}

main().catch((error: unknown) => {
  log(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
