import type { DeviceLike } from './oai.js';
import { INTEGRATION_SLOT_COUNT } from './states.js';

const KEYMAP_FILE = 'keymap.json';
const AGENT_KEYCODE = /^KV_OAI_AG(\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function resultText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (isRecord(result) && typeof result.data === 'string') return result.data;
  throw new Error('device keymap read returned no text');
}

function collectAgentSlots(value: unknown, slots: Set<number>): void {
  if (typeof value === 'string') {
    const match = value.match(AGENT_KEYCODE);
    if (!match) return;
    const slot = Number(match[1]);
    if (slot < INTEGRATION_SLOT_COUNT) slots.add(slot);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectAgentSlots(entry, slots);
    return;
  }
  if (isRecord(value)) {
    for (const entry of Object.values(value)) collectAgentSlots(entry, slots);
  }
}

/** Returns the sorted AG slot indices mapped anywhere in the keymap's profile layers. */
export function configuredAgentSlots(document: unknown): number[] {
  if (!isRecord(document) || !Array.isArray(document.profiles)) {
    throw new Error('device keymap has no profiles');
  }
  const slots = new Set<number>();
  for (const profile of document.profiles) {
    if (!isRecord(profile) || !Array.isArray(profile.layers)) continue;
    for (const layer of profile.layers) {
      if (isRecord(layer)) collectAgentSlots(layer.layout, slots);
    }
  }
  return [...slots].sort((a, b) => a - b);
}

/** Reads the current keymap from the keyboard without modifying device state. */
export async function readConfiguredAgentSlots(device: DeviceLike): Promise<number[]> {
  const result = await device.call('fs.read', { file: KEYMAP_FILE });
  let document: unknown;
  try {
    document = JSON.parse(resultText(result)) as unknown;
  } catch (err) {
    throw new Error(`cannot parse device keymap: ${(err as Error).message}`);
  }
  return configuredAgentSlots(document);
}