#!/bin/sh
set -eu

LABEL="eu.okko.agentkeys"
SERVICE="gui/$(id -u)/$LABEL"

launchctl print "$SERVICE" >/dev/null 2>&1 || {
  echo "$LABEL is not loaded; run scripts/install-agent.sh first" >&2
  exit 1
}

launchctl kickstart -k "$SERVICE"
echo "restarted $LABEL"