#!/usr/bin/env node
'use strict';

const { STATES, ALIASES, SLOT_COUNT, normalizeState } = require('./states');

const PORT = Number(process.env.AGENTKEYS_PORT ?? 8787);
const BASE = `http://127.0.0.1:${PORT}`;

const USAGE = `agentkeys - drive the Creator Micro 2 agent keys

  agentkeys set <slot> <state> [label]   set one slot (slot 0..${SLOT_COUNT - 1})
  agentkeys status                       show all slots
  agentkeys reset                        set every slot to idle
  agentkeys states                       list valid state names

states: ${Object.keys(STATES).join(', ')}
`;

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(`daemon not reachable on ${BASE} - is it running?`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `request failed (${res.status})`);
  return data;
}

function printStatus(data) {
  console.log(data.connected ? 'keyboard: connected' : 'keyboard: disconnected');
  for (const slot of data.slots) {
    console.log(`  ${slot.index}  ${slot.state.padEnd(8)} ${slot.label ?? ''}`);
  }
}

async function main(argv) {
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
      printStatus(await request('GET', '/state'));
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

    default:
      console.log(USAGE);
      process.exitCode = command ? 1 : 0;
  }
}

main(process.argv.slice(2)).catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
