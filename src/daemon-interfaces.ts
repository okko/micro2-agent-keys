/** One agent key on the keyboard: its lighting state plus the metadata `/state` reports. */
export interface Slot {
  /** Zero-based key index, used verbatim as the firmware thread id. */
  index: number;
  /** Key of the `STATES` table in states.ts; decides colour and effect. */
  state: string;
  /** Human-readable description of what occupies the slot, or null when idle. */
  label: string | null;
  /** ISO timestamp of the last state change, or null if never set. */
  updatedAt: string | null;
}

/** Device health as `/state` reports it. */
export interface DeviceStatus {
  connected: boolean;
  deviceVisible: boolean;
  deviceError: string | null;
}
