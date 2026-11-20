import { EFFECT } from './lighting.js';

export const INTEGRATION_SLOT_COUNT = 20;

export interface StateSpec {
  color: number;
  effect: number;
  speed?: number;
}

export const STATES: Record<string, StateSpec> = {
  idle: { color: 0x101010, effect: EFFECT.solid },
  running: { color: 0x0060ff, effect: EFFECT.breath, speed: 0.55 },
  done: { color: 0x00ff30, effect: EFFECT.solid },
  input: { color: 0xff6a00, effect: EFFECT.breath, speed: 0.35 },
  error: { color: 0xff0000, effect: EFFECT.solid },
};
