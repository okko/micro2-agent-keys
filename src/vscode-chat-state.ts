import * as path from 'path';

export const SOURCE_COPILOT_CLI = 'copilot-cli' as const;
export const SOURCE_NATIVE = 'native' as const;
export type SessionSource = typeof SOURCE_COPILOT_CLI | typeof SOURCE_NATIVE;
const SUPPORTED_PRODUCER = 'copilot-agent';
const SUPPORTED_EVENT_VERSION = 1;

/** The event payload shapes actually read from event/journal JSONL files. Every
 * field is optional: lines come from files this process does not control. */
export interface VSCodeEventData {
  hookType?: string;
  toolCallId?: string;
  toolName?: string;
  fromHook?: boolean;
  requestId?: string;
  turnId?: string;
  interactionId?: string;
  producer?: string;
  version?: number;
  copilotVersion?: string;
  sessionId?: string;
  toolRequests?: {
    toolCallId?: string;
    name?: string;
    toolName?: string;
    arguments?: unknown;
  }[];
}

export interface VSCodeEvent {
  type?: string;
  data?: VSCodeEventData;
  timestamp?: string;
}

export interface RunState {
  /** Error latched for the current run until the next prompt. */
  error: string | null;
  /** Latest chat request receiving execution transitions. */
  requestId: string | null;
  /** Whether the latest request can still produce work or input. */
  active: boolean;
  /** Human-input blockers for the latest request, keyed by stable identity. */
  blockers: Map<string, HumanInputBlocker>;
  /** Terminal outcome for the latest request. */
  terminal: RequestOutcome | null;
  /** Assistant turns that have started but not ended. */
  turns: Set<string>;
  /** Currently executing tools, keyed by tool-call ID. */
  activeTools: Map<string, string>;
  /** Question IDs retained even when transcript duplicates are not active tools. */
  knownQuestionToolIds: Set<string>;
  /** Whether hooks have provided question lifecycle events for this run. */
  questionHooksObserved: boolean;
  /** Approval request or tool-call IDs still waiting for permission. */
  pendingPermissionIds: Set<string>;
  /** Terminal tool-call IDs inferred as waiting from authoritative native state. */
  inferredPermissionIds: Set<string>;
  /** Tool-call IDs that have started during the current run. */
  startedToolIds: Set<string>;
  /** Terminal tool-call IDs requested by the assistant but not yet started. */
  unstartedTerminalToolIds: Set<string>;
}

export interface Compatibility {
  producer: string | null;
  eventVersion: number | null;
  copilotVersion: string | null;
  sawPrompt: boolean;
  sawSessionEnd: boolean;
  supported: boolean;
}

export interface Transition {
  run: RunState;
  prompt: boolean;
  state: string | null;
}

function eventKey<K extends keyof VSCodeEventData>(
  data: VSCodeEventData | undefined,
  preferred: K,
  fallback: K
): string | null {
  const value = data?.[preferred] ?? data?.[fallback];
  return typeof value === 'string' ? value : null;
}

function requestsPermission(argumentsValue: unknown, cwd?: string | null): boolean {
  let parsed = argumentsValue;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      return false;
    }
  }
  if (!parsed || typeof parsed !== 'object') return false;
  const options = parsed as Record<string, unknown>;
  if (options.requestUnsandboxedExecution === true || options.requestAllowNetwork === true) return true;
  if (!cwd) return false;

  const paths = [options.filePath, ...(Array.isArray(options.filePaths) ? options.filePaths : [])];
  const root = path.resolve(cwd);
  return paths.some((candidate) => {
    if (typeof candidate !== 'string' || !candidate) return false;
    const relative = path.relative(root, path.resolve(root, candidate));
    return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  });
}

export function nativeHookToolCallId(toolUseId: string): string {
  return toolUseId.replace(/__vscode-\d+$/, '');
}

export function emptyRun(): RunState {
  return {
    error: null,
    requestId: null,
    active: false,
    blockers: new Map(),
    terminal: null,
    turns: new Set(),
    activeTools: new Map(),
    knownQuestionToolIds: new Set(),
    questionHooksObserved: false,
    pendingPermissionIds: new Set(),
    inferredPermissionIds: new Set(),
    startedToolIds: new Set(),
    unstartedTerminalToolIds: new Set(),
  };
}

export function cloneRun(run: RunState): RunState {
  return {
    ...run,
    blockers: new Map([...run.blockers].map(([id, blocker]) => [id, { ...blocker }])),
    turns: new Set(run.turns),
    activeTools: new Map(run.activeTools),
    knownQuestionToolIds: new Set(run.knownQuestionToolIds),
    pendingPermissionIds: new Set(run.pendingPermissionIds),
    inferredPermissionIds: new Set(run.inferredPermissionIds),
    startedToolIds: new Set(run.startedToolIds),
    unstartedTerminalToolIds: new Set(run.unstartedTerminalToolIds),
  };
}

export function emptyCompatibility(): Compatibility {
  return {
    producer: null,
    eventVersion: null,
    copilotVersion: null,
    sawPrompt: false,
    sawSessionEnd: false,
    supported: false,
  };
}

export function updateCompatibility(
  compatibility: Compatibility,
  event: VSCodeEvent,
  source: SessionSource = SOURCE_COPILOT_CLI
): void {
  if (event?.type === 'session.start') {
    compatibility.producer = event.data?.producer ?? null;
    compatibility.eventVersion = event.data?.version ?? null;
    compatibility.copilotVersion = event.data?.copilotVersion ?? null;
    compatibility.supported =
      compatibility.producer === SUPPORTED_PRODUCER &&
      compatibility.eventVersion === SUPPORTED_EVENT_VERSION;
  }
  if (
    (event?.type === 'hook.start' && event.data?.hookType === 'userPromptSubmitted') ||
    event?.type === 'user.message'
  ) {
    compatibility.sawPrompt = true;
  }
  if (
    (event?.type === 'hook.end' && event.data?.hookType === 'sessionEnd') ||
    (source === SOURCE_NATIVE && event?.type === 'request.completed')
  ) {
    compatibility.sawSessionEnd = true;
  }
}

interface NativeModelState {
  value?: unknown;
  completedAt?: number | string;
}

interface NativeRequest {
  requestId?: unknown;
  result?: unknown;
  modelState?: NativeModelState;
  response?: unknown;
}

export interface NativePatch {
  kind?: number;
  k?: (string | number)[];
  v?: unknown;
  i?: number;
}

interface NativeResponsePart {
  kind?: unknown;
  id?: unknown;
  toolCallId?: unknown;
  resolveId?: unknown;
  isConfirmed?: unknown;
  isComplete?: unknown;
  isHidden?: unknown;
  isUsed?: unknown;
  state?: unknown;
  toolSpecificData?: {
    requestUnsandboxedExecution?: unknown;
    requestAllowNetwork?: unknown;
    confirmation?: unknown;
    terminalCommandState?: unknown;
  };
}

interface NativeChatState {
  requests?: NativeRequest[];
}

export type HumanInputBlockerKind =
  | 'tool-confirmation'
  | 'tool-result-confirmation'
  | 'tool-authentication'
  | 'confirmation'
  | 'question'
  | 'plan-review'
  | 'elicitation';

export interface HumanInputBlocker {
  id: string;
  requestId: string;
  responsePartKind: string;
  sourceId: string;
  kind: HumanInputBlockerKind;
}

export interface ChatExecutionSnapshot {
  requestId: string | null;
  active: boolean;
  busy: boolean;
  needsInput: boolean;
  blockers: Map<string, HumanInputBlocker>;
  observedToolCallIds: Set<string>;
  terminal: 'complete' | 'cancelled' | 'failed' | null;
  incompatibilities: ExecutionIncompatibility[];
}

export type RequestOutcome = 'complete' | 'cancelled' | 'failed';
export type HumanInputOutcome = 'resolved' | 'cancelled' | 'failed';
export type ExecutionIncompatibility =
  | {
      code: 'unknown-native-response';
      source: 'native';
      responsePartKind: string;
      stateType: string;
    }
  | {
      code: 'unknown-agent-host-tool-status';
      source: 'agent-host';
      responsePartKind: 'toolCall';
      toolStatus: string;
    }
  | {
      code: 'unknown-agent-host-response';
      source: 'agent-host';
      responsePartKind: string;
      chatStatus: string;
    };

export type NormalizedExecutionEvent =
  | { type: 'request.started'; requestId: string }
  | {
      type: 'human-input.opened';
      requestId: string;
      blockerId: string;
      kind: HumanInputBlockerKind;
      responsePartKind?: string;
      sourceId?: string;
    }
  | {
      type: 'human-input.closed';
      requestId: string;
      blockerId: string;
      outcome: HumanInputOutcome;
    }
  | {
      type: 'request.incompatible';
      requestId: string;
      code: ExecutionIncompatibility['code'];
    }
  | { type: 'request.finished'; requestId: string; outcome: RequestOutcome };

export function runState(run: RunState): string {
  if (run.error || run.terminal === 'failed') return 'error';
  if (run.blockers.size > 0) return 'input';
  if (run.active) return 'running';
  if (run.terminal) return 'done';
  return 'running';
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
        id: event.blockerId,
        requestId: event.requestId,
        responsePartKind: event.responsePartKind ?? String(event.kind),
        sourceId: event.sourceId ?? event.blockerId,
        kind: event.kind,
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
  /** Restarts the run even though the request id is unchanged. */
  restarted?: boolean;
  /** Keeps a blocker open while its hook-reported permission is missing from the snapshot. */
  deferPendingPermissions?: boolean;
  /** Emitted between the blocker events and `request.finished`. */
  incompatibilities?: readonly NormalizedExecutionEvent[];
  /** Set false when the terminal state was already reported. */
  reportTerminal?: boolean;
}

/** Diffs a run against a fresh execution snapshot of the same session. */
export function snapshotEvents(
  run: RunState,
  current: ChatExecutionSnapshot,
  options: SnapshotEventOptions = {}
): NormalizedExecutionEvent[] {
  const events: NormalizedExecutionEvent[] = [];
  const requestId = current.requestId;
  if (!requestId) return events;

  const requestChanged = run.requestId !== requestId;
  if (requestChanged || options.restarted) {
    events.push({ type: 'request.started', requestId });
  }
  for (const blocker of run.blockers.values()) {
    if (blocker.requestId !== requestId) {
      if (
        requestChanged &&
        options.deferPendingPermissions &&
        (
          (
            run.pendingPermissionIds.has(blocker.sourceId) &&
            !current.observedToolCallIds.has(blocker.sourceId)
          ) ||
          (current.needsInput && run.inferredPermissionIds.has(blocker.sourceId))
        )
      ) {
        events.push({
          type: 'human-input.opened',
          requestId,
          blockerId: blockerIdentity(requestId, blocker.responsePartKind, blocker.sourceId),
          kind: blocker.kind,
          responsePartKind: blocker.responsePartKind,
          sourceId: blocker.sourceId,
        });
      }
      continue;
    }
    if (current.blockers.has(blocker.id)) continue;
    if (
      options.deferPendingPermissions &&
      (
        (
          run.pendingPermissionIds.has(blocker.sourceId) &&
          !current.observedToolCallIds.has(blocker.sourceId)
        ) ||
        (current.needsInput && run.inferredPermissionIds.has(blocker.sourceId))
      )
    ) continue;
    if (options.deferPendingPermissions) {
      run.pendingPermissionIds.delete(blocker.sourceId);
      run.inferredPermissionIds.delete(blocker.sourceId);
    }
    events.push({
      type: 'human-input.closed',
      requestId,
      blockerId: blocker.id,
      outcome: 'resolved',
    });
  }
  for (const blocker of current.blockers.values()) {
    events.push({
      type: 'human-input.opened',
      requestId,
      blockerId: blocker.id,
      kind: blocker.kind,
      responsePartKind: blocker.responsePartKind,
      sourceId: blocker.sourceId,
    });
  }
  if (current.needsInput) {
    const blockerSourceIds = new Set([
      ...[...run.blockers.values()].map((blocker) => blocker.sourceId),
      ...[...current.blockers.values()].map((blocker) => blocker.sourceId),
    ]);
    for (const sourceId of run.unstartedTerminalToolIds) {
      if (blockerSourceIds.has(sourceId)) continue;
      run.inferredPermissionIds.add(sourceId);
      events.push({
        type: 'human-input.opened',
        requestId,
        blockerId: blockerIdentity(requestId, 'toolInvocation', sourceId),
        kind: 'tool-confirmation',
        responsePartKind: 'toolInvocation',
        sourceId,
      });
    }
  }
  events.push(...(options.incompatibilities ?? []));
  if (current.terminal && (options.reportTerminal ?? true)) {
    events.push({ type: 'request.finished', requestId, outcome: current.terminal });
  }
  return events;
}

function objectAtPath(root: unknown, path: (string | number)[]): Record<string | number, unknown> | null {
  let current = root;
  for (const segment of path) {
    if (!current || typeof current !== 'object') return null;
    current = (current as Record<string | number, unknown>)[segment];
  }
  return current && typeof current === 'object'
    ? current as Record<string | number, unknown>
    : null;
}

function modelStateTerminal(request: NativeRequest): ChatExecutionSnapshot['terminal'] {
  const state = request.modelState?.value;
  if (state === 1) return 'complete';
  if (state === 2) return 'cancelled';
  if (state === 3) return 'failed';
  if (request.result !== undefined) {
    const errorDetails = (request.result as { errorDetails?: { code?: unknown } } | null)?.errorDetails;
    if (errorDetails?.code === 'canceled') return 'cancelled';
    if (errorDetails) return 'failed';
    return 'complete';
  }
  return null;
}

function blockerIdentity(requestId: string, partKind: string, sourceId: string): string {
  return `${requestId}:${partKind}:${sourceId}`;
}

const KNOWN_NATIVE_TOOL_STATE_TYPES = new Set([0, 1, 2, 3, 4, 5, 6]);
const KNOWN_NATIVE_HUMAN_INPUT_PARTS = new Set([
  'confirmation',
  'questionCarousel',
  'planReview',
  'elicitation2',
  'elicitationSerialized',
]);

function isUnknownStateBearingNativePart(part: NativeResponsePart): boolean {
  const partKind = typeof part.kind === 'string' ? part.kind : 'unknown';
  const stateType = (part.state as { type?: unknown } | null)?.type;
  if (typeof part.toolCallId === 'string') {
    return stateType !== undefined &&
      (typeof stateType !== 'number' || !KNOWN_NATIVE_TOOL_STATE_TYPES.has(stateType));
  }
  if (KNOWN_NATIVE_HUMAN_INPUT_PARTS.has(partKind)) return false;
  return part.state !== undefined || part.isUsed === false;
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

function blockerForPart(
  requestId: string,
  part: NativeResponsePart,
  index: number,
  knownToolConfirmationIds: ReadonlySet<string>
): HumanInputBlocker | null {
  const partKind = typeof part.kind === 'string' ? part.kind : 'unknown';
  const toolCallId = typeof part.toolCallId === 'string' ? part.toolCallId : null;
  const stateType = (part.state as { type?: unknown } | null)?.type;
  let kind: HumanInputBlockerKind | null = null;
  let sourceId = typeof part.resolveId === 'string'
    ? part.resolveId
    : typeof part.id === 'string'
      ? part.id
      : `position-${index}`;

  if (toolCallId) {
    sourceId = toolCallId;
    if (stateType === 1) kind = 'tool-confirmation';
    else if (stateType === 3) kind = 'tool-result-confirmation';
    else if (stateType === 6) kind = 'tool-authentication';
    else if (
      part.isConfirmed == null &&
      part.toolSpecificData?.terminalCommandState == null &&
      (
        knownToolConfirmationIds.has(toolCallId) ||
        requestsPermission(part.toolSpecificData) ||
        part.toolSpecificData?.confirmation != null
      )
    ) kind = 'tool-confirmation';
  } else if (partKind === 'confirmation' && !part.isUsed) {
    kind = 'confirmation';
  } else if (partKind === 'questionCarousel' && !part.isUsed) {
    kind = 'question';
  } else if (partKind === 'planReview' && !part.isUsed) {
    kind = 'plan-review';
  } else if (partKind === 'elicitation2') {
    const state = typeof part.state === 'string'
      ? part.state
      : (part.state as { value?: unknown } | null)?.value;
    if (state === 'pending') kind = 'elicitation';
  } else if (partKind === 'elicitationSerialized' && part.isHidden === false) {
    kind = 'elicitation';
  }

  if (!kind) return null;
  const id = blockerIdentity(requestId, partKind, sourceId);
  return { id, requestId, responsePartKind: partKind, sourceId, kind };
}

function isResolvedHumanInputPart(part: NativeResponsePart): boolean {
  const partKind = typeof part.kind === 'string' ? part.kind : 'unknown';
  const state = typeof part.state === 'string'
    ? part.state
    : (part.state as { type?: unknown; value?: unknown } | null);
  const stateType = state && typeof state === 'object' ? state.type : undefined;
  const stateValue = state && typeof state === 'object' ? state.value : state;
  if (typeof part.toolCallId === 'string') {
    return ![1, 3, 6].includes(stateType as number) &&
      (stateType !== undefined || part.isConfirmed != null || part.isComplete === true);
  }
  if (['confirmation', 'questionCarousel', 'planReview'].includes(partKind)) return part.isUsed === true;
  if (partKind === 'elicitationSerialized' && part.isHidden === false) return false;
  return (partKind === 'elicitation2' || partKind === 'elicitationSerialized') &&
    stateValue !== undefined && stateValue !== 'pending';
}

export class NativeChatProjection {
  private state: NativeChatState | null = null;

  reset(): void {
    this.state = null;
  }

  apply(patch: NativePatch): void {
    if (patch.kind === 0) {
      this.state = patch.v && typeof patch.v === 'object' ? patch.v as NativeChatState : null;
      return;
    }
    if (!this.state || !Array.isArray(patch.k) || patch.k.length === 0) return;

    const parent = objectAtPath(this.state, patch.k.slice(0, -1));
    if (!parent) return;
    const key = patch.k.at(-1) as string | number;
    if (patch.kind === 1) {
      parent[key] = patch.v;
    } else if (patch.kind === 2) {
      const current = Array.isArray(parent[key]) ? parent[key] as unknown[] : [];
      if (Number.isInteger(patch.i) && (patch.i as number) >= 0) current.length = patch.i as number;
      if (Array.isArray(patch.v)) current.push(...patch.v);
      parent[key] = current;
    } else if (patch.kind === 3) {
      delete parent[key];
    }
  }

  snapshot(knownToolConfirmationIds: ReadonlySet<string> = new Set()): ChatExecutionSnapshot {
    const requests = Array.isArray(this.state?.requests) ? this.state.requests : [];
    const latest = requests.at(-1);
    const requestId = typeof latest?.requestId === 'string' ? latest.requestId : null;
    const blockers = new Map<string, HumanInputBlocker>();
    const observedToolCallIds = new Set<string>();
    if (latest && requestId && Array.isArray(latest.response)) {
      latest.response.forEach((part, index) => {
        if (!part || typeof part !== 'object') return;
        if (typeof (part as NativeResponsePart).toolCallId === 'string') {
          observedToolCallIds.add((part as NativeResponsePart).toolCallId as string);
        }
        const blocker = blockerForPart(
          requestId,
          part as NativeResponsePart,
          index,
          knownToolConfirmationIds
        );
        if (blocker) blockers.set(blocker.id, blocker);
      });
    }
    const hasResolvedHumanInputPart = Array.isArray(latest?.response) && latest.response.some(
      (part) => Boolean(part && typeof part === 'object' && isResolvedHumanInputPart(part as NativeResponsePart))
    );
    const response = Array.isArray(latest?.response) ? latest.response : [];
    const unknownStateBearingParts = response.filter(
      (part): part is NativeResponsePart =>
        Boolean(part && typeof part === 'object' && isUnknownStateBearingNativePart(part as NativeResponsePart))
    );
    const unexplainedWaitingParts = unknownStateBearingParts.length > 0
      ? unknownStateBearingParts
      : hasResolvedHumanInputPart
        ? []
        : response.length > 0
          ? response
          : [null];
    const incompatibilities: ExecutionIncompatibility[] =
      latest?.modelState?.value === 4 && blockers.size === 0
        ? unexplainedWaitingParts.map((part) => {
            const responsePart = part && typeof part === 'object' ? part as NativeResponsePart : null;
            const state = responsePart?.state;
            const stateType = state && typeof state === 'object'
              ? (state as { type?: unknown }).type
              : state;
            return {
              code: 'unknown-native-response' as const,
              source: 'native' as const,
              responsePartKind: diagnosticToken(responsePart?.kind),
              stateType: diagnosticToken(stateType),
            };
          })
        : [];
    const terminal = latest && blockers.size === 0 ? modelStateTerminal(latest) : null;
    const active = Boolean(latest) && terminal === null;
    return {
      requestId,
      active,
      busy: active && blockers.size === 0 && incompatibilities.length === 0,
      needsInput: latest?.modelState?.value === 4,
      blockers,
      observedToolCallIds,
      terminal,
      incompatibilities,
    };
  }

  completionTimestamp(): number | string | null {
    return this.state?.requests?.at(-1)?.modelState?.completedAt ?? null;
  }

  requestCount(): number {
    return Array.isArray(this.state?.requests) ? this.state.requests.length : 0;
  }
}

interface AgentHostInputRequestPart {
  kind?: unknown;
  request?: {
    id?: unknown;
    planReview?: unknown;
    purpose?: unknown;
  };
  response?: unknown;
}

interface AgentHostToolCallPart {
  kind?: unknown;
  toolCall?: {
    toolCallId?: unknown;
    status?: unknown;
    _meta?: {
      autoApproveBySetting?: unknown;
    };
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
  'streaming',
  'pending-confirmation',
  'pending-result-confirmation',
  'auth-required',
  'running',
  'completed',
  'cancelled',
]);

function agentHostInputKind(request: AgentHostInputRequestPart['request']): HumanInputBlockerKind {
  if (request && 'planReview' in request) return 'plan-review';
  if (request?.purpose === 'planReview') return 'plan-review';
  if (request?.purpose === 'elicitation') return 'elicitation';
  return 'question';
}

function agentHostTerminal(turn: AgentHostTurn | undefined): ChatExecutionSnapshot['terminal'] {
  if (!turn) return null;
  if (turn.state === 'failed' || turn.state === 'error') return 'failed';
  if (turn.state === 'cancelled' || turn.state === 'canceled') return 'cancelled';
  return 'complete';
}

/** Projects the source-independent Agent Host chat protocol state. The protocol
 * state is not currently present in session.db, so callers apply a complete
 * snapshot whenever an authoritative protocol source becomes available. */
export class AgentHostChatProjection {
  private state: AgentHostChatState | null = null;

  reset(): void {
    this.state = null;
  }

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
          const sourceId = typeof input.request?.id === 'string'
            ? input.request.id
            : `position-${index}`;
          const id = blockerIdentity(requestId, 'inputRequest', sourceId);
          blockers.set(id, {
            id,
            requestId,
            responsePartKind: 'inputRequest',
            sourceId,
            kind: agentHostInputKind(input.request),
          });
          continue;
        }
        if (partKind !== 'toolCall') continue;
        const toolCall = (part as AgentHostToolCallPart).toolCall;
        const sourceId = typeof toolCall?.toolCallId === 'string'
          ? toolCall.toolCallId
          : `position-${index}`;
        if (typeof toolCall?.toolCallId === 'string') observedToolCallIds.add(toolCall.toolCallId);
        let kind: HumanInputBlockerKind | null = null;
        if (
          toolCall?.status === 'pending-confirmation' &&
          toolCall._meta?.autoApproveBySetting !== true
        ) {
          kind = 'tool-confirmation';
        } else if (toolCall?.status === 'pending-result-confirmation') {
          kind = 'tool-result-confirmation';
        } else if (toolCall?.status === 'auth-required') {
          kind = 'tool-authentication';
        }
        if (!KNOWN_AGENT_HOST_TOOL_STATUSES.has(String(toolCall?.status))) {
          incompatibilities.push({
            code: 'unknown-agent-host-tool-status',
            source: 'agent-host',
            responsePartKind: 'toolCall',
            toolStatus: diagnosticToken(toolCall?.status),
          });
        }
        if (!kind) continue;
        const id = blockerIdentity(requestId, 'toolCall', sourceId);
        blockers.set(id, {
          id,
          requestId,
          responsePartKind: 'toolCall',
          sourceId,
          kind,
        });
      }
    }

    const executionStatus = typeof this.state?.status === 'number'
      ? this.state.status & 31
      : null;
    if (activeTurn && executionStatus === 24 && blockers.size === 0 && incompatibilities.length === 0) {
      const responseParts = Array.isArray(activeTurn.responseParts) ? activeTurn.responseParts : [];
      const unknownPart = responseParts.find((part) => {
        if (!part || typeof part !== 'object') return true;
        const kind = (part as { kind?: unknown }).kind;
        return kind !== 'inputRequest' && kind !== 'toolCall';
      });
      incompatibilities.push({
        code: 'unknown-agent-host-response',
        source: 'agent-host',
        responsePartKind: diagnosticToken(
          unknownPart && typeof unknownPart === 'object'
            ? (unknownPart as { kind?: unknown }).kind
            : undefined
        ),
        chatStatus: diagnosticToken(this.state?.status),
      });
    }

    const terminal = activeTurn ? null : agentHostTerminal(latestTurn);
    const active = Boolean(activeTurn);
    return {
      requestId,
      active,
      busy: active && blockers.size === 0 && incompatibilities.length === 0,
      needsInput: Boolean(activeTurn && executionStatus === 24),
      blockers,
      observedToolCallIds,
      terminal,
      incompatibilities,
    };
  }
}

export function reduceEvent(
  run: RunState,
  event: VSCodeEvent,
  source: SessionSource = SOURCE_COPILOT_CLI,
  cwd: string | null = null
): Transition {
  const data = event?.data;
  const hookType = data?.hookType;
  const steering =
    source === SOURCE_NATIVE &&
    event?.type === 'user.message' &&
    run.active &&
    run.turns.size > 0;
  const prompt =
    (event?.type === 'hook.start' && hookType === 'userPromptSubmitted') ||
    (event?.type === 'user.message' && !steering);

  if (steering) return { run, prompt: false, state: runState(run) };

  if (prompt) {
    run = emptyRun();
    const requestId = data?.requestId ?? data?.turnId ?? data?.interactionId ?? event.timestamp ?? 'current-request';
    const state = reduceNormalizedEvent(run, { type: 'request.started', requestId });
    return { run, prompt: true, state };
  }

  const ensureRequest = (): string => {
    const requestId = run.requestId ?? data?.turnId ?? data?.interactionId ?? event.timestamp ?? 'current-request';
    if (run.requestId === null) reduceNormalizedEvent(run, { type: 'request.started', requestId });
    return requestId;
  };
  const openInput = (
    sourceId: string,
    kind: HumanInputBlockerKind,
    responsePartKind: string
  ): void => {
    const requestId = ensureRequest();
    reduceNormalizedEvent(run, {
      type: 'human-input.opened',
      requestId,
      blockerId: blockerIdentity(requestId, responsePartKind, sourceId),
      kind,
      responsePartKind,
      sourceId,
    });
  };
  const closeInput = (sourceId: string, kind?: HumanInputBlockerKind): void => {
    const requestId = ensureRequest();
    for (const blocker of [...run.blockers.values()]) {
      if (blocker.sourceId !== sourceId || (kind && blocker.kind !== kind)) continue;
      reduceNormalizedEvent(run, {
        type: 'human-input.closed',
        requestId,
        blockerId: blocker.id,
        outcome: 'resolved',
      });
    }
  };

  if (event?.type === 'assistant.turn_start') {
    const id = eventKey(data, 'turnId', 'interactionId');
    if (id) run.turns.add(id);
    ensureRequest();
  } else if (event?.type === 'assistant.turn_end') {
    const id = eventKey(data, 'turnId', 'interactionId');
    if (id) run.turns.delete(id);
  } else if (source === SOURCE_NATIVE && event?.type === 'assistant.message') {
    for (const request of data?.toolRequests ?? []) {
      if (request.toolCallId && (request.name ?? request.toolName) === 'run_in_terminal') {
        run.unstartedTerminalToolIds.add(request.toolCallId);
      }
      if (request.toolCallId && requestsPermission(request.arguments, cwd)) {
        run.pendingPermissionIds.add(request.toolCallId);
        if (requestsPermission(request.arguments)) {
          openInput(request.toolCallId, 'tool-confirmation', 'toolInvocation');
        }
      }
    }
  } else if (event?.type === 'tool.execution_start') {
    const id = data?.toolCallId;
    const inferredPermission = id ? run.inferredPermissionIds.delete(id) : false;
    if (id) {
      if (source !== SOURCE_NATIVE) run.pendingPermissionIds.delete(id);
      run.startedToolIds.add(id);
      run.unstartedTerminalToolIds.delete(id);
    }
    const question = data?.toolName === 'vscode_askQuestions';
    if (id && question) run.knownQuestionToolIds.add(id);
    if (data?.fromHook && question) run.questionHooksObserved = true;
    if (
      id &&
      !(source === SOURCE_NATIVE && question && run.questionHooksObserved && !data?.fromHook)
    ) {
      run.activeTools.set(id, data?.toolName ?? '');
      if (question || data?.toolName === 'ask_user') openInput(id, 'question', 'questionCarousel');
    }
    if (id && inferredPermission) closeInput(id, 'tool-confirmation');
    ensureRequest();
  } else if (event?.type === 'tool.execution_complete') {
    if (data?.toolCallId) run.pendingPermissionIds.delete(data.toolCallId);
    if (data?.toolCallId) run.inferredPermissionIds.delete(data.toolCallId);
    if (data?.toolCallId) run.unstartedTerminalToolIds.delete(data.toolCallId);
    const completedQuestion = data?.toolCallId ? run.knownQuestionToolIds.delete(data.toolCallId) : false;
    const hookQuestion = data?.fromHook && data?.toolName === 'vscode_askQuestions';
    if (hookQuestion) run.questionHooksObserved = true;
    if (hookQuestion || (source === SOURCE_NATIVE && completedQuestion)) {
      for (const [id, name] of run.activeTools) {
        if (name === 'vscode_askQuestions') run.activeTools.delete(id);
      }
      for (const blocker of [...run.blockers.values()]) {
        if (blocker.kind === 'question') closeInput(blocker.sourceId, 'question');
      }
    }
    if (data?.toolCallId) {
      closeInput(data.toolCallId);
      run.activeTools.delete(data.toolCallId);
    }
  } else if (event?.type === 'permission.requested') {
    if (data?.requestId) {
      run.pendingPermissionIds.add(data.requestId);
      openInput(data.requestId, 'tool-confirmation', 'toolInvocation');
    }
  } else if (event?.type === 'permission.completed') {
    if (data?.requestId) {
      run.pendingPermissionIds.delete(data.requestId);
      closeInput(data.requestId);
    }
    if (data?.toolCallId) closeInput(data.toolCallId);
  } else if (event?.type === 'session.error' || event?.type === 'turn.error') {
    run.error = event.type;
    const requestId = ensureRequest();
    reduceNormalizedEvent(run, { type: 'request.finished', requestId, outcome: 'failed' });
  } else if (source === SOURCE_NATIVE && event?.type === 'request.completed') {
    const requestId = ensureRequest();
    reduceNormalizedEvent(run, { type: 'request.finished', requestId, outcome: 'complete' });
    run.turns.clear();
    run.activeTools.clear();
    run.knownQuestionToolIds.clear();
    run.pendingPermissionIds.clear();
    run.inferredPermissionIds.clear();
    run.startedToolIds.clear();
    run.unstartedTerminalToolIds.clear();
  } else if (event?.type === 'hook.end' && hookType === 'sessionEnd') {
    const requestId = ensureRequest();
    reduceNormalizedEvent(run, { type: 'request.finished', requestId, outcome: 'complete' });
    run.turns.clear();
    run.activeTools.clear();
    run.knownQuestionToolIds.clear();
    run.pendingPermissionIds.clear();
    run.inferredPermissionIds.clear();
    run.startedToolIds.clear();
    run.unstartedTerminalToolIds.clear();
  } else {
    return { run, prompt: false, state: null };
  }

  return { run, prompt: false, state: runState(run) };
}
