# micro2-agentkeys

Drive the six agent keys on a [Work Louder Creator Micro 2](https://worklouder.cc) from
any script, so up to six concurrent coding-agent sessions each get a key that shows
their status.

No custom firmware, and no vendor application needed at runtime. It talks to the device
over its existing USB HID interface, using the JSON-RPC messages the stock firmware
already accepts.

| State   | Colour       | Meaning                        |
| ------- | ------------ | ------------------------------ |
| `idle`  | dim white    | no session in this slot        |
| `running` | blue, breathing | agent is thinking / executing |
| `done`  | green        | finished, output unread        |
| `input` | amber, breathing | paused, waiting on you     |
| `error` | red          | run failed                     |

## How it works

```
your scripts ──HTTP──> daemon ──USB HID JSON-RPC──> keyboard
  (no perms)         (holds the Input Monitoring grant)
```

The daemon owns the single HID connection and the macOS permission. Everything else
is an unprivileged HTTP client, so hooks, shell aliases and editor tasks need no
special entitlement.

Lighting uses the vendor RPC method `v.oai.thstatus`, which takes a bare array of
per-thread descriptors. Sending one entry updates one key and leaves the rest alone.

The device exposes no RPC for switching layers, so the daemon rewrites `keymap.json`
with one layer bound to the agent-key codes. Writing that file triggers a live reload
but leaves the active layer alone, so the agent layer is not force-activated — you
switch to it yourself. That costs nothing, because the device retains per-key lighting
state whether or not the layer is showing: whatever you switch to reflects current
status.

Set `AGENTKEYS_LAYER` to choose which layer gets replaced (1-based, default `1`).

Your original keymap is copied to `~/.local/state/agentkeys/keymap.backup.json` before
the first write and put back on shutdown.


## Setup

```sh
npm install
scripts/make-app.sh        # builds AgentKeys.app
scripts/install-agent.sh   # runs it as a LaunchAgent
```

macOS gates this keyboard behind **Input Monitoring**, because it presents keyboard
interfaces alongside the vendor one. The grant is attached to a code signature, so a
bare `node` invocation cannot hold it — hence the tiny `AgentKeys.app`, which is just
the `node` binary in a signed bundle. Approve it once when prompted, under
System Settings → Privacy & Security → Input Monitoring.

Re-running `make-app.sh` after a Node upgrade changes the code hash and you will have
to approve it again; the script warns when that happens.

## Usage

```sh
agentkeys set 0 running "refactor auth"
agentkeys set 1 done
agentkeys set 2 input
agentkeys reset
agentkeys status
agentkeys states          # list names and aliases
```

Aliases exist so hooks can use their own vocabulary: `thinking`, `busy` and `working`
all mean `running`; `waiting`, `paused` and `blocked` mean `input`.

## HTTP API

Bound to `127.0.0.1` only, and requests must carry a loopback `Host` header so a web
page cannot drive your keyboard.

```
GET  /state                 -> { connected, slots: [...] }
POST /slots/:index          <- { "state": "running", "label": "optional" }
POST /reset
```

```sh
curl -s localhost:8787/state
curl -s -X POST localhost:8787/slots/3 -H 'content-type: application/json' -d '{"state":"error"}'
```

## Wiring it to an agent

Give each session a slot number and call the CLI at the transitions you care about:

```sh
SLOT=0
agentkeys set $SLOT running "$(basename "$PWD")"
if my-agent-command; then agentkeys set $SLOT done; else agentkeys set $SLOT error; fi
```

## Notes

- `AGENTKEYS_PORT` overrides the port for both daemon and CLI.
- `AGENTKEYS_LOG` redirects daemon output to a file, needed when launched via
  LaunchServices, which discards stdout.
- `AGENTKEYS_LAYER` picks which layer the agent keys replace (1-based, default `1`).
- The daemon reconnects on its own if the keyboard is unplugged.
- The device also emits `v.oai.hid` notifications when you physically press an agent
  key. Not wired up yet; it is the obvious path to clicking a key to focus a session.

## Docs

- [docs/hardware-safety.md](docs/hardware-safety.md) — **read before writing to the
  device.** How a two-process run once left it unresponsive, and the guardrails that
  now prevent that.
- [docs/protocol.md](docs/protocol.md) — HID framing, JSON-RPC, lighting, keycodes.
- [docs/development.md](docs/development.md) — macOS Input Monitoring, launching, tools.
- [docs/findings.md](docs/findings.md) — observed results, corrected assumptions, open
  questions.

## Notice

This is an independent, unofficial personal project. It is not affiliated with,
sponsored by, endorsed by, or supported by Work Louder, OpenAI, or any other company
whose products it interoperates with. Product, company and interface names are used
only to identify the hardware and software involved, and remain the property of their
respective owners.

The repository contains original code only. Apart from the open-source npm packages it
declares as dependencies, it ships no third-party firmware, SDK or application code and
requires none to build or run. The notes in `docs/` record behaviour observed on one
device while using its USB interface; they are not vendor documentation and may be
incomplete or wrong.

Writing to a keyboard's on-device configuration can leave it unusable, and doing so may
affect any warranty or support you have from its manufacturer. This software is
provided as-is, without warranty of any kind. Use it at your own risk.
