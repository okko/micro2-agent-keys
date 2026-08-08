# Reliable human-input state tracking

## Status

Done for the externally observable production surface validated on VS Code 1.131.x.
Runtime tracking and exact transcript opening support every installed VS Code version;
fixture claims remain tied to the build that produced them. The evidence manifest is the
coverage authority: every inventory row is classified as observed or unsupported, real
records are required for observed claims, and detectable unrecognized waiting forms fail
closed. Internal UI/model states that the evidence build does not export, or interactions
that require unavailable providers or credentials, are not claimed as empirically
covered. See `docs/archive-do-not-edit/vscode-plan-gaps-todo.md` for the archived
completion ledger and `docs/vscode-plan-residual-blind-spots.md` for limits without
current external signals.

## Goal

Make the `input` key color match VS Code whenever the latest chat request is active but
cannot continue without a human response. The daemon must return the key to `running`
when the response is supplied and must preserve the correct state across daemon and VS
Code restarts.

Use these behavioral definitions rather than tool-name heuristics:

```text
active = equivalent to ChatModel.hasActiveRequest
busy = equivalent to ChatModel.requestInProgress
needsHumanInput = active && !busy && an unresolved human-input blocker exists
```

State precedence remains:

```text
error > input > done > running > idle
```

Do not classify ordinary long-running tools, queued prompts, background terminals, or
unreviewed file edits as `input` unless they create one of the blockers below.

## Authoritative blocker inventory

VS Code's `ChatResponseModel` currently suppresses `requestInProgress` for these live
response forms:

- `toolInvocation` in `WaitingForConfirmation`;
- `toolInvocation` in `WaitingForPostApproval`;
- `toolInvocation` in `WaitingForAuthentication`;
- unused `confirmation` response part;
- unused `questionCarousel` response part;
- unused `planReview` response part;
- pending `elicitation2` response part.

The Agent Host protocol expresses the same contract through:

- `InputRequest` with no `response`, including `askUser` and `elicitation` purposes and
  the 1.131.x `planReview` payload property;
- `ToolCall` with status `pending-confirmation`, unless it is positively identified as
  auto-approved;
- `ToolCall` with status `pending-result-confirmation`;
- `ToolCall` with status `auth-required`.

Modified-file and feedback review UIs count when they are represented by a waiting tool
confirmation, including tool-specific kinds `modifiedFilesConfirmation` and
`agentFeedbackReviewConfirmation`. A chat editing session merely having modified files
is not an execution blocker and must not turn the key orange.

## DONE: Phase 1: account for every external signal

For every row below that can be induced through the installed evidence build's
production interfaces, collect sanitized before/waiting/resolved fixtures. Capture the
native transcript, chat-session journal patches, live Agent Host protocol state, Agent
Host persisted events, and hook payloads as available. Record which signal arrives first
and whether it survives a window reload. If a row is not exported or requires an
unavailable provider, authentication setup, or server, record it as unsupported in the
manifest instead of manufacturing a fixture. The table is the investigation inventory;
the manifest records the empirical result.

| Blocker | Enter fixture | Resolve fixtures |
|---|---|---|
| Pre-tool approval | terminal, network, external file, and a generic contributed tool | approve, deny, edit-and-approve, auto-approve |
| Post-tool approval | a tool requiring result review | approve and reject |
| Authentication | MCP tool with missing auth and insufficient-scope step-up auth | authenticate and cancel |
| Confirmation part | legacy/built-in confirmation response | each button and cancel |
| Questions | `vscode_askQuestions` and protocol `askUser` | submit, skip, and cancel |
| Plan review | plan review response/protocol request | approve, reject, and feedback |
| Elicitation | form and URL-style MCP elicitations | accept, decline, and cancel |
| Modified-files review | tool confirmation carrying modified-file metadata | approve and reject |
| Feedback review | tool confirmation carrying feedback-review metadata | approve and reject |

For each capture, verify this truth table against exported model/protocol state when it
is available, otherwise against the visibly blocking UI and its resolution. Record when
either form of truth is unavailable rather than inferring it from latency:

```text
waiting:  hasActiveRequest=true, requestInProgress=false
resolved: hasActiveRequest=true, requestInProgress=true, unless the request terminates
terminal: hasActiveRequest=false, requestInProgress=false
```

Do not claim empirical support for a state until at least one real waiting and one
resolved fixture establish its production representation. Version-locked source-contract
shapes may have unit coverage before they become externally reproducible, but remain
unsupported in the evidence manifest. Unknown waiting forms must fail closed instead of
silently reporting `running`.

## DONE: Phase 2: reconstruct native chat state

Replace the current journal pattern matching with a small typed projection of the latest
request. It does not need to rebuild the whole chat UI, but it must apply the mutation-log
operations needed for:

- request insertion, replacement, and removal;
- latest-request identity and index;
- `modelState` changes;
- response-part insertion, replacement, and mutation;
- tool call identity, confirmation, completion, and tool-specific data;
- `isUsed`, elicitation state, and plan/question results.

Keep the projection per session and derive one snapshot:

```ts
interface ChatExecutionSnapshot {
  requestId: string | null;
  active: boolean;
  busy: boolean;
  blockers: Map<string, HumanInputBlocker>;
  terminal: 'complete' | 'cancelled' | 'failed' | null;
}
```

A blocker needs a stable compound identity such as request ID, response-part kind, and
tool-call/resolve/request ID. This lets one approval clear only itself while another
parallel blocker remains.

Correlate completion with the latest request ID/index. A `result` or `modelState` patch
for an older request must not mark the current request done. Handle request removal,
resend/edit, queued requests, log truncation, inode replacement, and a new prompt that
arrives before an older completion patch.

Treat persisted `ResponseModelState.NeedsInput` only as supporting evidence. VS Code may
serialize or index a live pending response as cancelled, and some live tool states are
intentionally not persisted. The unresolved response part or protocol state is the
primary blocker evidence.

## DONE: Phase 3: normalize all input sources

Introduce source-independent reducer events rather than adding more tool-name branches:

```ts
{ type: 'request.started', requestId }
{ type: 'human-input.opened', requestId, blockerId, kind }
{ type: 'human-input.closed', requestId, blockerId, outcome }
{ type: 'request.finished', requestId, outcome }
```

Normalize these sources into that event set:

- live Agent Host protocol `ChatState`, which exposes `InputRequest` and
  `ToolCallStatus` directly;
- native chat-session journal projection;
- Copilot transcript events;
- preview hooks for low-latency entry/exit where journal writes lag.

Journal/protocol state is authoritative. Hooks may make a transition timely but must be
reconciled against the next authoritative snapshot. Deduplicate the same blocker seen in
multiple sources by its stable identity.

Update `RunState` to hold blockers by ID and associate every transition with a request
ID. Derive colors as follows:

```text
blockers.size > 0                 -> input
active && blockers.size === 0     -> running
latest request completed          -> done
latest request failed             -> error
```

An unknown waiting status must be logged with session ID, request ID, response-part kind,
and VS Code version, without logging prompts, answers, command text, paths, or tokens.

## DONE: Phase 4: close known coverage gaps

Implement and verify each adapter separately:

1. Generalize pre-tool confirmation detection beyond network, unsandboxed, and external
   file heuristics by reading the actual waiting tool state.
2. Add post-tool/result confirmation entry and resolution.
3. Add tool authentication entry, successful authentication, cancellation, and failure.
4. Add unresolved protocol `InputRequest` handling for every current and unknown future
   `purpose`; purpose affects diagnostics, not whether the key is orange.
5. Add legacy `confirmation`, `questionCarousel`, and `planReview` response-part
   lifecycles using `isUsed` and their stable IDs.
6. Add pending `elicitation2` handling and clear it on accepted/rejected state.
7. Ensure modified-files and feedback review confirmations flow through generic tool
   confirmation handling rather than dedicated color logic.
8. Preserve the existing hook fallbacks only where fixtures prove that no authoritative
   live signal arrives soon enough.

## DONE: Phase 5: recovery and reconciliation

On startup and after log rotation, rebuild each bound session from the last full journal
record plus following patches. Emit the color changes while reconstructing.

During normal operation:

- consume transcript and journal appends in a deterministic order;
- reconcile the complete projected blocker set after every scan;
- keep `input` while any blocker remains;
- clear stale hook-only blockers when an authoritative snapshot proves they are absent;
- time out nothing based solely on elapsed time;
- retain the last known state on a transient read error and surface a diagnostic;
- use the existing missing-stream policy only after its retry threshold.

Polling must balance responsiveness with CPU use and battery life:

- no polling interval may be shorter than 100 ms;
- configure periodic scans so a persisted state change normally reaches `onSlot` within
  100–300 ms; HID transport and device-rendering latency are outside this plan;
- prefer file events and hooks to extra polling, and coalesce bursts into one scan;
- do not busy-wait or add a faster fallback loop when a source is idle or unavailable.

On daemon restart, VS Code reload, session resume, request edit/resend, cancellation, and
failure, assert that no blocker from the previous request leaks into the next request.

## Test plan

Add table-driven reducer tests covering every blocker with these transitions:

```text
running -> input -> running -> done
running -> input -> done
running -> input -> error
running -> input -> cancelled/done
```

Add fixture-driven journal tests for:

- every captured blocker and every resolution outcome;
- two simultaneous blockers resolved in both orders;
- an old request completing while the latest request is waiting;
- question, plan, or elicitation replacement using the same response position;
- auto-approved confirmation that must never flash `input`;
- restart while blocked and restart immediately after resolution;
- partial final JSONL lines, malformed lines, truncation, and inode replacement;
- unsupported response parts degrading visibly in diagnostics rather than changing color
  incorrectly.

Add integration assertions that `onSlot` fires once per effective state change and that
`input` maps to the existing orange breathing key state.

For each real fixture, compare AgentKeys with VS Code's model or visible UI at entry and
exit. The acceptance matrix is:

| VS Code model | Expected key |
|---|---|
| active and busy | blue `running` |
| active, not busy, unresolved human blocker | orange `input` |
| completed successfully | green `done` |
| terminal failure | red `error` |
| inactive/acknowledged | white `idle` |

## Completion criteria

This work is complete when:

- the evidence manifest accounts for every inventory family and outcome as observed or
  unsupported, and every externally observable, reproducible waiting condition in the
  evidence build has a sanitized real fixture and automated test;
- unsupported interactions are not represented by synthetic empirical fixtures;
  version-locked source-contract forms remain unit-tested and all unrecognized waiting
  response parts or tool statuses fail closed;
- every polling interval is at least 100 ms and persisted state changes normally reach
  `onSlot` within 100–300 ms; HID transport and device-rendering latency are excluded;
- parallel blockers, restarts, queued requests, edits/resends, cancellation, and failure
  cannot leave a stale orange or blue key;
- latest-request completion is correlated by identity rather than any request index;
- an automated parity test exercises all captured states against their captured VS Code
  version;
- compatibility checking fails closed, with an actionable diagnostic, when any VS Code
  version introduces a detectably unrecognized waiting response part or tool status.

## Source anchors

The implementation should be checked against these VS Code ownership points whenever a
new VS Code version is added to the empirical evidence set:

- `ChatResponseModel._pendingInfo`, `isInProgress`, and `isIncomplete` in
  `src/vs/workbench/contrib/chat/common/model/chatModel.ts`;
- `IChatToolInvocation.StateKind`, response-part types, and `ResponseModelState` in
  `src/vs/workbench/contrib/chat/common/chatService/chatService.ts`;
- `chatAwaitsUserInput` in
  `src/vs/platform/agentHost/common/state/sessionState.ts`;
- `InputRequestResponsePart` and `ToolCallStatus` in
  `src/vs/platform/agentHost/common/state/protocol/channels-chat/state.ts`;
- native persistence schemas in `chatSessionOperationLog.ts` and
  `chatSessionStore.ts`.
