#!/usr/bin/env node
import { STATES, ALIASES, SLOT_COUNT, normalizeState } from './states.js';

const PORT = Number(process.env.AGENTKEYS_PORT ?? 8787);
const BASE = `http://127.0.0.1:${PORT}`;

const USAGE = `agentkeys - drive the Creator Micro 2 agent keys

  agentkeys set <slot> <state> [label]   set one slot (slot 0..${SLOT_COUNT - 1})
  agentkeys status                       show all slots
  agentkeys reset                        set every slot to idle
  agentkeys states                       list valid state names
  agentkeys vscode slots                 show automatic VS Code bindings
  agentkeys vscode open <slot>           open an exact VS Code session
  agentkeys doctor vscode                check VS Code integration availability

states: ${Object.keys(STATES).join(', ')}
`;

interface ApiSlot {
  index?: number;
  slot?: number;
  state: string;
  label?: string | null;
  sessionId?: string | null;
}

interface StatusResponse {
  connected: boolean;
  slots: ApiSlot[];
}

interface VSCodeSlotsResponse {
  slots: ApiSlot[];
}

interface DoctorResponse {
  ready: boolean;
  rootReadable: boolean;
  sessionStateRoot: string;
  nativeRootReadable: boolean;
  nativeSessionRoot: string;
  resourceScheme: string;
  trackedSessions: number;
  compatibleSessions: number;
  verifiedLifecycleSessions: number;
  exactOpenAvailable: boolean;
  vscodeVersion?: string | null;
  protocolRegistered: boolean;
  bindings: ApiSlot[];
}

interface ErrorResponse {
  error?: string;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(`daemon not reachable on ${BASE} - is it running?`);
  }
  const data = (await res.json().catch(() => ({}))) as T & ErrorResponse;
  if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
  return data;
}

function printStatus(data: StatusResponse): void {
  console.log(data.connected ? 'keyboard: connected' : 'keyboard: disconnected');
  for (const slot of data.slots) {
    console.log(`  ${slot.index}  ${slot.state.padEnd(8)} ${slot.label ?? ''}`);
  }
}

function printVSCodeSlots(data: VSCodeSlotsResponse): void {
  for (const slot of data.slots) {
    const session = slot.sessionId ? slot.sessionId.slice(0, 8) : '-';
    console.log(`  ${slot.slot}  ${slot.state.padEnd(8)} ${session.padEnd(8)} ${slot.label ?? ''}`);
  }
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  switch (command) {
    case 'set': {
      const [rawSlot, rawState, ...label] = rest;
      const slot = Number(rawSlot);
      if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_COUNT) {
        throw new Error(`slot must be 0..${SLOT_COUNT - 1}`);
      }
      if (!normalizeState(rawState)) {
        throw new Error(`unknown state '${rawState ?? ''}', try: ${Object.keys(STATES).join(', ')}`);
      }
      await request('POST', `/slots/${slot}`, {
        state: rawState,
        label: label.join(' ') || undefined,
      });
      return;
    }

    case 'status':
      printStatus(await request<StatusResponse>('GET', '/state'));
      return;

    case 'reset':
      await request('POST', '/reset');
      return;

    case 'states':
      for (const name of Object.keys(STATES)) {
        const aliases = Object.entries(ALIASES)
          .filter(([, target]) => target === name)
          .map(([alias]) => alias);
        console.log(`  ${name.padEnd(8)} ${aliases.length ? `(${aliases.join(', ')})` : ''}`);
      }
      return;

    case 'vscode': {
      const [subcommand, rawSlot] = rest;
      if (subcommand === 'slots') {
        printVSCodeSlots(await request<VSCodeSlotsResponse>('GET', '/integrations/vscode/slots'));
        return;
      }
      if (subcommand === 'open') {
        const slot = Number(rawSlot);
        if (!Number.isInteger(slot) || slot < 0 || slot > 3) throw new Error('VS Code slot must be 0..3');
        await request('POST', `/integrations/vscode/slots/${slot}/open`);
        return;
      }
      throw new Error('expected: agentkeys vscode slots | agentkeys vscode open <slot>');
    }

    case 'doctor':
      if (rest[0] !== 'vscode') throw new Error('expected: agentkeys doctor vscode');
      {
        const data = await request<DoctorResponse>('GET', '/integrations/vscode/doctor');
        console.log('daemon: reachable');
        console.log(`VS Code integration: ${data.ready ? 'ready' : 'not ready'}`);
        console.log(`Agent Host sessions: ${data.rootReadable ? 'readable' : 'unavailable'} (${data.sessionStateRoot})`);
        console.log(`native Chat sessions: ${data.nativeRootReadable ? 'readable' : 'unavailable'} (${data.nativeSessionRoot})`);
        console.log(`Agent Host resource scheme: ${data.resourceScheme}`);
        console.log(`tracked sessions: ${data.trackedSessions} (${data.compatibleSessions} compatible)`);
        console.log(`verified lifecycles: ${data.verifiedLifecycleSessions}`);
        console.log(
          `exact open: ${data.exactOpenAvailable ? 'available' : 'unavailable'} (VS Code ${data.vscodeVersion ?? 'not found'})`
        );
        console.log(`vscode: protocol: ${data.protocolRegistered ? 'registered' : 'not registered'}`);
        printVSCodeSlots({ slots: data.bindings });
        if (!data.ready) process.exitCode = 1;
      }
      return;

    default:
      console.log(USAGE);
      process.exitCode = command ? 1 : 0;
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
