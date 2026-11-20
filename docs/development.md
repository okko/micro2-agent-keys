# Extension development

Use Node.js 22.4 or newer. InputKit requires a standard global WebSocket.

```sh
npm ci
npm run check
npm test
npm run package
```

The package uses `docs/extension-details.md` as its README. Keep the root
`README.md` excluded in `.vscodeignore`: `vsce` packages the custom README as
`readme.md`, so including both causes a case-insensitive VSIX path collision.
The `docs/` directory is excluded from the VSIX; `vsce` still includes the custom
README specified by `--readme-path`.

The Marketplace and Activity Bar icons use `media/agentkeys.png`, a transparent
256x256 PNG. Keep `media/agentkeys.svg` as the editable source, excluded from the
VSIX. After editing it, regenerate the PNG with librsvg's `rsvg-convert`:

```sh
rsvg-convert --width 256 --height 256 --format png --output media/agentkeys.png media/agentkeys.svg
```

Commit both the source and generated image; normal builds need no image converter.

Successful local packaging does not guarantee Marketplace acceptance. For the
generic "Your extension has suspicious content" rejection, contact
[VS Marketplace support](mailto:VSMarketplace@microsoft.com) with the extension ID
`okko.agent-keys`, version, exact error, and public repository URL. Ask which
field or asset triggered the rejection and request a manual review; the
[Marketplace team has confirmed false positives](https://github.com/microsoft/vsmarketplace/issues/352).
Do not include publishing tokens or other credentials.

Press **F5** to build and launch an Extension Development Host, or install the
generated VSIX through **Extensions: Install from VSIX**. Open the AgentKeys Activity
Bar view and choose **Configure Keys**. Keep Input running and approve AgentKeys
there on first use. Never run the old daemon alongside the extension.

Tests use isolated configuration, fake devices, and loopback WebSocket servers.
They do not require a keyboard, Input approval, real credentials, or live sessions.
Run outside restricted sandboxes because the integration tests bind local sockets.

## Runtime boundaries

- `extension.ts`: activation, commands, SecretStorage, URI opening, and Output channel.
- `status-view.ts`: live TreeView, with one row per configured key.
- `coordinator.ts`: authenticated loopback IPC and single-owner election through an
  exclusive listening socket. Followers forward commands and receive status.
- `runtime.ts`: configuration, lifecycle, Input reconnection, and AHP/lighting wiring.
- `vscode.ts`, `vscode-chat-state.ts`, `agent-host.ts`: retained session allocation,
  projection, persistence, authenticated AHP transport, and replay handling.
- `device.ts`: InputKit authorization, key events, acknowledged/coalesced lighting.

No process-wide exit handlers, console redirection, shell launchers, or detached
processes are used. Async teardown runs in `deactivate()`, not async disposables.
Input setup is cancellable when the owner stops. A follower never starts its Input
or AHP clients until the prior owner releases the coordination socket.

The installable extension ID is `okko.agent-keys`. Internal IDs use `eu.okko.agentkeys`;
the Activity Bar container alone uses `eu-okko-agentkeys`, because its schema disallows dots.
The real-host smoke test in `test/extension-smoke.cjs` checks activation, the global
WebSocket needed by InputKit, command registration, and the Activity Bar container.
Launch VS Code's desktop executable with `--extensionDevelopmentPath` pointing at
this checkout and `--extensionTestsPath` pointing at that file. Use an isolated HOME,
extensions directory and a short `--user-data-dir` (macOS limits Unix socket paths to
103 characters). Unset `ELECTRON_RUN_AS_NODE` and `VSCODE_IPC_HOOK_CLI` so the test
does not reuse the working editor. Do not configure keys in this smoke test.

Configuration and bindings share `~/.local/state/eu.okko.agentkeys/` across
windows/profiles; SecretStorage is profile-scoped. The owner's AHP registry and URI
scheme apply to the shared runtime. Protocol version mismatch is reported explicitly.
Do not synchronize device bindings or credentials via Settings Sync.

## Manual acceptance check

1. Stop the previous LaunchAgent. Open Input with a supported keyboard.
2. Install the VSIX, configure two keys, map `vscode00` and `vscode01`, and approve Input.
3. Verify that only two keys appear in the sidebar.
4. Run two local AHP sessions. Check blue while running, amber for a question/approval,
   green on completion, and red on failure. Hidden/background chats must still update.
5. Press each key and click each sidebar row. Verify the exact project and conversation
   opens, and green becomes acknowledged white.
6. Open a second VS Code window. It must show shared state without another Input
   connection. Reset from that window and verify both views become unbound/idle.
7. Close or reload the owning window. Check takeover and restore without duplicate
   key actions or competing lights. Closing all windows must stop AgentKeys.
8. Restart Input, reconnect the keyboard, and switch layers. Check repaint and key events.
9. Remap a missing identifier, then Reset Keys. Check idle lighting and diagnostics.
10. Change the count down and up. Removed keys must be cleared; enabled keys must match
    the count. Restart Connection preserves bindings; Reset Keys clears them.

The unit/integration suite proves transport and lifecycle behavior with controlled
inputs. It does not prove physical lighting, Input approval UX, or exact UI navigation.
