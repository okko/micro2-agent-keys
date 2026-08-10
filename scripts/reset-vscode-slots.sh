#!/bin/sh
set -eu

AGENTKEYS_BIN="${AGENTKEYS_BIN:-$HOME/.local/bin/agentkeys}"

if [ ! -x "$AGENTKEYS_BIN" ]; then
  echo "agentkeys CLI not found at $AGENTKEYS_BIN; run scripts/install-agent.sh first" >&2
  exit 1
fi

"$AGENTKEYS_BIN" vscode reset
echo "VS Code integration slots freed"