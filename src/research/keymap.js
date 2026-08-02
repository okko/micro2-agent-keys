'use strict';

// Research support only. The daemon never writes keymap.json - you bind the agent
// keycodes yourself, once. Everything here exists so test scripts can install a layer
// temporarily and be sure of putting the original back.

const fs = require('fs');
const path = require('path');
const os = require('os');

const KEYMAP_FILE = 'keymap.json';
const MARKER = 'KV_OAI_AG00';
const STATE_DIR = path.join(os.homedir(), '.local', 'state', 'agentkeys');
const BACKUP_PATH = path.join(STATE_DIR, 'keymap.backup.json');

/**
 * `id` is a placeholder; install() overwrites it with the target index. Writing
 * keymap.json triggers a live reload but keeps the active layer (observed on
 * hardware), so this only becomes visible on the layer the user is already on.
 */
const CODEX_LAYER = {
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function asText(result) {
  if (typeof result === 'string') return result;
  if (result && typeof result.data === 'string') return result.data;
  return JSON.stringify(result);
}

async function readKeymap(device) {
  return asText(await device.call('fs.read', { file: KEYMAP_FILE }));
}

async function writeKeymap(device, text) {
  await device.call('fs.write', { file: KEYMAP_FILE, data: text });
  await sleep(RELOAD_MS);
}

function isCodexLayout(text) {
  return text.includes(MARKER);
}

/** Default builder: replaces the whole layer with the stock agent layout. */
function codexLayer(original, index) {
  return { ...CODEX_LAYER, id: index, name: original.name, lights: original.lights };
}

/**
 * Installs the Codex layer, preserving the user's own keymap on first use so it
 * can be put back later. `layerNumber` is 1-based, matching the layer names in
 * the host app and `device.status.layer_index`. `buildLayer` receives the
 * pristine layer and returns whatever should replace it.
 */
async function install(device, layerNumber = 1, buildLayer = codexLayer) {
  const index = layerNumber - 1;
  const live = await readKeymap(device);

  if (!fs.existsSync(BACKUP_PATH) && !isCodexLayout(live)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(BACKUP_PATH, live);
  }

  // Build from the pristine keymap so changing layerNumber cannot stack layers.
  const base = fs.existsSync(BACKUP_PATH) ? fs.readFileSync(BACKUP_PATH, 'utf8') : live;
  const keymap = JSON.parse(base);
  const layers = keymap.profiles[0].layers;
  if (index < 0 || index >= layers.length) {
    throw new Error(`layer ${layerNumber} does not exist (keymap has ${layers.length})`);
  }

  layers[index] = buildLayer(layers[index], index);

  const next = JSON.stringify(keymap);
  if (next === live) return { installed: false, reason: 'already installed' };

  await writeKeymap(device, next);
  return { installed: true, backup: BACKUP_PATH };
}

async function restore(device) {
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
async function withCodexLayer(device, layerNumber, fn, buildLayer) {
  const installed = await install(device, layerNumber, buildLayer);

  let restoring = null;
  const restoreOnce = () => (restoring ??= restore(device));

  const onSignal = (signal) => {
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

module.exports = {
  install,
  restore,
  withCodexLayer,
  readKeymap,
  isCodexLayout,
  BACKUP_PATH,
  CODEX_LAYER,
};
