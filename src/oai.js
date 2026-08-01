'use strict';

/** Values are the numeric effect ids the device expects, not names. */
const EFFECT = {
  off: 0,
  solid: 1,
  snake: 2,
  rainbow: 3,
  breath: 4,
  gradient: 5,
  shallowBreath: 6,
};

const THREADS_LIGHTING = 'v.oai.thstatus';
const RGB_CONFIG = 'v.oai.rgbcfg';

/** Both endpoints answer {"ok":1} to any payload, so shape errors are silent. */
function thread({ id, color, brightness = 1, effect = EFFECT.solid, speed = 0.5 }) {
  return { id, c: color, b: brightness, e: effect, s: speed };
}

function zone({ color, brightness = 1, effect = EFFECT.solid, speed = 0.5, magic = 1 }) {
  return { e: effect, b: brightness, s: speed, m: magic, c: color };
}

/** Sending a subset leaves the other threads as they are. */
function setThreads(device, threads) {
  return device.call(THREADS_LIGHTING, threads.map(thread));
}

function setZones(device, { keys, ambient }) {
  return device.call(RGB_CONFIG, { keys: zone(keys), ambient: zone(ambient) });
}

module.exports = { EFFECT, setThreads, setZones, THREADS_LIGHTING, RGB_CONFIG };
