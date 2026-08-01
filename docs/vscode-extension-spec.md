# AgentKeys VS Code Agent Session Integration

## 1. Decision

Do not implement the previously proposed `@ag` chat participant, workspace-storage
scanner, SQLite poller, or multi-window URI-routing extension.

Use this architecture instead:

1. One VS Code user-level hook observes every submitted local Copilot CLI session.
2. The first submitted prompt from an unbound session assigns it to the first free slot
   or the slot that has been `done` longest.
3. The AgentKeys daemon owns the four bindings and watches each bound Copilot CLI
   session's live `events.jsonl`.
4. A physical key press asks VS Code itself to open the exact bound session using its
   session handoff URL.
5. Input.app is used only to configure the keyboard. Karabiner is not required.

This is simpler because the session ID originates inside the session, live state comes
from the agent's event stream, and VS Code performs its own window selection and session
opening.

The first implementation supports **local Copilot CLI sessions only**. That includes
sessions created through the local Copilot CLI provider in the VS Code Agents window.
Local and remote workspace chat, Claude sessions, cloud agents, and remote Agent Host
sessions are separate follow-up integrations.

## 2. Why the previous design was rejected

The old design was not implementation-ready:

- `ChatRequest` does not expose the current built-in chat session.
- Choosing the most recently modified chat file can bind the wrong conversation.
- VS Code workspace storage directory names cannot be reconstructed with one
  `md5(folderUri)` rule.
- `agentSessions.model.cache` is not a live status source. VS Code deliberately persists
  an in-progress session as completed.
- `globalState` is not a safe global coordinator when several extension hosts run in
  several windows.
- Opening generic Chat does not satisfy the requirement to open the exact conversation.
- A native SQLite dependency adds packaging risk without solving the identification or
  live-state problems.

The replacement architecture does not infer any of those values.

## 3. User experience

### 3.1 Starting or resuming work

Use VS Code normally:

1. Open the project in which the work should run.
2. Start a new agent session.
3. Select any built-in or custom agent.
4. Submit a prompt.

The submitted prompt makes an unbound session eligible for automatic allocation. Merely
opening, browsing, or focusing an old session does not consume a slot.

No command-line command is part of this daily workflow.

### 3.2 Continuing an existing bound session

Continue chatting normally. `UserPromptSubmit` finds the binding by session ID and marks
its slot running.

If a session's former slot has since been reassigned, submitting a new prompt makes that
session eligible for allocation again. This is intentional: resumed work should return
to the hardware, while browsing old chats should not.

### 3.3 Allocation policy

Allocation is atomic and uses this order:

1. Keep the session's existing slot, if it is still bound.
2. Use the lowest-numbered unbound slot.
3. Reuse the slot with the oldest `doneAt` timestamp.
4. If every slot is `running`, `input`, or `error`, leave the session unbound and report
   a visible warning. Retry allocation when that session next submits a prompt.

Never steal a `running` or `input` slot. Do not silently clear an error to make room for
new work.

### 3.4 Pressing a physical key

Pressing `KV_OAI_AG00` through `KV_OAI_AG03`:

1. looks up the slot in the daemon;
2. asks VS Code to open that exact session in its project window;
3. focuses the resulting Chat UI;
4. acknowledges a `done` indication after a successful open.

The user does not select a VS Code window manually.

## 4. Supported session identity

Copilot CLI sessions have a raw UUID session ID. Local state is stored at:

```text
~/.copilot/session-state/<session-id>/
```

The directory includes:

```text
events.jsonl
workspace.yaml
```

Current VS Code uses these session resource schemes:

```text
agent-host-copilotcli:/<session-id>  # local Agents-window Agent Host
copilotcli:/<session-id>             # extension-host Copilot CLI provider
```

V1 records the resource scheme explicitly in the binding. It must not guess a scheme at
open time.

For the initial Agents-window workflow, the scheme is:

```text
agent-host-copilotcli
```

The binding hook supplies the raw `session_id` and `cwd`. The hook command supplies the
resource scheme as a fixed argument; the daemon chooses the slot.

## 5. VS Code user-level hooks

Install one dedicated hook file outside Copilot CLI's default hook directory:

```text
~/.config/agentkeys/vscode-hooks.json
```

Register that absolute file in the VS Code user setting `chat.hookFilesLocations`.
Do not install it under `~/.copilot/hooks`: Copilot CLI also discovers that directory,
which would unintentionally bind terminal sessions.

Representative hook file:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "type": "command",
        "command": "/absolute/path/to/agentkeys vscode-hook --scheme agent-host-copilotcli"
      }
    ],
    "UserPromptSubmit": [
      {
        "type": "command",
        "command": "/absolute/path/to/agentkeys vscode-hook --scheme agent-host-copilotcli"
      }
    ],
    "Stop": [
      {
        "type": "command",
        "command": "/absolute/path/to/agentkeys vscode-hook --scheme agent-host-copilotcli"
      }
    ]
  }
}
```

The fixed scheme restricts V1 to local Copilot CLI sessions created through the Agents
window. The hook contains no slot number; the daemon allocates slots.

Hooks run independently of the selected agent, so built-in and user-defined custom agents
remain available.

Hooks are a VS Code Preview feature. Installation must verify that the configured
user-level hook runs in the Agents window. The feasibility spike must also test a
workspace that defines hooks for the same events, because VS Code documents workspace
hooks as taking precedence over user hooks. If that suppresses the AgentKeys hook, the
installer and diagnostics must report the conflict rather than claiming the session is
tracked.

## 6. Hook command

Add this CLI operation:

```text
agentkeys vscode-hook --scheme <session-resource-scheme>
```

The operation:

1. reads exactly one JSON object from standard input;
2. validates `scheme`, `hook_event_name`, `session_id`, and optional `cwd`;
3. sends the validated event to the already-running local daemon;
4. emits valid hook JSON on standard output;
5. exits nonzero when notification fails or an eligible prompt cannot be allocated.

It must not start a second daemon or access the keyboard directly.

Supported hook inputs:

| Hook | Daemon action |
|---|---|
| `SessionStart` | Record session identity; atomically allocate if currently unbound |
| `UserPromptSubmit` | Allocate if unbound; clear run error latch; set `running` |
| `Stop` | If bound, set `done` unless the current run has a latched error |

`SessionStart` and `UserPromptSubmit` can occur close together for the first prompt.
Allocation therefore must be idempotent by session ID and serialized inside the daemon.
Two hook requests must never allocate two slots to one session.

The hook command forwards the complete input only after applying a size limit. The daemon
stores only fields required for routing and state. Prompt text must not be persisted.

## 7. Daemon-owned binding model

The daemon is the single authority across all VS Code windows.

```js
{
  schemaVersion: 1,
  slots: [
    {
      slot: 0,
      provider: "copilot-cli",
      resourceScheme: "agent-host-copilotcli",
      sessionId: "uuid",
      cwd: "/absolute/project/path",
      eventsPath: "/Users/name/.copilot/session-state/uuid/events.jsonl",
      label: "project-name",
      boundAt: "ISO-8601 timestamp",
      lastEventAt: "ISO-8601 timestamp",
      state: "running",
      stateChangedAt: "ISO-8601 timestamp",
      doneAt: null,
      runStartedAt: "ISO-8601 timestamp",
      runError: null,
      eventOffset: 12345
    },
    null,
    null,
    null
  ]
}
```

Requirements:

- Persist state atomically in the user's application-support directory.
- Maintain a reverse lookup from session ID to its currently bound slot.
- Serialize allocation, rebinding, and watcher replacement.
- An unbound session becomes eligible only on `SessionStart` or `UserPromptSubmit`.
- Prefer an unbound slot, then the oldest `done` slot by `doneAt`, with slot number as
  the tie-breaker.
- When reusing a `done` slot, remove the old session from the reverse lookup and close
  its watcher before installing the new binding.
- Retain lightweight historical `firstSeenAt` and `lastSeenAt` metadata so diagnostics
  can distinguish a new session from resumed unbound work. Historical presence must not
  prevent prompt-gated reallocation.
- Validate that a session ID is a UUID-like opaque path segment before constructing a
  path.
- Resolve the events path under the configured Copilot home; do not accept an events
  path from hook input.
- Rebinding closes the old file watcher before replacing the binding.
- Only slots 0 through 3 participate in this integration, even though the hardware
  daemon can drive six slots.
- Timestamps come from the daemon's clock, except event timestamps retained for
  diagnostics.

## 8. Live status from `events.jsonl`

VS Code's Copilot CLI integration and the Copilot SDK use
`~/.copilot/session-state/<id>/events.jsonl` as the session event stream. Current VS Code
itself resolves this file for both `agent-host-copilotcli:` and `copilotcli:` sessions.

The daemon watches only the four bound files.

### 8.1 State transitions

| Event or hook | Slot state |
|---|---|
| `UserPromptSubmit` hook | `running` |
| `assistant.turn_start` | `running` |
| `tool.execution_start` | `running` |
| `permission.requested` | `input` |
| `user_input.requested` | `input` |
| `elicitation.requested` | `input` |
| matching `*.completed` event | `running` |
| `session.error` | latch error; set `error` |
| `turn.error` | latch error; set `error` |
| `Stop` hook with no latched error | `done` |
| `Stop` hook with a latched error | remain `error` |

`permission.requested` and `permission.completed` make approval waits observable without
changing VS Code's approval policy. Explicit agent questions similarly use
`user_input.requested` and `user_input.completed`.

### 8.2 Stream reader

Do not use `fs.watch` as the source of truth. Use it only as a wake-up hint.

For each bound file:

- keep a byte offset;
- read appended bytes;
- retain an incomplete trailing line until the next read;
- parse each complete line independently;
- reject malformed JSON with a diagnostic containing the byte offset;
- handle file replacement, truncation, and daemon restart;
- periodically check file size so dropped file-system notifications cannot stall state;
- persist the last processed offset after applying events.

### 8.3 Restart recovery

On daemon startup, reconstruct each bound slot:

1. Replay from the persisted offset if the file is continuous.
2. If continuity cannot be proven, replay the file from the beginning.
3. Count outstanding permission, user-input, elicitation, tool, and assistant-turn
   requests by their IDs.
4. Set `input` if an input request remains outstanding.
5. Set `error` if the latest run contains `session.error` or `turn.error`.
6. Set `running` if a tool or assistant turn remains outstanding.
7. Otherwise set `done`.

This closes the gap when hooks fired while the daemon was unavailable.

## 9. Opening the exact session

Current VS Code accepts a `session` query parameter on a normal VS Code file/workspace
URL. The main process:

1. resolves the file or workspace to the correct VS Code window;
2. focuses that window;
3. sends the exact session resource to that renderer;
4. opens the session in Chat.

Conceptual URL:

```text
vscode://file/<absolute-project-path>?session=<encoded-session-resource>
```

Example before URL encoding:

```text
project path: /Users/okko/git/project-a
session:      agent-host-copilotcli:/01234567-89ab-cdef-0123-456789abcdef
```

The daemon must construct the URL with a URL API, not string concatenation, and launch:

```text
/usr/bin/open <url>
```

Use `child_process.spawn` or `execFile` with an argument array. Do not invoke a shell.

This path is preferable to an extension URI because VS Code's main process performs the
window routing before opening the session. It is also preferable to the private
`workbench.action.chat.openSessionIn*` commands, which are renderer-scoped and can move
an already-open session when invoked in the wrong window.

### 9.1 Compatibility status

The `session` URL parameter and Copilot CLI resource schemes are implemented by current
VS Code but are not documented stable extension APIs. Treat them as a versioned
compatibility boundary:

- verify them against every supported VS Code release;
- expose `agentkeys doctor vscode`;
- fail with a clear notification when exact opening is unavailable;
- never silently open generic Chat or a different session.

## 10. Key press path

Preferred path:

```text
physical AG key
  -> v.oai.hid notification
  -> AgentKeys daemon
  -> bound slot lookup
  -> VS Code exact-session URL
```

The existing daemon already receives `v.oai.hid` notifications. Add a mapping for the
first four agent keys and ignore AG04/AG05 for this feature.

Input.app remains responsible for the keyboard profile. No Karabiner rule or per-key
shell Smart Action is required once the daemon handles the HID notifications.

If Input.app consumes the key in a way that prevents the daemon notification, use four
small Smart Actions as a fallback. Each action should call one loopback daemon endpoint,
not VS Code directly:

```text
POST /integrations/vscode/slots/0/open
POST /integrations/vscode/slots/1/open
POST /integrations/vscode/slots/2/open
POST /integrations/vscode/slots/3/open
```

## 11. HTTP additions

Keep existing endpoints:

```text
GET  /state
POST /slots/:index
POST /reset
```

Add:

```text
POST /integrations/vscode/hook
POST /integrations/vscode/slots/:index/open
GET  /integrations/vscode/slots
```

The hook endpoint accepts only loopback requests and a bounded JSON body.

Example normalized hook request:

```json
{
  "resourceScheme": "agent-host-copilotcli",
  "hookEventName": "UserPromptSubmit",
  "sessionId": "01234567-89ab-cdef-0123-456789abcdef",
  "cwd": "/Users/okko/git/project-a",
  "timestamp": "2026-08-01T12:34:56.000Z"
}
```

The open endpoint returns an error for an unbound slot or failed VS Code launch. Success
means the URL was handed to LaunchServices; it does not claim that VS Code rendered the
session unless a later acknowledgement mechanism is added.

## 12. Slot acknowledgement

Opening a session acknowledges only a completed result:

- `done` becomes `idle` after the URL is launched successfully;
- `input`, `running`, and `error` remain unchanged;
- a subsequent session event always wins.

This keeps an approval/question indication visible until the user actually responds.
Errors remain visible until a new prompt clears the error latch or the slot is rebound.

## 13. Installation

Provide one setup command or installer action that:

1. writes the dedicated VS Code hook file;
2. registers it in the user-level `chat.hookFilesLocations` setting;
3. verifies `agentkeys` is resolvable in the hook execution environment;
4. confirms the daemon is reachable on loopback;
5. verifies the supported VS Code version;
6. checks for workspace-hook precedence conflicts.

The generated hook file should invoke an absolute AgentKeys executable path when possible.
Relying on an interactive shell's `PATH` is not robust because VS Code hook processes do
not necessarily inherit it.

## 14. Diagnostics

Add:

```text
agentkeys doctor vscode
agentkeys vscode slots
agentkeys vscode open <slot>
agentkeys vscode install-hooks
agentkeys vscode uninstall-hooks
```

`doctor vscode` checks:

- VS Code version and URL protocol registration;
- daemon availability;
- hook file and `chat.hookFilesLocations`;
- workspace-hook precedence conflicts;
- hook executable path;
- each binding's event file;
- persisted watcher offset;
- resource scheme;
- project directory existence;
- most recent event and state transition.

Diagnostics must not print prompt text, tool arguments, permission command text, or other
event payload content by default.

## 15. Security and privacy

- Bind HTTP only to `127.0.0.1`.
- Retain the existing loopback `Host` validation.
- Apply strict request-body limits.
- Do not expose an endpoint that accepts an arbitrary URL or command to launch.
- Construct session resources from validated scheme and session ID fields.
- Construct event paths from the configured Copilot home and validated session ID.
- Launch VS Code with `execFile`/`spawn`, never a shell.
- Persist no prompt or transcript content.
- Log event type, session ID prefix, slot, and timestamps only.
- Reject symlink escapes when resolving a session state directory.

## 16. Failure behavior

| Failure | Required behavior |
|---|---|
| Hook cannot reach daemon | Hook exits nonzero and displays a visible warning |
| Bound event file is absent | Retry briefly, then set slot `error` with diagnostic |
| Event line is malformed | Log offset; keep prior state; continue at next line |
| Slot is unbound | Do not launch VS Code; return explicit error |
| Project path no longer exists | Keep binding; set `error`; explain remediation |
| VS Code exact-open compatibility check fails | Do not open generic Chat |
| Session was archived/deleted | Set `error`; offer rebind |
| Slot is rebound | Close old watcher before activating new binding |
| Daemon restarts mid-run | Replay events and reconstruct state |
| All slots are active or errored | Leave new session unbound; warn and retry on next prompt |
| Workspace hooks suppress user hooks | Report unsupported workspace configuration |

## 17. Feasibility spike

Implementation must begin with a narrow spike against the installed VS Code version.
Do not build the full integration until all acceptance checks pass.

### 17.1 Binding check

- Install a temporary recorder through user-level `chat.hookFilesLocations`.
- Submit a prompt in a new local Agents-window Copilot CLI session.
- Confirm hook input `session_id` equals the directory name under
  `~/.copilot/session-state`.
- Confirm hook `cwd` is the intended project root.
- Confirm the hook runs with a built-in agent and a separate existing custom agent.
- Confirm opening or focusing a chat without submitting does not allocate it.
- Confirm the first four submitted sessions use free slots and the fifth reuses the
  oldest `done` slot.
- Add a workspace hook for the same event and determine whether it suppresses the
  AgentKeys user hook.

### 17.2 Event check

Capture:

- normal prompt start and completion;
- a permission request and response;
- an explicit user question and response;
- a forced agent error.

Confirm `events.jsonl` contains enough paired events to produce all four non-idle LED
states without timing guesses.

### 17.3 Exact-open check

- Construct both `agent-host-copilotcli:/<id>` and `copilotcli:/<id>` candidates.
- Use the VS Code file/workspace URL with `session=`.
- Confirm the supported resource opens the exact transcript.
- Confirm an already-open project window is focused rather than duplicated.
- Confirm two simultaneously open project windows route to their own sessions.
- Confirm a path containing spaces and non-ASCII characters is encoded correctly.

### 17.4 Restart check

- Stop the daemon during `running`.
- Cause a permission request while it is stopped.
- Restart it.
- Confirm replay reconstructs `input`.
- Answer the request and confirm the state returns to `running`, then `done`.

If any exact-open check fails, stop. The fallback is not the old extension design; the
next step is a small, version-specific prototype around VS Code's Sessions service.

## 18. Acceptance criteria

V1 is complete only when:

- submitting a prompt in a previously unbound session allocates it without terminal use;
- built-in and unrelated custom agents work without modification;
- free slots are filled before the oldest `done` slot is reused;
- active and errored slots are never silently stolen;
- resuming an unbound old session makes it eligible again only after prompt submission;
- four slots can point to four projects open in different VS Code windows;
- `running`, `input`, `done`, and `error` are driven by hooks/events, not cache polling;
- permission and explicit-question waits light `input`;
- pressing a key opens the exact transcript and focuses the correct project window;
- daemon restart reconstructs state;
- malformed state and unavailable VS Code features fail visibly;
- no native SQLite module, Karabiner configuration, or general VS Code extension is
  required.

## 19. Deferred work

- Stable support for normal local workspace chat resources.
- Remote SSH, Dev Container, WSL, and remote Agent Host sessions.
- Claude, cloud-agent, and other provider event formats.
- A VS Code Marketplace extension.
- Public upstream APIs for enumerating, observing, and opening built-in sessions.
- Positive acknowledgement from VS Code after the requested session is rendered.
- A manual pin or slot-selection command for exceptional workflows.

## 20. Maintainability boundary

Most of this design rests on documented or product-owned interfaces:

- user-level agent hooks and their documented `session_id`;
- Copilot CLI's persisted session event stream;
- AgentKeys' loopback daemon and canonical states.

One boundary remains version-sensitive: VS Code's exact-session URL handoff and session
resource scheme. Keep that code isolated in one adapter with fixtures and an explicit
supported-version table. That is a substantially smaller and safer compatibility surface
than scraping every workspace's private storage and coordinating multiple extension
hosts.
