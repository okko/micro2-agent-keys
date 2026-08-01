# Protocol reference

Notes on the USB HID interface this project talks to. No custom firmware is involved.

Two kinds of evidence, marked throughout:

- **hardware** — tested against the author's own device, running stock `v0.6.0-rc.12`.
- **image** — read out of `firmware_v0.6.0-rc.15_merged.bin`, published on Work
  Louder's public [release page](https://github.com/worklouder/cm-v2-fw-releases).
  That is a *different firmware version* from the unit tested here, so image-derived
  details are not guaranteed to describe rc.12.

This repository contains original code only. Apart from the open-source npm packages it
declares as dependencies, it bundles no third-party firmware, SDK or application code
and requires none to build or run. Nothing from the firmware image is reproduced here
beyond the interface names needed to describe the protocol. See the notice at the end
of [README.md](../README.md).

## Device identity

| | |
|---|---|
| Vendor ID | `0x303A` |
| Product ID | `0x8298` |
| SoC | ESP32-S3 (not QMK, not VIA) |
| Firmware | reports `v0.6.0-rc.12`, internal name `cm-v2-fw` |
| Variant | this unit reports **pro** |
| Hardware | 13 switches, touch sensor, rotary encoder, planar joystick, internal battery |

## HID interfaces

The device enumerates **six** interfaces. Filter on `usagePage === 0xFF00` to find the
vendor RPC endpoint:

```
0x1/0x6   Generic Desktop / Keyboard
0xc/0x1   Consumer Control
0x1/0x2   Generic Desktop / Mouse
0x1/0x1   Generic Desktop / Pointer
0x1/0x5   Generic Desktop / Game Pad
0xff00/0x1  <- vendor RPC, this is the one
```

Open non-exclusively on macOS, otherwise you seize the keyboard interface and typing
stops working:

```js
await HID.HIDAsync.open(path, { nonExclusive: true });
```

`nonExclusive` has been available in upstream `node-hid` since 3.2.0, so plain
`node-hid@^3.4.0` from npm is all this project needs.

## Wire format

Fixed 64-byte reports:

| Byte | Meaning |
|------|---------|
| 0 | report ID, always `0x06` |
| 1 | channel: `1` = debug log, `2` = RPC |
| 2 | payload length in this report, max `61` |
| 3..63 | payload chunk |

Payloads longer than 61 bytes are split across consecutive reports.

## JSON-RPC layer

Request body is `JSON.stringify({ method, params, id })`, unicode-escaped, with **no**
trailing newline. `id` must be in `[0, 999)`.

Transport rules that matter in practice:

- Requests are **serialized** — one in flight at a time. Sending more than one at a
  time was not reliable in testing.
- 50 ms cooldown between requests.
- 10 s response timeout.
- Because the open is non-exclusive, you will also receive replies belonging to *other*
  processes. Ignore any message whose `id` you did not issue.

### Methods

Every method name present in the rc.15 image (**image**):

```
device.status
fs.chksm  fs.delete  fs.format  fs.list  fs.read  fs.readbin  fs.write  fs.writebin
kb.cs.hide  kb.cs.show  kb.cs.toggle  kb.radial
kb.sa.exec  kb.sa.inserttext  kb.sa.openapp  kb.sa.openurl
lights.preview
sys.bootloader  sys.charger_diagnostic  sys.charger_diagnostic_summary  sys.selftest
sys.version
v.oai.hid  v.oai.rad  v.oai.rgbcfg  v.oai.thstatus
```

Note what is **absent**: there is no method to switch layers, and no notification when
the layer changes. `device.status` is the only way to learn the active layer, and it
has to be polled for.

Only these have been exercised here (**hardware**):

| Method | Params | Notes |
|---|---|---|
| `sys.version` | — | `{"version":"v0.6.0-rc.12"}` |
| `device.status` | — | see below |
| `lights.preview` | zone object | immediate, **not** persisted |
| `fs.list` | `{checksum, rec, path}` | |
| `fs.read` | `{file}` | |
| `fs.write` | `{file, data}` | **brick risk — see docs/hardware-safety.md** |

```json
{"version":"v0.6.0-rc.12","profile_index":0,"layer_index":2,
 "battery":100,"is_charging":true}
```

`layer_index` is **1-based**. Layer `id` inside `keymap.json` is **0-based**.

### Device to host notifications

`v.oai.hid` is pushed when a key bound to an agent keycode is physically pressed
(**hardware**). Captured verbatim, one press and its release:

```json
{"m":"v.oai.hid","p":{"k":"AG01","act":1}}
{"m":"v.oai.hid","p":{"k":"AG01","act":0}}
```

Note the envelope. Notifications use short `m` and `p` for method and params, not the
`method` / `params` a request carries, and there is no `id`. Inside, `k` is the key and
`act` is `1` for press, `0` for release.

`k` is assembled on the device from the format strings `AG%02u`, `ACT%02u`, `ENC_CW`,
`ENC_CC` and `ENC_CLK` (**image**), so it reads `"AG01"` — the `KV_OAI_` prefix used in
`keymap.json` is **not** there.

Keys *not* bound to an agent keycode send nothing here and emit ordinary HID instead,
even on the same layer.

Not wired up yet; it is the natural path to "click a key to focus that session".

`v.oai.rad` is the joystick counterpart: a layer whose joystick `type` is `VENDOR`
routes there instead of to `kb.radial` (**image**, never exercised).

## Lighting

### `lights.preview`

Immediate, not persisted. Zone shape uses **long** key names:

```js
{ effect, brightness, speed, magic, color }
```

`brightness` and `speed` are **0..1 floats** — sending `100` had no visible effect.
`color` is a **24-bit integer**, not a `"#hex"` string.

### `v.oai.thstatus` — per-key agent lights

`params` is a **bare array**, not an object:

```js
[{ id, c, b, e, s, sk, sa }]
```

| Field | Meaning |
|---|---|
| `id` | thread index, `0..5` |
| `c` | colour, 24-bit int |
| `b` | brightness, 0..1 float |
| `e` | effect, **numeric** |
| `s` | speed, 0..1 float |
| `sk` | syncKeysLighting, 0/1 flag |
| `sa` | syncAmbientLighting, 0/1 flag |

`sk`/`sa` behave as booleans. An early guess that `sa` was a status array cost roughly
fourteen failed encodings before that was ruled out.

Sending a subset updates only those threads and leaves the others lit. Verified.

### Nothing detects an agent layer

There is no agent-layer flag — not in the firmware, not on the wire. The binding is
entirely by keycode, which was read out of the image and then confirmed on hardware
with a deliberately mixed layer (**hardware**):

- `v.oai.thstatus` with `id: N` stores thread `N` unconditionally. It is rendered on
  whichever key of the **active** layer is bound to `KV_OAI_AG<NN>` where `NN == N`.
  With no key bound to it, there is simply nothing to paint.
- The bridge is registered once at boot, on every hardware variant, with no layer gate.

So "agent lighting only shows on an agent layer" is not a rule the firmware enforces —
it is what an empty match looks like. Neither side needs to know which layer is active,
which is why this project does not track layers either.

The practical consequence: thread ids mean something only because `CODEX_LAYER` in
[../src/keymap.js](../src/keymap.js) binds `AG00`..`AG05` to the first six keys. Bind
different numbers and the same `id` lights a different key, or none.

What the keycodes *do* change is lighting ownership. A layer holding them has its own
`lights.backlight` ignored and is painted only by `v.oai.thstatus`, so keys with no
thread bound stay dark and the agent keys stand out against them (**hardware**). That is
a property of the keycodes, not of the thread state: the same layer is solid white
without them and fully dark with them even when every thread is off.

The stock agent keymap numbers its keycodes `AG00`..`AG05` on keys 0-5 and then
`ACT06`..`ACT12` on keys 6-12. The continuous run reads like physical key position
rather than an action identifier, but that is an inference, not something observed.

### `v.oai.rgbcfg` — base zones

```js
{ ambient: { e, b, s, m, c }, keys: { e, b, s, m, c } }
```

Note the **short** key names here, unlike `lights.preview`. The `keys` zone works even
on a normal keymap; the `ambient` zone produced no visible change on this unit.

### Effects

```js
{ off: 0, solid: 1, snake: 2, rainbow: 3, breath: 4, gradient: 5, shallowBreath: 6 }
```

### Both `v.oai.*` endpoints are lenient

`v.oai.thstatus` and `v.oai.rgbcfg` returned `{"ok":1}` for **any** payload tried,
including `null`. They are therefore useless as a correctness oracle — the only way to
know whether an encoding worked is to look at the keyboard.

## Keycodes

| Prefix | Meaning |
|---|---|
| `KV_OAI_AG00`..`AG19` | agent thread keys |
| `KV_OAI_ACT00`..`ACT20` | agent action keys |
| `KV_OAI_ENC_CC` / `CW` / `CLK` | encoder counter-clockwise / clockwise / click |
| `KI_LS1`..`KI_LS15` | switch to layer (host app labels `KI_LS1` as "Layer 1", so **1-based**) |
| `KI_LM1`..`KI_LM15` | momentary layer |
| `KI_LSNEXT` / `KI_LSPREV` | cycle layers |
| `KI_PS1`..`KI_PS15` | switch profile |
| `KI_FP` | function/profile key |
| `KI_BLDW` / `KI_BLUP` | backlight down / up |
| `KI_CBT1`..`KI_CBT8` | Bluetooth channels |

There is **no layer-switch RPC**. Layers can only be changed physically, or by
rewriting `keymap.json`.

## `keymap.json`

- Lives on the device filesystem; read with `fs.read`, write with `fs.write`.
- Writing triggers a firmware live-reload.
- **The active layer is preserved across that reload** — it does *not* reset to layer 1.
  (An earlier assumption in this repo claimed otherwise. It was wrong; see
  docs/findings.md.)
- Layer `id` is 0-based. `device.status.layer_index` is 1-based.
- Restoring a byte-identical backup works and can be verified by reading back.
- A factory reset restores a default keymap, so the device comes back with a valid
  `keymap.json`.
- The rc.15 image carries **two** default keymaps as plaintext JSON (**image**): the
  ordinary one, and an agent one whose single layer deep-equals `CODEX_LAYER` in
  [../src/keymap.js](../src/keymap.js). Neither carries a `lights` object.

When the keymap is malformed, the debug channel reports it — messages naming
`keymap.json` and mentioning a missing profile, layer list or active profile id are the
ones to look for.
