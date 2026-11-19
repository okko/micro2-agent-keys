import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readConfig, writeConfig } from '../dist/config.js';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentkeys-config-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, '.local', 'state', 'agentkeys', 'config.json');
  const configure = (input) => spawnSync(process.execPath, ['dist/configure.js'], {
    env: { ...process.env, HOME: home }, input, encoding: 'utf8',
  });
  return { file, configure };
}

test('installer prompt validates the count and persists it for subsequent installs', (t) => {
  const { file, configure } = fixture(t);
  const result = configure('0\n21\n-1\n1.5\nsix\n6\n');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Activated keys \(1-20\)/);
  assert.match(result.stdout, /vscode00 through vscode05/);
  assert.equal((result.stderr.match(/Enter a whole number/g) ?? []).length, 5);
  assert.deepEqual(readConfig(file), { keyCount: 6 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const keep = configure('\n');
  assert.equal(keep.status, 0, keep.stderr);
  assert.match(keep.stdout, /\[6\]/);
  assert.deepEqual(readConfig(file), { keyCount: 6 });
  assert.equal(configure('20\n').status, 0);
  assert.deepEqual(readConfig(file), { keyCount: 20 });
  assert.equal(configure('0\n').status, 1);
  assert.deepEqual(readConfig(file), { keyCount: 20 });
  assert.equal(configure('1\n').status, 0);
  assert.deepEqual(readConfig(file), { keyCount: 1 });
});

test('missing input does not assume all keys are enabled or overwrite an existing setting', (t) => {
  const { file, configure } = fixture(t);
  assert.equal(readConfig(file), null);
  const result = configure('');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No key count supplied/);
  assert.equal(fs.existsSync(file), false);
  writeConfig({ keyCount: 3 }, file);
  assert.equal(configure('').status, 1);
  assert.deepEqual(readConfig(file), { keyCount: 3 });
});

test('configuration rejects malformed and out-of-range values without overwriting valid settings', (t) => {
  const { file, configure } = fixture(t);
  writeConfig({ keyCount: 1 }, file);
  for (const keyCount of [0, -1, 21, 2.5, '6', null]) {
    assert.throws(() => writeConfig({ keyCount }, file), /keyCount must be an integer/);
    assert.deepEqual(readConfig(file), { keyCount: 1 });
    fs.writeFileSync(file, JSON.stringify({ keyCount }));
    assert.throws(() => readConfig(file), /Invalid AgentKeys configuration/);
    writeConfig({ keyCount: 1 }, file);
  }
  fs.writeFileSync(file, '{invalid');
  assert.throws(() => readConfig(file), /Invalid AgentKeys configuration/);
  assert.equal(configure('4\n').status, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), '{invalid');
});
