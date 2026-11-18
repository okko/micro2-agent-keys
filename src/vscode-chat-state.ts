export type RequestOutcome = 'complete' | 'cancelled' | 'failed';
export type HumanInputOutcome = 'resolved' | 'cancelled' | 'failed';
export type HumanInputBlockerKind =
  | 'tool-confirmation' | 'tool-result-confirmation' | 'tool-authentication'
  | 'question' | 'plan-review' | 'elicitation';

export interface HumanInputBlocker {
  id: string;
  requestId: string;
  responsePartKind: string;
  sourceId: string;
  kind: HumanInputBlockerKind;
}

export type ExecutionIncompatibility =
  | { code: 'unknown-agent-host-tool-status'; source: 'agent-host'; responsePartKind: 'toolCall'; toolStatus: string }
  | { code: 'unknown-agent-host-response'; source: 'agent-host'; responsePartKind: string; chatStatus: string };

export interface ChatExecutionSnapshot {
  requestId: string | null;
  active: boolean;
  busy: boolean;
  needsInput: boolean;
  blockers: Map<string, HumanInputBlocker>;
  observedToolCallIds: Set<string>;
  terminal: RequestOutcome | null;
  incompatibilities: ExecutionIncompatibility[];
}

export interface RunState {
  error: string | null;
  requestId: string | null;
  active: boolean;
  blockers: Map<string, HumanInputBlocker>;
  terminal: RequestOutcome | null;
}

export function emptyRun(): RunState {
  return { error: null, requestId: null, active: false, blockers: new Map(), terminal: null };
}

export type NormalizedExecutionEvent =
  | { type: 'request.started'; requestId: string }
  | { type: 'human-input.opened'; requestId: string; blockerId: string; kind: HumanInputBlockerKind;
      responsePartKind?: string; sourceId?: string }
  | { type: 'human-input.closed'; requestId: string; blockerId: string; outcome: HumanInputOutcome }
  | { type: 'request.incompatible'; requestId: string; code: ExecutionIncompatibility['code'] }
  | { type: 'request.finished'; requestId: string; outcome: RequestOutcome };

export function runState(run: RunState): string {
  if (run.error || run.terminal === 'failed') return 'error';
  if (run.blockers.size > 0) return 'input';
  if (run.active) return 'running';
  if (run.terminal) return 'done';
  return 'idle';
}

export function reduceNormalizedEvent(run: RunState, event: NormalizedExecutionEvent): string {
  if (event.type === 'request.started') {
    if (run.requestId !== event.requestId) run.blockers.clear();
    run.requestId = event.requestId;
    run.active = true;
    run.terminal = null;
    run.error = null;
  } else if (event.type === 'human-input.opened') {
    if (run.requestId === event.requestId && run.active) {
      run.blockers.set(event.blockerId, {
        id: event.blockerId, requestId: event.requestId, kind: event.kind,
        responsePartKind: event.responsePartKind ?? event.kind,
        sourceId: event.sourceId ?? event.blockerId,
      });
    }
  } else if (event.type === 'human-input.closed') {
    if (run.requestId === event.requestId) run.blockers.delete(event.blockerId);
  } else if (event.type === 'request.incompatible') {
    if (run.requestId === event.requestId) run.error = `incompatible:${event.code}`;
  } else if (run.requestId === event.requestId) {
    run.active = false;
    run.blockers.clear();
    run.terminal = event.outcome;
    if (event.outcome === 'failed') run.error = 'request.failed';
  }
  return runState(run);
}

export interface SnapshotEventOptions {
  restarted?: boolean;
  incompatibilities?: readonly NormalizedExecutionEvent[];
  reportTerminal?: boolean;
}

export function snapshotEvents(
  run: RunState, current: ChatExecutionSnapshot, options: SnapshotEventOptions = {}
): NormalizedExecutionEvent[] {
  const events: NormalizedExecutionEvent[] = [];
  const requestId = current.requestId;
  if (!requestId) return events;
  if (run.requestId !== requestId || options.restarted) events.push({ type: 'request.started', requestId });
  for (const blocker of run.blockers.values()) {
    if (blocker.requestId === requestId && !current.blockers.has(blocker.id)) {
      events.push({ type: 'human-input.closed', requestId, blockerId: blocker.id, outcome: 'resolved' });
    }
  }
  for (const blocker of current.blockers.values()) {
    events.push({
      type: 'human-input.opened', requestId, blockerId: blocker.id, kind: blocker.kind,
      responsePartKind: blocker.responsePartKind, sourceId: blocker.sourceId,
    });
  }
  events.push(...(options.incompatibilities ?? []));
  if (current.terminal && (options.reportTerminal ?? true)) {
    events.push({ type: 'request.finished', requestId, outcome: current.terminal });
  }
  return events;
}

function blockerIdentity(requestId: string, partKind: string, sourceId: string): string {
  return `${requestId}:${partKind}:${sourceId}`;
}

function diagnosticToken(value: unknown): string {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return Array.isArray(value) ? 'array' : typeof value;
  }
  const token = String(value);
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(token) ? token : 'invalid';
}

interface AgentHostInputRequestPart {
  kind?: unknown;
  request?: { id?: unknown; planReview?: unknown; purpose?: unknown };
  response?: unknown;
}

interface AgentHostToolCallPart {
  kind?: unknown;
  toolCall?: {
    toolCallId?: unknown;
    status?: unknown;
    _meta?: { autoApproveBySetting?: unknown };
  };
}

interface AgentHostTurn {
  id?: unknown;
  state?: unknown;
  responseParts?: unknown;
}

interface AgentHostChatState {
  status?: unknown;
  activeTurn?: AgentHostTurn;
  turns?: AgentHostTurn[];
}

const KNOWN_AGENT_HOST_TOOL_STATUSES = new Set([
  'streaming', 'pending-confirmation', 'pending-result-confirmation',
  'auth-required', 'running', 'completed', 'cancelled',
]);

function agentHostInputKind(request: AgentHostInputRequestPart['request']): HumanInputBlockerKind {
  if (request && 'planReview' in request) return 'plan-review';
  if (request?.purpose === 'planReview') return 'plan-review';
  if (request?.purpose === 'elicitation') return 'elicitation';
  return 'question';
}

function agentHostTerminal(turn: AgentHostTurn | undefined): RequestOutcome | null {
  if (!turn) return null;
  if (turn.state === 'failed' || turn.state === 'error') return 'failed';
  if (turn.state === 'cancelled' || turn.state === 'canceled') return 'cancelled';
  return 'complete';
}

/** Projects reducer-maintained AHP chat state into the keyboard's execution states. */
export class AgentHostChatProjection {
  private state: AgentHostChatState | null = null;

  reset(): void { this.state = null; }

  apply(state: unknown): void {
    this.state = state && typeof state === 'object' ? state as AgentHostChatState : null;
  }

  snapshot(): ChatExecutionSnapshot {
    const activeTurn = this.state?.activeTurn;
    const latestTurn = activeTurn ?? this.state?.turns?.at(-1);
    const requestId = typeof latestTurn?.id === 'string' ? latestTurn.id : null;
    const blockers = new Map<string, HumanInputBlocker>();
    const observedToolCallIds = new Set<string>();
    const incompatibilities: ExecutionIncompatibility[] = [];
    if (activeTurn && requestId && Array.isArray(activeTurn.responseParts)) {
      for (let index = 0; index < activeTurn.responseParts.length; index++) {
        const part = activeTurn.responseParts[index];
        if (!part || typeof part !== 'object') continue;
        const partKind = (part as { kind?: unknown }).kind;
        if (partKind === 'inputRequest') {
          const input = part as AgentHostInputRequestPart;
          if (input.response !== undefined) continue;
          const sourceId = typeof input.request?.id === 'string' ? input.request.id : `position-${index}`;
          const id = blockerIdentity(requestId, 'inputRequest', sourceId);
          blockers.set(id, {
            id, requestId, responsePartKind: 'inputRequest', sourceId, kind: agentHostInputKind(input.request),
          });
          continue;
        }
        if (partKind !== 'toolCall') continue;
        const toolCall = (part as AgentHostToolCallPart).toolCall;
        const sourceId = typeof toolCall?.toolCallId === 'string' ? toolCall.toolCallId : `position-${index}`;
        if (typeof toolCall?.toolCallId === 'string') observedToolCallIds.add(toolCall.toolCallId);
        let kind: HumanInputBlockerKind | null = null;
        if (toolCall?.status === 'pending-confirmation' && toolCall._meta?.autoApproveBySetting !== true) {
          kind = 'tool-confirmation';
        } else if (toolCall?.status === 'pending-result-confirmation') {
          kind = 'tool-result-confirmation';
        } else if (toolCall?.status === 'auth-required') {
          kind = 'tool-authentication';
        }
        if (!KNOWN_AGENT_HOST_TOOL_STATUSES.has(String(toolCall?.status))) {
          incompatibilities.push({
            code: 'unknown-agent-host-tool-status', source: 'agent-host', responsePartKind: 'toolCall',
            toolStatus: diagnosticToken(toolCall?.status),
          });
        }
        if (!kind) continue;
        const id = blockerIdentity(requestId, 'toolCall', sourceId);
        blockers.set(id, { id, requestId, responsePartKind: 'toolCall', sourceId, kind });
      }
    }
    const executionStatus = typeof this.state?.status === 'number' ? this.state.status & 31 : null;
    if (activeTurn && executionStatus === 24 && blockers.size === 0 && incompatibilities.length === 0) {
      const responseParts = Array.isArray(activeTurn.responseParts) ? activeTurn.responseParts : [];
      const unknownPart = responseParts.find((part) => {
        if (!part || typeof part !== 'object') return true;
        const kind = (part as { kind?: unknown }).kind;
        return kind !== 'inputRequest' && kind !== 'toolCall';
      });
      incompatibilities.push({
        code: 'unknown-agent-host-response', source: 'agent-host',
        responsePartKind: diagnosticToken(
          unknownPart && typeof unknownPart === 'object' ? (unknownPart as { kind?: unknown }).kind : undefined
        ),
        chatStatus: diagnosticToken(this.state?.status),
      });
    }
    const terminal = activeTurn ? null : agentHostTerminal(latestTurn);
    const active = Boolean(activeTurn);
    return {
      requestId, active, busy: active && blockers.size === 0 && incompatibilities.length === 0,
      needsInput: Boolean(activeTurn && executionStatus === 24),
      blockers, observedToolCallIds, terminal, incompatibilities,
    };
  }
}
