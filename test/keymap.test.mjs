import assert from 'node:assert/strict';
import test from 'node:test';
import { configuredAgentSlots, readConfiguredAgentSlots } from '../dist/keymap.js';

const KEYMAP = {
  profiles: [
    {
      layers: [
        {
          name: 'KV_OAI_AG19 is text, not a mapping',
          layout: { keymap: [['KV_OAI_AG03', 'KC_A'], ['KV_OAI_AG00']], encoders: [] },
        },
        { layout: { keymap: [['KV_OAI_AG17', 'KV_OAI_ACT06', 'KV_OAI_AG03']] } },
      ],
    },
    { layers: [{ layout: { keymap: [['KV_OAI_AG01', 'KV_OAI_AG20']] } }] },
  ],
};

test('finds unique mapped AG slots across every profile layer', () => {
  assert.deepEqual(configuredAgentSlots(KEYMAP), [0, 1, 3, 17]);
});

test('reads keymap.json from the device and extracts mapped AG slots', async () => {
  const calls = [];
  const device = {
    call: async (method, params) => {
      calls.push([method, params]);
      return { data: JSON.stringify(KEYMAP) };
    },
  };

  assert.deepEqual(await readConfiguredAgentSlots(device), [0, 1, 3, 17]);
  assert.deepEqual(calls, [['fs.read', { file: 'keymap.json' }]]);
});