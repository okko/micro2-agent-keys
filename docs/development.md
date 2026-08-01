# Development notes

macOS-specific friction, and how to run things without breaking the keyboard.

## Input Monitoring (TCC)

This keyboard presents Generic Desktop / Keyboard interfaces alongside the vendor one,
so macOS gates **all** access behind **Input Monitoring** — including the vendor page.
Opening `nonExclusive` does **not** dodge it. This was confirmed, not assumed.

The grant is attached to a **code signature**, so a bare `node` invocation can never
hold it. Access therefore has to come from a signed application bundle.

`AgentKeys.app` exists solely to hold that grant: it is the real `node` binary plus an
`Info.plist` (`cc.okko.agentkeys`, `LSBackgroundOnly=true`), ad-hoc signed by
`scripts/make-app.sh`.

TCC cannot be scripted. Approve once under
**System Settings → Privacy & Security → Input Monitoring**.

Re-running `make-app.sh` after a Node upgrade changes the code hash, which invalidates
the grant and requires re-approval. The script warns about this.

## Launching

**Running the bundle's binary directly from a shell fails even after the grant**,
because the terminal becomes the responsible process:

```sh
./AgentKeys.app/Contents/MacOS/AgentKeys src/probe.js   # fails, (0xE00002E2) not permitted
```

Go through LaunchServices or launchd so the grant is attributed to the bundle:

```sh
open -n -a "$PWD/AgentKeys.app" \
  --env AGENTKEYS_LOG="$PWD/probe.log" \
  --args "$PWD/src/probe.js"
```

**LaunchServices discards stdout.** Anything launched this way must write its own log
file. Note that `AGENTKEYS_LOG` is not global — it is implemented inside `src/daemon.js`,
`src/probe.js` and `src/layertest.js` individually. A new ad-hoc script gets no logging
for free.

## Environment variables

| Variable | Used by | Meaning |
|---|---|---|
| `AGENTKEYS_PORT` | daemon, CLI | HTTP port, default `8787` |
| `AGENTKEYS_LOG` | daemon, probe, layertest, mixedlayertest, backlighttest | redirect output to a file |
| `AGENTKEYS_LAYER` | daemon, layertest, mixedlayertest, backlighttest | which layer to install onto, **1-based**, default `1` |
| `AGENTKEYS_HOLD_MS` | layertest, mixedlayertest | observation window, default `45000` |
| `AGENTKEYS_PHASE_MS` | backlighttest | per-phase observation window, default `25000` |

## Tools in `src/`

| File | Writes to device? | Purpose |
|---|---|---|
| `probe.js` | no | enumerate interfaces, read `sys.version` and `device.status` |
| `layertest.js` | **yes** | install the agent layer, set six colours, hold, restore |
| `mixedlayertest.js` | **yes** | install a layer mixing agent and ordinary keycodes, log `v.oai.hid` presses, restore |
| `backlighttest.js` | **yes** | A/B whether agent keycodes suppress the layer's own backlight |
| `daemon.js` | **yes** | the real thing |

### Running the layer test

```sh
cd ~/git/micro2-agentkeys
rm -f layertest.log
open -n -a "$PWD/AgentKeys.app" \
  --env AGENTKEYS_LOG="$PWD/layertest.log" \
  --env AGENTKEYS_LAYER=3 \
  --env AGENTKEYS_HOLD_MS=60000 \
  --args "$PWD/src/layertest.js"
```

Then wait and `cat layertest.log`. It refuses to start if the vendor app is running,
takes the device lock, and restores the keymap on every exit path.

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
