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

### Option 2: Observe live Agent Host Protocol state

AHP exposes a session catalog, exact chat resources, complete state snapshots, ordered
actions, and reconnect replay outside the renderer. The protocol package maintains the
state; AgentKeys projects it into key states, including non-rendered sessions.

### Decision

Use AHP exclusively for discovery and state; sessions not exposed through AHP are unsupported.
Do not use DOM elements, CSS classes, or toolbar visibility as production state inputs.
Background-session coverage remains a hard requirement.

Model the desired behavior using VS Code's semantic distinction:

```text
active = equivalent to ChatModel.hasActiveRequest
busy = equivalent to ChatModel.requestInProgress
needsHumanInput = active && !busy && an unresolved human-input blocker exists
```

The implementation does not claim direct access to those internal model properties. It
derives their relevant behavior from protocol state and fails closed as
`error` when VS Code reports a waiting state whose response form is unknown.

### Outcome

The chosen architecture is implemented in `src/agent-host.ts`, `src/vscode.ts`,
`src/vscode-chat-state.ts`, and `src/session-url.ts`. Bound sessions remain observable
when their widget is hidden, and protocol snapshots restore blockers after restart.
Exact opening uses the advertised host identity in the project-window `session` URL.
See [integration details](vscode-integration-details.md) for the contract and upstream
source anchors.

The cost is a larger compatibility surface than a CSS observer. The project contains
fixture-driven lifecycle tests, fail-closed handling for unknown waiting forms, and a
monthly installed-bundle structural verifier to detect changed VS Code contracts. DOM
observation was not implemented because its one-container-per-widget scope cannot
represent the concurrent background sessions that the physical keys are intended to
surface.