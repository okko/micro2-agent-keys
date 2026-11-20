import type { AuthorizationCredentials } from '@worklouder/input-kit';
import type { SecretStorage } from 'vscode';

const SECRET_KEY = 'eu.okko.agentkeys.input.credentials';

export interface CredentialStore {
  load(): Promise<AuthorizationCredentials | null>;
  save(credentials: AuthorizationCredentials): Promise<void>;
  remove(): Promise<void>;
}

export function secretCredentials(secrets: Pick<SecretStorage, 'get' | 'store' | 'delete'>): CredentialStore {
  return {
    async load() {
      const text = await secrets.get(SECRET_KEY);
      if (text === undefined) return null;
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        throw new Error('Invalid saved Input credentials; run AgentKeys: Forget Input Authorization');
      }
      if (
        typeof value !== 'object' || value === null ||
        !('applicationId' in value) || typeof value.applicationId !== 'string' || !value.applicationId ||
        !('token' in value) || typeof value.token !== 'string' || !value.token
      ) {
        throw new Error('Invalid saved Input credentials; run AgentKeys: Forget Input Authorization');
      }
      return { applicationId: value.applicationId, token: value.token };
    },
    async save(credentials) { await secrets.store(SECRET_KEY, JSON.stringify(credentials)); },
    async remove() { await secrets.delete(SECRET_KEY); },
  };
}
