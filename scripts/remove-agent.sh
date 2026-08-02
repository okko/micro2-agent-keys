#!/bin/sh
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="eu.okko.agentkeys"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

"$ROOT/scripts/stop-agent.sh"
rm -f "$PLIST"
echo "removed $PLIST"
