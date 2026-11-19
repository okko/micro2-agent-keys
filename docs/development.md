# Development

Use Node.js 22.4 or newer (global WebSocket support is required by InputKit).

```sh
npm install
npm run check
npm test
```

Tests use fake clients and a local WebSocket server; no keyboard, Input approval or
Keychain changes are required. Run the tests outside restricted sandboxes because
they listen on loopback sockets.

## Running

Open Input.app and connect a supported device, then:

```sh
node dist/configure.js
npm run daemon
```

Build first with `npm run build`. The configuration prompt saves the number of activated
keys (1–20) in `~/.local/state/agentkeys/config.json`. A count of N enables consecutive
identifiers from `vscode00` through `vscode(N-1)`; at least one key is required.
The installer runs the same prompt and offers the saved count on subsequent installs.
Restart the daemon after changing it. Even device-free daemon tests use an isolated
configuration rather than implicitly enabling all keys.

Approve AgentKeys in Input within 30 seconds on the first connection. Credentials
are saved in macOS Keychain. No Input Monitoring grant is needed for AgentKeys.
The daemon logs connection failures and retries with backoff while Input is unavailable.
For unattended use, build the app bundle and install the LaunchAgent as described in
the [README](../README.md#setup).

The previous direct-device research tools have been removed. Configure keys in Input;
do not bypass it or write device configuration from experimental tools.

## Environment variables

| Variable | Meaning |
| --- | --- |
| `AGENTKEYS_PORT` | HTTP port for daemon and CLI, default `8787` |
| `AGENTKEYS_LOG` | Redirect daemon output to a file (needed for LaunchServices) |
| `AGENTKEYS_VSCODE_USER_DATA` | VS Code user-data directory containing `agent-host/local-endpoint` |
| `AGENTKEYS_VSCODE_STATE` | Persisted VS Code binding-state file |
| `AGENTKEYS_NO_DEVICE=1` | Run HTTP/VS Code integration without connecting to Input, for tests |

## Verifying a restart

`npm run build` emits a unique ID in `dist/build-id`. The running daemon reports its
startup ID via `GET /build`. After restarting the LaunchAgent, run:

```sh
scripts/verify-build.sh
```

See [deployment verification](daemon-deployment.md).

## Manual acceptance check

1. Configure a key count of 2, map API Smart Actions `vscode00` and `vscode01` in Input,
   restart the daemon and select their layer.
2. Run `agentkeys set 0 running` and `agentkeys set 1 error`; verify the keys show
   breathing blue and solid red independently.
3. Bind VS Code sessions and press the keys; verify the correct sessions open.
4. Switch layers, unplug/replug the keyboard, and restart Input. Check that the current
   lighting returns and key events still work without another approval prompt.
5. Remap a missing identifier within the configured count, then run `agentkeys vscode reset`; verify it
   lights idle and the log no longer reports it missing.
6. Confirm `agentkeys set 2 running` is rejected and only two slots appear in
   `agentkeys status` and `agentkeys vscode slots`.
