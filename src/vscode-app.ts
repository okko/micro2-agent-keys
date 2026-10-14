import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile, execFileSync } from 'child_process';

export const RESOURCE_SCHEME = 'agent-host-copilotcli';
export const NATIVE_RESOURCE_SCHEME = 'vscode-chat-session';
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VSCODE_APP = '/Applications/Visual Studio Code.app';

export function nativeSessionResource(sessionId: string): string {
  if (!SESSION_ID.test(sessionId)) throw new Error('invalid VS Code session id');
  return `${NATIVE_RESOURCE_SCHEME}://local/${Buffer.from(sessionId).toString('base64url')}`;
}

function readSqlite(database: string, query: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/sqlite3', ['-readonly', database, query], {
      encoding: 'utf8', timeout: 1000,
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
  });
}

export async function copilotSessionResource(
  sessionId: string,
  userDataPath: string = process.env.AGENTKEYS_VSCODE_USER_DATA ??
    path.join(os.homedir(), 'Library', 'Application Support', 'Code')
): Promise<string> {
  if (!SESSION_ID.test(sessionId)) throw new Error('invalid VS Code session id');
  const catalog = path.join(userDataPath, 'User', 'globalStorage', 'agent-host.db');
  if (fs.existsSync(catalog) && await readSqlite(catalog,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_chats'`
  )) {
    const matches = await readSqlite(catalog,
      `SELECT session_uri || char(9) || chat_uri FROM session_chats ` +
      `WHERE session_uri LIKE 'copilotcli:/%' AND json_extract(provider_data, '$.sdkSessionId') = '${sessionId}'`
    );
    if (matches) {
      const rows = matches.split('\n');
      if (rows.length !== 1) throw new Error(`ambiguous VS Code host session for SDK chat ${sessionId}`);
      const [session, chatUri] = rows[0].split('\t');
      const hostId = session.slice('copilotcli:/'.length);
      const chat = new URL(chatUri);
      if (!SESSION_ID.test(hostId) || chat.protocol !== 'ahp-chat:' || !chat.hostname ||
          chat.search || chat.hash || Buffer.from(chat.pathname.slice(1), 'base64url').toString() !== session) {
        throw new Error(`invalid VS Code host chat mapping for SDK chat ${sessionId}`);
      }
      const fragment = chat.hostname === 'default' ? '' : `#${encodeURIComponent(chat.hostname)}`;
      return `${RESOURCE_SCHEME}:/${hostId}${fragment}`;
    }
  }
  const root = path.join(userDataPath, 'agentSessionData');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return `${RESOURCE_SCHEME}:/${sessionId}`;
    throw error;
  }
  let hostId: string | undefined;
  for (const entry of entries) {
    if (!entry.isDirectory() || !SESSION_ID.test(entry.name)) continue;
    const database = path.join(root, entry.name, 'session.db');
    try {
      const stat = fs.lstatSync(database);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    // New default chats have an SDK ID distinct from their owning host session.
    const matches = await readSqlite(database,
      `SELECT 1 FROM session_metadata WHERE key = 'defaultChatProviderData' ` +
      `AND json_extract(value, '$.sdkSessionId') = '${sessionId}'`
    );
    if (!matches) continue;
    if (hostId) throw new Error(`ambiguous VS Code host session for SDK chat ${sessionId}`);
    hostId = entry.name;
  }
  return `${RESOURCE_SCHEME}:/${hostId ?? sessionId}`;
}

export async function copilotSessionSdkId(
  resource: string,
  userDataPath: string = process.env.AGENTKEYS_VSCODE_USER_DATA ??
    path.join(os.homedir(), 'Library', 'Application Support', 'Code')
): Promise<string | null> {
  const match = /^agent-host-copilotcli:\/([^/#?]+)(?:#([^/#?]+))?$/.exec(resource);
  if (!match || !SESSION_ID.test(match[1])) throw new Error('invalid VS Code host session resource');
  const hostId = match[1];
  const chatId = match[2] ? decodeURIComponent(match[2]) : 'default';
  if (chatId !== 'default' && !SESSION_ID.test(chatId)) throw new Error('invalid VS Code host chat id');
  const sessionUri = `copilotcli:/${hostId}`;
  const chatUri = `ahp-chat://${chatId}/${Buffer.from(sessionUri).toString('base64url')}`;
  const catalog = path.join(userDataPath, 'User', 'globalStorage', 'agent-host.db');
  let sdkId = '';
  if (fs.existsSync(catalog) && await readSqlite(catalog,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_chats'`
  )) {
    sdkId = await readSqlite(catalog,
      `SELECT json_extract(provider_data, '$.sdkSessionId') FROM session_chats ` +
      `WHERE session_uri = '${sessionUri}' AND chat_uri = '${chatUri}'`
    );
  }
  if (!sdkId && chatId === 'default') {
    const database = path.join(userDataPath, 'agentSessionData', hostId, 'session.db');
    if (fs.existsSync(database)) {
      sdkId = await readSqlite(database,
        `SELECT json_extract(value, '$.sdkSessionId') FROM session_metadata WHERE key = 'defaultChatProviderData'`
      );
    }
  }
  if (!sdkId) return null;
  if (!SESSION_ID.test(sdkId)) throw new Error(`invalid VS Code SDK chat identity for host session ${hostId}`);
  return sdkId;
}

export function nativeSessionActive(indexPath: string, sessionId: string): boolean | null {
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

export function exactOpenSupported(
  _version: string | null,
  protocolRegistered: boolean
): boolean {
  return protocolRegistered;
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
    available: exactOpenSupported(version, protocolRegistered),
    version,
    protocolRegistered,
  };
}
