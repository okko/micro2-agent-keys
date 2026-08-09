# Verifying a VS Code update

VS Code ships monthly. AgentKeys does not require a repository update for every VS Code
release: runtime tracking is version-independent and unknown waiting states fail closed.
Run one read-only command after VS Code updates to check that the installed build still
contains every protocol and persistence marker AgentKeys consumes. This is a structural
smoke test: it does not prove unchanged semantics or detect a new producer that reuses an
existing marker.

## Monthly workflow

From the repository root, run:

```sh
npm run verify:vscode-update
```

That command performs the complete routine check. It does not access the keyboard,
restart the daemon, modify fixtures, create chat sessions, invoke a model, or require UI
interaction.

The verifier exits nonzero as soon as a structural check fails. A successful run ends
with:

```text
VS Code update structural verification passed.
Runtime contract markers: present in <installed-version>
```

A passing command means no consumed marker disappeared and the existing projection and
evidence tests remain green. It does not by itself establish semantic compatibility for a
different build.

## What the command checks

### 1. Installed build identity

The verifier locates VS Code Stable, falling back to VS Code Insiders, and reads the
version and commit from the installed application's `package.json`. This identifies the
actual build being checked rather than relying on the command-line launcher or an update
channel label.

To check a nonstandard installation explicitly:

```sh
npm run verify:vscode-update -- --app "/path/to/Visual Studio Code.app"
```

Automation may set `VSCODE_APP` instead. An explicit `--app` argument takes precedence.

### 2. Installed bundle contracts

The verifier reads the installed workbench and Agent Host bundles and requires the
structural tokens used by AgentKeys. These cover:

- native question, elicitation, and serialized tool response parts;
- Agent Host waiting statuses: `pending-confirmation`,
  `pending-result-confirmation`, and `auth-required`;
- input, tool-confirmation, result-confirmation, authentication, and turn-cancellation
  actions;
- edit-and-approve, result-review, and insufficient-scope contract fields.

A missing token means VS Code changed or removed a consumed contract. The command names
the bundle and every missing token. Do not delete the check merely to make the verifier
green; follow the failure procedure below.

Token presence cannot establish how a contract is produced or consumed. In particular,
the verifier cannot detect when an existing reducer-only field gains a new UI/provider
producer. Review source or capture production evidence when release notes, a provider
update, or observed UI behavior indicates such a change.

### 3. AgentKeys build and tests

The command runs the full `npm test` suite. This compiles TypeScript and checks native
and Agent Host projections, blocker identity, fail-closed behavior, restart handling,
captured-protocol parity, fixture structure, and the local MCP evidence providers.

`--skip-tests` exists only to develop the verifier itself. A run using it is not a
complete verification result.

### 4. Fixture privacy and provenance

Every manifest fixture is checked again for its size and for retained home paths, file
URIs, raw UUIDs, timestamps, authorization material, and token-like values. The summary
also compares the installed build with the build recorded by the evidence manifest.

Production fixtures are immutable evidence. The verifier never rewrites their
`vscodeVersion`, IDs, timestamps, or manifest provenance.

## Evidence-version messages

When the installed build exactly matches the evidence build, the verifier reports:

```text
Evidence corpus: current for this exact build
```

After an ordinary monthly update it will usually report:

```text
Evidence corpus: pinned to <evidence-version>; retained as historical production evidence
No fixture provenance was rewritten. Recapture only when adding empirical coverage.
Structural probes do not detect semantic changes or newly available producer paths.
```

This is informational, not a compatibility failure. Existing fixtures prove behavior on
the build that produced them; changing their version without new production capture
would make the evidence false. Installed-bundle probes and the full test suite establish
structural continuity, not semantic equivalence with the evidence build.

## When verification fails

### VS Code cannot be found

Pass the application path with `--app`. Verify that the path is the `.app` bundle, not
the `code` launcher or an executable inside the bundle.

### Installed metadata cannot be read

Confirm that the application is a complete VS Code installation and that
`Contents/Resources/app/package.json` is readable. A partial update should be completed
or reinstalled before AgentKeys compatibility is assessed.

### A bundle or contract token is missing

Treat this as a real compatibility investigation:

1. Record the installed version and commit printed by the verifier.
2. Inspect the owning source anchors listed in `docs/vscode-plan.md`: native chat model
   state, tool invocation state, `chatAwaitsUserInput`, Agent Host input/tool state, and
   native chat persistence.
3. Determine whether the contract was renamed, moved, removed, or semantically changed.
4. Update `src/vscode-chat-state.ts`, `src/vscode-session-files.ts`, `src/vscode.ts`, or
   `src/agent-host.ts` only if the
   production contract changed.
5. Add a focused synthetic unit test for the new shape while preserving fail-closed
   handling for unknown states.
6. If a new externally observable human-input state exists, capture real sanitized
   production evidence with the existing capture scripts. Never manufacture or relabel a
   fixture.
7. Add or update the required contract token in
   `scripts/dev/verify-vscode-update.mjs`, then rerun the one-command verifier.

Contract-preserving moves may require only updating the bundle path or token probe.
Semantic changes require projection code and tests before compatibility can be claimed.

### Tests fail

Use the first failing test as the compatibility boundary. Fix only the affected runtime
or fixture contract, run that focused test, then rerun `npm run verify:vscode-update`.
Do not update fixture version fields to satisfy a version assertion; real evidence must
retain its source build.

### Fixture privacy fails

Do not hand-edit private material into a placeholder. Delete the unsafe generated
fixture, correct the sanitizer or capture selection, and recapture from the raw record
outside the repository. The fixture tests and monthly verifier must both pass before the
new evidence is retained.

## When new evidence is required

Routine monthly verification does not require recapturing every production interaction.
Capture new evidence only when a release introduces a new blocker shape, changes an
outcome that AgentKeys distinguishes, makes a previously unsupported provider path
available, or invalidates an existing source-contract assumption.

The structural verifier cannot discover all of those changes when existing tokens remain
in the bundles. Treat release notes, changed interaction UI, newly installed providers,
and unexpected key state as independent triggers for the source-review and capture steps
above.

For such a change, keep old fixtures under their original VS Code version and add a new
versioned evidence set or deliberately migrate the manifest only with complete fresh
coverage. The capture commands and evidence rules are documented in
`docs/vscode-human-input-evidence.md`; the limitations of the current evidence build are
recorded in `docs/archive-do-not-edit/vscode-plan-gaps-todo.md`.