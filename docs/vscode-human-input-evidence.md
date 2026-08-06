# VS Code human-input evidence

This records the Phase 1 evidence captured from Visual Studio Code 1.131.0,
commit `d0fd3324a737f695bd14f2aee3ca92accd28870f`. The fixtures under
`test/fixtures/vscode-human-input/` contain real records with prompts, answers,
commands, paths, absolute timestamps, and opaque content redacted. IDs are stable
pseudonyms so related records remain correlatable. Each selected record retains its
source line and, when its source had a timestamp, a millisecond offset from the first
timestamped record in that fixture.

The capture command is `npm run dev:capture:vscode-fixture -- ...`. Exact source
lines can be selected independently, and `--agent-host-state-row-limit` bounds
unrelated SQLite rows without changing their structure. The fixture tests reject
home paths, raw UUIDs, file URIs, long opaque tokens, and files over 100 KB.
The manifest identifies exact start and end records for every measured lifecycle;
the fixture tests recompute each duration rather than trusting this document.

## Observed lifecycles

| Case | Ordered evidence | Measured wait | Resolution |
|---|---|---:|---|
| Native question | transcript `assistant.message` -> `tool.execution_start` -> `tool.execution_complete`; journal `questionCarousel` -> same `resolveId` with `isUsed: true` | 47,379 ms | submitted |
| Agent Host terminal | `tool.execution_start` -> `preToolUse` start/end -> `permission.requested(shell)` | 1,160,824 ms | `permission.completed(approved)` |
| Agent Host network | tool and `preToolUse` events -> `permission.requested(url)` | 5,008 ms | `permission.completed(approved)` |
| Agent Host external file | `permission.requested(read)` for a path outside the session working directory | 196,716 ms | `permission.completed(approved)` |
| Agent Host contributed tool | `preToolUse` start/end -> two `permission.requested(custom-tool)` records | 16,984 ms for the human-delayed request; 27 ms for the immediate control | both `approved` |
| Agent Host URL immediate control | `permission.requested(url)` -> `permission.completed(approved)` | 1 ms | approved; approval cause not persisted |
| Native tool outcomes | final `toolInvocationSerialized.isConfirmed.type` values 4, 0, and 1 | not persisted | explicit approve, deny, and confirmation-not-needed |
| Legacy confirmation | final `confirmation` with `isUsed: true` | not persisted | button identity not persisted |
| Elicitation | final `elicitationSerialized.state` values | not persisted | `accepted` and `rejected` |

The installed bundle and the corresponding public source define native confirmation
types as follows: 0 denied, 1 confirmation not needed, 2 setting, 3 per-tool scoped
approval, 4 explicit user action, and 5 skipped. Types 0 and 5 cancel; the other
types proceed.

## Source ordering

The Agent Host event log has timestamps and a total order. The fixtures retain that
order as source lines and relative offsets without retaining dates or time of day.
`preToolUse` finishes
before `permission.requested` for the captured terminal and contributed-tool
requests. The hook only identifies a tool boundary; `permission.requested` is the
first event that identifies a permission gate. It is not sufficient evidence of
a human blocker because the same event also appears in the 1 ms URL and 27 ms
contributed-tool immediate controls. Their latency proves that no human wait occurred,
but it does not identify the mechanism that approved them.

The native journal has no per-record timestamp. For the question lifecycle it
contains the authoritative unresolved and used `questionCarousel` snapshots,
while the transcript contains timestamped tool start and completion records.
Their cross-file first-arrival order cannot be established from persisted data.

Agent Host `session.db` was also captured. The fixtures preserve its table and column
inventory while bounding and sanitizing rows. Its three tables (`inbox_entries`,
`todo_deps`, and `todos`) contain inbox and todo state, not chat blockers. The
permission lifecycle is durable only in
`events.jsonl` among the inspected Agent Host files. Captured `preToolUse` and
`preMcpToolCall` hook payloads are useful ordering hints but expose no independent
open/closed blocker state.

## Reload persistence

The native question's unresolved and resolved snapshots both survive a fresh file
read, and the transcript retains tool start and completion. Completed native tool
calls survive as `toolInvocationSerialized`; their live waiting state does not.
No window reload occurred during the captured question wait, so restoration of the
live waiting UI is not directly established.

Agent Host permission requests and completions survive later session resumes in
the event log. No captured permission remained open across a reload, and the
SQLite state has no corresponding blocker row. Event history therefore proves
durability, not that an unresolved request can be reconstructed after reload from
these files alone.

## Support matrix

| Blocker family | Real evidence | Unsupported from available external signals |
|---|---|---|
| Pre-tool approval | terminal, network, external-file, and contributed-tool entry; approve, deny, native confirmation-not-needed, and Agent Host immediate controls | edit-and-approve; Agent Host deny/edit outcomes; cause of immediate approvals |
| Post-tool approval | none | pending result review, approve, reject |
| Authentication | none | missing-auth and insufficient-scope waits, authenticate, cancel |
| Confirmation part | final used response | waiting state, selected button, cancel |
| Questions | native `vscode_askQuestions` waiting and submit | native skip/cancel; protocol `askUser` |
| Plan review | none | waiting, approve, reject, feedback |
| Elicitation | final accepted and rejected states | pending form/URL requests; decline versus cancel |
| Modified-files review | none | waiting, approve, reject |
| Feedback review | none | waiting, approve, reject |

The Agent Host protocol defines unresolved `InputRequest`, non-auto-approved
`pending-confirmation`, `pending-result-confirmation`, and `auth-required` as the
authoritative blockers. None of the unavailable protocol states above is
synthesized in this corpus.

## UI truth limits

The human-delayed records were captured from visibly blocking interactions, and
their completion records establish the transition out of the wait. The persisted
formats do not contain `ChatModel.hasActiveRequest` or
`ChatModel.requestInProgress`, so the exact model truth table cannot be replayed
from these historical files. Unsupported rows must remain visible diagnostics in
later phases rather than being decoded from timing or tool names.