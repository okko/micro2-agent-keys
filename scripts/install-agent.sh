#!/bin/sh
# Registers the daemon as a LaunchAgent using the app bundle's Node runtime.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/AgentKeys.app/Contents/MacOS/AgentKeys"
LABEL="eu.okko.agentkeys"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
BINDIR="$HOME/.local/bin"
VSCODERESET="$BINDIR/agentkeys-reset-vscode-slots"

[ -x "$APP" ] || { echo "run scripts/make-app.sh first" >&2; exit 1; }
(cd "$ROOT" && npm run build --silent)
node "$ROOT/dist/configure.js"

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.local/state/agentkeys" "$BINDIR"

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

# A bundle opened manually is not owned by launchd. Stop it
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
echo "Keep Input.app running and approve AgentKeys in Input within 30 seconds if prompted."
while [ "$attempt" -lt 180 ]; do
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
  ? "no supported keyboard is ready in Input"
  : "connection did not complete");
console.error(`error: daemon cannot access the keyboard: ${reason}`);
process.exit(1);
'; then
  verified=false
else
  verified=true
fi

if [ "$verified" != true ]; then
  echo "Open Input.app, connect the keyboard, and approve AgentKeys in Input. Check the daemon log for authorization or Keychain errors, then retry." >&2
  exit 1
fi
echo "Input WebSocket: verified (keyboard connected)"

ln -sfn "$ROOT/dist/cli.js" "$BINDIR/agentkeys"
ln -sfn "$ROOT/scripts/reset-vscode-slots.sh" "$VSCODERESET"

# Remove obsolete AgentKeys-owned hook files.
rm -f "$HOME/.copilot/hooks/agentkeys.json" "$BINDIR/agentkeys-vscode-hook"

echo "loaded $LABEL"
echo "log: $HOME/.local/state/agentkeys/daemon.log"
echo "cli: $BINDIR/agentkeys"
echo "VS Code slot reset: $VSCODERESET"
echo "VS Code integration: AHP"

case ":$PATH:" in
  *":$BINDIR:"*) ;;
  *) echo "warning: $BINDIR is not on your PATH; add it to run 'agentkeys'" >&2 ;;
esac
