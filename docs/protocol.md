# Input WebSocket integration

AgentKeys uses `@worklouder/input-kit` for the supported Input.app API at
`ws://127.0.0.1:19147/input`. See the
[vendor guide](https://docs.worklouder.cc/websocket/user-guide.md).
Input owns all communication with the keyboard.

## Authorization and reconnects

On the first connection, `requestAuthorization()` shows an approval prompt in Input.
Approve AgentKeys within 30 seconds. Credentials are stored in the owning extension's
VS Code SecretStorage; they are never logged or written to repository files.
Storage errors are reported. Forget Input Authorization removes saved credentials.

Subsequent connections call `authenticate()`. Error `-32001` deletes revoked credentials
and starts authorization again. Approval attempts are spaced at least one minute apart.
Socket failures reconnect with exponential backoff from 3 to 60 seconds. Each connection
fetches `getDevices()` again; `devicesUpdated` replaces the ready-device list because
runtime device IDs can change. The first supported device is selected, retaining it
while available. An empty list keeps the authenticated socket open, waiting for a device.

## Key events

`keyTriggered` carries `deviceId`, `identifier` and `action`.
Only the selected device and exact identifiers `vscode00` through `vscode19` are accepted.
`press` and `click` open the corresponding slot's VS Code session; `release` does nothing.

Configure these identifiers manually as **API Smart Actions** in Input. The extension's
Configure Keys command asks for an activated key count (1–20) and saves `keyCount` in
`~/.local/state/eu.okko.agentkeys/config.json`. The runtime enables only the first N slots,
starting at `vscode00`, for session allocation and lighting. At least one key is required.
Missing configuration leaves the sidebar ready for setup without contacting Input.
Invalid configuration is reported explicitly.
The API cannot enumerate existing Smart Actions or read your layers; the count is not
automatic layout discovery. No device configuration is installed or modified by AgentKeys.

## Lighting

`setKeyLighting` targets an exact identifier (`isRegex: false`) and sends `color`
as `0xRRGGBB`, `brightness: 1`, numeric `effect`, and normalized `speed`.
Existing idle/running/done/input/error colors are retained. The extension does not modify
ambient lighting, base lighting, profiles or layers.

InputKit queues requests and spaces device writes at least 250 ms apart. AgentKeys
coalesces unsent changes per slot and caches acknowledged states. Shared device-budget
errors (`-32017`) retry after 250, 500, 1000, 2000 and 4000 ms; exhaustion is reported
and causes a reconnect. A newer slot state supersedes an obsolete retry.

An unmapped identifier (`-32009`) is diagnosed once and skipped until a profile/layer
change, device-list update, explicit VS Code slot reset, or reconnect. Other errors
are surfaced and cause reconnection rather than being treated as successful writes.
`deviceInfoChanged` invalidates the lighting cache and repaints stored states.
No periodic full repaint is needed: the API acknowledges lighting requests.
