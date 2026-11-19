# VS Code integration: AHP only

AgentKeys supports sessions exposed by VS Code's local Agent Host Protocol (AHP).

## Exact session opening

Investigated against installed **VS Code 1.146.0**, commit
[`69047191fc427f2f92828279aae1d90d8eeda7ab`](https://github.com/microsoft/vscode/tree/69047191fc427f2f92828279aae1d90d8eeda7ab),
including its installed main, workbench, and Agent Host bundles.

The project-window URL contract is current:

```text
vscode://file/<absolute-project-path>?session=<encoded-editor-session-resource>
```

The host advertises the default chat as an opaque resource such as
`ahp-chat:/<chat-uuid>`. Clients must use that resource rather than fabricate a channel
from the session ID.

Source anchors at the investigated commit:

- [Project URL parsing](https://github.com/microsoft/vscode/blob/69047191fc427f2f92828279aae1d90d8eeda7ab/src/vs/platform/window/common/window.ts):
  `extractChatSessionToOpen` reads `session` (preferred) or `copilotCliSession`.
- [Main-process dispatch](https://github.com/microsoft/vscode/blob/69047191fc427f2f92828279aae1d90d8eeda7ab/src/vs/platform/windows/electron-main/windowsMainService.ts):
  `handleChatSessionToOpen` sends `vscode:openChatSession` to the project window.
- [Editor-resource registration](https://github.com/microsoft/vscode/blob/69047191fc427f2f92828279aae1d90d8eeda7ab/src/vs/platform/agentHost/browser/agentHostConnectionsService.ts):
  `registerSessionResource` changes the backend scheme to `agent-host-<provider>`.
- [SDK import link](https://github.com/microsoft/vscode/blob/69047191fc427f2f92828279aae1d90d8eeda7ab/src/vs/workbench/contrib/chat/browser/copilotCliSessionLink.ts):
  `copilotCliSession` can import/adopt a session and offer takeover. It is not a
  substitute for opening an already advertised exact resource.
- [External Agents-window links](https://github.com/microsoft/vscode/blob/69047191fc427f2f92828279aae1d90d8eeda7ab/src/vs/platform/agentHost/common/openSessionLink.ts):
  `vscode://agents/agent-host-session/...` targets the Agents window, not the
  existing project window used by AgentKeys.

## Runtime

1. Discover the local Agent Host endpoint registry and authenticate its Unix
   WebSocket connection. Never log connection tokens.
2. Subscribe to the root session catalog. Follow active sessions and retained slot
   bindings using the catalog's exact `defaultChat`; never guess a chat channel.
   Entries without `defaultChat` are skipped until a later catalog update advertises
   it; other sessions on the endpoint continue to be tracked.
3. Use the protocol package's reducer for snapshots, ordered actions, and reconnect
   replay. Project its current chat state into running, input, done, idle, or error.
4. Build the editor resource by replacing only the backend scheme with
   `agent-host-<provider>`, preserving the URI remainder. Open it using the encoded
   `session` query parameter and the advertised local project directory.

Only the advertised default chat is currently discovered. Preserving an exact URI
does not imply discovery of all peer or additional chats. Remote project paths and
sessions absent from the local AHP catalog are not supported.

Unknown waiting/tool states fail red. Losing an active session's host also fails red;
fresh protocol state restores it. Completed slots retain their outcome during a
disconnect.

## Bindings and persistence

- Bind only a new active turn, not completed catalog history or an empty session.
- Prefer the lowest enabled unbound physical slot; otherwise reuse the oldest
  done/idle binding. Never evict active, waiting, or failed work.
- Opening green acknowledges completion to white and retains the shortcut.
  Opening red releases the binding only after successful URL launch.
- Reset frees all bindings and publishes idle only to the configured API Smart Action slots. Remembered
  request identities prevent the same turn from immediately rebinding.
- Schema 2 retains slot identities and request/outcome checkpoints, not chat content.
  Active restored bindings wait for authoritative AHP state in the error state.

Use `agentkeys doctor vscode` for AHP availability, installed version, exact-opening
availability, and per-binding project/host availability. `agentkeys vscode slots`,
`agentkeys vscode open <slot>`, and `agentkeys vscode reset` remain supported.

## Verification

Run `npm run verify:vscode-update` after updates. It checks installed structural
contracts and runs the full test suite, including AHP fixture replay, migration,
reconnect, exact resource URLs, acknowledgement, reset, and daemon restart behavior.
See [the update workflow](vscode-update.md).

AHP production fixtures retain their original build provenance and captured records.
Structural tests do not prove UI navigation; a real slot press must still open the
intended conversation in the intended project window.
