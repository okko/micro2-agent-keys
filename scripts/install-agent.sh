#!/bin/sh
# Registers the daemon as a LaunchAgent. launchd starts the app bundle directly,
# so the process is its own responsible process and keeps the TCC grant.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/AgentKeys.app/Contents/MacOS/AgentKeys"
LABEL="eu.okko.agentkeys"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
BINDIR="$HOME/.local/bin"

[ -x "$APP" ] || { echo "run scripts/make-app.sh first" >&2; exit 1; }

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
launchctl bootstrap "gui/$(id -u)" "$PLIST"

ln -sfn "$ROOT/src/cli.js" "$BINDIR/agentkeys"

echo "loaded $LABEL"
echo "log: $HOME/.local/state/agentkeys/daemon.log"
echo "cli: $BINDIR/agentkeys"

case ":$PATH:" in
  *":$BINDIR:"*) ;;
  *) echo "warning: $BINDIR is not on your PATH; add it to run 'agentkeys'" >&2 ;;
esac
