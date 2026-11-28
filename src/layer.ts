import type { LayerDefinition, LayerKey } from '@worklouder/input-kit';
import { slotIdentifier } from './lighting.js';

/** Keys per row of the supported devices' base layout, top to bottom. */
const BASE_ROWS = [2, 4, 4, 3];
export const LAYER_KEY_COUNT = BASE_ROWS.reduce((sum, keys) => sum + keys, 0);
/** Visual Studio Code brand blue. */
const VSCODE_BLUE = '#007ACC';

export interface AgentKeysLayer {
  definition: LayerDefinition;
  /** Slots placed on the layer: vscode00 through vscode{mapped - 1}. */
  mapped: number;
}

/**
 * A layer that maps the first keys, row by row from the top left, to the
 * configured API Smart Actions. Every other control does nothing.
 */
export function agentKeysLayer(keyCount: number, platform: NodeJS.Platform = process.platform): AgentKeysLayer {
  if (!Number.isInteger(keyCount) || keyCount < 1) throw new Error('keyCount must be a positive integer');
  const mapped = Math.min(keyCount, LAYER_KEY_COUNT);
  const none = (): LayerKey => ({ keycode: 'KC_NONE' });
  let position = 0;
  const base = BASE_ROWS.map((keys) => Array.from({ length: keys }, (): LayerKey => {
    position++;
    return position <= mapped ? { keycode: `SA_${position}` } : none();
  }));
  const ids = Array.from({ length: mapped }, (_, index) => index + 1);
  return {
    mapped,
    definition: {
      id: 1,
      name: 'Agent Keys',
      description: 'API Smart Actions for Agent Keys in VS Code.',
      os: [0, 1],
      keyboardLayoutTypes: ['universal'],
      devices: ['codex_micro', 'creator_micro_v2', 'creator_micro_v2_base', 'creator_micro_v2_pro'],
      layer: {
        id: 0,
        name: 'Agent Keys',
        color: '#2864FF',
        os: platform === 'win32' ? 1 : 0,
        layout: {
          base,
          encoders: [[none(), none(), none()]],
          joystick: {
            type: 'RADIAL',
            sectors: [[0.625, 0.875], [0.875, 0.125], [0.125, 0.375], [0.375, 0.625]]
              .map(([a1, a2]) => ({ k: 'KC_NONE', a1, a2 })),
          },
        },
      },
      actions: [],
      actionGroups: [],
      multiactions: [],
      multiactionGroups: [],
      smartActions: ids.map((id) => ({
        id, name: `Agent Key ${id}`, type: 'API', payload: { id: slotIdentifier(id - 1) },
      })),
      smartActionGroups: [{ id: 1, name: 'Agent Keys', color: VSCODE_BLUE, actionIds: ids }],
    },
  };
}
