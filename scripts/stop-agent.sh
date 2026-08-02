#!/bin/sh
set -eu

LABEL="eu.okko.agentkeys"
SERVICE="gui/$(id -u)/$LABEL"

if launchctl print "$SERVICE" >/dev/null 2>&1; then
  launchctl bootout "$SERVICE"
  echo "stopped $LABEL"
else
  echo "$LABEL is already stopped"
fi
