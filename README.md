# Agent Keys for Work Louder keyboards

Show up to 20 VS Code agent sessions on a
[Work Louder Creator Micro 2](https://worklouder.cc/creator-micro-2) or
[Codex Micro](https://worklouder.cc/codex-micro) keyboard.
Simply press the physical key to open the exact conversation.
Optional Claude Code hook tracking opens the project folder instead.
Each concurrent Copilot Agent session has a dedicated, color-coded
status indicator you can act on without hunting through editor windows and tabs.

**Independent project and trademark notice:** This extension is independently
developed and maintained. It is not an official Work Louder product and is not
created, sponsored, endorsed, or supported by Work Louder. Neither Agent Keys
nor its author is affiliated with Work Louder.
All third-party product names and trademarks belong to their respective owners
and are used solely to identify compatible devices and software. Their use does
not imply any affiliation with or endorsement by their owners.

Agent Keys is a desktop VS Code extension. No custom firmware is
required.
**Just Keep Input.app running**: it handles keyboard communication and continues providing your normal macros.

## Quick start

1. **Install the VS Code Extension.** It is easiest to install this Extension from the VS Code's Extensions menu. Simply search for **"okko.agent-keys"** and install.
2. **Configure the keys in Input.app**
    1. Open Input's **Keymap** section.
    2. Select **+ New Smart Action**, choose the **API** tab, and set Identifier to `vscode00`.
    3. Save and assign the action to a key on your chosen layer.
    4. Repeat for your configured count: six keys use `vscode00` through `vscode05`.
3. **Configure the amount of Agent Keys in VS Code**
    1. Press cmd+shift+p and select **>Agent Keys: Configure keys**. Then enter the amount of Agent Keys you want to use, for example, **6**, and press enter.

**Or let Input add a layer:** after step 3, run **>Agent Keys: Add Layer** instead of mapping the keys by hand. After you confirm, Input adds one new layer to the keyboard's current profile; your existing layers are not changed. See [Add a layer](#add-a-layer).

## Key States

| State | Colour | Meaning |
| --- | --- | --- |
| `idle` | dim white | Free key or acknowledged completion |
| `running` | blue, breathing | Agent is working |
| `input` | amber, breathing | Agent needs an answer or approval |
| `done` | green | Finished, not yet acknowledged |
| `error` | red | Failed or authoritative state unavailable |

## Detailed instructions and documentation

### Install and configure

Requires desktop VS Code **1.147 or newer**, Work Louder **Input.app v1.2.0 or newer**, and a supported keyboard. The current AHP integration is intended for macOS desktop; browser VS Code and remote-only agent hosts are not supported.

1. Install the AgentKeys Extension from the Marketplace.
2. Open **AgentKeys** from the Activity Bar (on the left).
3. Click **Configure your keys to begin** and enter a count from 1 to 20. I recommend 4 or 6 keys.
4. Approve **AgentKeys** in Input within 30 seconds when requested.
5. Map that many consecutive API Smart Actions in Input, starting at `vscode00`.

No count is assumed on a fresh install. Until configured, AgentKeys does not connect to Input or allocate keys. Credentials are stored in VS Code **SecretStorage**.
After revocation, the extension requests approval again; unsuccessful approval attempts are spaced at least one minute apart.

#### Map API Smart Actions in Input

1. Open Input's **Keymap** section.
2. Select **+ New Smart Action**, choose the **API** tab, and set Identifier to `vscode00`.
3. Save and assign the action to a key on your chosen layer.
4. Repeat for your configured count: six keys use `vscode00` through `vscode05`.

Identifiers are case-sensitive and zero-padded. The number identifies the slot,
not the physical key position. You can position the keys freely.
AgentKeys never changes or removes existing layouts, profiles, layers, firmware, or key
mappings. It can add one new layer on request; see [Add a layer](#add-a-layer).

Input cannot enumerate your API mappings, so you must configure the count yourself.

#### Add a layer

**AgentKeys: Add Layer** is an optional shortcut for the manual mapping above. It runs
only when you invoke it and confirm the dialog, which names the device, profile and
key count. Input then appends one new layer named **Agent Keys** to the keyboard's
current profile. Existing layers, keys and settings are never changed or removed.

- Keys are placed row by row from the top left: with 3 keys, `vscode00` and `vscode01`
  fill the first row and `vscode02` takes the left key of the second row.
- The layer holds up to 13 keys. With a higher count, map `vscode13` onward manually.
- All other keys, the dial and the stick do nothing on that layer. Its lighting is
  copied from the profile's last layer.
- Input refuses if the profile already has six layers. Switch to the new layer on the
  keyboard or in Input. If Input's window is open, it saves after its usual countdown.
- A failed or timed-out request is never retried. Check Input before trying again.
- The layer is not updated when you change the key count later. Lowering it is
  harmless; for more keys, add another layer or map the extra ones manually.

### Sidebar and commands

The sidebar shows Input connectivity, available AHP sessions, and each configured
key's state and project. Hover a key for its full project path, session identity,
last update, and error details. Click a bound key to open its conversation.

| Command | Purpose |
| --- | --- |
| **AgentKeys: Show Keys** | Open the live sidebar |
| **AgentKeys: Configure Keys** | Change the enabled count; disabled keys are returned to idle |
| **AgentKeys: Add Layer** | After confirmation, ask Input to add a new layer mapping the configured keys |
| **AgentKeys: Reset Keys** | Clear all bindings, repaint idle, and retry missing mappings |
| **AgentKeys: Restart Connection** | Reconnect Input and AHP, retaining bindings |
| **AgentKeys: Show Logs** | Open diagnostics, including Input approval instructions |
| **AgentKeys: Forget Input Authorization** | Remove the owner's saved credentials and request approval again |

Reset and reconnect buttons are also in the sidebar toolbar.
**Reset is not the same as restart**: reset remembers current turn identities so
the same ongoing work does not immediately reclaim a key. New turns can bind again.
Reloading VS Code preserves bindings and restores authoritative AHP state instead.

Opening a green key acknowledges completion to white while retaining its shortcut.
Opening a red key releases the failed binding only after successful URL launch.
Active, waiting, and failed bindings are never evicted to make room for another session.

### Lifecycle and multiple windows

The extension activates automatically after startup and runs while an enabled
desktop VS Code window remains open, even when unfocused or with the sidebar hidden.
One window owns the Input and AHP clients; other windows share the live status and
forward commands. When the owner closes or reloads, a remaining window takes over.

This is not a background OS service: monitoring pauses during sleep, extension-host
restarts, and when all enabled windows close. Keys can retain their last colours
while disconnected; the next owner restores their current state.

Coordination uses an authenticated, loopback-only connection on port **19148**.
It is private extension IPC, not a supported scripting API. The OS socket bind
ensures one owner; a hung owner is reported rather than bypassed by a second writer.
Input itself uses port **19147**.

The key count, binding checkpoints, and private coordination token live in
`~/.local/state/eu.okko.agentkeys/`. They are machine-local and shared across
windows and profiles, not Settings Sync data. Input credentials use the owning
window's SecretStorage; a different profile may require its own approval.

The owner discovers AHP in its VS Code user-data directory, including custom
`--user-data-dir` installations and profiles. **AgentKeys: Agent Host Registry**
can override the absolute endpoint-registry path. Reload all windows after changing
it. If Stable and Insiders are both open, the owner's installation/registry and
URI scheme determine which sessions are tracked and opened.

Remote SSH/container windows run AgentKeys on the local UI side, but that does not
make remote AHP sessions visible. Only sessions advertised in the selected local
registry are supported. AHP discovery and exact `?session=` navigation remain
version-sensitive contracts, not stable VS Code chat-observation APIs.

### Migrating from the daemon

Stop and uninstall the old LaunchAgent **before configuring the extension** so it
does not compete for Input lighting. In a normal macOS Terminal:

```sh
launchctl bootout "gui/$(id -u)/eu.okko.agentkeys"
```

Remove its `~/Library/LaunchAgents/eu.okko.agentkeys.plist` if installed, and remove
old CLI symlinks after checking their targets. The extension does not import old
configuration, bindings, or Keychain credentials. Configure the count and approve
Input again. Old deployment helpers are intentionally no longer included.

<!-- end common part with extension-details.md here, the rest is only for readme -->

### For developers

When developing, you can install the AgentKeys VSIX using **Extensions: Install from VSIX**.

For debug purposes, you can also open the Agent Keys sidebar to see connection status, configure amount of keys and even click virtual sidebar keys.

The extension ID is `okko.agent-keys`. Internal commands, views, settings and service
coordination use the `eu.okko.agentkeys` namespace. The Input credential key is
`eu.okko.agentkeys.input.credentials` in VS Code SecretStorage.

The Activity Bar container uses `eu-okko-agentkeys` because VS Code disallows dots there.

Unmapped identifiers are reported in **AgentKeys: Show Logs** and retried after
a layer/device change, reconnect, or reset. See the
[vendor guide](https://docs.worklouder.cc/websocket/user-guide.md).

### Build and develop

Use Node.js 22.4 or newer:

```sh
npm ci
npm run check
npm test
npm run package
```

Install the generated `.vsix`, or press **F5** to launch the Extension Development
Host. The build bundles the runtime dependencies and includes their licenses.
There is no Node.js installation requirement for extension users.

See [development and acceptance checks](docs/development.md),
[Input protocol](docs/protocol.md), [AHP integration](docs/vscode-integration-details.md),
and [VS Code update verification](docs/vscode-update.md).

### Demo

[<img src="https://img.youtube.com/vi/QpnkxvVaaSU/hqdefault.jpg" alt="Watch the demo" width="384">](https://youtu.be/QpnkxvVaaSU)
