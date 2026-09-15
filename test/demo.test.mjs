import assert from 'node:assert/strict';
import test from 'node:test';
import { EFFECT } from '../dist/oai.js';
import { demoThreads, runDemo } from '../dist/demo.js';
import { STATES } from '../dist/states.js';

const PALETTE = Object.values(STATES).map(({ color }) => color);

function originalKeymap() {
  return JSON.stringify({
    profiles: [
      { layers: [{ id: 0, name: 'Profile 0', layout: { encoders: [], buttons: [], keymap: [['KC_A']] } }] },
      { layers: [{ id: 0, name: 'Profile 1', layout: { encoders: [], buttons: [], keymap: [['KC_B']] } }] },
    ],
  });
}

test('demo generates one solid state color for every agent slot', () => {
  const threads = demoThreads(() => 0.4);

  assert.equal(threads.length, 20);
  assert.deepEqual(threads.map(({ id }) => id), Array.from({ length: 20 }, (_, id) => id));
  assert(threads.every(({ color, effect }) => PALETTE.includes(color) && effect === EFFECT.solid));
});

test('demo restores the exact original keymap after its run', async () => {
  const original = originalKeymap();
  let live = original;
  const calls = [];
  const device = {
    call: async (method, params) => {
      calls.push([method, params]);
      if (method === 'fs.read') return { data: live };
      if (method === 'fs.write') {
        live = params.data;
        return { ok: 1 };
      }
      if (method === 'v.oai.thstatus') return { ok: 1 };
      throw new Error(`unexpected method ${method}`);
    },
  };

  await runDemo(device, 1, 1, {
    durationMs: 1,
    intervalMs: 1,
    random: () => 0.4,
    sleep: async () => {},
  });

  assert.equal(live, original);
  const writes = calls.filter(([method]) => method === 'fs.write');
  assert.equal(writes.length, 2);
  const installed = JSON.parse(writes[0][1].data);
  assert.deepEqual(installed.profiles[0].layers[0].layout.keymap, [['KC_A']]);
  assert.deepEqual(installed.profiles[1].layers[0].layout.keymap.flat(), [
    'KV_OAI_AG00',
    'KV_OAI_AG01',
    'KV_OAI_AG02',
    'KV_OAI_AG03',
    'KV_OAI_AG04',
    'KV_OAI_AG05',
    'KV_OAI_AG06',
    'KV_OAI_AG07',
    'KV_OAI_AG08',
    'KV_OAI_AG09',
    'KV_OAI_AG10',
    'KV_OAI_AG11',
    'KV_OAI_AG12',
  ]);
  const lighting = calls.find(([method]) => method === 'v.oai.thstatus');
  assert(lighting);
  assert.equal(lighting[1].length, 20);
  assert(lighting[1].every(({ e, c }) => e === EFFECT.solid && c === PALETTE[2]));
});
