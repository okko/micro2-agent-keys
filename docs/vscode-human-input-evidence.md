# VS Code human-input evidence

This records sanitized production evidence captured from Visual Studio Code 1.131.0,
commit `d0fd3324a737f695bd14f2aee3ca92accd28870f`. The fixtures under
`test/fixtures/vscode-human-input/` retain only structural states, enum outcomes,
relative timing, and stable pseudonyms needed for correlation. Prompts, answers,
commands, URLs, paths, credentials, tokens, account names, private content, and
absolute timestamps are redacted.

Coverage is exhaustive for externally observable outcomes available from this build's
native transcript and journal, Agent Host event and state files, and live Agent Host
protocol. Every outcome not backed by a real fixture has a build-locked upstream or
provider limitation in the archived completion ledger at
`docs/archive-do-not-edit/vscode-plan-gaps-todo.md`. No unsupported state is synthesized.
Unknown waiting forms continue to fail closed.

## Capture and validation

Create sanitized fixtures with:

```sh
npm run dev:capture:vscode-fixture -- ...
```

Capture live Agent Host lifecycles with:

```sh
npm run dev:capture:vscode-ahp-lifecycle -- \
  --output "$TMPDIR/agentkeys-lifecycle.jsonl" \
  --scenario <name>
```

The lifecycle recorder supports isolated scenarios and passive `--session` attachment.
It preserves only safe blocker structure, correlates UI actions by request, turn, or tool
ID, and treats terminal state as authoritative when cancellation leaves an unresolved-
looking historical response part.

The fixture tests reject home paths, file URIs, raw UUIDs, long opaque tokens, absolute
timestamps, and files over 100 KB. Manifest measurements identify exact source records;
tests recompute every duration rather than trusting prose.

## Observed lifecycles

| Family | Real production evidence | Outcome |
|---|---|---|
| Native questions | unresolved and used `questionCarousel` records correlated with tool start/completion | submit and Skip |
| Agent Host questions | status `24` unresolved input -> action -> status `8` or terminal `1` | submit and turn cancel |
| Plan review | status `24` `request.planReview` -> correlated input response -> status `8` -> terminal `1` | reject, approve, and feedback followed by replacement approval |
| Pre-tool approval | terminal, network, external-file, and contributed-tool permission requests; live pending confirmation for denial | approve, deny, confirmation-not-needed, and immediate controls |
| Modified-files review | `modifiedFilesConfirmation` with status `24` -> correlated confirmation -> status `8` -> terminal `1` | approve and reject |
| Feedback review | `agentFeedbackReviewConfirmation` with status `24` -> correlated confirmation -> status `8` -> terminal `1` | approve and reject |
| Form elicitation | unresolved Agent Host input request -> `decline` response -> status `8` -> terminal `1` | decline |
| URL elicitation | unresolved redacted URL request -> correlated response or turn cancellation | decline and cancel |
| Native elicitation | final `elicitationSerialized.state` | accepted and rejected |
| Authentication | status `24` tool with `auth-required`, reason `expired` -> correlated turn cancellation -> terminal `1` | expired-auth cancel |
| Legacy confirmation | final native `confirmation` with `isUsed: true` | generic resolution only |

Agent Host execution bits are interpreted independently of AgentKeys: `24` means waiting
for input, `8` means an active running turn, and `1` means terminal/inactive. Waiting also
requires the expected unresolved input request, non-auto-approved pending confirmation,
pending result confirmation, or auth-required tool. Timing and tool names alone never
establish a blocker.

## Measured waits

Human-delayed captures include native question submit (47,379 ms), native question Skip
(39,866 ms), URL elicitation decline (72,700 ms), URL elicitation cancellation
(26,512 ms), and expired-auth cancellation (187,070 ms). Permission waits include
terminal (1,160,824 ms), external-file read (196,716 ms), contributed tool (16,984 ms),
and network (5,008 ms).

The 1 ms URL and 27 ms contributed-tool permission pairs are immediate controls, not
human waits. Recorder-driven protocol actions complete in 1-8 ms and are classified as
immediate protocol controls. Their timing verifies ordering, not human behavior.

## Ordering and persistence

Agent Host `events.jsonl` has timestamps and total order. Captured `preToolUse` and
`preMcpToolCall` hooks establish boundaries, while `permission.requested` first identifies
the permission gate. The same event can be immediately approved, so it is not sufficient
waiting evidence by itself.

The native journal has no per-record timestamp. Native question records establish
unresolved/used structure, while the transcript supplies tool start/completion timing;
cross-file first-arrival order cannot be reconstructed.

Agent Host `session.db` contains inbox and todo state, not chat blockers. Permission
history persists in `events.jsonl`; unresolved input requests and authoritative status
transitions come from the live protocol. Captured lifecycles were not held open across a
window reload, so restoration of a waiting UI is not claimed.

Turn cancellation may transition directly from status `24` to terminal status `1`.
Historical input parts can remain unresolved-looking after cancellation. The correlated
`chat/turnCancelled` action and terminal turn/tool state are authoritative in that case.

## Support matrix

| Blocker family | Real evidence | Remaining build-locked limitation |
|---|---|---|
| Pre-tool approval | waiting, approve, deny, confirmation-not-needed, immediate controls | edit-and-approve has reducer support but no installed producer or distinct persisted outcome |
| Post-tool approval | none | reducer contract exists, but no installed provider emits `requiresResultConfirmation` or a result-review action |
| Authentication | expired-auth waiting and cancel | missing-auth, insufficient-scope, and authenticate are blocked by Agent Host/server authentication-state divergence |
| Confirmation part | final generic resolution | no triggerable installed producer for waiting; selected button and cancel are not persisted distinctly |
| Questions | native waiting/submit/Skip; Agent Host waiting/submit/cancel | native cancel is not persisted distinctly; Agent Host has no Skip producer or response kind |
| Plan review | waiting, reject, approve, feedback, replacement review | none |
| Elicitation | native accepted/rejected; Agent Host pending form/URL, decline, and cancel | none |
| Modified-files review | waiting, approve, reject | none |
| Feedback review | waiting, approve, reject | none |

The expired authentication fixture proves only the observed `expired` reason and
cancellation. It does not prove missing credentials, insufficient scope, token refresh,
or successful authentication.

## UI truth limits

The human-delayed records were captured from visibly blocking production interactions,
and completion or terminal records establish exit from the wait. Native persisted formats
do not expose `ChatModel.hasActiveRequest` or `requestInProgress`; exact native model truth
cannot be replayed from history. Agent Host fixtures retain live status and blocker
structure, but their visual rendering was not separately screen-captured.

Unsupported outcomes remain explicit diagnostics. They must not be inferred from elapsed
time, labels, tool names, reducer capability, or a neighboring outcome.