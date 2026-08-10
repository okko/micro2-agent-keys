#!/bin/sh
# Registers the daemon as a LaunchAgent. launchd starts the app bundle directly,
# so the process is its own responsible process and keeps the TCC grant.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/AgentKeys.app/Contents/MacOS/AgentKeys"
LABEL="eu.okko.agentkeys"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
BINDIR="$HOME/.local/bin"
HOOKDIR="$HOME/.copilot/hooks"
HOOKFILE="$HOOKDIR/agentkeys.json"
HOOKRUNNER="$BINDIR/agentkeys-vscode-hook"
VSCODERESET="$BINDIR/agentkeys-reset-vscode-slots"

[ -x "$APP" ] || { echo "run scripts/make-app.sh first" >&2; exit 1; }
(cd "$ROOT" && npm run build --silent)

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.local/state/agentkeys" "$BINDIR" "$HOOKDIR"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$APP</string>
    <string>$ROOT/dist/daemon.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ExitTimeOut</key><integer>5</integer>
  <key>StandardOutPath</key><string>$HOME/.local/state/agentkeys/daemon.log</string>
  <key>StandardErrorPath</key><string>$HOME/.local/state/agentkeys/daemon.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true

# A bundle opened manually for the TCC prompt is not owned by launchd. Stop it
# before bootstrapping, otherwise both processes race to bind the HTTP port.
for pid in $(pgrep -x AgentKeys 2>/dev/null || true); do
  kill -TERM "$pid"
done

attempt=0
while pgrep -x AgentKeys >/dev/null 2>&1 && [ "$attempt" -lt 50 ]; do
  attempt=$((attempt + 1))
  sleep 0.1
done
if pgrep -x AgentKeys >/dev/null 2>&1; then
  echo "AgentKeys did not stop; refusing to start a second daemon" >&2
  exit 1
fi

launchctl bootstrap "gui/$(id -u)" "$PLIST"

"$ROOT/scripts/verify-build.sh"

PORT="${AGENTKEYS_PORT:-8787}"
DEVICE_STATE=""
attempt=0
while [ "$attempt" -lt 40 ]; do
  if DEVICE_STATE="$(curl --fail --silent "http://127.0.0.1:$PORT/state")" &&
    printf '%s' "$DEVICE_STATE" | node -e '
const state = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
process.exit(state.connected === true ? 0 : 1);
'; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 0.25
done

if [ -z "$DEVICE_STATE" ]; then
  echo "error: daemon became unreachable while verifying keyboard access" >&2
  verified=false
elif ! printf '%s' "$DEVICE_STATE" | node -e '
const state = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
if (state.connected === true) process.exit(0);
const reason = state.deviceError || (state.deviceVisible === false
  ? "vendor HID interface is not visible"
  : "connection did not complete");
console.error(`error: daemon cannot access the keyboard: ${reason}`);
process.exit(1);
'; then
  verified=false
else
  verified=true
fi

if [ "$verified" != true ]; then
  echo "Connect the keyboard and allow AgentKeys in System Settings → Privacy & Security → Input Monitoring, then run this installer again." >&2
  open "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent" || true
  exit 1
fi
echo "Input Monitoring: verified (keyboard connected)"

ln -sfn "$ROOT/dist/cli.js" "$BINDIR/agentkeys"
ln -sfn "$ROOT/scripts/reset-vscode-slots.sh" "$VSCODERESET"

cat > "$HOOKRUNNER" <<RUNNER
#!/bin/sh
exec "$APP" "$ROOT/dist/vscode-hook.js"
RUNNER
chmod 755 "$HOOKRUNNER"

cat > "$HOOKFILE" <<'HOOKS'
{
  "hooks": {
    "PreToolUse": [
      {
        "type": "command",
        "command": "~/.local/bin/agentkeys-vscode-hook",
        "timeout": 2
      }
    ],
    "PostToolUse": [
      {
        "type": "command",
        "command": "~/.local/bin/agentkeys-vscode-hook",
        "timeout": 2
      }
    ],
    "PermissionRequest": [
      {
        "type": "command",
        "command": "~/.local/bin/agentkeys-vscode-hook",
        "timeout": 2
      }
    ],
    "PermissionDenied": [
      {
        "type": "command",
        "command": "~/.local/bin/agentkeys-vscode-hook",
        "timeout": 2
      }
    ],
    "SessionStart": [
      {
        "type": "command",
        "command": "~/.local/bin/agentkeys-vscode-hook",
        "timeout": 2
      }
    ],
    "SessionEnd": [
      {
        "type": "command",
        "command": "~/.local/bin/agentkeys-vscode-hook",
        "timeout": 2
      }
    ]
  }
}
HOOKS

echo "loaded $LABEL"
echo "log: $HOME/.local/state/agentkeys/daemon.log"
echo "cli: $BINDIR/agentkeys"
echo "VS Code slot reset: $VSCODERESET"
echo "VS Code hooks: $HOOKFILE"

case ":$PATH:" in
  *":$BINDIR:"*) ;;
  *) echo "warning: $BINDIR is not on your PATH; add it to run 'agentkeys'" >&2 ;;
esac
