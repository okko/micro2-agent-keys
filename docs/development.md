# Development notes

macOS-specific friction, and how to run things without breaking the keyboard.

## Input Monitoring (TCC)

This keyboard presents Generic Desktop / Keyboard interfaces alongside the vendor one,
so macOS gates **all** access behind **Input Monitoring** — including the vendor page.
Opening `nonExclusive` does **not** dodge it. This was confirmed, not assumed.

The grant is attached to a **code signature**, so a bare `node` invocation can never
hold it. Access therefore has to come from a signed application bundle.

`AgentKeys.app` exists solely to hold that grant: it is the real `node` binary plus an
`Info.plist` (`eu.okko.agentkeys`, `LSBackgroundOnly=true`), ad-hoc signed by
`scripts/make-app.sh`.

TCC cannot be scripted. Approve once under
**System Settings → Privacy & Security → Input Monitoring**.

Re-running `make-app.sh` after a Node upgrade changes the code hash, which invalidates
the grant and requires re-approval. The script warns about this.

## Launching

**Running the bundle's binary directly from a shell fails even after the grant**,
because the terminal becomes the responsible process:

```sh
./AgentKeys.app/Contents/MacOS/AgentKeys src/research/probe.js   # fails, (0xE00002E2) not permitted
```

Go through LaunchServices or launchd so the grant is attributed to the bundle:

```sh
open -n -a "$PWD/AgentKeys.app" \
  --env AGENTKEYS_LOG="$PWD/probe.log" \
  --args "$PWD/src/research/probe.js"
```

**LaunchServices discards stdout.** Anything launched this way must write its own log
file. Note that `AGENTKEYS_LOG` is not global — it is implemented inside `src/daemon.js`,
`src/research/probe.js` and `src/research/layertest.js` individually. A new ad-hoc script
gets no logging for free.

## Environment variables

| Variable | Used by | Meaning |
|---|---|---|
| `AGENTKEYS_PORT` | daemon, CLI | HTTP port, default `8787` |
| `AGENTKEYS_LOG` | daemon, probe, layertest, mixedlayertest, backlighttest | redirect output to a file |
| `AGENTKEYS_LAYER` | daemon, layertest, mixedlayertest, backlighttest | which layer to install onto, **1-based**, default `1` |
| `AGENTKEYS_HOLD_MS` | layertest, mixedlayertest | observation window, default `45000` |
| `AGENTKEYS_PHASE_MS` | backlighttest, ag1819test | per-phase observation window |

## Tools in `src/research/`

| File | Writes to device? | Purpose |
|---|---|---|
| `probe.js` | no | enumerate interfaces, read `sys.version` and `device.status` |
| `layertest.js` | **yes** | install the agent layer, set six colours, hold, restore |
| `mixedlayertest.js` | **yes** | install a layer mixing agent and ordinary keycodes, log `v.oai.hid` presses, restore |
| `backlighttest.js` | **yes** | A/B whether agent keycodes suppress the layer's own backlight |
| `ag1819test.js` | **yes** | one-time AG18/AG19 test on row 2; resets the keymap to the saved default afterward |
| `keymap.js` | **yes** | shared temporary keymap installation and restoration support |

The application daemon remains at `src/daemon.js`.

### Running the layer test

```sh
cd ~/git/micro2-agentkeys
rm -f layertest.log
open -n -a "$PWD/AgentKeys.app" \
  --env AGENTKEYS_LOG="$PWD/layertest.log" \
  --env AGENTKEYS_LAYER=3 \
  --env AGENTKEYS_HOLD_MS=60000 \
  --args "$PWD/src/research/layertest.js"
```

Then wait and `cat layertest.log`. It refuses to start if the vendor app is running,
takes the device lock, and restores the keymap on every exit path.

### Running the AG18/AG19 test

> **Warning:** this one-time test does not preserve the keymap that is currently on the
> keyboard. When it finishes, it resets the keyboard to the saved default keymap. Export
> or otherwise record any custom keymap before running it.

Close the Work Louder Input app and switch to the layer to test. If your terminal has HID
permission, run:

```sh
node src/research/ag1819test.js
```

Otherwise, use the permitted app wrapper:

```sh
rm -f ag1819test.log
open -n -a "$PWD/AgentKeys.app" \
  --env AGENTKEYS_LOG="$PWD/ag1819test.log" \
  --env AGENTKEYS_PHASE_MS=30000 \
  --args "$PWD/src/research/ag1819test.js"
tail -f ag1819test.log
```

By default it temporarily replaces the active layer. Set `AGENTKEYS_LAYER` to target a
different 1-based layer. Follow the prompts to confirm the two leftmost switches on the
second row light individually, then press and release both. Through the app wrapper,
each visual and input phase lasts `AGENTKEYS_PHASE_MS`. After the test, the keyboard is
reset to the saved default keymap, not to the keymap that was active before the test.

## Detecting the vendor app correctly

Do **not** use `pgrep -f '/Applications/input.app'`. `pgrep -f` matches the whole
argv, so it false-positives on any process that merely *mentions* the path — including
your own shell script that contains the pattern as a literal. This produced a confusing
phantom PID during testing.

Match on the executable path instead:

```sh
ps -A -o pid=,comm= | grep '/Applications/input.app/'
```

Demonstrated difference, with a decoy process holding the string in argv:

```
old check, pgrep -f argv  -> 1 match(es)   <- false positive
new check, ps -o comm=    -> 0 match(es)   <- correct
```

## Testing without hardware

The restore guarantee is testable with a stub device that implements `call()` for
`fs.read` / `fs.write`. That covers the dangerous path — including the failure path —
without touching the keyboard. Assert that the final written text equals the pristine
backup after `fn` throws.

## Misc environment quirks

- Python `mmap.mmap(open(p, "rb").fileno(), ...)` fails with `Bad file descriptor`
  because the file object is garbage collected. Hold a reference to it.
- macOS `pgrep` has no `-c`; use `| wc -l`.
- zsh: quote `--include='*.ts'`; use `;` rather than `&&` after `rm`.
