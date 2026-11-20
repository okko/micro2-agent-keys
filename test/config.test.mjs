import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readConfig, writeConfig } from '../dist/config.js';

test('key configuration is explicit, persistent, and rejects invalid changes', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentkeys-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'config.json');
  assert.equal(readConfig(file), null);
  writeConfig({ keyCount: 6 }, file);
  assert.deepEqual(readConfig(file), { keyCount: 6 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  for (const keyCount of [0, -1, 21, 2.5, '6', null]) {
    assert.throws(() => writeConfig({ keyCount }, file), /keyCount must be an integer/);
    assert.deepEqual(readConfig(file), { keyCount: 6 });
  }
  fs.writeFileSync(file, '{invalid');
  assert.throws(() => readConfig(file), /Invalid AgentKeys configuration/);
});
