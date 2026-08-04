#!/bin/sh
# Builds AgentKeys.app: a minimal bundle whose only job is to own the macOS
# Input Monitoring grant that opening this keyboard requires.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/AgentKeys.app"
NODE_BIN="${NODE_BIN:-$(command -v node)}"

[ -x "$NODE_BIN" ] || { echo "node not found" >&2; exit 1; }

# The grant is tied to the code hash, so a changed node binary means re-granting.
OLD_HASH="$(codesign -dvvv "$APP" 2>&1 | sed -n 's/^CDHash=//p' || true)"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"

# TCC identifies the bundle, so the real node binary must live inside it.
cp "$NODE_BIN" "$APP/Contents/MacOS/AgentKeys"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>AgentKeys</string>
  <key>CFBundleIdentifier</key><string>eu.okko.agentkeys</string>
  <key>CFBundleName</key><string>AgentKeys</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSBackgroundOnly</key><true/>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
</dict>
</plist>
PLIST

codesign --force --sign - "$APP"
codesign --verify --strict "$APP"

NEW_HASH="$(codesign -dvvv "$APP" 2>&1 | sed -n 's/^CDHash=//p')"
echo "built $APP"

if [ -n "$OLD_HASH" ] && [ "$OLD_HASH" != "$NEW_HASH" ]; then
  echo "warning: code hash changed, re-grant Input Monitoring for AgentKeys in System Settings → Privacy & Security → Input Monitoring" >&2
  open "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
fi
