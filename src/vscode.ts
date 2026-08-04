import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { execFile, execFileSync } from 'child_process';

export const INTEGRATION_SLOT_COUNT = 4;
const CLIENT_NAME = 'vscode-agent-host';
export const RESOURCE_SCHEME = 'agent-host-copilotcli';
export const NATIVE_RESOURCE_SCHEME = 'vscode-chat-session';
const SOURCE_COPILOT_CLI = 'copilot-cli' as const;
const SOURCE_NATIVE = 'native' as const;
type SessionSource = typeof SOURCE_COPILOT_CLI | typeof SOURCE_NATIVE;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCAN_INTERVAL_MS = 1000;
const SCHEMA_VERSION = 1;
const SUPPORTED_PRODUCER = 'copilot-agent';
const SUPPORTED_EVENT_VERSION = 1;
const SUPPORTED_VSCODE_VERSION = /^1\.131\./;
const VSCODE_APP = '/Applications/Visual Studio Code.app';

export interface WorkspaceMetadata {
  id: string | null;
  cwd: string | null;
  clientName: string | null;
}

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

interface RunState {
  /** Error latched for the current run until the next prompt. */
  error: string | null;
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
  /** Tool-call IDs that have started during the current run. */
  startedToolIds: Set<string>;
  /** Whether request or session completion has been observed. */
  completed: boolean;
}

interface StartupReplay {
  slot: VSCodeSlot;
  eventOffset: number | null;
  eventIdentity: string | null;
  journalOffset: number | null;
  journalIdentity: string | null;
}

interface Compatibility {
  producer: string | null;
  eventVersion: number | null;
  copilotVersion: string | null;
  sawPrompt: boolean;
  sawSessionEnd: boolean;
  supported: boolean;
}

interface Transition {
  run: RunState;
  prompt: boolean;
  state: string | null;
}

function parseYamlScalar(source: string, key: string): string | null {
  const match = source.match(new RegExp(`^${key}:\\s*(.*?)\\s*$`, 'm'));
  if (!match) return null;
  const value = match[1];
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return null;
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

export function workspaceMetadata(source: string): WorkspaceMetadata {
  return {
    id: parseYamlScalar(source, 'id'),
    cwd: parseYamlScalar(source, 'cwd'),
    clientName: parseYamlScalar(source, 'client_name'),
  };
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

function nativeHookToolCallId(toolUseId: string): string {
  return toolUseId.replace(/__vscode-\d+$/, '');
}

export function emptyRun(): RunState {
  return {
    error: null,
    turns: new Set(),
    activeTools: new Map(),
    knownQuestionToolIds: new Set(),
    questionHooksObserved: false,
    pendingPermissionIds: new Set(),
    startedToolIds: new Set(),
    completed: false,
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

interface NativeRequest {
  result?: unknown;
  modelState?: { completedAt?: number | string };
  response?: unknown;
}

interface NativePatch {
  kind?: number;
  k?: unknown[];
  v?: unknown;
}

interface NativeToolInvocation {
  toolCallId?: unknown;
  isConfirmed?: unknown;
  isComplete?: unknown;
  toolSpecificData?: {
    requestUnsandboxedExecution?: unknown;
    requestAllowNetwork?: unknown;
    terminalCommandState?: unknown;
  };
}

function asNativeRequests(value: unknown): NativeRequest[] | null {
  return Array.isArray(value) ? (value as NativeRequest[]) : null;
}

function isNativeCompletionPatch(patch: NativePatch): boolean {
  const key = patch.k;
  if (
    patch.kind === 1 &&
    Array.isArray(key) &&
    key[0] === 'requests' &&
    Number.isInteger(key[1]) &&
    (key[2] === 'result' || (key[2] === 'modelState' && (patch.v as { completedAt?: unknown } | undefined)?.completedAt))
  ) return true;

  const requests =
    patch.kind === 0
      ? asNativeRequests((patch.v as { requests?: unknown } | undefined)?.requests)
      : patch.kind === 2 && key?.length === 1 && key[0] === 'requests'
        ? asNativeRequests(patch.v)
        : null;
  const latest = requests?.at(-1);
  return Boolean(latest && (latest.result || latest.modelState?.completedAt));
}

function nativeCompletionTimestamp(patch: NativePatch): number | string | null {
  const key = patch.k;
  if (patch.kind === 1 && key?.[2] === 'modelState') {
    return (patch.v as { completedAt?: number | string } | undefined)?.completedAt ?? null;
  }
  const requests: unknown =
    patch.kind === 0 ? (patch.v as { requests?: unknown } | undefined)?.requests : key?.length === 1 ? patch.v : null;
  return asNativeRequests(requests)?.at(-1)?.modelState?.completedAt ?? null;
}

function nativePermissionEvents(patch: NativePatch, pendingPermissionIds: Set<string> = new Set()): VSCodeEvent[] {
  const key = patch.k;
  const response =
    Array.isArray(key) && key[0] === 'requests' && Number.isInteger(key[1]) && key[2] === 'response'
      ? patch.v
      : patch.kind === 0
        ? asNativeRequests((patch.v as { requests?: unknown } | undefined)?.requests)?.at(-1)?.response
        : patch.kind === 2 && key?.length === 1 && key[0] === 'requests'
          ? asNativeRequests(patch.v)?.at(-1)?.response
          : null;
  if (!Array.isArray(response)) return [];

  const events: VSCodeEvent[] = [];
  for (const value of response as NativeToolInvocation[]) {
    if (
      typeof value?.toolCallId !== 'string' ||
      (!requestsPermission(value.toolSpecificData) && !pendingPermissionIds.has(value.toolCallId))
    ) continue;
    const waiting = value.isConfirmed == null && value.toolSpecificData?.terminalCommandState == null;
    events.push({
      type: waiting ? 'permission.requested' : 'permission.completed',
      data: { requestId: value.toolCallId },
    });
  }
  return events;
}

function inspectCompatibility(eventsPath: string, source: SessionSource, journalPath: string | null = null): Compatibility {
  const compatibility = emptyCompatibility();
  const contents = fs.readFileSync(eventsPath, 'utf8');
  for (const line of contents.split('\n')) {
    if (!line.trim()) continue;
    try {
      updateCompatibility(compatibility, JSON.parse(line) as VSCodeEvent, source);
    } catch {
      // Malformed line; ignore for compatibility inspection purposes.
    }
  }
  if (source === SOURCE_NATIVE && journalPath) {
    const journal = fs.readFileSync(journalPath, 'utf8');
    for (const line of journal.split('\n')) {
      if (!line.trim()) continue;
      try {
        if (isNativeCompletionPatch(JSON.parse(line) as NativePatch)) {
          updateCompatibility(compatibility, { type: 'request.completed' }, source);
          break;
        }
      } catch {
        // Malformed line; ignore.
      }
    }
  }
  return compatibility;
}

export function reduceEvent(
  run: RunState,
  event: VSCodeEvent,
  source: SessionSource = SOURCE_COPILOT_CLI,
  cwd: string | null = null
): Transition {
  const data = event?.data;
  const hookType = data?.hookType;
  const prompt =
    (event?.type === 'hook.start' && hookType === 'userPromptSubmitted') ||
    event?.type === 'user.message';

  if (prompt) {
    run = emptyRun();
    return { run, prompt: true, state: 'running' };
  }

  if (event?.type === 'assistant.turn_start') {
    const id = eventKey(data, 'turnId', 'interactionId');
    if (id) run.turns.add(id);
    run.completed = false;
  } else if (event?.type === 'assistant.turn_end') {
    const id = eventKey(data, 'turnId', 'interactionId');
    if (id) run.turns.delete(id);
  } else if (source === SOURCE_NATIVE && event?.type === 'assistant.message') {
    for (const request of data?.toolRequests ?? []) {
      if (request.toolCallId && requestsPermission(request.arguments, cwd)) {
        run.pendingPermissionIds.add(request.toolCallId);
      }
    }
  } else if (event?.type === 'tool.execution_start') {
    const id = data?.toolCallId;
    if (id) {
      if (source !== SOURCE_NATIVE) run.pendingPermissionIds.delete(id);
      run.startedToolIds.add(id);
    }
    const question = data?.toolName === 'vscode_askQuestions';
    if (id && question) run.knownQuestionToolIds.add(id);
    if (data?.fromHook && question) run.questionHooksObserved = true;
    if (
      id &&
      !(source === SOURCE_NATIVE && question && run.questionHooksObserved && !data?.fromHook)
    ) run.activeTools.set(id, data?.toolName ?? '');
    run.completed = false;
  } else if (event?.type === 'tool.execution_complete') {
    if (data?.toolCallId) run.pendingPermissionIds.delete(data.toolCallId);
    const completedQuestion = data?.toolCallId ? run.knownQuestionToolIds.delete(data.toolCallId) : false;
    const hookQuestion = data?.fromHook && data?.toolName === 'vscode_askQuestions';
    if (hookQuestion) run.questionHooksObserved = true;
    if (hookQuestion || (source === SOURCE_NATIVE && completedQuestion)) {
      for (const [id, name] of run.activeTools) {
        if (name === 'vscode_askQuestions') run.activeTools.delete(id);
      }
    }
    if (data?.toolCallId) {
      run.activeTools.delete(data.toolCallId);
    }
  } else if (event?.type === 'permission.requested') {
    if (data?.requestId && !run.startedToolIds.has(data.requestId)) run.pendingPermissionIds.add(data.requestId);
  } else if (event?.type === 'permission.completed') {
    if (data?.requestId) run.pendingPermissionIds.delete(data.requestId);
  } else if (event?.type === 'session.error' || event?.type === 'turn.error') {
    run.error = event.type;
  } else if (source === SOURCE_NATIVE && event?.type === 'request.completed') {
    run.completed = true;
    run.turns.clear();
    run.activeTools.clear();
    run.knownQuestionToolIds.clear();
    run.pendingPermissionIds.clear();
    run.startedToolIds.clear();
  } else if (event?.type === 'hook.end' && hookType === 'sessionEnd') {
    run.completed = true;
    run.turns.clear();
    run.activeTools.clear();
    run.knownQuestionToolIds.clear();
    run.pendingPermissionIds.clear();
    run.startedToolIds.clear();
  } else {
    return { run, prompt: false, state: null };
  }

  let state = 'running';
  if (run.error) state = 'error';
  else if (
    run.pendingPermissionIds.size ||
    [...run.activeTools.values()].some((name) => name === 'ask_user' || name === 'vscode_askQuestions')
  ) state = 'input';
  else if (run.completed) state = 'done';
  return { run, prompt: false, state };
}

export function nativeSessionResource(sessionId: string): string {
  if (!SESSION_ID.test(sessionId)) throw new Error('invalid VS Code session id');
  return `${NATIVE_RESOURCE_SCHEME}://local/${Buffer.from(sessionId).toString('base64url')}`;
}

function nativeSessionActive(indexPath: string, sessionId: string): boolean | null {
  try {
    const query =
      `SELECT CASE WHEN EXISTS (` +
      `SELECT 1 FROM ItemTable WHERE key IN ('memento/interactive-session', 'chat.terminalSessions') ` +
      `AND instr(CAST(value AS TEXT), '${sessionId}') > 0) THEN 1 ELSE 0 END`;
    const result = execFileSync('/usr/bin/sqlite3', [indexPath, query], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    }).trim();
    return result === '1' ? true : result === '0' ? false : null;
  } catch {
    return null;
  }
}

export function buildSessionUrl(cwd: string, sessionId: string, resource: string = `${RESOURCE_SCHEME}:/${sessionId}`): string {
  if (!path.isAbsolute(cwd)) throw new Error('project path is not absolute');
  if (!SESSION_ID.test(sessionId)) throw new Error('invalid VS Code session id');
  const url = new URL('vscode://file');
  url.pathname = cwd;
  url.searchParams.set('session', resource);
  return url.toString();
}

export function launchUrl(url: string, exec: typeof execFile = execFile): Promise<void> {
  return new Promise((resolve, reject) => {
    exec('/usr/bin/open', [url], (err) => (err ? reject(err) : resolve()));
  });
}

interface ExactOpenCompatibility {
  available: boolean;
  version: string | null;
  protocolRegistered: boolean;
}

export function exactOpenCompatibility(): ExactOpenCompatibility {
  if (process.platform !== 'darwin' || !fs.existsSync(VSCODE_APP)) {
    return { available: false, version: null, protocolRegistered: false };
  }
  let version: string | null = null;
  let protocolRegistered = false;
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(VSCODE_APP, 'Contents', 'Resources', 'app', 'package.json'), 'utf8')
    ) as { version?: string };
    version = packageJson.version ?? null;
    const urlTypes = JSON.parse(
      execFileSync(
        '/usr/bin/plutil',
        ['-extract', 'CFBundleURLTypes', 'json', '-o', '-', path.join(VSCODE_APP, 'Contents', 'Info.plist')],
        { encoding: 'utf8' }
      )
    ) as { CFBundleURLSchemes?: string[] }[];
    protocolRegistered = urlTypes.some((entry) => entry.CFBundleURLSchemes?.includes('vscode'));
    execFileSync('/usr/bin/open', ['-Ra', 'Visual Studio Code'], { stdio: 'ignore' });
  } catch {
    return { available: false, version, protocolRegistered };
  }
  return {
    available: SUPPORTED_VSCODE_VERSION.test(version ?? '') && protocolRegistered,
    version,
    protocolRegistered,
  };
}

/** One key on the physical keyboard, bound to a VS Code session or idle. */
export interface VSCodeSlot {
  slot: number;
  sessionId?: string;
  cwd?: string;
  eventsPath?: string;
  journalPath?: string | null;
  source?: SessionSource;
  resource?: string;
  label?: string;
  boundAt?: string;
  state: string;
  stateChangedAt?: string;
  doneAt?: string | null;
  lastEventAt?: string | null;
  runError?: string | null;
  eventOffset?: number;
}

interface Session {
  id: string;
  cwd: string;
  eventsPath: string;
  journalPath: string | null;
  source: SessionSource;
  resource: string;
  offset: number;
  identity: string | null;
  journalOffset: number;
  journalIdentity: string | null;
  run: RunState;
  compatibility: Compatibility;
  boundSlot: number | null;
  missingScans: number;
  lastEventAt: string | null;
  startupReplay: StartupReplay | null;
}

interface Candidate {
  id: string;
  cwd: string;
  eventsPath: string;
  journalPath: string | null;
  indexPath?: string;
  source: SessionSource;
  resource: string;
}

interface PersistedSession {
  id: string;
  cwd?: string | null;
  eventsPath: string;
  journalPath?: string | null;
  source?: SessionSource;
  resource?: string;
  offset: number;
  identity?: string | null;
  journalOffset?: number;
  journalIdentity?: string | null;
  compatibility?: Partial<Compatibility>;
  lastEventAt?: string | null;
}

interface PersistedState {
  schemaVersion: number;
  slots?: ((Partial<VSCodeSlot> & { sessionId?: string }) | null)[];
  sessions?: PersistedSession[];
}

export interface VSCodeIntegrationOptions {
  root?: string;
  nativeRoot?: string;
  statePath?: string;
  onSlot?: (slot: VSCodeSlot) => void | Promise<void>;
  onStartup?: (slots: VSCodeSlot[]) => void | Promise<void>;
  log?: (...args: unknown[]) => void;
  launch?: (url: string) => Promise<void>;
  nativeSessionActive?: (indexPath: string, sessionId: string) => boolean | null;
  scanIntervalMs?: number;
}

interface DoctorBinding {
  slot: number;
  state: string;
  sessionId: string | null;
  eventsReadable: boolean | null;
  projectExists: boolean | null;
  eventOffset: number | null;
  lastEventAt: string | null;
}

export interface DoctorInfo {
  ready: boolean;
  sessionStateRoot: string;
  rootReadable: boolean;
  nativeSessionRoot: string;
  nativeRootReadable: boolean;
  resourceScheme: string;
  trackedSessions: number;
  compatibleSessions: number;
  verifiedLifecycleSessions: number;
  exactOpenAvailable: boolean;
  protocolRegistered: boolean;
  vscodeVersion: string | null;
  bindings: DoctorBinding[];
}

export class VSCodeIntegration {
  root: string;
  nativeRoot: string;
  statePath: string;
  onSlot: (slot: VSCodeSlot) => void | Promise<void>;
  onStartup: (slots: VSCodeSlot[]) => void | Promise<void>;
  log: (...args: unknown[]) => void;
  launch: (url: string) => Promise<void>;
  nativeSessionActive: (indexPath: string, sessionId: string) => boolean | null;
  scanIntervalMs: number;
  slots: (VSCodeSlot | null)[];
  sessions: Map<string, Session>;
  timer: NodeJS.Timeout | null;
  scanning: boolean;
  started: boolean;
  lifecycleVersion: number;
  startupSlots: Map<number, VSCodeSlot> | null;

  constructor(options: VSCodeIntegrationOptions = {}) {
    this.root =
      options.root ?? path.join(process.env.COPILOT_HOME ?? path.join(os.homedir(), '.copilot'), 'session-state');
    this.nativeRoot =
      options.nativeRoot ??
      process.env.AGENTKEYS_VSCODE_WORKSPACE_STORAGE ??
      path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage');
    this.statePath =
      options.statePath ??
      process.env.AGENTKEYS_VSCODE_STATE ??
      path.join(os.homedir(), 'Library', 'Application Support', 'AgentKeys', 'vscode-sessions.json');
    this.onSlot = options.onSlot ?? (() => {});
    this.onStartup = options.onStartup ?? (async (slots) => {
      for (const slot of slots) await this.onSlot(slot);
    });
    this.log = options.log ?? (() => {});
    this.launch = options.launch ?? launchUrl;
    this.nativeSessionActive = options.nativeSessionActive ?? nativeSessionActive;
    this.scanIntervalMs = options.scanIntervalMs ?? SCAN_INTERVAL_MS;
    this.slots = Array(INTEGRATION_SLOT_COUNT).fill(null);
    this.sessions = new Map();
    this.timer = null;
    this.scanning = false;
    this.started = false;
    this.lifecycleVersion = 0;
    this.startupSlots = null;
  }

  load(): void {
    let saved: PersistedState;
    try {
      saved = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as PersistedState;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`cannot read VS Code integration state: ${(err as Error).message}`);
      }
      return;
    }
    if (saved.schemaVersion !== SCHEMA_VERSION) {
      throw new Error(`unsupported VS Code integration state schema ${saved.schemaVersion}`);
    }
    for (const raw of saved.sessions ?? []) {
      if (!SESSION_ID.test(raw.id) || !Number.isInteger(raw.offset) || raw.offset < 0) continue;
      this.sessions.set(raw.id, {
        id: raw.id,
        cwd: raw.cwd ?? '',
        eventsPath: raw.source === SOURCE_NATIVE ? raw.eventsPath : this.eventsPath(raw.id),
        journalPath: raw.journalPath ?? null,
        source: raw.source ?? SOURCE_COPILOT_CLI,
        resource: raw.resource ?? `${RESOURCE_SCHEME}:/${raw.id}`,
        offset: typeof raw.identity === 'string' ? raw.offset : 0,
        identity: typeof raw.identity === 'string' ? raw.identity : null,
        journalOffset:
          typeof raw.journalOffset === 'number' && Number.isInteger(raw.journalOffset) && raw.journalOffset >= 0
            ? raw.journalOffset
            : 0,
        journalIdentity: typeof raw.journalIdentity === 'string' ? raw.journalIdentity : null,
        run: emptyRun(),
        compatibility: { ...emptyCompatibility(), ...raw.compatibility },
        boundSlot: null,
        missingScans: 0,
        lastEventAt: raw.lastEventAt ?? null,
        startupReplay: null,
      });
    }
    for (let index = 0; index < INTEGRATION_SLOT_COUNT; index++) {
      const raw = saved.slots?.[index];
      if (!raw || !SESSION_ID.test(raw.sessionId ?? '')) continue;
      const sessionId = raw.sessionId as string;
      const session = this.sessions.get(sessionId) ?? {
        id: sessionId,
        cwd: raw.cwd ?? '',
        eventsPath: raw.eventsPath ?? this.eventsPath(sessionId),
        journalPath: raw.journalPath ?? null,
        source: raw.source ?? SOURCE_COPILOT_CLI,
        resource: raw.resource ?? `${RESOURCE_SCHEME}:/${sessionId}`,
        offset: 0,
        identity: null,
        journalOffset: 0,
        journalIdentity: null,
        run: emptyRun(),
        compatibility: emptyCompatibility(),
        boundSlot: null,
        missingScans: 0,
        lastEventAt: null,
        startupReplay: null,
      };
      const eventOffset = session.identity ? session.offset : null;
      const eventIdentity = session.identity;
      const journalOffset = session.journalIdentity ? session.journalOffset : null;
      const journalIdentity = session.journalIdentity;
      session.boundSlot = index;
      session.offset = 0;
      session.journalOffset = 0;
      session.run = emptyRun();
      this.sessions.set(session.id, session);
      this.slots[index] = {
        slot: index,
        sessionId: session.id,
        cwd: session.cwd,
        eventsPath: session.eventsPath,
        journalPath: session.journalPath,
        source: session.source,
        resource: session.resource,
        label: raw.label,
        boundAt: raw.boundAt,
        state: raw.state ?? 'idle',
        stateChangedAt: raw.stateChangedAt,
        doneAt: raw.doneAt,
        lastEventAt: raw.lastEventAt,
        runError: raw.runError,
        eventOffset: 0,
      };
      session.startupReplay = {
        slot: { ...this.slots[index] as VSCodeSlot },
        eventOffset,
        eventIdentity,
        journalOffset,
        journalIdentity,
      };
    }
  }

  eventsPath(id: string): string {
    if (!SESSION_ID.test(id)) throw new Error('invalid VS Code session id');
    return path.join(this.root, id, 'events.jsonl');
  }

  save(): void {
    const state: PersistedState = {
      schemaVersion: SCHEMA_VERSION,
      slots: this.slots,
      sessions: [...this.sessions.values()].map((session) => ({
        id: session.id,
        cwd: session.cwd,
        eventsPath: session.eventsPath,
        journalPath: session.journalPath,
        source: session.source,
        resource: session.resource,
        offset: session.offset,
        identity: session.identity,
        journalOffset: session.journalOffset,
        journalIdentity: session.journalIdentity,
        compatibility: session.compatibility,
        lastEventAt: session.lastEventAt,
      })),
    };
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this.statePath);
  }

  async start(): Promise<void> {
    if (this.started) return;
    const lifecycleVersion = ++this.lifecycleVersion;
    this.load();
    this.started = true;
    const startupSlots = new Map<number, VSCodeSlot>();
    this.startupSlots = startupSlots;
    try {
      await this.scan(true);
      if (!this.started || this.lifecycleVersion !== lifecycleVersion) return;
      const slots = [...startupSlots.values()].sort((a, b) => a.slot - b.slot);
      this.startupSlots = null;
      await this.onStartup(slots);
    } catch (err) {
      this.log(`VS Code initial scan failed: ${(err as Error).message}`);
    } finally {
      if (this.startupSlots === startupSlots) this.startupSlots = null;
    }
    if (!this.started || this.lifecycleVersion !== lifecycleVersion) return;
    this.timer = setInterval(
      () => this.scan().catch((err: unknown) => this.log(`VS Code scan failed: ${(err as Error).message}`)),
      this.scanIntervalMs
    );
    this.timer.unref?.();
  }

  stop(): void {
    this.lifecycleVersion++;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.started) this.save();
    this.started = false;
  }

  async emitSlot(slot: VSCodeSlot): Promise<void> {
    const snapshot = { ...slot };
    if (this.startupSlots) {
      this.startupSlots.set(slot.slot, snapshot);
      return;
    }
    await this.onSlot(snapshot);
  }

  admit(id: string): Candidate | null {
    if (!SESSION_ID.test(id)) return null;
    const directory = path.join(this.root, id);
    const workspacePath = path.join(directory, 'workspace.yaml');
    const eventsPath = this.eventsPath(id);
    let directoryReal: string;
    let rootReal: string;
    let metadata: WorkspaceMetadata;
    try {
      rootReal = fs.realpathSync(this.root);
      directoryReal = fs.realpathSync(directory);
      if (path.dirname(directoryReal) !== rootReal) return null;
      metadata = workspaceMetadata(fs.readFileSync(workspacePath, 'utf8'));
      fs.accessSync(eventsPath, fs.constants.R_OK);
    } catch {
      return null;
    }
    if (metadata.clientName !== CLIENT_NAME || metadata.id !== id || !path.isAbsolute(metadata.cwd ?? '')) {
      return null;
    }
    return {
      id,
      cwd: metadata.cwd as string,
      eventsPath,
      journalPath: null,
      source: SOURCE_COPILOT_CLI,
      resource: `${RESOURCE_SCHEME}:/${id}`,
    };
  }

  nativeCandidates(initial = false): Candidate[] {
    const candidates: Candidate[] = [];
    let workspaceIds: string[];
    try {
      workspaceIds = fs.readdirSync(this.nativeRoot);
    } catch {
      return candidates;
    }
    for (const workspaceId of workspaceIds) {
      const directory = path.join(this.nativeRoot, workspaceId);
      let cwd: string;
      try {
        const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'workspace.json'), 'utf8')) as {
          folder?: string;
          workspace?: string;
        };
        const workspaceUri = metadata.folder ?? metadata.workspace;
        if (!workspaceUri || new URL(workspaceUri).protocol !== 'file:') continue;
        cwd = fileURLToPath(workspaceUri);
      } catch {
        continue;
      }
      const transcripts = path.join(directory, 'GitHub.copilot-chat', 'transcripts');
      const indexPath = path.join(directory, 'state.vscdb');
      let files: string[];
      try {
        files = fs.readdirSync(transcripts);
      } catch {
        continue;
      }
      for (const file of files) {
        const id = path.basename(file, '.jsonl');
        if (file !== `${id}.jsonl` || !SESSION_ID.test(id)) continue;
        const eventsPath = path.join(transcripts, file);
        const chatPath = path.join(directory, 'chatSessions', file);
        try {
          fs.accessSync(eventsPath, fs.constants.R_OK);
          fs.accessSync(chatPath, fs.constants.R_OK);
        } catch {
          continue;
        }
        const persisted = this.sessions.get(id);
        const persistedSlot = persisted?.boundSlot === null ? null : this.slots[persisted?.boundSlot ?? -1];
        if (
          initial &&
          persistedSlot &&
          this.nativeSessionActive(indexPath, id) === false
        ) continue;
        candidates.push({
          id,
          cwd,
          eventsPath,
          journalPath: chatPath,
          indexPath,
          source: SOURCE_NATIVE,
          resource: nativeSessionResource(id),
        });
      }
    }
    return candidates;
  }

  async scan(initial = false): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      let ids: string[] = [];
      try {
        ids = fs.readdirSync(this.root);
      } catch {
        // Root does not exist yet; native candidates may still be usable.
      }
      const candidatesById = new Map(
        this.nativeCandidates(initial).map((candidate) => [candidate.id, candidate] as const)
      );
      for (const candidate of ids.map((id) => this.admit(id)).filter((c): c is Candidate => c !== null)) {
        candidatesById.set(candidate.id, candidate);
      }
      const candidates = [...candidatesById.values()];
      if (!candidates.length && !fs.existsSync(this.root) && !fs.existsSync(this.nativeRoot)) {
        throw new Error('Copilot session-state and VS Code workspace storage directories unavailable');
      }
      const admittedIds = new Set<string>();
      for (const admitted of candidates) {
        const { id } = admitted;
        admittedIds.add(id);
        let session = this.sessions.get(id);
        if (!session) {
          const stat = fs.statSync(admitted.eventsPath);
          session = {
            id,
            cwd: admitted.cwd,
            eventsPath: admitted.eventsPath,
            journalPath: admitted.journalPath ?? null,
            source: admitted.source,
            resource: admitted.resource,
            offset: initial ? stat.size : 0,
            identity: `${stat.dev}:${stat.ino}`,
            journalOffset: admitted.journalPath ? fs.statSync(admitted.journalPath).size : 0,
            journalIdentity: admitted.journalPath
              ? `${fs.statSync(admitted.journalPath).dev}:${fs.statSync(admitted.journalPath).ino}`
              : null,
            run: emptyRun(),
            compatibility: inspectCompatibility(admitted.eventsPath, admitted.source, admitted.journalPath),
            boundSlot: null,
            missingScans: 0,
            lastEventAt: null,
            startupReplay: null,
          };
          this.sessions.set(id, session);
          if (initial) continue;
        } else {
          session.cwd = admitted.cwd;
          session.eventsPath = admitted.eventsPath;
          session.journalPath = admitted.journalPath ?? null;
          session.source = admitted.source;
          session.resource = admitted.resource;
          if (!session.compatibility.producer) {
            session.compatibility = inspectCompatibility(admitted.eventsPath, admitted.source, admitted.journalPath);
          }
        }
        session.missingScans = 0;
        const startup = initial ? session.startupReplay : null;
        let changedWhileStopped = false;
        if (startup && startup.eventOffset !== null) {
          const stat = fs.statSync(session.eventsPath);
          changedWhileStopped =
            startup.eventIdentity !== `${stat.dev}:${stat.ino}` || startup.eventOffset !== stat.size;
        }
        if (startup && startup.journalOffset !== null && session.journalPath) {
          const stat = fs.statSync(session.journalPath);
          changedWhileStopped ||=
            startup.journalIdentity !== `${stat.dev}:${stat.ino}` || startup.journalOffset !== stat.size;
        }
        await this.readAppended(session);
        if (session.journalPath) await this.readJournalAppended(session);
        if (startup) {
          const slot = this.slots[startup.slot.slot];
          if (slot?.sessionId === session.id) {
            if (!changedWhileStopped) {
              const eventOffset = slot.eventOffset;
              Object.assign(slot, startup.slot);
              slot.eventOffset = eventOffset;
              if (slot.state === 'done') {
                slot.state = 'idle';
                slot.stateChangedAt = new Date().toISOString();
                slot.doneAt = null;
              }
            }
            session.startupReplay = null;
            await this.emitSlot(slot);
          } else {
            session.startupReplay = null;
          }
        }
      }
      for (const slot of this.slots) {
        if (!slot || !slot.sessionId || admittedIds.has(slot.sessionId)) continue;
        const session = this.sessions.get(slot.sessionId);
        if (!session) continue;
        if (initial) {
          session.boundSlot = null;
          this.slots[slot.slot] = null;
          await this.emitSlot({ slot: slot.slot, state: 'idle', stateChangedAt: new Date().toISOString() });
          this.log(`Released stale VS Code slot ${slot.slot} for ${slot.sessionId.slice(0, 8)}`);
          continue;
        }
        session.missingScans++;
        if (session.missingScans < 3 || slot.runError === 'event-stream-missing') continue;
        slot.state = 'error';
        slot.runError = 'event-stream-missing';
        slot.stateChangedAt = new Date().toISOString();
        await this.emitSlot(slot);
      }
      this.save();
    } finally {
      this.scanning = false;
    }
  }

  async readAppended(session: Session): Promise<void> {
    const stat = fs.statSync(session.eventsPath);
    const identity = `${stat.dev}:${stat.ino}`;
    if (session.identity && session.identity !== identity) {
      session.offset = 0;
      session.run = emptyRun();
      session.compatibility = emptyCompatibility();
    }
    session.identity = identity;
    if (stat.size < session.offset) {
      session.offset = 0;
      session.run = emptyRun();
      session.compatibility = emptyCompatibility();
    }
    if (stat.size === session.offset) return;
    const length = stat.size - session.offset;
    const fd = fs.openSync(session.eventsPath, 'r');
    const buffer = Buffer.alloc(length);
    try {
      fs.readSync(fd, buffer, 0, length, session.offset);
    } finally {
      fs.closeSync(fd);
    }
    const startOffset = session.offset;
    const text = buffer.toString('utf8');
    const lines = text.split('\n');
    lines.pop();
    let lineOffset = startOffset;
    for (const line of lines) {
      const bytes = Buffer.byteLength(line) + 1;
      if (line.trim()) {
        try {
          await this.applyEvent(session, JSON.parse(line) as VSCodeEvent);
        } catch (err) {
          if (err instanceof SyntaxError) this.log(`Malformed VS Code event at ${session.id.slice(0, 8)}:${lineOffset}`);
          else throw err;
        }
      }
      lineOffset += bytes;
    }
    session.offset = lineOffset;
    if (session.boundSlot !== null) {
      const slot = this.slots[session.boundSlot];
      if (slot) slot.eventOffset = session.offset;
    }
  }

  async readJournalAppended(session: Session): Promise<void> {
    if (!session.journalPath) return;
    const stat = fs.statSync(session.journalPath);
    const identity = `${stat.dev}:${stat.ino}`;
    if (session.journalIdentity && session.journalIdentity !== identity) session.journalOffset = 0;
    session.journalIdentity = identity;
    if (stat.size < session.journalOffset) session.journalOffset = 0;
    if (stat.size === session.journalOffset) return;
    const length = stat.size - session.journalOffset;
    const fd = fs.openSync(session.journalPath, 'r');
    const buffer = Buffer.alloc(length);
    try {
      fs.readSync(fd, buffer, 0, length, session.journalOffset);
    } finally {
      fs.closeSync(fd);
    }
    const lines = buffer.toString('utf8').split('\n');
    lines.pop();
    let offset = session.journalOffset;
    for (const line of lines) {
      const bytes = Buffer.byteLength(line) + 1;
      if (line.trim()) {
        try {
          const patch = JSON.parse(line) as NativePatch;
          for (const event of nativePermissionEvents(patch, session.run.pendingPermissionIds)) {
            await this.applyEvent(session, event);
          }
          if (isNativeCompletionPatch(patch)) {
            const timestamp = nativeCompletionTimestamp(patch);
            await this.applyEvent(session, {
              type: 'request.completed',
              timestamp: timestamp ? new Date(timestamp).toISOString() : new Date().toISOString(),
            });
          }
        } catch (err) {
          if (err instanceof SyntaxError) this.log(`Malformed VS Code journal at ${session.id.slice(0, 8)}:${offset}`);
          else throw err;
        }
      }
      offset += bytes;
    }
    session.journalOffset = offset;
  }

  allocate(session: Session, timestamp?: string | null): number | null {
    if (session.boundSlot !== null) return session.boundSlot;
    let index = this.slots.findIndex((slot) => slot === null);
    if (index < 0) {
      const reusable = this.slots
        .filter((slot): slot is VSCodeSlot => slot !== null && (slot.state === 'done' || slot.state === 'idle'))
        .sort((a, b) => {
          const time = String(a.doneAt ?? a.stateChangedAt ?? '').localeCompare(
            String(b.doneAt ?? b.stateChangedAt ?? '')
          );
          return time || a.slot - b.slot;
        })[0];
      if (!reusable) {
        this.log(`No inactive VS Code slot available for ${session.id.slice(0, 8)}`);
        return null;
      }

      index = reusable.slot;
      const previous = reusable.sessionId ? this.sessions.get(reusable.sessionId) : undefined;
      if (previous) previous.boundSlot = null;
    }
    const now = timestamp ?? new Date().toISOString();
    session.boundSlot = index;
    this.slots[index] = {
      slot: index,
      sessionId: session.id,
      cwd: session.cwd,
      eventsPath: session.eventsPath,
      journalPath: session.journalPath,
      source: session.source,
      resource: session.resource,
      label: path.basename(session.cwd),
      boundAt: now,
      state: 'running',
      stateChangedAt: now,
      doneAt: null,
      lastEventAt: now,
      runError: null,
      eventOffset: session.offset,
    };
    return index;
  }

  providerVerified(): boolean {
    return [...this.sessions.values()].some(
      (session) =>
        session.compatibility.supported &&
        session.compatibility.sawPrompt &&
        session.compatibility.sawSessionEnd
    );
  }

  async applyEvent(session: Session, event: VSCodeEvent): Promise<void> {
    updateCompatibility(session.compatibility, event, session.source);
    const transition = reduceEvent(session.run, event, session.source, session.cwd);
    session.run = transition.run;
    session.lastEventAt = event.timestamp ?? new Date().toISOString();
    let allocated = false;
    if (transition.prompt && session.boundSlot === null) {
      if (session.compatibility.supported && this.providerVerified()) {
        allocated = this.allocate(session, session.lastEventAt) !== null;
      }
      else this.log(`Unsupported VS Code event producer for ${session.id.slice(0, 8)}`);
    }
    if (session.boundSlot === null || !transition.state) return;

    const slot = this.slots[session.boundSlot];
    if (!slot) return;
    const changed = slot.state !== transition.state;
    slot.state = transition.state;
    slot.lastEventAt = session.lastEventAt;
    slot.eventOffset = session.offset;
    slot.runError = session.run.error;
    if (changed) slot.stateChangedAt = session.lastEventAt;
    if (transition.state === 'done' && changed) slot.doneAt = session.lastEventAt;
    if (transition.prompt) {
      slot.doneAt = null;
      slot.runError = null;
    }
    if ((allocated || changed) && !session.startupReplay) await this.emitSlot(slot);
  }

  async applyHook(event: unknown): Promise<boolean> {
    const hook = event as
      | {
          sessionId?: string;
          toolName?: string;
          hookEventName?: string;
          toolUseId?: string;
          requestId?: string;
          timestamp?: string;
        }
      | null
      | undefined;
    if (!hook || !SESSION_ID.test(hook.sessionId ?? '')) return false;
    const session = this.sessions.get(hook.sessionId as string);
    if (!session || session.source !== SOURCE_NATIVE || session.boundSlot === null) return false;
    const timestamp = typeof hook.timestamp === 'string' ? hook.timestamp : new Date().toISOString();
    if (
      hook.toolName === 'vscode_askQuestions' &&
      ['PreToolUse', 'PostToolUse'].includes(hook.hookEventName ?? '') &&
      typeof hook.toolUseId === 'string' &&
      hook.toolUseId
    ) {
      await this.applyEvent(session, {
        type: hook.hookEventName === 'PreToolUse' ? 'tool.execution_start' : 'tool.execution_complete',
        data: { toolCallId: hook.toolUseId, toolName: hook.toolName, fromHook: true },
        timestamp,
      });
    } else if (
      hook.toolName === 'vscode_get_terminal_confirmation' &&
      ['PermissionRequest', 'PostToolUse', 'PermissionDenied'].includes(hook.hookEventName ?? '') &&
      typeof hook.requestId === 'string' &&
      hook.requestId.startsWith('terminal-confirmation:')
    ) {
      await this.applyEvent(session, {
        type: hook.hookEventName === 'PermissionRequest' ? 'permission.requested' : 'permission.completed',
        data: { requestId: hook.requestId },
        timestamp,
      });
    } else if (
      hook.toolName !== 'vscode_askQuestions' &&
      hook.toolName !== 'vscode_get_terminal_confirmation' &&
      (
        hook.hookEventName === 'PostToolUse' ||
        hook.hookEventName === 'PermissionDenied'
      ) &&
      typeof hook.toolUseId === 'string' &&
      hook.toolUseId
    ) {
      const requestId = nativeHookToolCallId(hook.toolUseId);
      if (!session.run.pendingPermissionIds.has(requestId)) return false;
      await this.applyEvent(session, {
        type: 'permission.completed',
        data: { requestId },
        timestamp,
      });
    } else {
      return false;
    }
    this.save();
    return true;
  }

  publicSlots(): VSCodeSlot[] {
    return this.slots.map((slot, index) => (slot ? { ...slot } : { slot: index, state: 'idle' }));
  }

  async open(index: number): Promise<{ slot: VSCodeSlot; url: string }> {
    if (!Number.isInteger(index) || index < 0 || index >= INTEGRATION_SLOT_COUNT) {
      throw new Error(`VS Code slot must be 0..${INTEGRATION_SLOT_COUNT - 1}`);
    }
    const slot = this.slots[index];
    if (!slot || !slot.sessionId) throw new Error(`VS Code slot ${index} is unbound`);
    const sessionId = slot.sessionId;
    const session = this.sessions.get(sessionId);
    if (!session?.compatibility.supported) {
      throw new Error(`VS Code session ${sessionId.slice(0, 8)} uses an unsupported event format`);
    }
    if (!exactOpenCompatibility().available) {
      throw new Error('exact VS Code session opening is unavailable on this system');
    }
    if (!slot.cwd || !fs.existsSync(slot.cwd)) {
      slot.state = 'error';
      slot.runError = 'project-path-missing';
      slot.stateChangedAt = new Date().toISOString();
      await this.emitSlot(slot);
      this.save();
      throw new Error(`project path does not exist: ${slot.cwd}`);
    }
    const url = buildSessionUrl(slot.cwd, slot.sessionId, slot.resource);
    await this.launch(url);
    const current = this.slots[index];
    if (current?.sessionId === sessionId && current.state === 'done') {
      current.state = 'idle';
      current.stateChangedAt = new Date().toISOString();
      await this.emitSlot(current);
      this.save();
    }
    return { slot: this.publicSlots()[index], url };
  }

  doctor(): DoctorInfo {
    let rootReadable = false;
    try {
      fs.accessSync(this.root, fs.constants.R_OK);
      rootReadable = true;
    } catch {
      // not readable
    }
    let nativeRootReadable = false;
    try {
      fs.accessSync(this.nativeRoot, fs.constants.R_OK);
      nativeRootReadable = true;
    } catch {
      // not readable
    }
    const compatibleSessions = [...this.sessions.values()].filter(
      (session) => session.compatibility.supported
    ).length;
    const verifiedLifecycleSessions = [...this.sessions.values()].filter(
      (session) =>
        session.compatibility.supported &&
        session.compatibility.sawPrompt &&
        session.compatibility.sawSessionEnd
    ).length;
    const exactOpen = exactOpenCompatibility();
    return {
      ready: this.started && (rootReadable || nativeRootReadable) && verifiedLifecycleSessions > 0 && exactOpen.available,
      sessionStateRoot: this.root,
      rootReadable,
      nativeSessionRoot: this.nativeRoot,
      nativeRootReadable,
      resourceScheme: RESOURCE_SCHEME,
      trackedSessions: this.sessions.size,
      compatibleSessions,
      verifiedLifecycleSessions,
      exactOpenAvailable: exactOpen.available,
      protocolRegistered: exactOpen.protocolRegistered,
      vscodeVersion: exactOpen.version,
      bindings: this.publicSlots().map((slot) => ({
        slot: slot.slot,
        state: slot.state,
        sessionId: slot.sessionId ?? null,
        eventsReadable: slot.sessionId
          ? fs.existsSync(slot.eventsPath ?? this.sessions.get(slot.sessionId)?.eventsPath ?? '')
          : null,
        projectExists: slot.cwd ? fs.existsSync(slot.cwd) : null,
        eventOffset: slot.eventOffset ?? null,
        lastEventAt: slot.lastEventAt ?? null,
      })),
    };
  }
}
