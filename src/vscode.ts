import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import { CLAUDE_SESSION_ID, type ClaudeHookEvent } from './claude-hooks.js';
import type { AgentHostSession, AgentHostStateSource } from './agent-host.js';
import { INTEGRATION_SLOT_COUNT } from './states.js';
import {
  AgentHostChatProjection,
  emptyRun,
  reduceNormalizedEvent,
  runState,
  snapshotEvents,
  type RunState,
} from './vscode-chat-state.js';
import { SESSION_ID, buildSessionUrl } from './session-url.js';

const SCHEMA_VERSION = 2;
const isClaude = (id: string): boolean => id.startsWith('claude:');
const validSessionId = (id: string): boolean => isClaude(id) ? CLAUDE_SESSION_ID.test(id.slice(7)) : SESSION_ID.test(id);
const observation = (id: string): 'ahp' | 'claude-hooks' => isClaude(id) ? 'claude-hooks' : 'ahp';

/** One physical integration slot, either unbound or bound to an AHP session. */
export interface VSCodeSlot {
  /** Fixed integration slot index (0..INTEGRATION_SLOT_COUNT-1). */
  slot: number;
  /** Bound AHP session UUID; omitted for unbound public slots, not acknowledged idle bindings. */
  sessionId?: string;
  /** Absolute local project path for the bound session. */
  cwd?: string;
  /** Exact editor session resource included in VS Code's `session` URL parameter. */
  resource?: string;
  /** Human-facing label shown on the slot (basename of cwd when bound). */
  label?: string;
  /** ISO timestamp when this slot was last bound to its current session. */
  boundAt?: string;
  /** Display state mapped to LEDs and APIs (`idle`/`running`/`input`/`done`/`error`). */
  state: string;
  /** ISO timestamp of the last display-state transition. */
  stateChangedAt?: string;
  /** ISO timestamp when state entered `done`; retained on acknowledgement, cleared on a new request. */
  doneAt?: string | null;
  /** Local ISO timestamp of the latest AHP reconciliation applied to this slot's state. */
  lastEventAt?: string | null;
  /** Machine-readable error code, such as `incompatible:*` or `agent-host-state-unavailable`. */
  runError?: string | null;
  /** Authoritative observation source for bound slots; omitted for unbound public slots. */
  observation?: 'ahp' | 'claude-hooks';
}

interface Session {
  /** AHP session UUID (validated by {@link SESSION_ID}), not an SDK alias or chat-channel UUID. */
  id: string;
  /** Absolute local project path used for labels and exact-session URLs. */
  cwd: string;
  /** Editor session resource passed to VS Code via `?session=`, not the AHP chat subscription channel. */
  resource: string;
  /** Reduced AHP execution state; retained independently of the slot's completion acknowledgement. */
  run: RunState;
  /** Bound integration slot index, or null when unbound. */
  boundSlot: number | null;
  /** Whether AHP state has been received since restoration or the last reported source loss. */
  available: boolean;
}

interface PersistedState {
  schemaVersion: number;
  slots?: (VSCodeSlot | null)[];
  sessions?: {
    id: string;
    cwd?: string;
    resource?: string;
    observation?: string;
    requestId?: string | null;
    terminal?: RunState['terminal'];
  }[];
}

export interface VSCodeIntegrationOptions {
  statePath: string;
  uriScheme?: string;
  enabledSlots?: Iterable<number>;
  agentHostSource: AgentHostStateSource;
  onSlot?: (slot: VSCodeSlot) => void | Promise<void>;
  log?: (...args: unknown[]) => void;
  launch: (url: string) => Promise<void>;
}

export interface SessionStatus {
  observation: 'ahp';
  trackedSessions: number;
  availableSessions: number;
  bindings: (VSCodeSlot & { projectExists: boolean | null; available: boolean })[];
}

export class VSCodeIntegration {
  readonly statePath: string;
  readonly uriScheme: string;
  readonly agentHostSource: AgentHostStateSource;
  readonly onSlot: (slot: VSCodeSlot) => void | Promise<void>;
  readonly log: (...args: unknown[]) => void;
  readonly launch: (url: string) => Promise<void>;
  enabledSlots: Set<number>;
  slots: (VSCodeSlot | null)[] = Array(INTEGRATION_SLOT_COUNT).fill(null);
  sessions = new Map<string, Session>();
  started = false;
  private lifecycleVersion = 0;

  constructor(options: VSCodeIntegrationOptions) {
    this.statePath = options.statePath;
    this.uriScheme = options.uriScheme ?? 'vscode';
    this.agentHostSource = options.agentHostSource;
    this.onSlot = options.onSlot ?? (() => {});
    this.log = options.log ?? (() => {});
    this.launch = options.launch;
    this.enabledSlots = new Set(options.enabledSlots ??
      Array.from({ length: INTEGRATION_SLOT_COUNT }, (_, index) => index));
  }

  load(): void {
    let saved: PersistedState;
    try {
      saved = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as PersistedState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error(`cannot read VS Code integration state: ${(error as Error).message}`);
    }
    if (saved.schemaVersion !== SCHEMA_VERSION) {
      throw new Error(`unsupported VS Code integration state schema ${saved.schemaVersion}`);
    }
    for (const raw of saved.sessions ?? []) {
      if (!validSessionId(raw.id) || !raw.cwd || !path.isAbsolute(raw.cwd) || !raw.resource) {
        throw new Error('invalid persisted AHP session');
      }
      const run = emptyRun();
      run.requestId = raw.requestId ?? null;
      run.terminal = raw.terminal ?? null;
      this.sessions.set(raw.id, {
        id: raw.id, cwd: raw.cwd, resource: raw.resource,
        run, boundSlot: null, available: false,
      });
    }
    for (const index of this.enabledSlots) {
      const raw = saved.slots?.[index];
      const session = raw?.sessionId ? this.sessions.get(raw.sessionId) : undefined;
      if (!raw || !session) continue;
      if (session.boundSlot !== null) throw new Error('duplicate persisted AHP binding');
      session.boundSlot = index;
      // Reconcile bound sessions from the host, not a persisted execution snapshot.
      const unavailable = raw.state === 'running' || raw.state === 'input' || raw.state === 'error';
      if (unavailable) {
        session.run.active = true;
        session.run.error = isClaude(session.id) ? 'claude-hook-state-unavailable' : 'agent-host-state-unavailable';
      }
      this.slots[index] = {
        slot: index, sessionId: session.id, cwd: session.cwd, resource: session.resource,
        observation: observation(session.id), label: path.basename(session.cwd), boundAt: raw.boundAt,
        state: unavailable ? 'error' : raw.state,
        stateChangedAt: unavailable ? new Date().toISOString() : raw.stateChangedAt,
        doneAt: raw.doneAt, lastEventAt: raw.lastEventAt,
        runError: unavailable ? session.run.error : null,
      };
    }
  }

  save(): void {
    const state: PersistedState = {
      schemaVersion: SCHEMA_VERSION,
      slots: this.slots,
      sessions: [...this.sessions.values()].map(({ id, cwd, resource, run }) => ({
        id, cwd, resource, observation: observation(id), requestId: run.requestId, terminal: run.terminal,
      })),
    };
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this.statePath);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.load();
    this.started = true;
    const lifecycle = ++this.lifecycleVersion;
    for (const slot of this.publicSlots()) {
      await this.onSlot(slot);
      if (!this.started || lifecycle !== this.lifecycleVersion) return;
    }
    this.updateTargets();
    this.agentHostSource.start(
      async (id, state, descriptor) => {
        if (this.started && lifecycle === this.lifecycleVersion) {
          await this.applyAgentHostChatState(id, state, descriptor);
        }
      },
      async (ids) => {
        if (this.started && lifecycle === this.lifecycleVersion) await this.markAgentHostStateUnavailable(ids);
      }
    );
    this.save();
  }

  stop(): void {
    ++this.lifecycleVersion;
    this.agentHostSource.stop();
    if (this.started) this.save();
    this.started = false;
  }

  private updateTargets(): void {
    this.agentHostSource.setSessions([...this.sessions.values()]
      .filter((session) => session.boundSlot !== null && !isClaude(session.id)).map((session) => session.id));
  }

  async applyClaudeHook(event: ClaudeHookEvent): Promise<void> {
    if (event.agent_id) return;
    const id = `claude:${event.session_id}`;
    let session = this.sessions.get(id);
    if (event.hook_event_name === 'SessionEnd') {
      if (!session) return;
      if (session.boundSlot !== null) {
        const index = session.boundSlot;
        this.slots[index] = null;
        await this.onSlot({ slot: index, state: 'idle' });
      }
      this.sessions.delete(id);
      this.save();
      return;
    }
    if (!session) {
      session = {
        id, cwd: event.cwd, resource: `claude-code:/${event.session_id}`,
        run: emptyRun(), boundSlot: null, available: true,
      };
      this.sessions.set(id, session);
    }
    session.cwd = event.cwd;
    session.available = true;
    const run = session.run;
    const name = event.hook_event_name;
    if (event.prompt_id && run.requestId && name !== 'UserPromptSubmit' && name !== 'SessionStart' &&
        event.prompt_id !== run.requestId) return;
    const elicitation = `elicitation:${event.elicitation_id ?? event.mcp_server_name ?? 'unknown'}`;
    if (name === 'UserPromptSubmit') {
      if (event.prompt_id && event.prompt_id === run.requestId) return;
      session.run = emptyRun();
      reduceNormalizedEvent(session.run, { type: 'request.started', requestId: event.prompt_id || randomUUID() });
      if (session.boundSlot === null) this.allocate(session);
    } else if (name === 'SessionStart') {
      // A resumed session is not evidence that its previous turn is still running.
      session.run = emptyRun();
    } else if (run.requestId) {
      // Another Stop hook can continue the turn; subsequent tool activity is evidence of that.
      if (name === 'PreToolUse' && run.terminal === 'complete') {
        reduceNormalizedEvent(run, { type: 'request.started', requestId: run.requestId });
      }
      if (!run.active) return;
      const requestId = run.requestId;
      if (name !== 'Notification') run.error = null;
      if (name === 'Stop' || name === 'StopFailure') {
        reduceNormalizedEvent(run, {
          type: 'request.finished', requestId, outcome: name === 'Stop' ? 'complete' : 'failed',
        });
      } else if (name === 'PermissionRequest' ||
          (name === 'Notification' && event.notification_type === 'permission_prompt')) {
        reduceNormalizedEvent(run, { type: 'human-input.opened', requestId, blockerId: 'permission', kind: 'tool-confirmation' });
      } else if (name === 'Elicitation') {
        reduceNormalizedEvent(run, {
          type: 'human-input.opened', requestId, blockerId: elicitation, kind: 'elicitation',
          sourceId: event.mcp_server_name,
        });
      } else if (name === 'ElicitationResult') {
        run.blockers.delete(elicitation);
      } else if (name === 'PreToolUse' && event.tool_name === 'AskUserQuestion') {
        reduceNormalizedEvent(run, {
          type: 'human-input.opened', requestId, blockerId: event.tool_use_id ?? 'question', kind: 'question',
        });
      } else if (name === 'PostToolUse' || name === 'PostToolUseFailure') {
        run.blockers.delete('permission');
        run.blockers.delete(event.tool_use_id ?? 'question');
        // Hook-answered elicitations skip ElicitationResult; the enclosing tool still finishes.
        if (event.tool_name?.startsWith('mcp__')) {
          const server = event.tool_name.split('__')[1];
          for (const blocker of run.blockers.values()) {
            if (blocker.kind === 'elicitation' && blocker.sourceId === server) run.blockers.delete(blocker.id);
          }
        }
      }
    }
    const slot = session.boundSlot === null ? null : this.slots[session.boundSlot];
    if (slot) {
      const next = runState(session.run);
      const timestamp = new Date().toISOString();
      // Completion acknowledgement survives repeated terminal hooks.
      if (!(slot.state === 'idle' && session.run.terminal && name !== 'UserPromptSubmit')) {
        if (slot.state !== next) slot.stateChangedAt = timestamp;
        if (next === 'done' && slot.state !== 'done') slot.doneAt = timestamp;
        slot.state = next;
      }
      if (name === 'UserPromptSubmit') slot.doneAt = null;
      slot.cwd = session.cwd;
      slot.label = path.basename(session.cwd);
      slot.runError = session.run.error;
      slot.lastEventAt = timestamp;
      await this.onSlot({ ...slot });
    }
    this.save();
  }

  async applyAgentHostChatState(id: string, state: unknown, descriptor?: AgentHostSession): Promise<boolean> {
    if (!SESSION_ID.test(id) || (descriptor && (descriptor.id !== id || !path.isAbsolute(descriptor.cwd)))) {
      throw new Error('invalid AHP session descriptor');
    }
    let session = this.sessions.get(id);
    if (!session) {
      if (!descriptor) throw new Error('AHP session state has no advertised identity');
      session = {
        id, cwd: descriptor.cwd, resource: descriptor.resource,
        run: emptyRun(), boundSlot: null, available: true,
      };
      this.sessions.set(id, session);
    }
    session.available = true;
    if (descriptor) {
      session.cwd = descriptor.cwd;
      session.resource = descriptor.resource;
    }
    const projection = new AgentHostChatProjection();
    projection.apply(state);
    const current = projection.snapshot();
    const newRequest = current.requestId !== session.run.requestId;
    const allocated = current.active && newRequest && session.boundSlot === null
      ? this.allocate(session) !== null : false;
    const slot = session.boundSlot === null ? null : this.slots[session.boundSlot];
    if (slot) {
      slot.resource = session.resource;
      slot.cwd = session.cwd;
      slot.label = path.basename(session.cwd);
      if (newRequest) slot.doneAt = null;
    }
    const timestamp = new Date().toISOString();
    const incompatibilities = current.incompatibilities.map((incompatibility) => {
      if (session.run.requestId !== current.requestId || session.run.error !== `incompatible:${incompatibility.code}`) {
        this.log(`Incompatible AHP execution state session=${id} request=${current.requestId} code=${incompatibility.code}`);
      }
      return { type: 'request.incompatible' as const, requestId: current.requestId!, code: incompatibility.code };
    });
    const events = snapshotEvents(session.run, current, {
      restarted: session.run.error === 'agent-host-state-unavailable' || (current.active && !session.run.active),
      reportTerminal: newRequest || current.terminal !== session.run.terminal,
      incompatibilities,
    });
    if (!current.requestId) session.run = emptyRun();
    else for (const event of events) reduceNormalizedEvent(session.run, event);
    // Repeated terminal snapshots must not re-arm an acknowledged white key.
    const changed = !current.requestId || events.length > 0;
    if (slot && changed) {
      const nextState = current.requestId ? runState(session.run) : 'idle';
      const notify = allocated || slot.state !== nextState || slot.runError !== session.run.error;
      if (slot.state !== nextState) slot.stateChangedAt = timestamp;
      if (nextState === 'done' && slot.state !== 'done') slot.doneAt = timestamp;
      slot.state = nextState;
      slot.runError = session.run.error;
      slot.lastEventAt = timestamp;
      if (notify) await this.onSlot({ ...slot });
    }
    this.updateTargets();
    this.save();
    return changed;
  }

  async markAgentHostStateUnavailable(ids: readonly string[]): Promise<void> {
    const timestamp = new Date().toISOString();
    for (const id of ids) {
      const session = this.sessions.get(id);
      if (!session) continue;
      session.available = false;
      if (session.boundSlot === null || !session.run.active || session.run.error === 'agent-host-state-unavailable') continue;
      const slot = this.slots[session.boundSlot];
      if (!slot) continue;
      session.run.error = 'agent-host-state-unavailable';
      slot.state = 'error';
      slot.runError = session.run.error;
      slot.stateChangedAt = timestamp;
      this.log(`Agent Host protocol state unavailable session=${id}`);
      await this.onSlot({ ...slot });
    }
    this.save();
  }

  private allocate(session: Session): number | null {
    let index = [...this.enabledSlots].find((slot) => this.slots[slot] === null) ?? -1;
    if (index < 0) {
      const reusable = this.slots.filter((slot): slot is VSCodeSlot =>
        slot !== null && this.enabledSlots.has(slot.slot) && (slot.state === 'done' || slot.state === 'idle')
      ).sort((a, b) =>
        String(a.doneAt ?? a.stateChangedAt ?? '').localeCompare(String(b.doneAt ?? b.stateChangedAt ?? '')) ||
        a.slot - b.slot
      )[0];
      if (!reusable) {
        this.log(`No inactive VS Code slot available for ${session.id.slice(0, 8)}`);
        return null;
      }
      index = reusable.slot;
      const previous = reusable.sessionId ? this.sessions.get(reusable.sessionId) : undefined;
      if (previous) previous.boundSlot = null;
    }
    const timestamp = new Date().toISOString();
    session.boundSlot = index;
    this.slots[index] = {
      slot: index, sessionId: session.id, cwd: session.cwd, resource: session.resource,
      observation: observation(session.id), label: path.basename(session.cwd), boundAt: timestamp,
      state: 'running', stateChangedAt: timestamp, doneAt: null, lastEventAt: timestamp, runError: null,
    };
    return index;
  }

  async setEnabledSlots(indices: Iterable<number>): Promise<void> {
    const next = new Set([...indices].filter((index) =>
      Number.isInteger(index) && index >= 0 && index < INTEGRATION_SLOT_COUNT
    ).sort((a, b) => a - b));
    const changed = new Set([...this.enabledSlots, ...next].filter((index) => this.enabledSlots.has(index) !== next.has(index)));
    if (!changed.size) return;
    for (const index of changed) {
      const id = this.slots[index]?.sessionId;
      const session = id ? this.sessions.get(id) : undefined;
      if (session) session.boundSlot = null;
      this.slots[index] = null;
    }
    this.enabledSlots = next;
    this.updateTargets();
    if (this.started) this.save();
    for (const slot of changed) await this.onSlot({ slot, state: 'idle', stateChangedAt: new Date().toISOString() });
  }

  publicSlots(): VSCodeSlot[] {
    return [...this.enabledSlots].map((index) => this.slots[index] ? { ...this.slots[index] } : { slot: index, state: 'idle' });
  }

  async resetSlots(): Promise<VSCodeSlot[]> {
    for (const session of this.sessions.values()) session.boundSlot = null;
    this.slots.fill(null);
    this.updateTargets();
    this.save();
    for (const slot of this.enabledSlots) {
      await this.onSlot({ slot, state: 'idle', stateChangedAt: new Date().toISOString() });
    }
    return this.publicSlots();
  }

  async open(index: number): Promise<{ slot: VSCodeSlot; url: string }> {
    if (!Number.isInteger(index) || index < 0 || index >= INTEGRATION_SLOT_COUNT) {
      throw new Error(`VS Code slot must be 0..${INTEGRATION_SLOT_COUNT - 1}`);
    }
    if (!this.enabledSlots.has(index)) throw new Error(`VS Code slot ${index} is not activated`);
    const slot = this.slots[index];
    if (!slot?.sessionId || !slot.resource) throw new Error(`VS Code slot ${index} is unbound`);
    const session = this.sessions.get(slot.sessionId);
    if (!session) throw new Error('bound AHP session is missing');
    if (!slot.cwd || !fs.existsSync(slot.cwd)) {
      slot.state = 'error';
      slot.runError = 'project-path-missing';
      slot.stateChangedAt = new Date().toISOString();
      await this.onSlot({ ...slot });
      this.save();
      throw new Error(`project path does not exist: ${slot.cwd}`);
    }
    let url: string;
    if (isClaude(session.id)) {
      const project = new URL(`${this.uriScheme}://file`);
      project.pathname = slot.cwd;
      url = project.toString();
      this.log('Claude Code hooks do not provide conversation navigation; opening the project folder.');
    } else {
      url = buildSessionUrl(slot.cwd, slot.sessionId, slot.resource, this.uriScheme);
    }
    await this.launch(url);
    const current = this.slots[index];
    if (current?.sessionId === session.id) {
      if (current.state === 'error') {
        session.boundSlot = null;
        this.slots[index] = null;
        this.updateTargets();
        await this.onSlot({ slot: index, state: 'idle', stateChangedAt: new Date().toISOString() });
      } else if (current.state === 'done') {
        current.state = 'idle';
        current.stateChangedAt = new Date().toISOString();
        await this.onSlot({ ...current });
      }
      this.save();
    }
    return { slot: this.slots[index] ? { ...this.slots[index] } : { slot: index, state: 'idle' }, url };
  }

  status(): SessionStatus {
    const availableSessions = [...this.sessions.values()].filter((session) => session.available).length;
    return {
      observation: 'ahp', trackedSessions: this.sessions.size, availableSessions,
      bindings: this.publicSlots().map((slot) => ({
        ...slot, projectExists: slot.cwd ? fs.existsSync(slot.cwd) : null,
        available: slot.sessionId ? this.sessions.get(slot.sessionId)?.available === true : false,
      })),
    };
  }
}
