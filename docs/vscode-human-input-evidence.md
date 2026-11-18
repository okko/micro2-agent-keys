# VS Code human-input evidence

The AHP fixtures were captured from Visual Studio Code 1.131.0, commit
`d0fd3324a737f695bd14f2aee3ca92accd28870f`. The 14 fixtures under
`test/fixtures/vscode-human-input/` contain protocol snapshots and correlated actions.
They retain structural states, enum outcomes, relative timing, and stable pseudonyms.
Prompts, answers, commands, URLs, paths, credentials, tokens, account names, private
content, and absolute timestamps are redacted.

The manifest identifies observed outcomes and coverage gaps for that build. These
records are not empirical proof for other VS Code versions. Unknown waiting forms
fail closed; synthetic unit tests exercise additional protocol shapes but do not
count as production evidence.

## Capture and validation

Record a live AHP lifecycle:

```sh
npm run dev:capture:vscode-ahp-lifecycle -- \
  --output "$TMPDIR/agentkeys-lifecycle.jsonl" \
  --scenario <name>
```

The recorder supports isolated scenarios and `--session <uuid>` attachment.
Isolated scenarios create a session and invoke a model. Use `--no-resolve` for passive
attachment; otherwise the selected resolution can answer or cancel the live blocker.
It correlates actions by request, turn, or tool ID and treats terminal state as
authoritative when cancellation leaves an unresolved-looking response part.

Sanitize the recorded protocol stream:

```sh
npm run dev:capture:vscode-fixture -- \
  --session <uuid> \
  --agent-host-protocol "$TMPDIR/agentkeys-lifecycle.jsonl" \
  --output <fixture.json>
```

Use `--agent-host-protocol-lines` to select exact source lines and `--vscode-package`
to identify the build that produced the capture. Missing or malformed input fails
explicitly. Record the source commit in the manifest when adding evidence.

Fixture tests reject home paths, file URIs, raw UUIDs, long opaque tokens, absolute
timestamps, and files over 100 KB. They recompute all 15 manifest measurements from
the referenced protocol records. Retained records preserve their original source-line
numbers, capture-relative offsets, pseudonyms, and build provenance; selecting records
does not rebase their timestamps or relabel their build.

## Observed lifecycles

| Family | Protocol evidence | Outcomes |
|---|---|---|
| Questions | unresolved input, status `24`, followed by resolution and terminal state | submit and cancel |
| Plan review | `request.planReview` with correlated input responses | reject, approve, feedback, replacement approval |
| Pre-tool approval | `pending-confirmation` followed by a cancelled tool and resumed turn | deny |
| Modified-files review | `modifiedFilesConfirmation` with correlated confirmation action | approve and reject |
| Feedback review | `agentFeedbackReviewConfirmation` with correlated confirmation action | approve and reject |
| Form elicitation | unresolved input followed by a decline response | decline |
| URL elicitation | redacted URL request followed by response or turn cancellation | decline and cancel |
| Authentication | `auth-required` tool with reason `expired` followed by turn cancellation | expired-auth cancel |

AHP execution bits are interpreted independently of AgentKeys: `24` means waiting
for input, `8` means an active running turn, and `1` means terminal/inactive. Waiting
also requires the expected unresolved input request or tool blocker. Timing and tool
names alone never establish a blocker.

Turn cancellation can transition directly from status `24` to terminal status `1`.
Input parts can remain unresolved-looking after cancellation; correlated cancellation
actions and terminal turn/tool state are authoritative.

## Coverage limits

The manifest's `unsupported` entries mean outcomes not covered by this production
corpus, not necessarily outcomes the runtime cannot project.

- Pre-tool evidence covers denial, not general terminal/network approvals,
  confirmation-not-needed, or edit-and-approve.
- Post-tool result confirmation has protocol/reducer tests but no production capture.
- Authentication evidence covers the `expired` reason and cancellation, not missing
  credentials, insufficient scope, refresh, or successful authentication.
- Questions cover submit and cancel, not Skip.
- Elicitation covers form/URL decline and URL cancellation, not acceptance.
- Waiting UI restoration across a VS Code window reload was not captured.
- Protocol status and blocker structure are captured; visual rendering was not
  separately screen-captured.

Do not infer missing outcomes from elapsed time, labels, tool names, reducer capability,
or a neighboring outcome. Capture real production evidence when a producer becomes
available or changes semantics, and retain its actual build identity.
