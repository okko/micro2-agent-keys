# How the VS Code integration works

1. **Discover VS Code sessions**

   The primary observer uses `@microsoft/agent-host-protocol/client` over VS Code's
   authenticated local Unix WebSocket. It subscribes to `ahp-root://`, pages through
   `listSessions`, and follows `root/sessionAdded`, `root/sessionSummaryChanged`, and
   `root/sessionRemoved`. Session working directories and advertised chat resources
   supply discovery metadata; no transcript, hook, SQLite database, or journal is
   required for a protocol-exposed session.

   Active and already-bound sessions are subscribed to their `ahp-chat` channels.
   Browsed or historical idle sessions do not allocate keys or trigger bulk chat
   subscriptions. Root notifications expose later activity without repeatedly
   fetching the catalog. For older catalogs without chat resources, the default
   channel is derived from the backend session URI.

   Copilot SDK transcript UUIDs can differ from their owning AHP session UUIDs.
   Optional, read-only chat backing metadata connects those identities: an AHP
   session records its SDK alias, and the filesystem observer ignores that alias,
   including native mirrors. If both identities were already bound, they merge
   under the AHP identity, retaining the lowest occupied key and releasing only
   the duplicate. The alias is persisted across restarts. Missing metadata is
   retried on subsequent AHP updates or uncovered transcript activity; it is not
   required for protocol-only discovery.

   Sessions not exposed by AHP retain the legacy fallback:

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

   Independently of slot bindings, the daemon reads VS Code's owner-only local endpoint
   registry under the active user-data directory. It supports both the legacy shared
   `metadata.json` array and current per-instance `entries/*.json` files, ignores dead endpoint
   owners, and connects to each live editor endpoint until one serves the session. The
   WebSocket upgrade uses the registry bearer token over the published Unix socket; the token
   is never logged.

   Only for uncovered native Chat sessions, VS Code's preview agent hooks notify the daemon immediately before
   and after `vscode_askQuestions`, avoiding the native Chat transcript's buffered writes.
   Generic `PostToolUse` or `PermissionDenied` events clear external-file approval state
   without forwarding tool input. Lifecycle hooks reconcile execution state without
   releasing a bound slot; authoritative journal or protocol snapshots clear stale input
   blockers. The `chat.useHooks` setting must be enabled; it defaults to enabled in the
   verified VS Code version.

For the historical evidence behind the native fallback, see
[`findings.md`](./findings.md), section "VS Code chat telemetry findings".


2. **Wait for actual work**

   Creating or browsing a session does nothing.

   A new active AHP turn proves actual work and can allocate a key immediately, including
   when reconnecting to existing work. Completed catalog history alone cannot allocate.
   Resetting slots does not reallocate the same turn on its next state update; a new turn
   is required. The legacy fallback still recognizes `userPromptSubmitted` or `user.message`.

3. **Allocate a slot**

   For an unbound session:

   - use the lowest unbound AG index enabled by the device keymap;
   - otherwise reuse the oldest `done` or acknowledged `idle` slot;
   - never steal `running`, `input`, or `error`.

   Slot identity is the AG keycode number, not an ordinal position in the enabled set.
   When the keymap changes, bindings whose exact AG indices remain mapped stay on those
   physical keys. Never renumber or compact surviving bindings: doing so would move sessions
   between physical keys unexpectedly.

   A session whose AG index was removed remains tracked but becomes unbound. A later qualifying
   prompt may allocate it to an available mapped slot. Remapping must not evict another active
   session merely to preserve the displaced session's binding.

   `agentkeys vscode reset` is intentionally stronger than a keymap refresh. It re-reads the
   device keymap, releases every VS Code binding, and publishes `idle` to the complete firmware
   range `AG00` through `AG19`, including currently unmapped indices. This clears lingering LED
   state. The all-slots-idle publication is part of the command contract and must be preserved
   by future changes even though `agentkeys vscode slots` lists only mapped indices.

4. **Update the LED**

   - prompt or active work -> `running`
   - unresolved native response part, Agent Host `InputRequest`, or blocking Agent Host
     tool status -> `input`
   - session or turn error -> `error`
   - AHP terminal turn or fallback native Chat request `result` -> `done`

   AHP subscriptions deliver one initial snapshot, followed by sequenced actions applied
   with the package's shared `chatReducer`. Actions at or below that channel's snapshot
   sequence are ignored, including duplicate replay. Actions arriving during subscription
   are buffered behind the snapshot. There is no re-subscription per action and no custom
   implementation of the protocol reducer.

   Once AHP serves a session, `observation: "ahp"` is persisted. Transcript reads,
   native journal reconciliation, SQLite active-session checks, and hook-derived state
   are disabled for that session, including after connection loss and daemon restart.
   Legacy sources cannot overwrite authoritative input, completion, or error state.
   Hooks remain installed only to cover native sessions not exposed through AHP.

   In that fallback, native Chat's `vscode_askQuestions` transition comes from the installed
    `PreToolUse`/`PostToolUse` hooks. Transcript tool requests identify explicit network,
   unsandboxed, and outside-workspace file access candidates before execution. Explicit
   network and unsandboxed requests enter `input` immediately, and native execution starts
   retain that state. An outside-workspace path alone is not proof of a wait: its tool ID is
   retained for correlation, and the chat-session journal enters `input` only while the
   matching confirmation is null and no terminal command state exists. A persisted
   confirmation keeps an ordinary external read in `running`. This also covers external-file
   journal records, which omit the original access flags. Correlated `PostToolUse`,
   `PermissionDenied`, and tool completion are fallbacks. No command or tool input is
   retained. Automatic outside-sandbox terminal confirmations use verified
    `PermissionRequest`, `PostToolUse`, and `PermissionDenied` hooks, forwarding only a
    local command fingerprint. Persisted records support restart recovery.

   Native transcript prompts and journal request insertion can arrive out of order by a
   single poll. The reducer keeps a prompt barrier so stale journal completion from the
   previous request cannot flash green on a newly started prompt, and now carries journal
   insertion credit forward when the journal wins the race. This preserves the rule that stale
   completion must not briefly show done on a new request, while still allowing journal-only
   completion to settle a slot when the transcript tail stops mid-tool.

   An unrecognized native response form while VS Code reports `NeedsInput`, an
   unrecognized Agent Host `ToolCallStatus`, or Agent Host status `24` without a
   recognized blocker fails closed as `error` and turns the key solid red. The slot
   records an `incompatible:*` run error, and the daemon logs only the session ID,
   request ID, source, response-part kind, unknown state/status token, and VS Code
   version. Prompt text, tool input, paths, and answers are not logged.
   Endpoint closure or replacement drops ownership; an active bound session turns red with
   `agent-host-state-unavailable`. Reconnection uses the same client identity and requests
   replay from the retained channel checkpoints. Missed actions are reduced locally; when
   replay is unavailable, host-provided snapshots replace local state. The ephemeral catalog
   is re-fetched after reconnect. Failed resumption is logged and retried with a fresh
   handshake and snapshots. Completed sessions are not changed by source loss.
   Unsupported chat actions also invalidate the feed rather than silently preserving
   stale state. Endpoint tokens, tool arguments, prompts, and answers are not logged.

   Polling is deliberately bounded to protect CPU use and battery life. No polling
   interval may be shorter than 100 ms, and periodic scans are configured so a
   persisted state change normally reaches the `onSlot` callback within 100–300 ms.
   HID transport and device-rendering latency are not part of this integration target.
   File events and hooks should trigger or coalesce scans instead of introducing faster
   polling or busy-wait loops.

5. **Recover after restart**

   AHP-bound slots retain identity without consulting legacy files. Previously active
   bindings start red (`agent-host-state-unavailable`) until the host supplies authoritative
   state. A fresh daemon obtains current snapshots; a transport reconnect can replay actions.
   The native fallback replays each bound event file:

   - unresolved question or permission -> `input`
   - unfinished turn or tool -> `running`
   - recorded error -> `error`
   - completed run -> `done`

   Restart intentionally re-announces a completed, still-bound session as green, even
   if it was acknowledged white before the restart. Pressing the key acknowledges it
   again. A discoverable native session with journal-proven unresolved input remains
   bound even when it is absent from VS Code's active-session mementos. A session that is
   no longer discoverable is instead unbound and initialized white, so no missing
   transcript can leave an unacknowledgeable green key.

6. **Open the session**

   Pressing a physical key constructs an exact-session VS Code URL containing:

   - the project path;
   - `agent-host-copilotcli:/<host-session-id>` for Agent Host; or
   - VS Code's encoded `vscode-chat-session://local/...` resource for native Chat.

   New Agent Host default chats can have an SDK transcript ID different from their
   owning host session ID. For filesystem-backed bindings, opening reads VS Code's
   persisted `agentSessionData/<host-session-id>/session.db` metadata
   (`defaultChatProviderData.sdkSessionId`) to resolve the owning session. Additional
   chats use the `session_chats` provider data in `User/globalStorage/agent-host.db`
   and preserve their chat ID as a resource fragment, so opening does not switch to
   the default transcript. This uses
   the same identity as working `agent-host-session://copilotcli/<host-session-id>`
   links, while preserving the project-window routing of `vscode://file?...session=`.
   Legacy sessions without a backing mapping keep their original ID. Bindings created
   from SDK transcripts retain that SDK identity across AHP takeover and daemon
   restarts, so a coinciding host ID cannot redirect their links. Directly AHP-discovered
   resources are already host identities and native Chat resources remain unchanged;
   neither is reinterpreted as an SDK ID. Mapping failures are reported rather than
   opening a different or generic chat. These lookups run asynchronously. Opening
   an SDK-backed chat resolves its current host resource; discovery also reads the
   exact host chat's SDK identity to avoid allocating a second key for its transcript.
   Once that alias is known, state-observation polling does not repeat the lookup.

   VS Code focuses the relevant project window and opens the exact transcript there.
  Opening a green `done` session acknowledges it by turning its key white, but keeps
  the session bound: pressing the white key reopens the same transcript repeatedly.
  The binding remains until a newly submitted session needs and reuses that slot.
   Opening a red `error` session turns its key white and releases the failed binding,
   preventing a persisted incompatibility from reclaiming the slot on the next scan.
   Exact opening is enabled for every installed VS Code version that registers the
   `vscode://` URL handler. `agentkeys doctor vscode` reports the observed version and
   protocol registration; the version is diagnostic metadata rather than an opening gate.
   Empirical blocker evidence remains versioned independently.