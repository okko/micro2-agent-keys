import assert from 'node:assert/strict';
import test from 'node:test';
import { secretCredentials } from '../dist/input-credentials.js';

test('Input authorization uses SecretStorage and rejects corrupt data without exposing it', async () => {
  let saved;
  const store = secretCredentials({
    async get(key) { assert.equal(key, 'eu.okko.agentkeys.input.credentials'); return saved; },
    async store(key, value) { assert.equal(key, 'eu.okko.agentkeys.input.credentials'); saved = value; },
    async delete(key) { assert.equal(key, 'eu.okko.agentkeys.input.credentials'); saved = undefined; },
  });
  assert.equal(await store.load(), null);
  const credentials = { applicationId: 'test-app', token: 'test-secret' };
  await store.save(credentials);
  assert.deepEqual(await store.load(), credentials);
  saved = '{"token":"test-secret"}';
  await assert.rejects(store.load(), (error) => {
    assert.match(error.message, /Forget Input Authorization/);
    assert.ok(!error.message.includes('test-secret'));
    return true;
  });
  await store.remove();
  assert.equal(await store.load(), null);
});
