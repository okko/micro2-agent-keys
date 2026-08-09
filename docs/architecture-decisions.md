# Architecture decisions

## ADR-001: Observe VS Code chat state through exported contracts, not UI CSS

- **Status:** Accepted
- **Decision date:** 2026-08-04

### Context

AgentKeys must map each bound VS Code chat session to a physical key and keep its color
in sync with the session state: `idle`, `running`, `input`, `done`, or `error`. The
important distinction is whether the latest request is still active but cannot continue
without human input. The result must work across multiple VS Code windows, for sessions
that are not currently visible, and after either the daemon or VS Code restarts.

Showing simultaneous background-session status is the core purpose of the VS Code
integration. A user should be able to continue working in one visible chat while the
physical keys report which other sessions are running, waiting for input, completed, or
failed. An observation method that covers only the selected or rendered session cannot
implement the product concept, even if its foreground signal is accurate.

VS Code's chat input is rendered by `ChatInputPart`. Its outlined DOM element uses the
`.chat-input-container` class and gains `.working` while the visible chat is actively
working. The execute toolbar also presents a Stop button while the chat model still has
an active request. This suggested two possible observation architectures.

The decision was evaluated against these requirements:

- identify the exact session rather than only the visible chat widget;
- observe background, hidden, and multi-window sessions;
- distinguish human-input waits from running and terminal outcomes;
- recover state after process restarts;
- avoid patching or injecting code into VS Code's renderer;
- keep polling at or above 100 ms and avoid unnecessary CPU and battery use;
- fail closed when a new waiting-state contract is not understood.

### Option 1: Observe the chat input DOM and CSS classes

Code running inside the workbench renderer could use a `MutationObserver` to inspect
`.chat-input-container.working` and the presence of the Stop button. For the currently
rendered chat, the signals approximately map as follows:

| `.working` | Stop button | Approximate state |
|---|---|---|
| Present | Either | `running` |
| Absent | Present | `input` or another active pause |
| Absent | Absent | inactive or terminal |

This option is visually direct and could report foreground transitions with low latency.
It is not sufficient as the primary state source:

- the daemon and ordinary extensions cannot access the workbench DOM;
- gaining access would require VS Code patching, renderer injection, or a debugging
  protocol, adding deployment and compatibility risk;
- VS Code creates a `.chat-input-container` per instantiated `ChatWidget`, not per chat
  session;
- the normal Chat view owns one widget and one input container, then calls
  `ChatWidget.setModel()` to rebind that same widget when the user selects another
  session;
- the rebind clears listeners for the outgoing session, so its model may continue
  running in the background without updating that widget's `.working` class;
- additional containers can exist for visible or retained Chat editors, editor groups,
  or VS Code windows, but their existence and lifetime follow UI layout rather than the
  set of running sessions;
- consequently, DOM observation cannot enumerate or continuously observe all concurrent
  background sessions, which directly conflicts with AgentKeys' core purpose;
- the element does not provide the stable session identity needed to select a key;
- inactive, completed, cancelled, and failed sessions collapse into the same visible
  result;
- Stop-button visibility also depends on UI context, and `.working` is a presentation
  contract affected by progress and motion behavior rather than a supported state API;
- DOM structure and CSS class names are private implementation details that may change
  without a protocol or persistence migration path.

DOM observation therefore cannot implement background-session status, provide restart
recovery, or establish all five key states. It remains a possible diagnostic or
foreground-only corroborating signal, but it is not an alternative runtime architecture
for AgentKeys and runtime correctness must not depend on it.

### Option 2: Observe persisted state, hooks, and live protocol snapshots

The daemon can reconstruct state from interfaces that preserve session identity and are
available outside the renderer:

- native Chat transcripts identify prompts, requests, tools, errors, and session IDs;
- the native chat-session journal records the latest request, response parts,
  confirmations, completion, and unresolved blockers;
- preview hooks provide timely native question, permission, and lifecycle transitions
  when persisted writes lag;
- Agent Host persisted events support discovery and replay;
- complete live Agent Host Protocol snapshots provide the authoritative current Agent
  Host state without reimplementing its reducer.

These sources require a typed projection and compatibility checks, so they are more
complex than reading one CSS class. In return, they cover non-rendered sessions, retain
stable identities, survive restarts, distinguish outcomes, and expose unknown shapes
that can be handled explicitly.

### Decision

Use persisted transcript and journal records, low-latency hooks, and live Agent Host
Protocol snapshots as the VS Code observation architecture. Treat journal or protocol
state as authoritative; hooks may make a transition timely but must be reconciled with
an authoritative snapshot. Do not use DOM elements, CSS classes, or toolbar visibility
as production state inputs. Background-session coverage is a hard architectural
requirement, not a desirable extension to foreground observation.

Model the desired behavior using VS Code's semantic distinction:

```text
active = equivalent to ChatModel.hasActiveRequest
busy = equivalent to ChatModel.requestInProgress
needsHumanInput = active && !busy && an unresolved human-input blocker exists
```

The implementation does not claim direct access to those internal model properties. It
derives their relevant behavior from externally observable records and fails closed as
`error` when VS Code reports a waiting state whose response form is unknown.

### Outcome

The chosen architecture is implemented in `src/vscode.ts`, `src/vscode-chat-state.ts`,
`src/vscode-session-files.ts`, `src/vscode-app.ts`, and `src/vscode-hook.ts`. Native Chat
uses a journal projection plus transcript and hook
correlation. Agent Host uses persisted events for discovery and recovery and complete
protocol snapshots for live state. Bound sessions remain observable when their chat
widget is hidden, and unresolved blockers can be reconstructed after restart.

The cost is a larger compatibility surface than a CSS observer. The project contains
fixture-driven lifecycle tests, fail-closed handling for unknown waiting forms, and a
monthly installed-bundle structural verifier to detect changed VS Code contracts. DOM
observation was not implemented because its one-container-per-widget scope cannot
represent the concurrent background sessions that the physical keys are intended to
surface.