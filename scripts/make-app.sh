#!/bin/sh
# Builds AgentKeys.app: a minimal background app bundle for the Node daemon.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/AgentKeys.app"
NODE_BIN="${NODE_BIN:-$(command -v node)}"

[ -x "$NODE_BIN" ] || { echo "node not found" >&2; exit 1; }

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"

# Keep the launchd runtime independent of shell version-manager initialization.
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

echo "built $APP"
