# How the VS Code integration works

1. **Discover VS Code sessions**

    The daemon watches both Agent Host and native Copilot Chat sessions:

   ```text
   ~/.copilot/session-state/
    ~/Library/Application Support/Code/User/workspaceStorage/*/GitHub.copilot-chat/transcripts/
   ```

    Agent Host sessions must have this `workspace.yaml` value:

   ```yaml
   client_name: vscode-agent-host
   ```

    This prevents ordinary terminal Copilot sessions from taking slots. Native transcripts
    must have a matching persisted entry under the workspace's `chatSessions/` directory.

   For each bound Agent Host session, the daemon reads VS Code's owner-only local endpoint
   registry under the active user-data directory. It supports both the legacy shared
   `metadata.json` array and current per-instance `entries/*.json` files, ignores dead endpoint
   owners, and connects to each live editor endpoint until one serves the session. The
   WebSocket upgrade uses the registry bearer token over the published Unix socket; the token
   is never logged.

   At the same time, VS Code's preview agent hooks notify the daemon immediately before
   and after `vscode_askQuestions`, avoiding the native Chat transcript's buffered writes.
   Generic `PostToolUse` or `PermissionDenied` events clear external-file approval state
   without forwarding tool input. Lifecycle hooks reconcile execution state without
   releasing a bound slot; authoritative journal or protocol snapshots clear stale input
   blockers. The `chat.useHooks` setting must be enabled; it defaults to enabled in the
   verified VS Code version.

For the evidence and rationale behind this hybrid file-plus-hook model, see
[`docs/findings.md`](docs/findings.md), section "VS Code chat telemetry findings".


2. **Wait for actual work**

   Creating or browsing a session does nothing.

   When its event file records `userPromptSubmitted` or `user.message`, the daemon knows
   the user submitted a prompt.

3. **Allocate a slot**

   For an unbound session:

   - use the lowest unbound slot;
  - otherwise reuse the oldest `done` or acknowledged `idle` slot;
   - never steal `running`, `input`, or `error`.

4. **Update the LED**

   - prompt or active work -> `running`
   - unresolved native response part, Agent Host `InputRequest`, or blocking Agent Host
     tool status -> `input`
   - session or turn error -> `error`
   - Agent Host `sessionEnd` or native Chat request `result` -> `done`

    Native Chat's `vscode_askQuestions` transition comes from the installed
    `PreToolUse`/`PostToolUse` hooks. Transcript tool requests identify explicit network,
    unsandboxed, and outside-workspace file approvals before execution; native execution
    starts retain that input state. The chat-session journal keeps an approval pending
    while its confirmation is null and no terminal command state exists, then clears it
    when a confirmation is persisted. This also covers external-file journal records,
    which omit the original access flags. Correlated `PostToolUse`, `PermissionDenied`,
    and tool completion are fallbacks. No command or tool input is retained. Automatic
    outside-sandbox terminal confirmations use verified
    `PermissionRequest`, `PostToolUse`, and `PermissionDenied` hooks, forwarding only a
    local command fingerprint. Persisted records support restart recovery.

   An unrecognized native response form while VS Code reports `NeedsInput`, or an
   unrecognized Agent Host `ToolCallStatus`, fails closed as `error` and turns the key
   solid red. The slot records an `incompatible:*` run error, and the daemon logs only
   the session ID, request ID, source, response-part kind, unknown state/status token,
   and VS Code version. Prompt text, tool input, paths, and answers are not logged.
   Agent Host sessions use the live Agent Host Protocol as their authoritative state source.
   After `initialize`, the daemon subscribes to the default `ahp-chat` channel derived from
   `copilotcli:/<session-id>`. The initial complete `ChatState` snapshot is applied directly.
   Later protocol actions are coalesced into fresh `subscribe` snapshots, avoiding a second
   implementation of VS Code's chat reducer. Endpoint closure or replacement drops ownership;
   the normal bounded scan reconnects and obtains a new complete snapshot. `session.db` is not
   used as a chat-state source.

    Polling is deliberately bounded to protect CPU use and battery life. No polling
    interval may be shorter than 100 ms, and periodic scans are configured so a
    persisted state change normally reaches the key within 100–300 ms. File events and
    hooks should trigger or coalesce scans instead of introducing faster polling or
    busy-wait loops.

5. **Recover after restart**

   The daemon replays each bound event file:

   - unresolved question or permission -> `input`
   - unfinished turn or tool -> `running`
   - recorded error -> `error`
   - completed run -> `done`

  Restart intentionally re-announces a completed, still-bound session as green, even
  if it was acknowledged white before the restart. Pressing the key acknowledges it
  again. A session that is no longer discoverable is instead unbound and initialized
  white, so no missing transcript can leave an unacknowledgeable green key.

6. **Open the session**

   Pressing a physical key constructs an exact-session VS Code URL containing:

   - the project path;
    - `agent-host-copilotcli:/<session-id>` for Agent Host; or
    - VS Code's encoded `vscode-chat-session://local/...` resource for native Chat.

   VS Code focuses the relevant project window and opens the exact transcript there.
  Opening a green `done` session acknowledges it by turning its key white, but keeps
  the session bound: pressing the white key reopens the same transcript repeatedly.
  The binding remains until a newly submitted session needs and reuses that slot.
   Exact opening is currently enabled only for the verified VS Code `1.131.x` compatibility
   boundary; `agentkeys doctor vscode` reports unsupported versions instead of opening a
   generic or potentially incorrect chat.