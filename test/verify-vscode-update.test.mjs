import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  auditFixtures,
  findVscodeApp,
  parseArgs,
  readVscodeBuild,
  verifyBundleContracts,
} from '../scripts/dev/verify-vscode-update.mjs';

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentkeys-vscode-update-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('parses verifier options and rejects incomplete app paths', () => {
  assert.deepEqual(parseArgs([]), { skipTests: false });
  assert.deepEqual(parseArgs(['--skip-tests']), { skipTests: true });
  assert.deepEqual(parseArgs(['--app', './Code.app']), {
    app: path.resolve('./Code.app'),
    skipTests: false,
  });
  assert.throws(() => parseArgs(['--app']), /--app requires a path/);
  assert.throws(() => parseArgs(['--unknown']), /unknown argument/);
});

test('discovers and reads an installed VS Code build', (t) => {
  const root = temporaryDirectory(t);
  const missing = path.join(root, 'missing.app');
  const app = path.join(root, 'Code.app');
  const resources = path.join(app, 'Contents', 'Resources', 'app');
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(resources, 'package.json'), JSON.stringify({
    version: '1.132.0',
    distro: '0123456789abcdef0123456789abcdef01234567',
  }));

  assert.equal(findVscodeApp(undefined, [missing, app]), app);
  assert.deepEqual(readVscodeBuild(app), {
    appPath: app,
    resources,
    version: '1.132.0',
    commit: '0123456789abcdef0123456789abcdef01234567',
  });
  assert.throws(() => findVscodeApp(missing, []), /does not exist/);
});

test('fails when an installed VS Code contract token disappears', (t) => {
  const resources = temporaryDirectory(t);
  const relativePath = 'out/example.js';
  fs.mkdirSync(path.dirname(path.join(resources, relativePath)), { recursive: true });
  fs.writeFileSync(path.join(resources, relativePath), 'alpha beta');
  const contracts = [{ relativePath, tokens: ['alpha', 'beta'] }];

  assert.deepEqual(verifyBundleContracts(resources, contracts), [{
    file: relativePath,
    tokenCount: 2,
  }]);
  assert.throws(
    () => verifyBundleContracts(resources, [{ relativePath, tokens: ['alpha', 'gamma'] }]),
    /missing AgentKeys contract token\(s\): gamma/
  );
});

test('audits fixture provenance and rejects private material', (t) => {
  const fixtureRoot = temporaryDirectory(t);
  const manifestPath = path.join(fixtureRoot, 'manifest.json');
  const fixturePath = path.join(fixtureRoot, 'safe.json');
  fs.writeFileSync(manifestPath, JSON.stringify({
    capturedFrom: { version: '1.131.0', commit: 'a'.repeat(40) },
    fixtures: [{ file: 'safe.json' }],
  }));
  fs.writeFileSync(fixturePath, JSON.stringify({ status: 'completed' }));

  assert.deepEqual(auditFixtures(manifestPath), {
    version: '1.131.0',
    commit: 'a'.repeat(40),
    fixtureCount: 1,
  });

  fs.writeFileSync(fixturePath, JSON.stringify({ path: '/Users/private/file' }));
  assert.throws(() => auditFixtures(manifestPath), /safe\.json: fixture contains home path/);
});