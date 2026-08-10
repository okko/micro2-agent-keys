import { EFFECT } from './oai.js';

export const SLOT_COUNT = 20;

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

export const DEFAULT_STATE = 'idle';

/** Aliases so hooks and scripts can use whatever word fits their vocabulary. */
export const ALIASES: Record<string, string> = {
  off: 'idle',
  free: 'idle',
  thinking: 'running',
  busy: 'running',
  working: 'running',
  complete: 'done',
  completed: 'done',
  finished: 'done',
  unread: 'done',
  waiting: 'input',
  paused: 'input',
  blocked: 'input',
  ask: 'input',
  failed: 'error',
  fail: 'error',
};

export function normalizeState(name: unknown): string | null {
  const key = String(name ?? '').trim().toLowerCase();
  const resolved = ALIASES[key] ?? key;
  return resolved in STATES ? resolved : null;
}
