'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileURLToPath } = require('url');
const { execFile, execFileSync } = require('child_process');

const INTEGRATION_SLOT_COUNT = 4;
const CLIENT_NAME = 'vscode-agent-host';
const RESOURCE_SCHEME = 'agent-host-copilotcli';
const NATIVE_RESOURCE_SCHEME = 'vscode-chat-session';
const SOURCE_COPILOT_CLI = 'copilot-cli';
const SOURCE_NATIVE = 'native';
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCAN_INTERVAL_MS = 1000;
const SCHEMA_VERSION = 1;
const SUPPORTED_PRODUCER = 'copilot-agent';
const SUPPORTED_EVENT_VERSION = 1;
const SUPPORTED_VSCODE_VERSION = /^1\.131\./;
const VSCODE_APP = '/Applications/Visual Studio Code.app';

function parseYamlScalar(source, key) {
  const match = source.match(new RegExp(`^${key}:\\s*(.*?)\\s*$`, 'm'));
  if (!match) return null;
  const value = match[1];
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

function workspaceMetadata(source) {
  return {
    id: parseYamlScalar(source, 'id'),
    cwd: parseYamlScalar(source, 'cwd'),
    clientName: parseYamlScalar(source, 'client_name'),
  };
}

function eventKey(data, preferred, fallback) {
  return data?.[preferred] ?? data?.[fallback] ?? null;
}

function emptyRun() {
  return {
    error: null,
    turns: new Set(),
    tools: new Map(),
    questionHooksObserved: false,
    permissions: new Set(),
    completed: false,
  };
}

function emptyCompatibility() {
  return {
    producer: null,
    eventVersion: null,
    copilotVersion: null,
    sawPrompt: false,
    sawSessionEnd: false,
    supported: false,
  };
}

function updateCompatibility(compatibility, event, source = SOURCE_COPILOT_CLI) {
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

function isNativeCompletionPatch(patch) {
  const key = patch?.k;
  if (
    patch?.kind === 1 &&
    Array.isArray(key) &&
    key[0] === 'requests' &&
    Number.isInteger(key[1]) &&
    (key[2] === 'result' || (key[2] === 'modelState' && patch.v?.completedAt))
  ) return true;
  const requests =
    patch?.kind === 0 && Array.isArray(patch.v?.requests)
      ? patch.v.requests
      : patch?.kind === 2 && key?.length === 1 && key[0] === 'requests' && Array.isArray(patch.v)
        ? patch.v
        : null;
  const latest = requests?.at(-1);
  return Boolean(latest && (latest.result || latest.modelState?.completedAt));
}

function nativeCompletionTimestamp(patch) {
  const key = patch?.k;
  if (patch?.kind === 1 && key?.[2] === 'modelState') return patch.v?.completedAt ?? null;
  const requests = patch?.kind === 0 ? patch.v?.requests : key?.length === 1 ? patch.v : null;
  return requests?.at?.(-1)?.modelState?.completedAt ?? null;
}

function inspectCompatibility(eventsPath, source, journalPath = null) {
  const compatibility = emptyCompatibility();
  const contents = fs.readFileSync(eventsPath, 'utf8');
  for (const line of contents.split('\n')) {
    if (!line.trim()) continue;
    try {
      updateCompatibility(compatibility, JSON.parse(line), source);
    } catch {}
  }
  if (source === SOURCE_NATIVE && journalPath) {
    const journal = fs.readFileSync(journalPath, 'utf8');
    for (const line of journal.split('\n')) {
      if (!line.trim()) continue;
      try {
        if (isNativeCompletionPatch(JSON.parse(line))) {
          updateCompatibility(compatibility, { type: 'request.completed' }, source);
          break;
        }
      } catch {}
    }
  }
  return compatibility;
}

function reduceEvent(run, event, source = SOURCE_COPILOT_CLI) {
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
  } else if (event?.type === 'tool.execution_start') {
    const id = data?.toolCallId;
    const question = data?.toolName === 'vscode_askQuestions';
    if (data?.fromHook && question) run.questionHooksObserved = true;
    if (
      id &&
      !(source === SOURCE_NATIVE && question && run.questionHooksObserved && !data?.fromHook)
    ) run.tools.set(id, data?.toolName ?? '');
    run.completed = false;
  } else if (event?.type === 'tool.execution_complete') {
    if (data?.fromHook && data?.toolName === 'vscode_askQuestions') {
      run.questionHooksObserved = true;
      for (const [id, name] of run.tools) {
        if (name === 'vscode_askQuestions') run.tools.delete(id);
      }
    }
    if (data?.toolCallId) {
      run.tools.delete(data.toolCallId);
    }
  } else if (event?.type === 'permission.requested') {
    if (data?.requestId) run.permissions.add(data.requestId);
  } else if (event?.type === 'permission.completed') {
    if (data?.requestId) run.permissions.delete(data.requestId);
  } else if (event?.type === 'session.error' || event?.type === 'turn.error') {
    run.error = event.type;
  } else if (source === SOURCE_NATIVE && event?.type === 'request.completed') {
    run.completed = true;
    run.turns.clear();
    run.tools.clear();
    run.permissions.clear();
  } else if (event?.type === 'hook.end' && hookType === 'sessionEnd') {
    run.completed = true;
    run.turns.clear();
    run.tools.clear();
    run.permissions.clear();
  } else {
    return { run, prompt: false, state: null };
  }

  let state = 'running';
  if (run.error) state = 'error';
  else if (
    run.permissions.size ||
    [...run.tools.values()].some((name) => name === 'ask_user' || name === 'vscode_askQuestions')
  ) state = 'input';
  else if (run.completed) state = 'done';
  return { run, prompt: false, state };
}

function nativeSessionResource(sessionId) {
  if (!SESSION_ID.test(sessionId)) throw new Error('invalid VS Code session id');
  return `${NATIVE_RESOURCE_SCHEME}://local/${Buffer.from(sessionId).toString('base64url')}`;
}

function buildSessionUrl(cwd, sessionId, resource = `${RESOURCE_SCHEME}:/${sessionId}`) {
  if (!path.isAbsolute(cwd)) throw new Error('project path is not absolute');
  if (!SESSION_ID.test(sessionId)) throw new Error('invalid VS Code session id');
  const url = new URL('vscode://file');
  url.pathname = cwd;
  url.searchParams.set('session', resource);
  return url.toString();
}

function launchUrl(url, exec = execFile) {
  return new Promise((resolve, reject) => {
    exec('/usr/bin/open', [url], (err) => (err ? reject(err) : resolve()));
  });
}

function exactOpenCompatibility() {
  if (process.platform !== 'darwin' || !fs.existsSync(VSCODE_APP)) {
    return { available: false, version: null, protocolRegistered: false };
  }
  let version = null;
  let protocolRegistered = false;
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(VSCODE_APP, 'Contents', 'Resources', 'app', 'package.json'), 'utf8')
    );
    version = packageJson.version ?? null;
    const urlTypes = JSON.parse(
      execFileSync(
        '/usr/bin/plutil',
        ['-extract', 'CFBundleURLTypes', 'json', '-o', '-', path.join(VSCODE_APP, 'Contents', 'Info.plist')],
        { encoding: 'utf8' }
      )
    );
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

class VSCodeIntegration {
  constructor(options = {}) {
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
    this.log = options.log ?? (() => {});
    this.launch = options.launch ?? launchUrl;
    this.scanIntervalMs = options.scanIntervalMs ?? SCAN_INTERVAL_MS;
    this.slots = Array(INTEGRATION_SLOT_COUNT).fill(null);
    this.sessions = new Map();
    this.timer = null;
    this.scanning = false;
    this.started = false;
  }

  load() {
    let saved;
    try {
      saved = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`cannot read VS Code integration state: ${err.message}`);
      return;
    }
    if (saved.schemaVersion !== SCHEMA_VERSION) {
      throw new Error(`unsupported VS Code integration state schema ${saved.schemaVersion}`);
    }
    for (const raw of saved.sessions ?? []) {
      if (!SESSION_ID.test(raw.id) || !Number.isInteger(raw.offset) || raw.offset < 0) continue;
      this.sessions.set(raw.id, {
        id: raw.id,
        cwd: raw.cwd ?? null,
        eventsPath: raw.source === SOURCE_NATIVE ? raw.eventsPath : this.eventsPath(raw.id),
        journalPath: raw.journalPath ?? null,
        source: raw.source ?? SOURCE_COPILOT_CLI,
        resource: raw.resource ?? `${RESOURCE_SCHEME}:/${raw.id}`,
        offset: typeof raw.identity === 'string' ? raw.offset : 0,
        identity: typeof raw.identity === 'string' ? raw.identity : null,
        journalOffset: 0,
        journalIdentity: null,
        run: emptyRun(),
        compatibility: { ...emptyCompatibility(), ...raw.compatibility },
        boundSlot: null,
        missingScans: 0,
        lastEventAt: raw.lastEventAt ?? null,
      });
    }
    for (let index = 0; index < INTEGRATION_SLOT_COUNT; index++) {
      const raw = saved.slots?.[index];
      if (!raw || !SESSION_ID.test(raw.sessionId)) continue;
      const session = this.sessions.get(raw.sessionId) ?? {
        id: raw.sessionId,
        cwd: raw.cwd,
        eventsPath: raw.eventsPath ?? this.eventsPath(raw.sessionId),
        journalPath: raw.journalPath ?? null,
        source: raw.source ?? SOURCE_COPILOT_CLI,
        resource: raw.resource ?? `${RESOURCE_SCHEME}:/${raw.sessionId}`,
        offset: 0,
        identity: null,
        journalOffset: 0,
        journalIdentity: null,
        run: emptyRun(),
        compatibility: emptyCompatibility(),
        boundSlot: null,
        missingScans: 0,
        lastEventAt: null,
      };
      session.boundSlot = index;
      session.offset = 0;
      session.run = emptyRun();
      this.sessions.set(session.id, session);
      this.slots[index] = {
        slot: index,
        sessionId: session.id,
        cwd: raw.cwd,
        label: raw.label,
        boundAt: raw.boundAt,
        state: raw.state,
        stateChangedAt: raw.stateChangedAt,
        doneAt: raw.doneAt,
        lastEventAt: raw.lastEventAt,
        runError: raw.runError,
        eventOffset: 0,
      };
    }
  }

  eventsPath(id) {
    if (!SESSION_ID.test(id)) throw new Error('invalid VS Code session id');
    return path.join(this.root, id, 'events.jsonl');
  }

  save() {
    const state = {
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
        compatibility: session.compatibility,
        lastEventAt: session.lastEventAt,
      })),
    };
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this.statePath);
  }

  async start() {
    if (this.started) return;
    this.load();
    this.started = true;
    try {
      await this.scan(true);
    } catch (err) {
      this.log(`VS Code initial scan failed: ${err.message}`);
    }
    this.timer = setInterval(() => this.scan().catch((err) => this.log(`VS Code scan failed: ${err.message}`)), this.scanIntervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.started) this.save();
    this.started = false;
  }

  admit(id) {
    if (!SESSION_ID.test(id)) return null;
    const directory = path.join(this.root, id);
    const workspacePath = path.join(directory, 'workspace.yaml');
    const eventsPath = this.eventsPath(id);
    let directoryReal;
    let rootReal;
    let metadata;
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
      cwd: metadata.cwd,
      eventsPath,
      source: SOURCE_COPILOT_CLI,
      resource: `${RESOURCE_SCHEME}:/${id}`,
    };
  }

  nativeCandidates() {
    const candidates = [];
    let workspaceIds;
    try {
      workspaceIds = fs.readdirSync(this.nativeRoot);
    } catch {
      return candidates;
    }
    for (const workspaceId of workspaceIds) {
      const directory = path.join(this.nativeRoot, workspaceId);
      let cwd;
      try {
        const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'workspace.json'), 'utf8'));
        const workspaceUri = metadata.folder ?? metadata.workspace;
        if (new URL(workspaceUri).protocol !== 'file:') continue;
        cwd = fileURLToPath(workspaceUri);
      } catch {
        continue;
      }
      const transcripts = path.join(directory, 'GitHub.copilot-chat', 'transcripts');
      let files;
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
        candidates.push({
          id,
          cwd,
          eventsPath,
          journalPath: chatPath,
          source: SOURCE_NATIVE,
          resource: nativeSessionResource(id),
        });
      }
    }
    return candidates;
  }

  async scan(initial = false) {
    if (this.scanning) return;
    this.scanning = true;
    try {
      let ids = [];
      try {
        ids = fs.readdirSync(this.root);
      } catch {}
      const candidates = ids.map((id) => this.admit(id)).filter(Boolean);
      candidates.push(...this.nativeCandidates());
      if (!candidates.length && !fs.existsSync(this.root) && !fs.existsSync(this.nativeRoot)) {
        throw new Error('Copilot session-state and VS Code workspace storage directories unavailable');
      }
      const admittedIds = new Set();
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
        await this.readAppended(session);
        if (session.journalPath) await this.readJournalAppended(session);
      }
      for (const slot of this.slots) {
        if (!slot || admittedIds.has(slot.sessionId)) continue;
        const session = this.sessions.get(slot.sessionId);
        if (!session) continue;
        session.missingScans++;
        if (session.missingScans < 3 || slot.runError === 'event-stream-missing') continue;
        slot.state = 'error';
        slot.runError = 'event-stream-missing';
        slot.stateChangedAt = new Date().toISOString();
        await this.onSlot({ ...slot });
      }
      this.save();
    } finally {
      this.scanning = false;
    }
  }

  async readAppended(session) {
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
          await this.applyEvent(session, JSON.parse(line));
        } catch (err) {
          if (err instanceof SyntaxError) this.log(`Malformed VS Code event at ${session.id.slice(0, 8)}:${lineOffset}`);
          else throw err;
        }
      }
      lineOffset += bytes;
    }
    session.offset = lineOffset;
    if (session.boundSlot !== null) this.slots[session.boundSlot].eventOffset = session.offset;
  }

  async readJournalAppended(session) {
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
          const patch = JSON.parse(line);
          if (isNativeCompletionPatch(patch)) {
            await this.applyEvent(session, {
              type: 'request.completed',
              timestamp: nativeCompletionTimestamp(patch)
                ? new Date(nativeCompletionTimestamp(patch)).toISOString()
                : new Date().toISOString(),
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

  allocate(session, timestamp) {
    if (session.boundSlot !== null) return session.boundSlot;
    let index = this.slots.findIndex((slot) => slot === null);
    if (index < 0) {
      const reusable = this.slots
        .filter((slot) => slot.state === 'done' || slot.state === 'idle')
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
      const previous = this.sessions.get(reusable.sessionId);
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

  providerVerified() {
    return [...this.sessions.values()].some(
      (session) =>
        session.compatibility.supported &&
        session.compatibility.sawPrompt &&
        session.compatibility.sawSessionEnd
    );
  }

  async applyEvent(session, event) {
    updateCompatibility(session.compatibility, event, session.source);
    const transition = reduceEvent(session.run, event, session.source);
    session.run = transition.run;
    session.lastEventAt = event.timestamp ?? new Date().toISOString();
    if (transition.prompt && session.boundSlot === null) {
      if (session.compatibility.supported && this.providerVerified()) {
        this.allocate(session, session.lastEventAt);
      }
      else this.log(`Unsupported VS Code event producer for ${session.id.slice(0, 8)}`);
    }
    if (session.boundSlot === null || !transition.state) return;

    const slot = this.slots[session.boundSlot];
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
    await this.onSlot({ ...slot });
  }

  async applyHook(event) {
    if (
      !SESSION_ID.test(event?.sessionId ?? '') ||
      event?.toolName !== 'vscode_askQuestions' ||
      !['PreToolUse', 'PostToolUse'].includes(event?.hookEventName) ||
      typeof event?.toolUseId !== 'string' ||
      !event.toolUseId
    ) return false;
    const session = this.sessions.get(event.sessionId);
    if (!session || session.source !== SOURCE_NATIVE || session.boundSlot === null) return false;
    await this.applyEvent(session, {
      type: event.hookEventName === 'PreToolUse' ? 'tool.execution_start' : 'tool.execution_complete',
      data: { toolCallId: event.toolUseId, toolName: event.toolName, fromHook: true },
      timestamp: typeof event.timestamp === 'string' ? event.timestamp : new Date().toISOString(),
    });
    this.save();
    return true;
  }

  publicSlots() {
    return this.slots.map((slot, index) => (slot ? { ...slot } : { slot: index, state: 'idle' }));
  }

  async open(index) {
    if (!Number.isInteger(index) || index < 0 || index >= INTEGRATION_SLOT_COUNT) {
      throw new Error(`VS Code slot must be 0..${INTEGRATION_SLOT_COUNT - 1}`);
    }
    const slot = this.slots[index];
    if (!slot) throw new Error(`VS Code slot ${index} is unbound`);
    const sessionId = slot.sessionId;
    const session = this.sessions.get(sessionId);
    if (!session?.compatibility.supported) {
      throw new Error(`VS Code session ${sessionId.slice(0, 8)} uses an unsupported event format`);
    }
    if (!exactOpenCompatibility().available) {
      throw new Error('exact VS Code session opening is unavailable on this system');
    }
    if (!fs.existsSync(slot.cwd)) {
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
    if (current?.sessionId === sessionId && current.state === 'done') {
      current.state = 'idle';
      current.stateChangedAt = new Date().toISOString();
      await this.onSlot({ ...current });
      this.save();
    }
    return { slot: { ...this.slots[index] }, url };
  }

  doctor() {
    let rootReadable = false;
    try {
      fs.accessSync(this.root, fs.constants.R_OK);
      rootReadable = true;
    } catch {}
    let nativeRootReadable = false;
    try {
      fs.accessSync(this.nativeRoot, fs.constants.R_OK);
      nativeRootReadable = true;
    } catch {}
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

module.exports = {
  VSCodeIntegration,
  INTEGRATION_SLOT_COUNT,
  RESOURCE_SCHEME,
  NATIVE_RESOURCE_SCHEME,
  workspaceMetadata,
  reduceEvent,
  emptyRun,
  emptyCompatibility,
  updateCompatibility,
  exactOpenCompatibility,
  buildSessionUrl,
  nativeSessionResource,
  launchUrl,
};
