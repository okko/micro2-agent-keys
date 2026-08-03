#!/bin/sh
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${AGENTKEYS_PORT:-8787}"

expected="$(tr -d '\r\n' < "$ROOT/dist/build-id")"
response="$(curl --fail --silent --show-error --retry 20 --retry-connrefused --retry-delay 0 "http://127.0.0.1:$PORT/build")"
printf 'expected: %s\nlive:     %s\n' "$expected" "$response"
[ "$response" = "{\"buildId\":\"$expected\"}" ]