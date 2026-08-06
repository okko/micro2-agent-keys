# Findings

Effective behavior established from Creator Micro 2 hardware tests and inspection.
The tested keyboard reports firmware `v0.6.0-rc.12`; firmware bounds were checked
in the production v0.6.1 image.

## Agent-key capacity

- The firmware supports 20 logical agent IDs: `AG00` through `AG19`.
- Both the keycode decoder and `v.oai.thstatus` enforce 19 as the inclusive upper
  bound. `AG20` is not supported.
- Creator Micro 2 has 13 physical switches, so one layer can expose at most 13 distinct
  agent IDs at once.
- The stock agent layer uses six agent IDs, `AG00` through `AG05`. Six is a layout
  choice, not the firmware limit.
- `AG18` and `AG19` were verified on hardware. Each controlled only its bound switch,
  both could be lit independently at the same time, and both emitted press and release
  notifications.

## Stock agent layer

The firmware image contains this single-layer agent layout:

```text
Encoder: ENC_CC / ENC_CW / ENC_CLK

AG00  AG01
AG02  AG03  AG04  AG05
ACT06 ACT07 ACT08 ACT09
ACT10 ACT11 ACT12

Joystick: VENDOR
```

It deep-equals `CODEX_LAYER` in
[`src/research/keymap.ts`](../src/research/keymap.ts).

Agent bindings may be moved to any physical switch and do not need to be contiguous or
ordered. Ordinary HID keycodes and agent keycodes can coexist on the same layer:

- ordinary keys continue to type normally;
- agent keys do not type;
- agent keys emit vendor notifications to the host.

## Layer and keymap behavior

- Writing `keymap.json` live-reloads the keymap while preserving the active layer.
- Installing an agent layer does not activate it.
- There is no agent-layer flag, layer-change notification, or layer-switch RPC.
- Agent behavior is determined entirely by the keycode bound to each physical control.
- Thread state is retained independently of the active layer. A host may update agent
  state while another layer is active; the current state appears when a layer containing
  matching agent bindings becomes active.
- No layer polling or host-side layer tracking is needed for agent lighting.

The research helper restores its saved baseline, not necessarily the keymap present
immediately before a test. In particular,
[`src/research/ag1819test.ts`](../src/research/ag1819test.ts) resets the keyboard to the
saved default keymap after running. Custom keymaps must be exported before that one-time
test.

## Agent lighting

Agent lighting is updated with:

```text
v.oai.thstatus
```

Its parameter is a bare array of thread entries. Sending a subset updates only those
thread IDs and leaves all other thread state unchanged.

For an entry with `id: N`, the firmware renders that state on the physical switch bound
to `KV_OAI_AG<NN>` in the active layer. If no switch has that binding, nothing is
painted.

This mapping was verified with agent IDs deliberately scattered and reordered across a
mixed layer. Lighting followed each keycode rather than its physical position.

### Lighting ownership

If a layer contains agent keycodes, its normal `lights.backlight` is ignored. The layer
is painted from agent thread state instead:

- switches with matching agent bindings show their thread state;
- switches without a matching agent binding remain dark;
- ordinary keys still function even though they are dark.

This behavior is triggered by the presence of agent keycodes, including when all thread
states are off. It provides the isolated agent-layer lighting described by the firmware
release notes.

Thread effects verified on hardware include `solid` and `breath`.

## Host notifications

Agent-key press and release events use:

```json
{"m":"v.oai.hid","p":{"k":"AG01","act":1}}
```

- `k` is the identifier without the `KV_OAI_` keymap prefix.
- `act: 1` means press.
- `act: 0` means release.
- Notifications were verified for `AG00` through `AG05`, `AG18`, and `AG19`.

Action keys and encoder bindings use the same notification method with their respective
identifiers.

The joystick counterpart is `v.oai.rad` when the layer joystick type is `VENDOR`.

## Other lighting zones

`v.oai.rgbcfg` exposes `keys` and `ambient` zones.

- The `keys` zone changes the base key-lighting zone and works on an ordinary layer.
- The `ambient` zone accepts commands but produces no visible change on the agentic layer,
  the ambient zone is disabled on it.

Both `v.oai.thstatus` and `v.oai.rgbcfg` return `{"ok":1}` for malformed payloads,
including `null`. A successful RPC response therefore confirms receipt only; it does
not validate the payload or prove a visible result.

The production daemon follows each state-change burst with one delayed, idempotent
full-state reconciliation. This recovers a lighting update that returned successfully
without becoming visible, while always sampling the latest state so an old retry cannot
overwrite a newer transition.

## Device lifecycle

- Reading, writing, and reading back byte-identical `keymap.json` content works.
- Agent thread state survives layer changes.
- The vendor agent bridge is registered once at boot on all hardware variants.
- Only one process should own the device communication interface at a time.
- Shutdown closes active HTTP connections and has a four-second watchdog. This bounds
  launchd stop/reinstall even when an in-progress native HID open or close does not
  settle.
- The Work Louder application must be closed before the research tools acquire the
  device.

## VS Code telemetry

The effective telemetry model used by this project is:

- persisted Agent Host event streams are the source of truth for session discovery,
  replay, recovery, and lifecycle state;
- native VS Code Chat completion is derived from its persisted chat-session journal;
- native transcript tool requests expose explicit network and unsandboxed flags, and
  external-file requests can be identified by resolving their structured paths against
  the session workspace;
- the transcript writes `tool.execution_start` when the approval UI opens, not after the
  user accepts, so a permissioned native start must retain input state;
- generic approvals do not emit a verified pre-approval `PermissionRequest` hook.
  `PostToolUse` or `PermissionDenied` clears input state as a fallback without forwarding
  tool input. The hook ID's `__vscode-<number>` suffix is removed to correlate it with the
  transcript tool-call ID, and transcript completion remains a final fallback;
- the persisted journal provides the approval-response boundary. A waiting record has
  `isConfirmed: null`, `isComplete: true`, and no `terminalCommandState`; after the user
  responds, `isConfirmed` is populated and terminal calls also gain a command state.
  Process creation and `PreToolUse` are not response signals because both may occur before
  the user accepts;
- journal records for external reads omit access flags, so records whose tool-call IDs are
  already pending from the transcript are also interpreted. Each confirmation clears only
  its matching request, preserving other parallel approval waits;
- unconfirmed journal records recover approval waits across restarts;
- automatic outside-sandbox retry waits use `PermissionRequest`, `PostToolUse`, and
  `PermissionDenied` hooks for the internal terminal-confirmation tool; the hook runner
  forwards only a SHA-256 command fingerprint;
- native live input prompts require preview hook events for timely
  `PreToolUse`/`PostToolUse` tracking;
- lifecycle hook events clear stale native-chat state between runs.

This combination prevents agent slots from retaining stale input state while preserving
file-based recovery after restarts.

## Not established

- The payload and physical direction mapping of `v.oai.rad`.
- Whether the joystick also reports through the standard gamepad interface while vendor
  notifications are enabled.
