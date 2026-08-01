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

The daemon never touches your keymap. You bind the agent keycodes to a layer once, the
way you want them, and from then on the daemon only sends colours. That works because
lighting is layer-independent: the device holds per-key state whether or not the layer
is showing, so whenever you switch to it, it already reflects current status.

## The agent layer

Agent keys are ordinary keymap bindings. Six keycodes, one per agent slot:

| Keycode | Purpose |
| --- | --- |
| `KV_OAI_AG00`..`AG05` | the six agent slots — slot `N` is `KV_OAI_AG<NN>` |
| `KV_OAI_ACT06`..`ACT12` | action keys; they report presses over `v.oai.hid` too |
| `KV_OAI_ENC_CW` / `_CC` / `_CLK` | encoder clockwise, counter-clockwise, click |

The firmware's keycode table runs to `AG19` and `ACT20`, so more than six slots may be
addressable. Only `AG00`..`AG05` have been tried here.

### Default layout

This is the stock agent layer, verified byte-for-byte against the one embedded in the
published firmware image. Use it as a starting point and change what you like — it is
also available as `CODEX_LAYER` in [src/keymap.js](src/keymap.js) for scripts.

```json
{
  "id": 0,
  "name": "Agent layer",
  "color": 16711680,
  "layout": {
    "encoders": [["KV_OAI_ENC_CC", "KV_OAI_ENC_CW", "KV_OAI_ENC_CLK"]],
    "buttons": [],
    "keymap": [
      ["KV_OAI_AG00", "KV_OAI_AG01"],
      ["KV_OAI_AG02", "KV_OAI_AG03", "KV_OAI_AG04", "KV_OAI_AG05"],
      ["KV_OAI_ACT06", "KV_OAI_ACT07", "KV_OAI_ACT08", "KV_OAI_ACT09"],
      ["KV_OAI_ACT10", "KV_OAI_ACT11", "KV_OAI_ACT12"]
    ],
    "joystick": { "type": "VENDOR", "sectors": [] }
  },
  "os": 0
}
```

The four `keymap` rows are the physical key rows, 2/4/4/3. Drop this in as one layer of
`profiles[0].layers` in the device's `profile.json`, then import the JSON to Input.app
to write it to the device. Writing that file triggers a live
reload and leaves the active layer alone, so nothing is force-activated.

Managing that file is deliberately out of scope here. Expect the ChatGPT app to gain
the ability to set up and manage the agent-key layer for you in an upcoming version,
at which point hand-editing JSON becomes optional — a forward-looking statement about
software that is not released yet, and nothing in this project depends on it. In the
meantime `install()` in [src/keymap.js](src/keymap.js) can write a layer as a one-off;
read [docs/hardware-safety.md](docs/hardware-safety.md) first.

### Agent keys can share a layer with your own keys

Nothing marks a layer as an agent layer — the device acts on each keycode individually.
So a layer can carry the six agent keys *and* your own keycodes side by side: the agent
keys light up and report presses to the host, everything else types normally. Verified
on hardware.

The slot-to-key mapping follows the **number in the keycode**, not the position, so
`KV_OAI_AG00`..`AG05` can sit anywhere in the layout, in any order. Slot 3 lights
wherever `KV_OAI_AG03` is bound.

**The layer's own key lighting is ignored once it holds agent keycodes.** The whole
layer is then painted by agent colours alone, so keys without a live agent stay dark
and the agent keys stand out against them. This is the intended look, and the other
keys still type normally — they are simply unlit. Verified by A/B on hardware
(`src/backlighttest.js`): the same layer, written the same way, is solid white without
the agent keycodes and fully dark with them, even with every agent colour switched off.


## Setup

```sh
npm install
scripts/make-app.sh        # builds AgentKeys.app
scripts/install-agent.sh   # runs it as a LaunchAgent, links the CLI
```

`install-agent.sh` symlinks the `agentkeys` command into `~/.local/bin`, so that
directory has to be on your `PATH`; the script says so if it is not. The CLI is only an
HTTP client — it needs no permissions, and the checkout has to stay where it is because
the symlink and the LaunchAgent both point at it.

The installer also writes `~/.copilot/hooks/agentkeys.json`. VS Code's preview agent
hooks notify the daemon immediately before and after `vscode_askQuestions`, avoiding the
native Chat transcript's buffered writes. It also registers lifecycle hooks to clear the
VS Code integration slots (AG00..AG03) on session start/end, so stale yellow input
state does not survive between local chat sessions. The `chat.useHooks` setting must be
enabled; it defaults to enabled in the verified VS Code version.

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
agentkeys vscode slots
agentkeys vscode open 0
agentkeys doctor vscode
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
GET  /integrations/vscode/slots
GET  /integrations/vscode/doctor
POST /integrations/vscode/hooks
POST /integrations/vscode/slots/:index/open
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

## How the VS Code integration works

1. **Discover VS Code sessions**

    The daemon watches both Agent Host and native Copilot Chat sessions:

   ```text
   ~/.copilot/session-state/
    ~/Library/Application Support/Code/User/workspaceStorage/*/GitHub.copilot-chat/transcripts/
   ```

    Agent Host sessions must have this `workspace.yaml` value:

   ```yaml
   client_name: vscode-agent-host
   ```

    This prevents ordinary terminal Copilot sessions from taking slots. Native transcripts
    must have a matching persisted entry under the workspace's `chatSessions/` directory.

2. **Wait for actual work**

   Creating or browsing a session does nothing.

   When its event file records `userPromptSubmitted` or `user.message`, the daemon knows
   the user submitted a prompt.

3. **Allocate a slot**

   For an unbound session:

   - use the lowest unbound slot;
   - otherwise reuse the oldest `done` slot;
   - never steal `running`, `input`, or `error`.

4. **Update the LED**

   - prompt or active work -> `running`
    - permission request or outstanding `ask_user`/`vscode_askQuestions` -> `input`
   - session or turn error -> `error`
    - Agent Host `sessionEnd` or native Chat request `result` -> `done`

    Native Chat's `vscode_askQuestions` transition comes from the installed
    `PreToolUse`/`PostToolUse` hooks. Persisted transcript events remain the restart
    fallback; the journal remains the completion source.

5. **Recover after restart**

   The daemon replays each bound event file:

   - unresolved question or permission -> `input`
   - unfinished turn or tool -> `running`
   - recorded error -> `error`
   - completed run -> `done`

6. **Open the session**

   Pressing a physical key constructs an exact-session VS Code URL containing:

   - the project path;
    - `agent-host-copilotcli:/<session-id>` for Agent Host; or
    - VS Code's encoded `vscode-chat-session://local/...` resource for native Chat.

   VS Code focuses the relevant project window and opens the exact transcript there.
   Exact opening is currently enabled only for the verified VS Code `1.131.x` compatibility
   boundary; `agentkeys doctor vscode` reports unsupported versions instead of opening a
   generic or potentially incorrect chat.

## Notes

- `AGENTKEYS_PORT` overrides the port for both daemon and CLI.
- `AGENTKEYS_LOG` redirects daemon output to a file, needed when launched via
  LaunchServices, which discards stdout.
- `COPILOT_HOME` overrides the Copilot data directory used by the VS Code integration.
- `AGENTKEYS_VSCODE_WORKSPACE_STORAGE` overrides the native VS Code workspace-storage directory.
- `AGENTKEYS_VSCODE_STATE` overrides its persisted binding-state file.
- `AGENTKEYS_LAYER` picks which layer the agent keys replace (1-based, default `1`).
- The daemon reconnects on its own if the keyboard is unplugged.
- Pressing `AG00` through `AG03` opens the corresponding bound VS Code session.

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
