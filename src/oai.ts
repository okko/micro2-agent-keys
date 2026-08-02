/** Values are the numeric effect ids the device expects, not names. */
export const EFFECT = {
  off: 0,
  solid: 1,
  snake: 2,
  rainbow: 3,
  breath: 4,
  gradient: 5,
  shallowBreath: 6,
} as const;

export const THREADS_LIGHTING = 'v.oai.thstatus';
export const RGB_CONFIG = 'v.oai.rgbcfg';

/** Structural contract for anything that can carry a JSON-RPC call, so this module does not
 * need to depend on the concrete Device implementation. */
export interface DeviceLike {
  call(method: string, params?: unknown): Promise<unknown>;
}

export interface ThreadInput {
  id: number;
  color: number;
  brightness?: number;
  effect?: number;
  speed?: number;
}

interface ThreadPayload {
  id: number;
  c: number;
  b: number;
  e: number;
  s: number;
}

export interface ZoneInput {
  color: number;
  brightness?: number;
  effect?: number;
  speed?: number;
  magic?: number;
}

interface ZonePayload {
  e: number;
  b: number;
  s: number;
  m: number;
  c: number;
}

/** Both endpoints answer {"ok":1} to any payload, so shape errors are silent. */
function thread({ id, color, brightness = 1, effect = EFFECT.solid, speed = 0.5 }: ThreadInput): ThreadPayload {
  return { id, c: color, b: brightness, e: effect, s: speed };
}

function zone({ color, brightness = 1, effect = EFFECT.solid, speed = 0.5, magic = 1 }: ZoneInput): ZonePayload {
  return { e: effect, b: brightness, s: speed, m: magic, c: color };
}

/** Sending a subset leaves the other threads as they are. */
export function setThreads(device: DeviceLike, threads: ThreadInput[]): Promise<unknown> {
  return device.call(THREADS_LIGHTING, threads.map(thread));
}

export function setZones(device: DeviceLike, zones: { keys: ZoneInput; ambient: ZoneInput }): Promise<unknown> {
  return device.call(RGB_CONFIG, { keys: zone(zones.keys), ambient: zone(zones.ambient) });
}
