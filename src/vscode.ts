import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import type { AgentHostStateSource } from './agent-host.js';
import { INTEGRATION_SLOT_COUNT } from './states.js';
import {
  AgentHostChatProjection,
  NativeChatProjection,
  SOURCE_COPILOT_CLI,
  SOURCE_NATIVE,
  cloneRun,
  emptyCompatibility,
  emptyRun,
  nativeHookToolCallId,
  reduceEvent,
  reduceNormalizedEvent,
  runState,
  snapshotEvents,
  updateCompatibility,
  type ChatExecutionSnapshot,
  type Compatibility,
  type NativePatch,
  type NormalizedExecutionEvent,
  type RunState,
  type SessionSource,
  type VSCodeEvent,
} from './vscode-chat-state.js';
import {
  RESOURCE_SCHEME,
  SESSION_ID,
  buildSessionUrl,
  exactOpenCompatibility,
  launchUrl,
  nativeSessionActive,
  nativeSessionResource,
} from './vscode-app.js';
import {
  applyNativeJournalPatches,
  inspectCompatibility,
  nativeProjectionFromFile,
  workspaceMetadata,
  type WorkspaceMetadata,
} from './vscode-session-files.js';

const CLIENT_NAME = 'vscode-agent-host';
const MIN_SCAN_INTERVAL_MS = 100;
const SCAN_INTERVAL_MS = 200;
const SCHEMA_VERSION = 1;

interface StartupReplay {
  slot: VSCodeSlot;
  eventOffset: number | null;
  eventIdentity: string | null;
  journalOffset: number | null;
  journalIdentity: string | null;
}

/** One key on the physical keyboard, bound to a VS Code session or idle. */
export interface VSCodeSlot {
  /** Fixed integration slot index (0..INTEGRATION_SLOT_COUNT-1). */
  slot: number;
  /** Bound session UUID; omitted for idle/unbound public slots. */
  sessionId?: string;
  /** Absolute project path for the bound session. */
  cwd?: string;
  /** Transcript/event JSONL path for diagnostics and doctor checks. */
  eventsPath?: string;
  /** Native journal JSONL path; null/omitted for Agent Host sessions. */
  journalPath?: string | null;
  /** Session source discriminator (`native` or `copilot-cli`). */
  source?: SessionSource;
  /** Exact session resource included in VS Code open URLs. */
  resource?: string;
  /** Human-facing label shown on the slot (basename of cwd when bound). */
  label?: string;
  /** ISO timestamp when this slot was last bound to its current session. */
  boundAt?: string;
  /** Display state mapped to LEDs and APIs (`idle`/`running`/`input`/`done`/`error`). */
  state: string;
  /** ISO timestamp of the last state transition. */
  stateChangedAt?: string;
  /** ISO completion timestamp when state entered `done`; cleared on acknowledge/new prompt. */
  doneAt?: string | null;
  /** ISO timestamp of the latest event/snapshot applied to the slot state. */
  lastEventAt?: string | null;
  /** Machine-readable run error code when state is `error` (for example `incompatible:*`). */
  runError?: string | null;
  /** Last consumed transcript byte offset associated with this slot. */
  eventOffset?: number;
}

interface Session {
  /** Canonical VS Code chat session UUID (validated by {@link SESSION_ID}). */
  id: string;
  /** Absolute workspace path for the session, used for labels and exact-session URLs. */
  cwd: string;
  /** Path to the persisted transcript/event JSONL consumed by {@link readAppended}. */
  eventsPath: string;
  /** Path to the native chat-session journal JSONL, or null for Agent Host sessions. */
  journalPath: string | null;
  /** Origin of truth for this session (`native` transcript/journal or `copilot-cli`). */
  source: SessionSource;
  /** Exact session resource passed to VS Code via `?session=` when opening. */
  resource: string;
  /** Consumed byte offset within {@link eventsPath}. */
  offset: number;
  /** File identity (`dev:ino`) for {@link eventsPath} at the tracked {@link offset}. */
  identity: string | null;
  /** Consumed byte offset within {@link journalPath}. */
  journalOffset: number;
  /** File identity (`dev:ino`) for {@link journalPath} at the tracked {@link journalOffset}. */
  journalIdentity: string | null;
  /** Native journal projection used to derive authoritative native request state. */
  nativeProjection: NativeChatProjection;
  /** Last native projection snapshot applied during reconciliation. */
  nativeSnapshot: ChatExecutionSnapshot;
  /** Last observed native request count, used to detect newly inserted requests. */
  nativeRequestCount: number;
  /** Transcript prompts not yet matched by authoritative native request insertion. */
  pendingNativePrompts: number;
  /** Surplus native request insertions that arrived before transcript prompts. */
  pendingNativePromptCredits: number;
  /** Reduced execution state for slot mapping (running/input/error/done). */
  run: RunState;
  /** Producer/version/lifecycle support markers derived from observed events. */
  compatibility: Compatibility;
  /** Bound integration slot index, or null when unbound. */
  boundSlot: number | null;
  /** Consecutive scans where a previously bound session was not rediscovered. */
  missingScans: number;
  /** Timestamp of the latest applied event or normalized snapshot transition. */
  lastEventAt: string | null;
  /** Restart checkpoint used to replay persisted bindings before adopting live state. */
  startupReplay: StartupReplay | null;
}

/**
 * Discoverable VS Code session descriptor produced by filesystem scans before it is
 * merged into tracked {@link Session} state.
 */
interface Candidate {
  /** Canonical VS Code chat session UUID (validated by {@link SESSION_ID}). */
  id: string;
  /** Absolute workspace path resolved from workspace metadata/URI. */
  cwd: string;
  /** Path to the persisted transcript/event JSONL for this session. */
  eventsPath: string;
  /** Path to the native chat-session journal JSONL, or null for Agent Host sessions. */
  journalPath: string | null;
  /** Native workspace state database path used for active-session checks during initial scan. */
  indexPath?: string;
  /** Whether VS Code still lists this persisted native session as active during initial scan. */
  nativeActive?: boolean | null;
  /** Session source discriminator (`native` or `copilot-cli`). */
  source: SessionSource;
  /** Exact session resource used to open the chat in VS Code. */
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
  enabledSlots?: Iterable<number>;
  agentHostSource?: AgentHostStateSource;
  onSlot?: (slot: VSCodeSlot) => void | Promise<void>;
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
  agentHostSource: AgentHostStateSource | null;
  onSlot: (slot: VSCodeSlot) => void | Promise<void>;
  log: (...args: unknown[]) => void;
  launch: (url: string) => Promise<void>;
  nativeSessionActive: (indexPath: string, sessionId: string) => boolean | null;
  scanIntervalMs: number;
  enabledSlots: Set<number>;
  slots: (VSCodeSlot | null)[];
  sessions: Map<string, Session>;
  timer: NodeJS.Timeout | null;
  scanning: boolean;
  started: boolean;
  lifecycleVersion: number;

  /** Initializes integration paths, callbacks, and in-memory slot/session state. */
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
    this.agentHostSource = options.agentHostSource ?? null;
    this.onSlot = options.onSlot ?? (() => {});
    this.log = options.log ?? (() => {});
    this.launch = options.launch ?? launchUrl;
    this.nativeSessionActive = options.nativeSessionActive ?? nativeSessionActive;
    const requestedScanInterval = options.scanIntervalMs ?? SCAN_INTERVAL_MS;
    this.scanIntervalMs = Number.isFinite(requestedScanInterval)
      ? Math.max(MIN_SCAN_INTERVAL_MS, requestedScanInterval)
      : SCAN_INTERVAL_MS;
    this.enabledSlots = new Set(
      options.enabledSlots ?? Array.from({ length: INTEGRATION_SLOT_COUNT }, (_, index) => index)
    );
    this.slots = Array(INTEGRATION_SLOT_COUNT).fill(null);
    this.sessions = new Map();
    this.timer = null;
    this.scanning = false;
    this.started = false;
    this.lifecycleVersion = 0;
  }

  /** Loads persisted slots and sessions, preparing bound sessions for startup replay. */
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
      const nativeProjection = nativeProjectionFromFile(raw.journalPath ?? null);
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
        nativeProjection,
        nativeSnapshot: nativeProjection.snapshot(),
        nativeRequestCount: nativeProjection.requestCount(),
        pendingNativePrompts: 0,
        pendingNativePromptCredits: 0,
        run: emptyRun(),
        compatibility: { ...emptyCompatibility(), ...raw.compatibility },
        boundSlot: null,
        missingScans: 0,
        lastEventAt: raw.lastEventAt ?? null,
        startupReplay: null,
      });
    }
    for (let index = 0; index < INTEGRATION_SLOT_COUNT; index++) {
      if (!this.enabledSlots.has(index)) continue;
      const raw = saved.slots?.[index];
      if (!raw || !SESSION_ID.test(raw.sessionId ?? '')) continue;
      const sessionId = raw.sessionId as string;
      let session = this.sessions.get(sessionId);
      if (!session) {
        const nativeProjection = nativeProjectionFromFile(raw.journalPath ?? null);
        session = {
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
          nativeProjection,
          nativeSnapshot: nativeProjection.snapshot(),
          nativeRequestCount: nativeProjection.requestCount(),
          pendingNativePrompts: 0,
          pendingNativePromptCredits: 0,
          run: emptyRun(),
          compatibility: emptyCompatibility(),
          boundSlot: null,
          missingScans: 0,
          lastEventAt: null,
          startupReplay: null,
        };
      }
      const eventOffset = session.identity ? session.offset : null;
      const eventIdentity = session.identity;
      const journalOffset = session.journalIdentity ? session.journalOffset : null;
      const journalIdentity = session.journalIdentity;
      session.boundSlot = index;
      session.offset = 0;
      session.journalOffset = 0;
      session.nativeProjection.reset();
      session.nativeSnapshot = session.nativeProjection.snapshot();
      session.nativeRequestCount = 0;
      session.pendingNativePromptCredits = 0;
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

  /** Returns the canonical event-log path for a validated session ID. */
  eventsPath(id: string): string {
    if (!SESSION_ID.test(id)) throw new Error('invalid VS Code session id');
    return path.join(this.root, id, 'events.jsonl');
  }

  /** Persists current slots and tracked session metadata atomically to disk. */
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

  /** Starts protocol listeners, performs an initial scan, and schedules periodic scans. */
  async start(): Promise<void> {
    if (this.started) return;
    const lifecycleVersion = ++this.lifecycleVersion;
    this.load();
    this.started = true;
    this.agentHostSource?.start(
      (sessionId, state) => this.applyAgentHostChatState(sessionId, state).then(() => undefined),
      (sessionIds) => this.markAgentHostStateUnavailable(sessionIds)
    );
    try {
      await this.scan(true);
    } catch (err) {
      this.log(`VS Code initial scan failed: ${(err as Error).message}`);
    }
    if (!this.started || this.lifecycleVersion !== lifecycleVersion) return;
    this.timer = setInterval(
      () => this.scan().catch((err: unknown) => this.log(`VS Code scan failed: ${(err as Error).message}`)),
      this.scanIntervalMs
    );
    this.timer.unref?.();
  }

  /** Stops scanning, stops protocol listeners, and saves state if started. */
  stop(): void {
    this.lifecycleVersion++;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.agentHostSource?.stop();
    if (this.started) this.save();
    this.started = false;
  }

  /** Validates and returns an Agent Host session candidate from session-state files. */
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

  /** Discovers native VS Code transcript/journal pairs as scan candidates. */
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
        candidates.push({
          id,
          cwd,
          eventsPath,
          journalPath: chatPath,
          indexPath,
          source: SOURCE_NATIVE,
          resource: nativeSessionResource(id),
          nativeActive: initial && persistedSlot
            ? this.nativeSessionActive(indexPath, id)
            : null,
        });
      }
    }
    return candidates;
  }

  /** Reconciles discovered candidates with tracked sessions and updates published slots. */
  async scan(initial = false): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    const previousSlots = this.slots.map((slot) => slot ? { ...slot } : null);
    const startupSlots = new Set<number>();
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
          const nativeProjection = initial
            ? nativeProjectionFromFile(admitted.journalPath ?? null)
            : new NativeChatProjection();
          session = {
            id,
            cwd: admitted.cwd,
            eventsPath: admitted.eventsPath,
            journalPath: admitted.journalPath ?? null,
            source: admitted.source,
            resource: admitted.resource,
            offset: initial ? stat.size : 0,
            identity: `${stat.dev}:${stat.ino}`,
            journalOffset: admitted.journalPath && initial ? fs.statSync(admitted.journalPath).size : 0,
            journalIdentity: admitted.journalPath
              ? `${fs.statSync(admitted.journalPath).dev}:${fs.statSync(admitted.journalPath).ino}`
              : null,
            nativeProjection,
            nativeSnapshot: nativeProjection.snapshot(),
            nativeRequestCount: nativeProjection.requestCount(),
            pendingNativePrompts: 0,
            pendingNativePromptCredits: 0,
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
        const startup = session.startupReplay;
        const checkpointSessionIds = new Set([
          session.id,
          ...this.slots.flatMap((slot) => slot?.sessionId ? [slot.sessionId] : []),
        ]);
        const checkpoint = {
          offset: session.offset,
          identity: session.identity,
          journalOffset: session.journalOffset,
          journalIdentity: session.journalIdentity,
          pendingNativePrompts: session.pendingNativePrompts,
          pendingNativePromptCredits: session.pendingNativePromptCredits,
          run: cloneRun(session.run),
          compatibility: { ...session.compatibility },
          lastEventAt: session.lastEventAt,
          slots: this.slots.map((slot) => slot ? { ...slot } : null),
          boundSlots: new Map([...checkpointSessionIds].map((sessionId) => [
            sessionId,
            this.sessions.get(sessionId)?.boundSlot ?? null,
          ])),
        };
        let changedWhileStopped = false;
        try {
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
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (typeof code !== 'string') throw err;
          session.offset = checkpoint.offset;
          session.identity = checkpoint.identity;
          session.journalOffset = checkpoint.journalOffset;
          session.journalIdentity = checkpoint.journalIdentity;
          session.pendingNativePrompts = checkpoint.pendingNativePrompts;
          session.pendingNativePromptCredits = checkpoint.pendingNativePromptCredits;
          session.run = checkpoint.run;
          session.compatibility = checkpoint.compatibility;
          session.lastEventAt = checkpoint.lastEventAt;
          this.slots = checkpoint.slots;
          for (const [sessionId, boundSlot] of checkpoint.boundSlots) {
            const tracked = this.sessions.get(sessionId);
            if (tracked) tracked.boundSlot = boundSlot;
          }
          this.log(`VS Code stream read failed session=${session.id} source=${session.source} code=${code}`);
          continue;
        }
        if (startup) {
          const slot = this.slots[startup.slot.slot];
          if (slot?.sessionId === session.id) {
            const staleIncompatibility = startup.slot.runError?.startsWith('incompatible:') &&
              session.run.error !== startup.slot.runError;
            const staleNativeRunning = session.source === SOURCE_NATIVE &&
              startup.slot.state === 'running' &&
              slot.state === 'done';
            if (!changedWhileStopped && !staleIncompatibility && !staleNativeRunning) {
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
            startupSlots.add(slot.slot);
            if (
              initial &&
              admitted.nativeActive === false &&
              slot.state !== 'done' &&
              slot.state !== 'idle'
            ) {
              session.boundSlot = null;
              this.slots[slot.slot] = null;
            }
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
          this.log(`Released stale VS Code slot ${slot.slot} for ${slot.sessionId.slice(0, 8)}`);
          continue;
        }
        session.missingScans++;
        if (session.missingScans < 3 || slot.runError === 'event-stream-missing') continue;
        slot.state = 'error';
        slot.runError = 'event-stream-missing';
        slot.stateChangedAt = new Date().toISOString();
      }
      for (const index of this.enabledSlots) {
        const previous = previousSlots[index];
        const current = this.slots[index];
        const changed =
          previous?.sessionId !== current?.sessionId ||
          previous?.state !== current?.state ||
          previous?.runError !== current?.runError;
        if (!changed && !startupSlots.has(index)) continue;
        await this.onSlot(
          current
            ? { ...current }
            : { slot: index, state: 'idle', stateChangedAt: new Date().toISOString() }
        );
      }
      this.save();
    } finally {
      this.scanning = false;
      this.agentHostSource?.setSessions(
        [...this.sessions.values()]
          .filter((session) => session.source === SOURCE_COPILOT_CLI && session.boundSlot !== null)
          .map((session) => session.id)
      );
    }
  }

    /** Reads newly appended transcript events and applies them to a tracked session. */
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
          await this.applyEvent(
            session,
            JSON.parse(line) as VSCodeEvent
          );
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

  /** Reads newly appended native journal patches and reconciles authoritative state. */
  async readJournalAppended(session: Session): Promise<void> {
    if (!session.journalPath) return;
    const stat = fs.statSync(session.journalPath);
    const identity = `${stat.dev}:${stat.ino}`;
    const reset = Boolean(session.journalIdentity && session.journalIdentity !== identity) || stat.size < session.journalOffset;
    if (reset) session.journalOffset = 0;
    const rebuild = reset || Boolean(session.startupReplay && session.journalOffset === 0);
    session.journalIdentity = identity;
    if (stat.size === session.journalOffset) {
      if (rebuild) session.nativeProjection.reset();
      await this.reconcileNativeSnapshot(
        session,
        session.nativeProjection.snapshot(session.run.pendingPermissionIds)
      );
      return;
    }
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
    const patches: NativePatch[] = [];
    for (const line of lines) {
      const bytes = Buffer.byteLength(line) + 1;
      if (line.trim()) {
        try {
          patches.push(JSON.parse(line) as NativePatch);
        } catch (err) {
          if (err instanceof SyntaxError) this.log(`Malformed VS Code journal at ${session.id.slice(0, 8)}:${offset}`);
          else throw err;
        }
      }
      offset += bytes;
    }
    session.journalOffset = offset;
    applyNativeJournalPatches(session.nativeProjection, patches, rebuild);
    await this.reconcileNativeSnapshot(
      session,
      session.nativeProjection.snapshot(session.run.pendingPermissionIds)
    );
  }

  /** Applies a native snapshot to run state while honoring prompt/journal ordering barriers. */
  async reconcileNativeSnapshot(session: Session, current: ChatExecutionSnapshot): Promise<void> {
    const previous = session.nativeSnapshot;
    const requestCount = session.nativeProjection.requestCount();
    const insertedRequests = Math.max(0, requestCount - session.nativeRequestCount);
    if (insertedRequests > 0) {
      const unresolvedPrompts = session.pendingNativePrompts - insertedRequests;
      session.pendingNativePrompts = Math.max(0, unresolvedPrompts);
      if (unresolvedPrompts < 0) {
        session.pendingNativePromptCredits += Math.abs(unresolvedPrompts);
      }
    } else if (current.requestId !== previous.requestId && session.pendingNativePrompts > 0) {
      session.pendingNativePrompts--;
    }
    session.nativeRequestCount = requestCount;
    session.nativeSnapshot = current;

    if (session.pendingNativePrompts > 0 || !current.requestId) return;

    const normalized = snapshotEvents(session.run, current, {
      deferPendingPermissions: true,
      incompatibilities: this.incompatibilityEvents(session, current),
      reportTerminal:
        previous.requestId !== current.requestId || previous.terminal !== current.terminal,
    });
    if (normalized.length === 0) return;
    const completedAt = session.nativeProjection.completionTimestamp();
    const timestamp = completedAt && current.terminal
      ? new Date(completedAt).toISOString()
      : new Date().toISOString();
    await this.applyNormalizedEvents(session, normalized, timestamp);
  }

  /** Builds normalized incompatibility events and emits one diagnostic log per new mismatch. */
  incompatibilityEvents(session: Session, current: ChatExecutionSnapshot): NormalizedExecutionEvent[] {
    const events: NormalizedExecutionEvent[] = [];
    if (!current.requestId) return events;
    const vscodeVersion = current.incompatibilities.length > 0
      ? exactOpenCompatibility().version ?? 'unknown'
      : null;
    for (const incompatibility of current.incompatibilities) {
      const error = `incompatible:${incompatibility.code}`;
      if (session.run.requestId !== current.requestId || session.run.error !== error) {
        const detail = incompatibility.code === 'unknown-native-response'
          ? `stateType=${incompatibility.stateType}`
          : incompatibility.code === 'unknown-agent-host-tool-status'
            ? `toolStatus=${incompatibility.toolStatus}`
            : `chatStatus=${incompatibility.chatStatus}`;
        this.log(
          `Incompatible VS Code execution state session=${session.id} request=${current.requestId} ` +
          `source=${incompatibility.source} responsePart=${incompatibility.responsePartKind} ${detail} vscode=${vscodeVersion}`
        );
      }
      events.push({
        type: 'request.incompatible',
        requestId: current.requestId,
        code: incompatibility.code,
      });
    }
    return events;
  }

  /** Applies one complete Agent Host protocol chat snapshot. The persisted
   * source is not available yet; its adapter can feed this method directly. */
  async applyAgentHostChatState(sessionId: string, state: unknown): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || session.source !== SOURCE_COPILOT_CLI || session.boundSlot === null) return false;
    const projection = new AgentHostChatProjection();
    projection.apply(state);
    const current = projection.snapshot();
    if (!current.requestId) return false;

    const normalized = snapshotEvents(session.run, current, {
      restarted: session.run.error === 'agent-host-state-unavailable',
      incompatibilities: this.incompatibilityEvents(session, current),
    });
    if (normalized.length === 0) return false;
    await this.applyNormalizedEvents(session, normalized, new Date().toISOString());
    this.save();
    return true;
  }

  /** Marks active bound Agent Host sessions as unavailable when protocol state is lost. */
  async markAgentHostStateUnavailable(sessionIds: readonly string[]): Promise<void> {
    const timestamp = new Date().toISOString();
    let changed = false;
    for (const sessionId of sessionIds) {
      const session = this.sessions.get(sessionId);
      if (
        !session ||
        session.source !== SOURCE_COPILOT_CLI ||
        session.boundSlot === null ||
        !session.run.active
      ) continue;
      const slot = this.slots[session.boundSlot];
      if (!slot || session.run.error === 'agent-host-state-unavailable') continue;
      session.run.error = 'agent-host-state-unavailable';
      slot.state = 'error';
      slot.runError = session.run.error;
      slot.lastEventAt = timestamp;
      slot.stateChangedAt = timestamp;
      this.log(`Agent Host protocol state unavailable session=${session.id}`);
      await this.onSlot({ ...slot });
      changed = true;
    }
    if (changed) this.save();
  }

  /** Applies normalized reducer events to run/slot state and emits slot updates on change. */
  async applyNormalizedEvents(
    session: Session,
    events: NormalizedExecutionEvent[],
    timestamp: string
  ): Promise<void> {
    let state = runState(session.run);
    for (const event of events) state = reduceNormalizedEvent(session.run, event);
    session.lastEventAt = timestamp;
    if (session.boundSlot === null) return;
    const slot = this.slots[session.boundSlot];
    if (!slot) return;
    const changed = slot.state !== state;
    slot.state = state;
    slot.lastEventAt = timestamp;
    slot.eventOffset = session.offset;
    slot.runError = session.run.error;
    if (changed) slot.stateChangedAt = timestamp;
    if (state === 'done' && changed) slot.doneAt = timestamp;
    if (changed && !session.startupReplay && !this.scanning) await this.onSlot({ ...slot });
  }

  /** Ensures a session is bound to a slot, reusing an inactive slot when needed. */
  allocate(session: Session, timestamp?: string | null): number | null {
    if (session.boundSlot !== null) return session.boundSlot;
    let index = [...this.enabledSlots].find((slot) => this.slots[slot] === null) ?? -1;
    if (index < 0) {
      const reusable = this.slots
        .filter(
          (slot): slot is VSCodeSlot =>
            slot !== null && this.enabledSlots.has(slot.slot) && (slot.state === 'done' || slot.state === 'idle')
        )
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

  /** Returns whether any tracked session has verified supported producer lifecycle markers. */
  providerVerified(): boolean {
    return [...this.sessions.values()].some(
      (session) =>
        session.compatibility.supported &&
        session.compatibility.sawPrompt &&
        session.compatibility.sawSessionEnd
    );
  }

  /** Applies one transcript- or hook-derived event to session and bound-slot state. */
  async applyEvent(session: Session, event: VSCodeEvent): Promise<void> {
    updateCompatibility(session.compatibility, event, session.source);
    const transition = reduceEvent(session.run, event, session.source, session.cwd);
    session.run = transition.run;
    if (transition.prompt && session.source === SOURCE_NATIVE) {
      session.pendingNativePrompts++;
      if (session.pendingNativePromptCredits > 0) {
        const resolvedPrompts = Math.min(session.pendingNativePrompts, session.pendingNativePromptCredits);
        session.pendingNativePrompts -= resolvedPrompts;
        session.pendingNativePromptCredits -= resolvedPrompts;
      }
    }
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
    if ((allocated || changed) && !session.startupReplay && !this.scanning) {
      await this.onSlot({ ...slot });
    }
  }

  /** Maps supported native hook events into normalized integration events. */
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
      hook.hookEventName === 'PermissionRequest' &&
      typeof hook.toolUseId === 'string' &&
      hook.toolUseId
    ) {
      await this.applyEvent(session, {
        type: 'permission.requested',
        data: { requestId: nativeHookToolCallId(hook.toolUseId) },
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

  /** Replaces the sparse set of physical AG indices available to VS Code sessions. */
  async setEnabledSlots(indices: Iterable<number>): Promise<void> {
    const next = new Set(
      [...indices]
        .filter((index) => Number.isInteger(index) && index >= 0 && index < INTEGRATION_SLOT_COUNT)
        .sort((a, b) => a - b)
    );
    const changed = new Set([...this.enabledSlots, ...next].filter((index) => this.enabledSlots.has(index) !== next.has(index)));
    if (!changed.size) return;

    for (const index of changed) {
      const binding = this.slots[index];
      if (binding?.sessionId) {
        const session = this.sessions.get(binding.sessionId);
        if (session) {
          session.boundSlot = null;
          session.startupReplay = null;
        }
      }
      this.slots[index] = null;
    }
    this.enabledSlots = next;
    this.agentHostSource?.setSessions(
      [...this.sessions.values()]
        .filter((session) => session.source === SOURCE_COPILOT_CLI && session.boundSlot !== null)
        .map((session) => session.id)
    );
    if (this.started) this.save();

    const stateChangedAt = new Date().toISOString();
    for (const slot of changed) await this.onSlot({ slot, state: 'idle', stateChangedAt });
  }

  /** Returns enabled physical slots, filling unbound entries as idle slots. */
  publicSlots(): VSCodeSlot[] {
    return [...this.enabledSlots].map((index) => {
      const slot = this.slots[index];
      return slot ? { ...slot } : { slot: index, state: 'idle' };
    });
  }

  /** Clears all slot bindings and publishes idle across the full firmware slot range. */
  async resetSlots(): Promise<VSCodeSlot[]> {
    for (const session of this.sessions.values()) {
      session.boundSlot = null;
      session.startupReplay = null;
    }
    this.slots.fill(null);
    this.agentHostSource?.setSessions([]);
    this.save();

    const stateChangedAt = new Date().toISOString();
    for (let slot = 0; slot < INTEGRATION_SLOT_COUNT; slot++) {
      await this.onSlot({ slot, state: 'idle', stateChangedAt });
    }
    return this.publicSlots();
  }

  /** Opens the exact VS Code session for a slot and handles post-open acknowledgement rules. */
  async open(index: number): Promise<{ slot: VSCodeSlot; url: string }> {
    if (!Number.isInteger(index) || index < 0 || index >= INTEGRATION_SLOT_COUNT) {
      throw new Error(`VS Code slot must be 0..${INTEGRATION_SLOT_COUNT - 1}`);
    }
    if (!this.enabledSlots.has(index)) throw new Error(`VS Code slot ${index} is not mapped on the keyboard`);
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
      await this.onSlot({ ...slot });
      this.save();
      throw new Error(`project path does not exist: ${slot.cwd}`);
    }
    const url = buildSessionUrl(slot.cwd, slot.sessionId, slot.resource);
    await this.launch(url);
    const current = this.slots[index];
    if (current?.sessionId === sessionId) {
      if (current.state === 'error') {
        session.boundSlot = null;
        this.slots[index] = null;
        this.agentHostSource?.setSessions(
          [...this.sessions.values()]
            .filter((candidate) => candidate.source === SOURCE_COPILOT_CLI && candidate.boundSlot !== null)
            .map((candidate) => candidate.id)
        );
        await this.onSlot({ slot: index, state: 'idle', stateChangedAt: new Date().toISOString() });
        this.save();
      } else if (current.state === 'done') {
        current.state = 'idle';
        current.stateChangedAt = new Date().toISOString();
        await this.onSlot({ ...current });
        this.save();
      }
    }
    const publicSlot = this.slots[index];
    return { slot: publicSlot ? { ...publicSlot } : { slot: index, state: 'idle' }, url };
  }

  /** Reports integration readiness and per-slot diagnostics for troubleshooting. */
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
