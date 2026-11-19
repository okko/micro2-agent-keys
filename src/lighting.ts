export const EFFECT = {
  off: 0,
  solid: 1,
  rainbow: 3,
  breath: 4,
  shallowBreath: 6,
} as const;

export interface SlotLighting {
  id: number;
  color: number;
  effect: number;
  speed?: number;
}

export function slotIdentifier(slot: number): string {
  if (!Number.isInteger(slot) || slot < 0 || slot > 19) throw new Error('slot must be 0..19');
  return `vscode${String(slot).padStart(2, '0')}`;
}

export function slotForIdentifier(identifier: string): number | null {
  const match = /^vscode([01]\d)$/.exec(identifier);
  return match ? Number(match[1]) : null;
}
