# VS Code integration residual blind spots

This records the forward-compatibility and source-availability limits that remain after
the VS Code human-input plan. Runtime integration and exact transcript opening are not
version-gated. The real evidence corpus is still anchored to VS Code 1.131.0 and must not
be presented as empirical proof for other versions.

## Current mitigations

| Blind spot | Current behavior | Verification |
|---|---|---|
| Unknown native waiting response | A native request with model state `NeedsInput`, no recognized blocker, and an unknown response shape produces `incompatible:unknown-native-response` and solid red. | Integration test checks red state and sanitized diagnostic. |
| Unknown native state hidden beside an older resolved response | Unknown state-bearing response kinds and tool state numbers outside the observed `0..6` enum are checked independently of resolved human-input parts and fail red. | The native incompatibility test includes a resolved question before the unknown part. |
| Unknown Agent Host tool status | Any status outside the known protocol set produces `incompatible:unknown-agent-host-tool-status` and solid red. | Projection and bound-slot integration tests. |
| Unknown Agent Host response-part kind | Raw Agent Host execution status bits `24` are treated as authoritative. If status says waiting and no recognized blocker explains it, the slot produces `incompatible:unknown-agent-host-response` and solid red. | Integration test uses a future response kind with status `24`. |
| Established Agent Host source disconnects | Loss of the endpoint that owned a bound session sets `agent-host-state-unavailable` and solid red. The next complete snapshot clears that source error and reconstructs input/running/done. | Source reconnect test and integration recovery test. |
| Installed VS Code version differs from evidence version | Tracking and exact transcript opening remain enabled. Version is reported in `doctor` and incompatibility diagnostics; unknown exported states fail red where an authoritative waiting signal exists. | Exact-open policy test covers current, future, and unreadable versions. |

Diagnostics retain only session/request identity, source, response-part kind, unknown
state/status token, and observed VS Code version. They do not retain prompts, answers,
commands, tool input, paths, URLs, tokens, or feedback.

## Limits that cannot be removed with current signals

### Native `NeedsInput` enum changes or disappears

Known blocker shapes are recognized without relying on the model-state number. A new
unknown native blocker, however, can only be identified as waiting when VS Code also
exports the recognized `NeedsInput` value (`4`) or another stable waiting signal. If a
future version changes that enum and changes the response shape at the same time,
AgentKeys cannot prove that the request is waiting.

Mitigation when adopting a new VS Code build:

1. Check `ResponseModelState`, `ChatResponseModel._pendingInfo`, `isInProgress`, and
   `isIncomplete` at the source anchors in `docs/vscode-plan.md`.
2. Capture one real waiting/resolved/terminal lifecycle with raw model/protocol truth.
3. Update the decoder and versioned parity evidence before claiming empirical support.

Do not infer the new enum from elapsed time.

### Unknown native response with no structural waiting marker

The masked-response hardening recognizes unknown parts carrying `state`, `isUsed: false`,
or an unknown tool state number. A future human-input part with none of those structural
markers can be indistinguishable from ordinary response content, especially when an older
resolved input part is also present. Treating every unknown response kind as waiting would
turn normal markdown, progress, references, edits, and other response content red.

This requires an upstream semantic waiting flag or a complete versioned response-kind
inventory. Until then, preserve the fail-closed check when model state is unexplained and
do not guess from kind names.

### No exported signal

If a UI blocks execution but neither the native journal/transcript/hooks nor the live
Agent Host protocol exports that blocker, AgentKeys cannot observe it and therefore
cannot turn red. Timing is not an acceptable substitute because auto-approved and
human-delayed permission events share persisted shapes.

The archived evidence completion ledger at
`docs/archive-do-not-edit/vscode-plan-gaps-todo.md` requires each such case to remain
unsupported until a production signal exists. The correct upstream fix is to export an
unresolved blocker identity or authoritative `awaitsUserInput` state.

### No Agent Host endpoint before first ownership

A disconnect is actionable only after an endpoint has delivered a complete snapshot and
become the session owner. On daemon startup, an existing Agent Host session may be known
from persisted events before any live endpoint is discovered. Marking that interval red
would create an error on every normal editor startup and would not distinguish a session
that has already terminated.

Current behavior:

- no red source error before the first authoritative snapshot;
- established ownership loss turns red;
- endpoint discovery and reconnect continue on the bounded retry loop;
- the first complete snapshot establishes or restores authoritative state.

A stronger startup guarantee would require persisted Agent Host chat state or an endpoint
API that distinguishes unavailable, inactive, and terminal sessions.

### Agent Host status contract changes

Unknown tool statuses already fail red. Unknown response kinds fail red when raw execution
bits still report `24`. If a future protocol changes both the status encoding and response
shape, no stable signal remains. The connection handshake negotiates a protocol version,
but the current endpoint API does not publish a machine-readable schema for status bits.

On protocol upgrades, recapture status truth and update the evidence manifest. Do not
silently treat a new status encoding as running.

## Version policy

AgentKeys supports exact transcript opening for every installed VS Code version that
registers the `vscode://` URL handler. The version read from VS Code's `package.json` is
observability metadata, not a feature gate.

This policy does not turn the VS Code 1.131.0 evidence corpus into cross-version proof.
For other versions:

- known exported shapes are handled normally;
- authoritative unknown waits fail red where detectable;
- event producer/schema compatibility remains independently checked;
- `agentkeys doctor vscode` reports the observed version and protocol registration;
- evidence claims remain tied to the build from which each fixture was captured.

## Follow-up triggers

Reopen this document and the evidence backlog when any of these occur:

- VS Code changes `ResponseModelState`, native response kinds, or tool state numbers;
- Agent Host changes status bits, response-part kinds, or `ToolCallStatus`;
- a currently unsupported blocker becomes reproducible;
- Agent Host adds persisted chat state or explicit availability/session-state APIs;
- a real interaction produces blue while the UI is visibly waiting, or red while the
  authoritative model says running.

For each trigger, capture production truth first, make the smallest decoder change, add a
versioned parity fixture, and retain sanitized diagnostics for anything still unknown.
