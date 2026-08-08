import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENUM_KEYS = new Set([
  'clientName',
  'client_name',
  'confirmationKind',
  'contributorKind',
  'hookEventName',
  'hookType',
  'hook_event_name',
  'kind',
  'producer',
  'purpose',
  'responseKind',
  'reasonKind',
  'source',
  'stage',
  'state',
  'status',
  'toolId',
  'toolName',
  'tool_name',
  'type',
  'valueKind',
]);
const SAFE_SCALAR_KEYS = new Set([
  'answerCount',
  'approved',
  'allowSkip',
  'alreadyInUse',
  'awaitsUserInput',
  'formatVersion',
  'fromHook',
  'hasActiveRequest',
  'hasEditedToolInput',
  'hasFreeformValues',
  'isComplete',
  'isConfirmed',
  'isUsed',
  'kind',
  'planReview',
  'remoteSteerable',
  'requiredScopeCount',
  'requestInProgress',
  'schemaVersion',
  'status',
  'success',
  'type',
  'version',
]);
const JOURNAL_PATH_KEYS = new Set([
  'completedAt',
  'isComplete',
  'isConfirmed',
  'isUsed',
  'modelState',
  'requests',
  'response',
  'result',
  'state',
  'toolSpecificData',
]);
const ID_KEY = /(?:^|_)(?:call|interaction|request|resolve|response|session|tool|turn|use)?id$|Id$/;
const TIME_KEY = /(?:^|_)(?:at|date|time|timestamp)$/i;
const DEFAULT_VSCODE_PACKAGE =
  '/Applications/Visual Studio Code.app/Contents/Resources/app/package.json';
const CAPTURE_TIMESTAMP = Symbol('captureTimestamp');

function usage() {
  return `Usage: npm run dev:capture:vscode-fixture -- --session <uuid> --output <file> [options]

Options:
  --label <text>                 Capture stage, such as before, waiting, or resolved
  --workspace-storage <path>    VS Code workspaceStorage root
  --copilot-home <path>         Copilot home containing session-state
  --hooks <path>                Optional hook payload JSONL
  --agent-host-protocol <path>  Optional live Agent Host snapshot JSONL
  --native-transcript-lines N  Comma-separated lines/ranges, for example 4,8-10
  --native-journal-lines N     Comma-separated lines/ranges
  --native-journal-response-id ID
                                 Keep only response parts correlated with this ID
  --agent-host-lines N         Comma-separated lines/ranges
  --agent-host-protocol-lines N
                                 Comma-separated lines/ranges
  --agent-host-state-row-limit N
                                 Maximum rows captured from each SQLite table
  --hook-lines N               Comma-separated lines/ranges
  --vscode-package <path>       Installed VS Code package.json
  --force                       Replace an existing output file
`;
}

function pseudonym(key, value) {
  const digest = createHash('sha256')
    .update(`agentkeys-vscode-fixture-v1\0${key}\0${value}`)
    .digest('hex')
    .slice(0, 12);
  return `<id:${digest}>`;
}

function sanitizeObjectKey(key) {
  return /[/\\]|^[a-z][a-z0-9+.-]*:/i.test(key) ? pseudonym('objectKey', key) : key;
}

export function sanitizeCapture(value, key = '') {
  if (Array.isArray(value)) {
    if (key === 'k') {
      return value.map((item) =>
        typeof item === 'number' || (typeof item === 'string' && JOURNAL_PATH_KEYS.has(item))
          ? item
          : '<redacted>'
      );
    }
    return value.map((item) => sanitizeCapture(item, key));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        sanitizeObjectKey(childKey),
        sanitizeCapture(childValue, childKey),
      ])
    );
  }
  if (TIME_KEY.test(key)) return value == null ? value : '<timestamp>';
  if (typeof value !== 'string') {
    return value == null || SAFE_SCALAR_KEYS.has(key) ? value : '<redacted>';
  }
  if ((value.startsWith('{') && value.endsWith('}')) || (value.startsWith('[') && value.endsWith(']'))) {
    try {
      return sanitizeCapture(JSON.parse(value), key);
    } catch {
      // Preserve the normal string redaction below.
    }
  }
  if (ID_KEY.test(key)) return pseudonym('id', value);
  if (ENUM_KEYS.has(key)) return value;
  return '<redacted>';
}

function timestampMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readJsonLines(file, selectedLines = null, annotate = null, filter = null) {
  const records = [];
  let lineNumber = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    lineNumber++;
    if (selectedLines && !selectedLines.has(lineNumber)) continue;
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      const selected = filter?.(parsed) ?? parsed;
      if (selected === null) continue;
      const record = sanitizeCapture(selected);
      record._capture = { sourceLine: lineNumber, ...(annotate?.(parsed) ?? {}) };
      Object.defineProperty(record, CAPTURE_TIMESTAMP, { value: timestampMs(parsed.timestamp) });
      records.push(record);
    } catch {
      records.push({ malformedLine: lineNumber, _capture: { sourceLine: lineNumber } });
    }
  }
  return records;
}

function addRelativeOffsets(sources) {
  const records = sources.flatMap((source) => source.records ?? []);
  const timestamps = records
    .map((record) => record[CAPTURE_TIMESTAMP])
    .filter((value) => value !== null);
  if (timestamps.length === 0) return null;
  const firstTimestamp = Math.min(...timestamps);
  for (const record of records) {
    const timestamp = record[CAPTURE_TIMESTAMP];
    if (timestamp !== null) record._capture.offsetMs = timestamp - firstTimestamp;
  }
  return { basis: 'relative-to-first-captured-event', unit: 'ms' };
}

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function sanitizeSqlIdentifier(identifier) {
  return /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(identifier)
    ? identifier
    : pseudonym('sqliteIdentifier', identifier);
}

function sanitizeSqlType(type) {
  return typeof type === 'string' && /^[A-Za-z][A-Za-z0-9_ ()]{0,63}$/.test(type)
    ? type.toUpperCase()
    : '<redacted>';
}

function readSqlite(file, rowLimit = null) {
  const tableRows = JSON.parse(
    execFileSync(
      '/usr/bin/sqlite3',
      ['-json', file, "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name"],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
    ) || '[]'
  );
  return tableRows.map(({ name }) => {
    const columns = JSON.parse(
      execFileSync('/usr/bin/sqlite3', ['-json', file, `PRAGMA table_info(${quoteIdentifier(name)})`], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      }) || '[]'
    );
    const limit = rowLimit === null ? '' : ` LIMIT ${rowLimit}`;
    const rows = JSON.parse(
      execFileSync('/usr/bin/sqlite3', ['-json', file, `SELECT * FROM ${quoteIdentifier(name)}${limit}`], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      }) || '[]'
    );
    return {
      name: sanitizeSqlIdentifier(name),
      columns: columns.map((column) => ({
        name: sanitizeSqlIdentifier(column.name),
        type: sanitizeSqlType(column.type),
        notNull: column.notnull === 1,
        primaryKey: column.pk > 0,
      })),
      rows: sanitizeCapture(rows),
    };
  });
}

function readWorkspaceCwd(agentHostDirectory) {
  try {
    const workspace = fs.readFileSync(path.join(agentHostDirectory, 'workspace.yaml'), 'utf8');
    const match = workspace.match(/^cwd:\s*(.*)$/m);
    if (!match) return null;
    const value = match[1].trim();
    if (value.startsWith('"')) return JSON.parse(value);
    if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
    return value;
  } catch {
    return null;
  }
}

function classifyAgentHostRecord(record, cwd) {
  if (record?.type !== 'permission.requested' || record.data?.permissionRequest?.kind !== 'read') return null;
  const target = record.data.permissionRequest.path;
  if (typeof cwd !== 'string' || typeof target !== 'string') return { pathScope: 'unknown' };
  const relative = path.relative(cwd, path.resolve(cwd, target));
  const outside = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  return { pathScope: outside ? 'outside-working-directory' : 'inside-working-directory' };
}

function filterJournalResponse(record, responseId) {
  if (!responseId) return record;
  if (!Array.isArray(record?.v)) return null;
  const responseParts = record.v.filter((part) =>
    part?.resolveId === responseId || part?.toolCallId === responseId
  );
  return responseParts.length > 0 ? { ...record, v: responseParts } : null;
}

function findNativeFiles(workspaceStorage, sessionId, lineSelections, nativeJournalResponseId) {
  const sources = [];
  let directories = [];
  try {
    directories = fs.existsSync(path.join(workspaceStorage, 'chatSessions'))
      ? [workspaceStorage]
      : fs.readdirSync(workspaceStorage).map((workspaceId) => path.join(workspaceStorage, workspaceId));
  } catch {
    return sources;
  }
  for (const directory of directories) {
    const candidates = [
      ['native-transcript', path.join(directory, 'GitHub.copilot-chat', 'transcripts', `${sessionId}.jsonl`)],
      ['native-journal', path.join(directory, 'chatSessions', `${sessionId}.jsonl`)],
    ];
    for (const [source, file] of candidates) {
      if (fs.existsSync(file)) {
        sources.push({
          source,
          records: readJsonLines(
            file,
            lineSelections[source],
            null,
            source === 'native-journal'
              ? (record) => filterJournalResponse(record, nativeJournalResponseId)
              : null
          ),
        });
      }
    }
  }
  return sources;
}

function readVersion(vscodePackage) {
  try {
    return JSON.parse(fs.readFileSync(vscodePackage, 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

export function captureFixture({
  sessionId,
  label = null,
  workspaceStorage,
  copilotHome,
  hooksPath = null,
  agentHostProtocolPath = null,
  vscodePackage = DEFAULT_VSCODE_PACKAGE,
  lineSelections = {},
  agentHostStateRowLimit = null,
  nativeJournalResponseId = null,
}) {
  if (!SESSION_ID.test(sessionId)) throw new Error('session must be a UUID');
  const sources = findNativeFiles(
    workspaceStorage,
    sessionId,
    lineSelections,
    nativeJournalResponseId
  );
  const agentHostDirectory = path.join(copilotHome, 'session-state', sessionId);
  const agentHostEvents = path.join(agentHostDirectory, 'events.jsonl');
  const agentHostDatabase = path.join(agentHostDirectory, 'session.db');
  if (fs.existsSync(agentHostEvents)) {
    const cwd = readWorkspaceCwd(agentHostDirectory);
    sources.push({
      source: 'agent-host-events',
      records: readJsonLines(
        agentHostEvents,
        lineSelections['agent-host-events'],
        (record) => classifyAgentHostRecord(record, cwd)
      ),
    });
  }
  if (fs.existsSync(agentHostDatabase)) {
    try {
      sources.push({
        source: 'agent-host-state',
        tables: readSqlite(agentHostDatabase, agentHostStateRowLimit),
      });
    } catch (error) {
      sources.push({
        source: 'agent-host-state',
        unavailable: true,
        reason: sanitizeCapture(error instanceof Error ? error.message : String(error), 'reason'),
      });
    }
  }
  if (agentHostProtocolPath && fs.existsSync(agentHostProtocolPath)) {
    sources.push({
      source: 'agent-host-protocol',
      records: readJsonLines(
        agentHostProtocolPath,
        lineSelections['agent-host-protocol']
      ),
    });
  }
  if (hooksPath && fs.existsSync(hooksPath)) {
    sources.push({ source: 'hooks', records: readJsonLines(hooksPath, lineSelections.hooks) });
  }
  const timing = addRelativeOffsets(sources);
  return {
    formatVersion: 2,
    vscodeVersion: readVersion(vscodePackage),
    sessionId: pseudonym('sessionId', sessionId),
    label,
    ...(timing ? { timing } : {}),
    sources,
  };
}

function parseArgs(argv) {
  const options = { force: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--force') {
      options.force = true;
    } else if (argument.startsWith('--')) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`missing value for ${argument}`);
      options[argument.slice(2)] = value;
    } else {
      throw new Error(`unexpected argument ${argument}`);
    }
  }
  return options;
}

function parseLineSelection(value) {
  if (!value) return null;
  const lines = new Set();
  for (const part of value.split(',')) {
    const match = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) throw new Error(`invalid line selection: ${part}`);
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    if (start < 1 || end < start) throw new Error(`invalid line selection: ${part}`);
    for (let line = start; line <= end; line++) lines.add(line);
  }
  return lines;
}

function parseRowLimit(value) {
  if (value === undefined) return null;
  if (!/^\d+$/.test(value)) throw new Error(`invalid row limit: ${value}`);
  return Number(value);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.session || !options.output) {
    process.stderr.write(usage());
    process.exitCode = 2;
    return;
  }
  const output = path.resolve(options.output);
  if (!options.force && fs.existsSync(output)) throw new Error(`output already exists: ${output}`);
  const fixture = captureFixture({
    sessionId: options.session,
    label: options.label ?? null,
    workspaceStorage:
      options['workspace-storage'] ??
      path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage'),
    copilotHome: options['copilot-home'] ?? path.join(os.homedir(), '.copilot'),
    hooksPath: options.hooks ?? null,
    agentHostProtocolPath: options['agent-host-protocol'] ?? null,
    vscodePackage: options['vscode-package'] ?? DEFAULT_VSCODE_PACKAGE,
    agentHostStateRowLimit: parseRowLimit(options['agent-host-state-row-limit']),
    nativeJournalResponseId: options['native-journal-response-id'] ?? null,
    lineSelections: {
      'native-transcript': parseLineSelection(options['native-transcript-lines']),
      'native-journal': parseLineSelection(options['native-journal-lines']),
      'agent-host-events': parseLineSelection(options['agent-host-lines']),
      'agent-host-protocol': parseLineSelection(options['agent-host-protocol-lines']),
      hooks: parseLineSelection(options['hook-lines']),
    },
  });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(fixture, null, 2)}\n`, { flag: options.force ? 'w' : 'wx' });
  process.stdout.write(`${output}: captured ${fixture.sources.map(({ source }) => source).join(', ') || 'no sources'}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();