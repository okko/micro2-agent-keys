# VS Code human-input evidence completion ledger

This closes the evidence backlog for Visual Studio Code 1.131.0, commit
`d0fd3324a737f695bd14f2aee3ca92accd28870f`. Every outcome in
`test/fixtures/vscode-human-input/manifest.json` is either backed by sanitized production
evidence or retained as unsupported with a current installed-source/provider limitation.
No fixture in this corpus is synthetic.

## Evidence rules

1. A waiting claim requires production state: Agent Host status `24`, an active turn, and
   the matching unresolved blocker; native Chat requires persisted unresolved structure
   plus visibly blocking UI.
2. Resolution requires stable request, turn, tool-call, or resolve identity. Labels and
   elapsed time are not outcomes.
3. Prompts, answers, commands, URLs, paths, credentials, tokens, account names, private
   content, and absolute timestamps never enter committed fixtures.
4. Reducer or type support proves only that a consumer understands a state. It is not
   production evidence that an installed provider emits it.
5. Unsupported outcomes remain fail-closed until a newer build or provider supplies a
   real, externally distinguishable path.

## Completed production captures

| Backlog area | Evidence completed in this build |
|---|---|
| Recorder | passive session attachment, generalized blocker predicates, safe action/state trimming, terminal cancellation truth |
| Native questions | real submit and Skip lifecycles |
| Agent Host questions | real submit and cancel lifecycles |
| Plan review | real reject, approve, feedback, replacement wait, and replacement approval |
| Modified-files review | real waiting, approve, and reject |
| Feedback review | real waiting, approve, and reject |
| Elicitation | real form decline, URL decline, and URL turn cancellation; corrected MCP `2025-11-25` URL negotiation |
| Authentication | disposable OAuth/MCP provider plus real `expired` auth-required wait and turn cancellation |

Form and URL evidence came from a deterministic local MCP server. Authentication used a
separate disposable OAuth/MCP server with dynamic registration, PKCE, resource indicators,
short-lived in-memory tokens, and read/step-up scopes. No token, callback data, identity,
or authorization material was retained.

## Remaining unsupported outcomes

These are the exact remaining manifest IDs and their installed-build limitations.

| Manifest outcome | VS Code 1.131.0 limitation |
|---|---|
| `pre-tool-approval.edit-and-approve` | `editedToolInput` occurs only in the `chat/toolCallConfirmed` reducer. The installed workbench has no producer that dispatches it and no post-edit waiting state. |
| `pre-tool-approval.agent-host-edit-outcome` | The reducer replaces `toolInput` and then uses the ordinary running/completed path. No edited outcome enum or durable marker distinguishes it from direct approval. |
| `post-tool-approval.pending-result-confirmation` | `requiresResultConfirmation` occurs only in the `chat/toolCallComplete` reducer. No installed provider emits that flag. Existing modified-files and feedback fixtures are pre-tool `pending-confirmation`, not result review. |
| `post-tool-approval.approve` | `chat/toolCallResultConfirmed` is registered and reduced, but no installed UI/provider dispatches it because no result-confirmation producer exists. |
| `post-tool-approval.reject` | Same missing producer as approval; reducer capability is not an observable rejection path. |
| `authentication.missing-auth` | The disposable provider reached a real auth-required wait only as reason `expired`; this does not establish the default `required` case. The installed authentication action could not be entered from that state. |
| `authentication.insufficient-scope` | Installed Agent Host maps an `upscope` challenge to `insufficientScope`, but reaching it requires successful initial authentication, which the available UI path could not start. |
| `authentication.authenticate` | The tool-card Authenticate control was inert. The documented `MCP: List Servers` route exposed no Authenticate action. Installed `authenticateMcpServer` returns without interaction unless server-management state is `authRequired`, while the real Agent Host tool was already waiting in `auth-required`. |
| `confirmation-part.waiting` | The build contains a native confirmation renderer/consumer, but no installed provider or command exposed a reproducible production confirmation wait. Only a final historical `isUsed: true` record was available. |
| `confirmation-part.selected-button` | Native persistence records generic `isUsed` resolution without a selected button ID/index or outcome enum. |
| `confirmation-part.cancel` | Native persistence has no distinct confirmation cancel value; dismissal and other terminal navigation cannot be separated from the available record. |
| `questions.native-cancel` | Native `questionCarousel` persistence retains `allowSkip`, answer data, and `isUsed`, but no cancellation enum. Closing/canceling cannot be distinguished from an unrecorded dismissal. |
| `questions.agent-host-skip` | Installed Agent Host/workbench producers use accept, decline, and cancel responses; there is no Skip response or producer. Native `allowSkip` does not transfer to Agent Host input requests. |

The authentication fixture is deliberately labeled `expired`, not missing-auth. Its
status `24 -> 1`, correlated `chat/turnCancelled`, and terminal canceled tool prove a real
auth wait/cancel lifecycle only.

## Reopen criteria

Reopen an unsupported row only after upgrading VS Code or installing a production
provider that changes its prerequisite. Before promotion:

1. Verify the producer in the exact installed build rather than relying on a reducer or
   public type.
2. Capture the real waiting and outcome states through native or Agent Host production
   surfaces.
3. Sanitize with `scripts/capture-vscode-fixture.mjs` and inspect the result for private
   material.
4. Add manifest accounting, a focused structural assertion, and protocol parity where
   applicable.
5. Run the focused fixture tests, full `npm test`, `git diff --check`, and a final privacy
   scan.

Until those criteria are met, this ledger is complete for VS Code 1.131.0.