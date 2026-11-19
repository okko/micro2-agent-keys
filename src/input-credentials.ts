import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AuthorizationCredentials } from '@worklouder/input-kit';

const execute = promisify(execFile);
const SERVICE = 'eu.okko.agentkeys.input';
const ACCOUNT = 'AgentKeys';

export interface CredentialStore {
  load(): Promise<AuthorizationCredentials | null>;
  save(credentials: AuthorizationCredentials): Promise<void>;
  remove(): Promise<void>;
}

function requireMacOS(): void {
  if (process.platform !== 'darwin') throw new Error('Input credential storage requires macOS Keychain');
}

function missingItem(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 44;
}

export const keychainCredentials: CredentialStore = {
  async load() {
    requireMacOS();
    let text: string;
    try {
      const result = await execute('/usr/bin/security', [
        'find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w',
      ]);
      text = result.stdout;
    } catch (error) {
      if (missingItem(error)) return null;
      throw new Error('Cannot read Input credentials from macOS Keychain; unlock your login keychain');
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error(`Invalid Input credentials in Keychain item ${SERVICE}; remove that item and restart`);
    }
    if (
      typeof value !== 'object' || value === null ||
      !('applicationId' in value) || typeof value.applicationId !== 'string' || !value.applicationId ||
      !('token' in value) || typeof value.token !== 'string' || !value.token
    ) {
      throw new Error(`Invalid Input credentials in Keychain item ${SERVICE}; remove that item and restart`);
    }
    return { applicationId: value.applicationId, token: value.token };
  },
  async save(credentials) {
    requireMacOS();
    try {
      await execute('/usr/bin/security', [
        'add-generic-password', '-U', '-s', SERVICE, '-a', ACCOUNT, '-w', JSON.stringify(credentials),
      ]);
    } catch {
      // execFile errors include argv, which contains the token.
      throw new Error('Cannot save Input credentials in macOS Keychain; unlock your login keychain and retry');
    }
  },
  async remove() {
    requireMacOS();
    try {
      await execute('/usr/bin/security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT]);
    } catch (error) {
      if (!missingItem(error)) throw new Error('Cannot remove revoked Input credentials from macOS Keychain');
    }
  },
};
