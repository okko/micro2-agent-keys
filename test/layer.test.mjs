import assert from 'node:assert/strict';
import test from 'node:test';
import { agentKeysLayer, LAYER_KEY_COUNT } from '../dist/layer.js';

const keycodes = (definition) => definition.layer.layout.base.map((row) => row.map(({ keycode }) => keycode));

test('keys fill the layout row by row from the top left; other controls do nothing', () => {
  const { definition, mapped } = agentKeysLayer(3, 'darwin');
  assert.equal(mapped, 3);
  assert.deepEqual(keycodes(definition), [
    ['SA_1', 'SA_2'],
    ['SA_3', 'KC_NONE', 'KC_NONE', 'KC_NONE'],
    ['KC_NONE', 'KC_NONE', 'KC_NONE', 'KC_NONE'],
    ['KC_NONE', 'KC_NONE', 'KC_NONE'],
  ]);
  assert.deepEqual(definition.layer.layout.encoders, [[{ keycode: 'KC_NONE' }, { keycode: 'KC_NONE' }, { keycode: 'KC_NONE' }]]);
  assert.ok(definition.layer.layout.joystick.sectors.every(({ k }) => k === 'KC_NONE'));
  assert.deepEqual(definition.smartActions.map(({ id, type, payload }) => [id, type, payload.id]),
    [[1, 'API', 'vscode00'], [2, 'API', 'vscode01'], [3, 'API', 'vscode02']]);
  assert.deepEqual(definition.smartActionGroups, [{ id: 1, name: 'Agent Keys', color: '#007ACC', actionIds: [1, 2, 3] }]);
  assert.deepEqual([definition.actions, definition.multiactions], [[], []]);
  assert.equal(definition.layer.lights, undefined, 'the new layer keeps the profile lighting');
  assert.equal(definition.layer.os, 0);
  assert.equal(agentKeysLayer(1, 'win32').definition.layer.os, 1);
});

test('counts above the layout map every position and leave the rest to manual mapping', () => {
  assert.equal(LAYER_KEY_COUNT, 13);
  const all = agentKeysLayer(13);
  assert.deepEqual(keycodes(all.definition).flat(), Array.from({ length: 13 }, (_, index) => `SA_${index + 1}`));
  const extra = agentKeysLayer(20);
  assert.equal(extra.mapped, 13);
  assert.deepEqual(extra.definition, all.definition);
  assert.equal(extra.definition.smartActions.at(-1).payload.id, 'vscode12');
  assert.throws(() => agentKeysLayer(0), /positive integer/);
});
