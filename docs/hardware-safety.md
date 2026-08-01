# Hardware safety

Read this before writing anything to the device.

This page records what was observed on one unit while developing this project. It is
not vendor documentation and makes no claim about how the device is designed or how
other units behave. Writing to the device is done at your own risk.

## What happened

During development the keyboard stopped responding, and getting it back required
**physically opening the case**. The circumstances are worth recording, because nothing
in the OS stops you from repeating them.

### Circumstances

macOS HID opens here are `nonExclusive`, so **the OS lets several processes drive the
device at once**.

A second test process was launched while the first was still alive. Both issued RPC
concurrently, including `fs.write` of `keymap.json`, and the device stopped responding
shortly afterwards. The exact mechanism was never established. Treat concurrent access
as unsafe.

### Symptom signature

Recognise this quickly, because it looks worse than it is:

- LED task and the USB stack **stay alive** — the device still enumerates all six HID
  interfaces, and ambient lighting keeps animating.
- Ambient shows the default rainbow, which suggests it had restarted.
- Keys dead, touch dead, RPC dead.
- The debug channel goes **completely silent** — a passive 25 s listen received zero
  reports, not even log lines.

A narrow `grep` over `system_profiler SPUSBDataType` returned nothing and briefly
suggested the device had stopped enumerating. That was a red herring. Use
`HID.devices()` to answer "is it enumerating", not `system_profiler`.

## Rules

1. **Never run two processes against the device at once.** This is the whole lesson.
2. Take the exclusive lock before opening. It is enforced in `Device.open()`.
3. **Quit the vendor app (`input.app`) first.** It opens the same interface and does
   *not* respect our lock. This is the one remaining way to reproduce the incident.
4. Any code that writes `keymap.json` must restore it in its **failure** path, not just
   on success. Use `withCodexLayer()`.
5. Prefer read-only probes. Treat every `fs.write` as carrying a risk of leaving the
   device unresponsive.

## The device lock

`src/device.js` maintains a PID lockfile at `~/.local/state/agentkeys/device.lock`.

- Acquired in `Device.open()` before the HID open.
- Released in `close()`, and on process `exit`.
- Released if the HID open itself throws.
- A **live** holder causes a `DeviceError`. A **stale** holder (dead PID) is reclaimed
  automatically.

Verified behaviour:

```
live holder  -> DeviceError: device is already in use by pid NNNNN
stale holder -> reclaimed
lock file cleaned up even when open() throws
```

**Limitation: this only coordinates our own processes.** The vendor app does not know
about it.

## Guaranteed keymap restore

`withCodexLayer(device, layerNumber, fn)` in `src/keymap.js` is the only sanctioned way
to install the agent layer. It restores the user's keymap:

- on success,
- on throw (then re-raises the original error),
- on `SIGINT` / `SIGTERM` before exiting.

Restore is memoised, so a signal arriving mid-restore cannot start a second overlapping
`fs.write`. Signal handlers are deregistered afterwards.

Never call `install()` bare.

## Recovery when wedged

**There is no external power-off on this device.** Unplugging does nothing, because it
has an internal battery.

As far as could be determined, only the **rear button** can power it down, and that
button is **inside the case** — four screws. The touch sensor only puts it into
standby, which is not enough.

The rear button responds to how long it is held, and acts **on release**:

| Hold duration | Observed result |
|---|---|
| tap | standby / battery animation |
| hold | powers off — **this is the safe one**, and the device shows it is armed |
| hold longer | arms a factory reset — destructive |

The exact hold thresholds are not recorded here. Release while it is indicating
power-off, which is non-destructive, then power back on.

If the board ends up in bootloader mode, the vendor app detects it and offers to
reflash, stepping through backup, download, bootload and restore.

A factory reset is survivable — it restores a default keymap, so the device comes back
with a valid `keymap.json`.

## Backups

`~/.local/state/agentkeys/keymap.backup.json` holds the user's original keymap.

Be aware: `install()` only creates the backup **if none exists**, and `install()` /
`restore()` both rebuild from that baseline. So the baseline can silently go stale and
revert deliberate edits the user made afterwards. If the user has changed their keymap
on purpose, refresh the baseline and keep the old one aside.
