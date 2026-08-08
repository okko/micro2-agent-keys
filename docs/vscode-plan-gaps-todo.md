# VS Code human-input evidence gap backlog

This is the handoff plan for a separate evidence-capture session. It covers every
`unsupported` outcome in `test/fixtures/vscode-human-input/manifest.json`. The goal is
real, sanitized production evidence, not synthetic fixtures or timing-based inference.

## Evidence rules

1. Capture against an installed VS Code build and record its version and commit. Do not
   merge records from different builds into one fixture.
2. Use harmless local actions. Prefer a disposable workspace, `/etc/hosts` for a denied
   external read, localhost services, and disposable test identities. Never put tokens,
   credentials, prompt text, answers, commands, or private paths in committed fixtures.
3. Keep raw captures under `$TMPDIR`, outside the repository. Commit only output produced
   by `scripts/capture-vscode-fixture.mjs` after the fixture tests accept it.
4. A waiting-state claim needs independent truth:
   - Agent Host: status bits `24`, an active turn, and the unresolved blocker;
   - native Chat: a persisted unresolved part plus visibly blocking UI, unless a stable
     exported model signal becomes available.
5. Capture waiting, resolved, and terminal snapshots where the source exports them. Keep
   stable request, turn, tool-call, or resolve IDs so the stages are correlatable.
6. If no production surface distinguishes an outcome, document the negative result and
   leave it unsupported. Do not infer an outcome from elapsed time or fabricate a record.
7. After each fixture, update the manifest, evidence support matrix, measurements where
   timestamps exist, fixture-accounting tests, and protocol parity tests when an
   `agent-host-protocol` source is present.

## Common capture procedure

### Agent Host lifecycle

Use the isolated protocol driver when it supports the required scenario:

```sh
raw="$TMPDIR/agentkeys-<scenario>.jsonl"
rm -f "$raw"
npm run dev:capture:vscode-ahp-lifecycle -- \
  --output "$raw" \
  --scenario <scenario>
```

The command prints the generated session UUID. Use it immediately to collect the
sanitized fixture:

```sh
npm run dev:capture:vscode-fixture -- \
  --session <uuid-from-driver> \
  --label lifecycle \
  --agent-host-protocol "$raw" \
  --agent-host-state-row-limit 0 \
  --output test/fixtures/vscode-human-input/<fixture>.json
```

Inspect the raw JSONL locally before selecting lines. The committed protocol source must
contain the minimum complete lifecycle and no unrelated turns. Preserve status, stage,
request/turn/tool identity, response presence, tool status, and auto-approval metadata;
all content remains redacted.

### Existing native Chat session

Use a disposable workspace and one chat request per outcome. Record the session UUID from
the native transcript/journal filenames. Note source lines locally, then capture only the
needed records:

```sh
npm run dev:capture:vscode-fixture -- \
  --session <native-session-uuid> \
  --label lifecycle \
  --native-transcript-lines <lines> \
  --native-journal-lines <lines> \
  --output test/fixtures/vscode-human-input/<fixture>.json
```

The defaults already target macOS Stable VS Code workspace storage and `~/.copilot`.
Pass `--workspace-storage`, `--copilot-home`, or `--vscode-package` for Insiders or a
custom profile. If waiting exists only in memory, first extend the passive protocol
recorder; do not substitute a final persisted record for a waiting snapshot.

### Validation after every capture

```sh
node --test test/vscode-human-input-fixtures.test.mjs \
  test/vscode-fixture-parity.test.mjs
npm test
```

Also run `git diff --check` and inspect every fixture diff for accidental private data.

## Tooling work required first

### T1. Add passive Agent Host attachment

Extend `scripts/capture-agent-host-question.mjs`, or split out a general driver, with:

- `--session <uuid>` to subscribe to an existing session without creating a turn;
- `--scenario <name>` to choose the blocker predicate;
- `--resolution <name>` to choose a known protocol action;
- `--no-resolve` to record a user-driven UI outcome;
- structural recording of unknown response-part kinds instead of dropping them;
- the existing waiting/resolved/terminal truth checks for every scenario.

Do not add a resolution payload until it has been verified from the installed VS Code
source or observed from a real UI action. A guessed `chat/inputCompleted` response is not
evidence.

### T2. Generalize blocker predicates

Add predicates for:

- `inputRequest` question, plan review, and elicitation;
- `toolCall` statuses `pending-confirmation`, `pending-result-confirmation`, and
  `auth-required`;
- optional confirmation-kind metadata for modified-files and feedback review.

Each predicate must reject a snapshot unless status bits are `24`, `activeTurn` exists,
and the expected unresolved part is present. Resolution requires status `8` or a terminal
status and absence/resolution of the same blocker identity.

### T3. Preserve safe outcome structure

Extend `trimState()` only for structural fields needed to distinguish outcomes, such as
response `kind`, confirmation kind, or an enum-valued result. Add those field names to the
fixture sanitizer allowlist only after confirming that they cannot contain user content.
Keep answer text, feedback text, URLs, paths, tool input, and auth material redacted.

## Missing outcome captures

### 1. Pre-tool approval: edit-and-approve and Agent Host edit outcome

**Prerequisite:** A real tool-confirmation UI that permits editing arguments before
approval.

**Procedure:**

1. Add passive attachment from T1 and subscribe before opening the confirmation.
2. Invoke a harmless tool whose edited form still has no side effect, such as changing an
   external read target between two public system files.
3. Record the initial `pending-confirmation` snapshot.
4. Edit through the VS Code UI but do not approve yet; request another complete snapshot.
5. Approve through the UI and capture resumed and terminal snapshots plus correlated
   `permission.requested`, `permission.completed`, and tool completion events.
6. Compare the two waiting snapshots. Promote `edit-and-approve` only if a production
   signal structurally proves the edit or the completion records a distinct edit outcome.

**Expected evidence:** Same turn/tool ID across waiting, post-edit waiting, resumed, and
terminal stages; status `24 -> 24 -> 8 -> terminal`; an outcome distinct from ordinary
approve. If no structural difference exists, retain both manifest entries as unsupported
and document that edit is UI-only.

### 2. Post-tool approval: waiting, approve, reject

**Prerequisite:** A local MCP or contributed tool that deliberately requests review of
its result and causes `pending-result-confirmation`. It must return inert text or a change
inside the disposable workspace.

**Procedure:**

1. Implement T2's `pending-result-confirmation` predicate.
2. Run the tool once and capture status `24` with the matching tool-call ID and status
   `pending-result-confirmation`.
3. In separate isolated sessions, approve and reject through the real UI. Use passive
   capture until the action payload is source-verified.
4. Capture status `8` or terminal, final tool status, and persisted tool events for each
   outcome.

**Expected fixtures:** One approval lifecycle and one rejection lifecycle. The manifest
can mark waiting observed after either fixture, but approve and reject require their own
correlated completions. If no available production tool emits result confirmation, record
that prerequisite and leave all three unsupported.

### 3. Authentication: missing auth, insufficient scope, authenticate, cancel

**Prerequisite:** A deterministic local MCP test server implementing the authentication
flow, plus a disposable test identity. Never use a personal token or production account.
The server must support both no credential and insufficient-scope responses.

**Procedure:**

1. Add T2's `auth-required` predicate and passive capture.
2. With no credential, invoke a harmless read-only tool and capture status `24` with
   `auth-required`.
3. Complete authentication in one session and cancel it in another; capture resumed or
   terminal state and the same tool-call ID.
4. Repeat with a deliberately under-scoped disposable credential to establish step-up
   auth independently from missing auth.
5. Run fixture sanitization before inspecting diffs. Reject the capture if any token,
   callback query, account name, or authorization header survives.

**Expected fixtures:** Missing-auth/authenticate, missing-auth/cancel, and
insufficient-scope/authenticate lifecycles. If the protocol does not distinguish missing
from insufficient scope structurally, record one `auth-required` waiting form and leave
the distinction unsupported.

### 4. Legacy confirmation part: waiting, selected button, cancel

**Prerequisite:** A built-in or provider response that still renders a native
`confirmation` response part.

**Procedure:**

1. Use separate native sessions for every button and for cancellation.
2. Capture the journal while the UI is visibly waiting and again after resolution.
3. Require the same response identity and `isUsed: false -> true` for waiting/resolved.
4. Look for a persisted selected button ID/index or outcome enum; add only a safe enum to
   T3 if one exists.
5. Cancel through the actual UI or request cancellation and capture the terminal request.

**Expected evidence:** Waiting can become observed with unresolved persisted structure
and contemporaneous visible UI. A selected-button outcome requires a persisted button
identity; `isUsed: true` alone proves only generic resolution. Cancellation requires a
specific cancel/terminal record. Retain any indistinguishable outcome as unsupported.

### 5. Questions: native skip/cancel and Agent Host submit/skip

**Native procedure:**

1. Invoke `vscode_askQuestions` in a disposable native session.
2. If the UI exposes Skip, capture unresolved journal/transcript records, click Skip, and
   capture completion. Repeat for cancellation.
3. Verify whether Skip is a protocol/UI outcome or merely a normal answer option. If it is
   only an option supplied by the caller, reclassify `native-skip` as not applicable
   rather than claiming a separate lifecycle.

**Agent Host procedure:**

1. Extend the `question` scenario with source-verified `submit` and `skip` resolutions.
2. Use a fixed single-choice question. Keep the selected answer redacted.
3. Capture independent submit and skip sessions with status `24 -> 8 -> terminal` and the
   same input-request ID.

**Expected fixtures:** Native cancel if externally distinguishable; Agent Host submit and
skip if they are distinct response kinds. Update parity automatically by declaring
`agent-host-protocol` in each manifest fixture entry.

### 6. Plan review: approve and feedback

**Prerequisite:** Isolated Agent Host plan mode, already used by `plan-reject`.

**Procedure:**

1. Extend the plan scenario with a source-verified approval action and capture
   `request.planReview`, status `24`, response presence, resumed status `8`, and terminal.
2. For feedback, use the real feedback/revise UI. Prefer passive capture until the exact
   response shape is observed; feedback text must be redacted.
3. Confirm whether feedback resolves the current request, opens a replacement request, or
   leaves plan review pending. Preserve both old and new request IDs if replacement occurs.

**Expected fixtures:** `agent-host-plan-approve.json` and
`agent-host-plan-feedback.json`, each with complete truth. Feedback is not observed unless
the structural outcome is distinguishable without retaining its text.

### 7. Elicitation: pending form, pending URL, decline versus cancel

**Prerequisite:** A local deterministic MCP server implementing form and URL elicitation.
The URL flow must use localhost and contain no credential material.

**Procedure:**

1. Add an elicitation scenario to T1/T2 and capture the unresolved `InputRequest` or native
   `elicitation2` part while status is `24`.
2. For a form, run accept, decline, and cancel in separate sessions.
3. For URL elicitation, capture before opening localhost, after opening while still
   pending, and after accept/decline/cancel.
4. Preserve only request kind, response presence/kind, state enum, and correlation IDs.

**Expected fixtures:** At minimum one pending form and one pending URL lifecycle. Decline
and cancel become separate observations only if the production response or terminal
outcome distinguishes them.

### 8. Modified-files review: waiting, approve, reject

**Prerequisite:** A real tool that emits a waiting confirmation carrying
`modifiedFilesConfirmation`; ordinary chat edits and the generic Keep/Undo editing state
do not qualify.

**Procedure:**

1. Locate the owning tool/provider from the installed VS Code source anchors before
   attempting capture.
2. Run it only in a disposable repository with a trivial generated file.
3. Use passive Agent Host capture and native journal capture together.
4. Capture the waiting confirmation kind and same tool-call ID through approve and reject
   in separate sessions.
5. Verify that the review actually blocks the active request; modified files alone must
   not be classified as input.

**Expected fixtures:** Waiting/approve and waiting/reject with authoritative status or
visible UI truth. If confirmation-kind metadata is not exported, retain the family as
unsupported rather than inferring it from file changes.

### 9. Feedback review: waiting, approve, reject

**Prerequisite:** A provider/tool that emits
`agentFeedbackReviewConfirmation`. Do not synthesize that metadata in a fixture.

**Procedure:**

1. Locate the production path and induction trigger from the installed source or provider
   documentation.
2. Attach the passive recorder before invoking it.
3. Capture the explicit waiting confirmation and status `24`.
4. Approve and reject in separate sessions, preserving blocker identity and redacting all
   feedback content.

**Expected fixtures:** Waiting/approve and waiting/reject. If no installed provider can
emit this state, document the provider dependency and leave it unsupported.

## Manifest and documentation updates

For each successful capture:

1. Add the fixture and exact `sources`/`observed` IDs to `manifest.json`.
2. Move only proven outcomes from `unsupported` to `observed`; change family status from
   `unsupported` to `partial` when the first real outcome lands.
3. Add measurements only when both records have real source timestamps and a stable
   correlation path.
4. Update `docs/vscode-human-input-evidence.md` with ordered evidence, truth source,
   persistence behavior, and remaining limits.
5. Add a focused structural assertion when an outcome needs more than generic manifest
   accounting. Protocol fixtures are automatically included by the manifest-driven parity
   test.
6. Re-run sanitization, parity, the full suite, and `git diff --check`.

The backlog is complete only when every currently unsupported outcome is either backed by
real evidence or has a recorded, current upstream/provider limitation showing why no
production capture is possible.
