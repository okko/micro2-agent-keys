import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DeviceLike } from '../oai.js';

// Temporary keymap support for experiments and the CLI demo. All callers must use
// a wrapper that restores the original keymap instead of leaving a replacement live.

const KEYMAP_FILE = 'keymap.json';
const MARKER = 'KV_OAI_AG00';
const STATE_DIR = path.join(os.homedir(), '.local', 'state', 'agentkeys');
export const BACKUP_PATH = path.join(STATE_DIR, 'keymap.backup.json');

export interface KeymapLayout {
  encoders: string[][];
  buttons: unknown[];
  keymap: string[][];
  joystick?: { type: string; sectors: unknown[] };
  [key: string]: unknown;
}

export interface KeymapLayer {
  id: number;
  name: string;
  color?: number;
  layout: KeymapLayout;
  lights?: unknown;
  os?: number;
  [key: string]: unknown;
}

interface KeymapDocument {
  profiles: { layers: KeymapLayer[] }[];
}

export type LayerBuilder = (original: KeymapLayer, index: number) => KeymapLayer;

/**
 * `id` is a placeholder; install() overwrites it with the target index. Writing
 * keymap.json triggers a live reload but keeps the active layer (observed on
 * hardware), so this only becomes visible on the layer the user is already on.
 */
export const CODEX_LAYER: KeymapLayer = {
  id: 0,
  name: 'Layer 1',
  color: 16711680,
  layout: {
    encoders: [['KV_OAI_ENC_CC', 'KV_OAI_ENC_CW', 'KV_OAI_ENC_CLK']],
    buttons: [],
    keymap: [
      ['KV_OAI_AG00', 'KV_OAI_AG01'],
      ['KV_OAI_AG02', 'KV_OAI_AG03', 'KV_OAI_AG04', 'KV_OAI_AG05'],
      ['KV_OAI_ACT06', 'KV_OAI_ACT07', 'KV_OAI_ACT08', 'KV_OAI_ACT09'],
      ['KV_OAI_ACT10', 'KV_OAI_ACT11', 'KV_OAI_ACT12'],
    ],
    joystick: { type: 'VENDOR', sectors: [] },
  },
  os: 0,
};

const RELOAD_MS = 2500;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isDataResult(result: unknown): result is { data: string } {
  return typeof result === 'object' && result !== null && 'data' in result && typeof result.data === 'string';
}

function asText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (isDataResult(result)) return result.data;
  return JSON.stringify(result);
}

export async function readKeymap(device: DeviceLike): Promise<string> {
  return asText(await device.call('fs.read', { file: KEYMAP_FILE }));
}

async function writeKeymap(device: DeviceLike, text: string): Promise<void> {
  await device.call('fs.write', { file: KEYMAP_FILE, data: text });
  await sleep(RELOAD_MS);
}

export function isCodexLayout(text: string): boolean {
  return text.includes(MARKER);
}

/** Default builder: replaces the whole layer with the stock agent layout. */
function codexLayer(original: KeymapLayer, index: number): KeymapLayer {
  return { ...CODEX_LAYER, id: index, name: original.name, lights: original.lights };
}

export type InstallResult =
  | { installed: false; reason: 'already installed' }
  | { installed: true; backup: string };

/**
 * Installs the Codex layer, preserving the user's own keymap on first use so it
 * can be put back later. `layerNumber` is 1-based, matching the layer names in
 * the host app and `device.status.layer_index`. `buildLayer` receives the
 * pristine layer and returns whatever should replace it.
 */
export async function install(
  device: DeviceLike,
  layerNumber = 1,
  buildLayer: LayerBuilder = codexLayer
): Promise<InstallResult> {
  const index = layerNumber - 1;
  const live = await readKeymap(device);

  if (!fs.existsSync(BACKUP_PATH) && !isCodexLayout(live)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(BACKUP_PATH, live);
  }

  const base = fs.existsSync(BACKUP_PATH) ? fs.readFileSync(BACKUP_PATH, 'utf8') : live;
  const keymap = JSON.parse(base) as KeymapDocument;
  const layers = keymap.profiles[0]?.layers;
  if (!layers) throw new Error('keymap has no profile layers');
  if (index < 0 || index >= layers.length) {
    throw new Error(`layer ${layerNumber} does not exist (keymap has ${layers.length})`);
  }

  layers[index] = buildLayer(layers[index], index);

  const next = JSON.stringify(keymap);
  if (next === live) return { installed: false, reason: 'already installed' };

  await writeKeymap(device, next);
  return { installed: true, backup: BACKUP_PATH };
}

export type RestoreResult =
  | { restored: false; reason: 'no backup' }
  | { restored: true; verified: boolean };

export async function restore(device: DeviceLike): Promise<RestoreResult> {
  if (!fs.existsSync(BACKUP_PATH)) return { restored: false, reason: 'no backup' };

  const original = fs.readFileSync(BACKUP_PATH, 'utf8');
  await writeKeymap(device, original);
  const verified = (await readKeymap(device)) === original;

  return { restored: true, verified };
}

/**
 * Runs `fn` with the Codex layer installed and always puts the user's keymap
 * back: on success, on throw, and on SIGINT/SIGTERM. An interrupted run that
 * leaves the Codex layer installed is what makes ad-hoc experiments dangerous.
 */
export async function withCodexLayer<T>(
  device: DeviceLike,
  layerNumber: number,
  fn: () => T | Promise<T>,
  buildLayer?: LayerBuilder
): Promise<{ installed: InstallResult; result: T; restored: RestoreResult }> {
  const installed = await install(device, layerNumber, buildLayer);

  let restoring: Promise<RestoreResult> | null = null;
  const restoreOnce = (): Promise<RestoreResult> => (restoring ??= restore(device));

  const onSignal = (signal: NodeJS.Signals): void => {
    restoreOnce().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    return { installed, result: await fn(), restored: await restoreOnce() };
  } catch (err) {
    await restoreOnce().catch(() => {});
    throw err;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

/** Replaces one live layer for the duration of a callback and restores its exact source text. */
export async function withTemporaryCodexLayer<T>(
  device: DeviceLike,
  profileIndex: number,
  layerNumber: number,
  fn: () => T | Promise<T>,
  buildLayer: LayerBuilder = codexLayer,
  exitOnSignal = true
): Promise<T> {
  const original = await readKeymap(device);
  const keymap = JSON.parse(original) as KeymapDocument;
  const index = layerNumber - 1;
  const layers = keymap.profiles[profileIndex]?.layers;
  if (!layers) throw new Error(`profile ${profileIndex} has no layers`);
  if (index < 0 || index >= layers.length) {
    throw new Error(`layer ${layerNumber} does not exist (keymap has ${layers.length})`);
  }

  layers[index] = buildLayer(layers[index], index);
  const next = JSON.stringify(keymap);
  let restoreNeeded = next !== original;
  let restoring: Promise<void> | null = null;
  const restoreOnce = (): Promise<void> => (restoring ??= (async () => {
    if (!restoreNeeded) return;
    await writeKeymap(device, original);
    if ((await readKeymap(device)) !== original) throw new Error('keymap restore verification failed');
    restoreNeeded = false;
  })());

  const onSignal = (signal: NodeJS.Signals): void => {
    restoreOnce().finally(() => {
      if (exitOnSignal) process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    if (restoreNeeded) {
      await writeKeymap(device, next);
      if ((await readKeymap(device)) !== next) throw new Error('temporary keymap verification failed');
    }
    return await fn();
  } finally {
    try {
      await restoreOnce();
    } finally {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    }
  }
}

export function deviceLayerIndex(status: unknown): number | null {
  if (typeof status !== 'object' || status === null || !('layer_index' in status)) return null;
  return typeof status.layer_index === 'number' ? status.layer_index : null;
}

export function deviceProfileIndex(status: unknown): number | null {
  if (typeof status !== 'object' || status === null || !('profile_index' in status)) return null;
  return typeof status.profile_index === 'number' ? status.profile_index : null;
}
