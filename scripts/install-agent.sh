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

[ -x "$APP" ] || { echo "run scripts/make-app.sh first" >&2; exit 1; }

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
    <string>$ROOT/src/daemon.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
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

ln -sfn "$ROOT/src/cli.js" "$BINDIR/agentkeys"

cat > "$HOOKRUNNER" <<RUNNER
#!/bin/sh
exec "$APP" "$ROOT/src/vscode-hook.js"
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
echo "VS Code hooks: $HOOKFILE"

case ":$PATH:" in
  *":$BINDIR:"*) ;;
  *) echo "warning: $BINDIR is not on your PATH; add it to run 'agentkeys'" >&2 ;;
esac
