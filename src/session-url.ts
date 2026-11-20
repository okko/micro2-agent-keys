import * as path from 'path';

export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function buildSessionUrl(cwd: string, sessionId: string, resource: string, scheme = 'vscode'): string {
  if (!path.isAbsolute(cwd)) throw new Error('project path is not absolute');
  if (!SESSION_ID.test(sessionId)) throw new Error('invalid VS Code session id');
  if (!resource) throw new Error('missing advertised VS Code session resource');
  if (!/^[a-z][a-z0-9+.-]*$/i.test(scheme)) throw new Error('invalid VS Code URI scheme');
  const url = new URL(`${scheme}://file`);
  url.pathname = cwd;
  url.searchParams.set('session', resource);
  return url.toString();
}
