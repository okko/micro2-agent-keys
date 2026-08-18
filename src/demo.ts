import { EFFECT, setThreads, type DeviceLike, type ThreadInput } from './oai.js';
import { INTEGRATION_SLOT_COUNT, STATES } from './states.js';
import { CODEX_LAYER, withTemporaryCodexLayer, type LayerBuilder } from './keymap.js';

export const DEMO_DURATION_MS = 30_000;
export const DEMO_INTERVAL_MS = 5_000;

const STATE_COLORS = Object.values(STATES).map(({ color }) => color);
const demoLayer: LayerBuilder = (original, index) => ({
  ...CODEX_LAYER,
  id: index,
  name: original.name,
  lights: original.lights,
  layout: {
    ...CODEX_LAYER.layout,
    keymap: [
      ['KV_OAI_AG00', 'KV_OAI_AG01'],
      ['KV_OAI_AG02', 'KV_OAI_AG03', 'KV_OAI_AG04', 'KV_OAI_AG05'],
      ['KV_OAI_AG06', 'KV_OAI_AG07', 'KV_OAI_AG08', 'KV_OAI_AG09'],
      ['KV_OAI_AG10', 'KV_OAI_AG11', 'KV_OAI_AG12'],
    ],
  },
});

export interface DemoOptions {
  durationMs?: number;
  intervalMs?: number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function demoThreads(random: () => number = Math.random): ThreadInput[] {
  return Array.from({ length: INTEGRATION_SLOT_COUNT }, (_, id) => ({
    id,
    color: STATE_COLORS[Math.min(STATE_COLORS.length - 1, Math.floor(random() * STATE_COLORS.length))],
    effect: EFFECT.solid,
  }));
}

export async function runDemo(
  device: DeviceLike,
  profileIndex: number,
  layerNumber: number,
  options: DemoOptions = {}
): Promise<void> {
  const durationMs = options.durationMs ?? DEMO_DURATION_MS;
  const intervalMs = options.intervalMs ?? DEMO_INTERVAL_MS;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const steps = Math.ceil(durationMs / intervalMs);

  if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('demo duration must be positive');
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error('demo interval must be positive');

  await withTemporaryCodexLayer(
    device,
    profileIndex,
    layerNumber,
    async () => {
      for (let step = 0; step < steps; step++) {
        await setThreads(device, demoThreads(random));
        await sleep(intervalMs);
      }
    },
    demoLayer
  );
}
