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
Live protocol captures are produced with
`npm run dev:capture:vscode-ahp-lifecycle -- --output <jsonl> --scenario <name>`
and supplied to the
fixture command with `--agent-host-protocol <jsonl>`. The driver creates an isolated
Agent Host session, invokes one real question, and resolves it with the protocol's
cancel action without approving or executing another tool.

## Observed lifecycles

| Case | Ordered evidence | Measured wait | Resolution |
|---|---|---:|---|
| Native question | transcript `assistant.message` -> `tool.execution_start` -> `tool.execution_complete`; journal `questionCarousel` -> same `resolveId` with `isUsed: true` | 47,379 ms | submitted |
| Agent Host question | raw chat status `24` with unresolved `inputRequest` -> status `8` with its response present -> terminal status `1` | 5 ms to resume; 2,620 ms to terminal | protocol cancel |
| Agent Host external-file denial | raw status `24` with `pending-confirmation` -> status `8` with the same tool call `cancelled` -> terminal status `1`; event log records the same tool and request IDs | 5 ms to resume; 2,562 ms to terminal | `denied-interactively-by-user` |
| Agent Host plan review | raw status `24` with unresolved `inputRequest.request.planReview` -> status `8` with its response present -> terminal status `1` | 2 ms to resume; 1,722 ms to terminal | protocol reject/cancel |
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

The live Agent Host question, plan-review, and tool-denial captures are independently
grounded in VS Code's reduced chat `status`, not in the AgentKeys projection:
execution bits `24` mean waiting for input, `8` mean an active running turn, and `1`
means terminal/inactive. The same turn and blocker pseudonyms correlate each set of
three snapshots. Their automated cancel, reject, and deny actions are immediate
protocol controls, not measured human reaction times. VS Code 1.131.0 identifies
the captured plan review by the presence of `InputRequest.request.planReview`, not a
`purpose: planReview` field.

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

The Agent Host question's start and completion survive in `events.jsonl`, but its
unresolved `inputRequest` and status transitions were available only from the live
protocol. The external-file denial additionally persists correlated
`permission.requested` and `permission.completed(denied-interactively-by-user)`
records. The plan review's tool start and completion persist, but its unresolved
request is likewise live-protocol-only. No reload was performed while any of these
requests waited.

## Support matrix

| Blocker family | Real evidence | Unsupported from available external signals |
|---|---|---|
| Pre-tool approval | terminal, network, external-file, and contributed-tool entry; approve, native and Agent Host deny, native confirmation-not-needed, and Agent Host immediate controls; live Agent Host waiting/resume/terminal model truth for external-file denial | edit-and-approve; Agent Host edit outcome; cause of immediate approvals |
| Post-tool approval | none | pending result review, approve, reject |
| Authentication | none | missing-auth and insufficient-scope waits, authenticate, cancel |
| Confirmation part | final used response | waiting state, selected button, cancel |
| Questions | native `vscode_askQuestions` waiting/submit; Agent Host `askUser` waiting/cancel/resume/terminal | native skip/cancel; Agent Host submit/skip |
| Plan review | Agent Host waiting/reject/resume/terminal, identified by `request.planReview` | approve, feedback |
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
`ChatModel.requestInProgress`, so the exact native model truth table cannot be
replayed from those historical files. The Agent Host question, plan-review, and
tool-denial fixtures do retain the corresponding authoritative live model status
and verify their complete waiting/resumed/terminal truth tables. Their visual
rendering was not separately screen-captured. Unsupported rows must remain visible
diagnostics rather than being decoded from timing or tool names.