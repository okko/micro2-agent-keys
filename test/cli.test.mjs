import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/cli.js', ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('log follows the daemon log under the user home directory', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentkeys-cli-'));
  const binDirectory = path.join(directory, 'bin');
  const argsFile = path.join(directory, 'tail-args');
  fs.mkdirSync(binDirectory);
  fs.writeFileSync(path.join(binDirectory, 'tail'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$AGENTKEYS_TAIL_ARGS"\n');
  fs.chmodSync(path.join(binDirectory, 'tail'), 0o755);

  try {
    const result = await runCli(['log'], {
      AGENTKEYS_TAIL_ARGS: argsFile,
      HOME: directory,
      PATH: `${binDirectory}:${process.env.PATH ?? ''}`,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(fs.readFileSync(argsFile, 'utf8').trimEnd().split('\n'), [
      '-f',
      path.join(directory, '.local/state/agentkeys/daemon.log'),
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});