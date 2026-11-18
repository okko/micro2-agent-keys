import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENUM_KEYS = new Set([
  'confirmationKind', 'contributorKind', 'kind', 'purpose', 'responseKind', 'reasonKind',
  'source', 'stage', 'state', 'status', 'toolName', 'type', 'valueKind',
]);
const SAFE_SCALAR_KEYS = new Set([
  'answerCount', 'approved', 'awaitsUserInput', 'formatVersion', 'hasActiveRequest',
  'hasEditedToolInput', 'hasFreeformValues', 'kind', 'planReview', 'requiredScopeCount',
  'requestInProgress', 'status', 'success', 'type', 'version',
]);
const ID_KEY = /(?:^|_)(?:call|interaction|request|resolve|response|session|tool|turn|use)?id$|Id$/;
const TIME_KEY = /(?:^|_)(?:at|date|time|timestamp)$/i;
const SCHEMA_KEY = /^[$_A-Za-z][A-Za-z0-9_$]{0,63}$/;
// Provider identifiers such as call_<opaque> are used as map keys.
const OPAQUE_RUN =
  /(?=[A-Za-z0-9]{16})(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*[A-Z])(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{16,}/;
const DEFAULT_VSCODE_PACKAGE =
  '/Applications/Visual Studio Code.app/Contents/Resources/app/package.json';
const CAPTURE_TIMESTAMP = Symbol('captureTimestamp');

function usage() {
  return `Usage: npm run dev:capture:vscode-fixture -- --session <uuid> --agent-host-protocol <jsonl> --output <file> [options]

Options:
  --label <text>                Capture stage, such as waiting or resolved
  --agent-host-protocol-lines N Comma-separated lines/ranges, for example 4,8-10
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
  return SCHEMA_KEY.test(key) && !OPAQUE_RUN.test(key) ? key : pseudonym('objectKey', key);
}

export function sanitizeCapture(value, key = '') {
  if (Array.isArray(value)) return value.map((item) => sanitizeCapture(item, key));
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

function readJsonLines(file, selectedLines) {
  const records = [];
  let lineNumber = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    lineNumber++;
    if (selectedLines && !selectedLines.has(lineNumber)) continue;
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`invalid capture JSON at line ${lineNumber}`);
    }
    if (!parsed || typeof parsed !== 'object' ||
        !['agent-host.snapshot', 'agent-host.action'].includes(parsed.type)) {
      throw new Error(`expected an AHP capture record at line ${lineNumber}`);
    }
    const record = sanitizeCapture(parsed);
    record._capture = { sourceLine: lineNumber };
    Object.defineProperty(record, CAPTURE_TIMESTAMP, { value: timestampMs(parsed.timestamp) });
    records.push(record);
  }
  if (!records.length) throw new Error('capture contains no selected AHP records');
  return records;
}

function addRelativeOffsets(records) {
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

export function captureFixture({
  sessionId,
  label = null,
  agentHostProtocolPath,
  vscodePackage = DEFAULT_VSCODE_PACKAGE,
  lineSelections = {},
}) {
  if (!SESSION_ID.test(sessionId)) throw new Error('session must be a UUID');
  if (!agentHostProtocolPath) throw new Error('agent-host-protocol capture path is required');
  const records = readJsonLines(agentHostProtocolPath, lineSelections['agent-host-protocol']);
  const timing = addRelativeOffsets(records);
  const { version } = JSON.parse(fs.readFileSync(vscodePackage, 'utf8'));
  if (typeof version !== 'string' || !version) throw new Error('VS Code metadata has no version');
  return {
    formatVersion: 2,
    vscodeVersion: version,
    sessionId: pseudonym('sessionId', sessionId),
    label,
    ...(timing ? { timing } : {}),
    sources: [{ source: 'agent-host-protocol', records }],
  };
}

function parseArgs(argv) {
  const options = { force: false };
  const names = new Set([
    'session', 'output', 'label', 'agent-host-protocol', 'agent-host-protocol-lines', 'vscode-package',
  ]);
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--force') {
      options.force = true;
    } else if (argument.startsWith('--') && names.has(argument.slice(2))) {
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

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.session || !options.output || !options['agent-host-protocol']) {
    process.stderr.write(usage());
    process.exitCode = 2;
    return;
  }
  const output = path.resolve(options.output);
  if (!options.force && fs.existsSync(output)) throw new Error(`output already exists: ${output}`);
  const fixture = captureFixture({
    sessionId: options.session,
    label: options.label ?? null,
    agentHostProtocolPath: options['agent-host-protocol'],
    vscodePackage: options['vscode-package'] ?? DEFAULT_VSCODE_PACKAGE,
    lineSelections: {
      'agent-host-protocol': parseLineSelection(options['agent-host-protocol-lines']),
    },
  });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(fixture, null, 2)}\n`, { flag: options.force ? 'w' : 'wx' });
  process.stdout.write(`${output}: captured agent-host-protocol\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
