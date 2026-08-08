#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST_PATH = path.join(ROOT, 'test', 'fixtures', 'vscode-human-input', 'manifest.json');
const DEFAULT_APPS = [
  '/Applications/Visual Studio Code.app',
  '/Applications/Visual Studio Code - Insiders.app',
];
const BUNDLE_CONTRACTS = [
  {
    relativePath: 'out/vs/workbench/workbench.desktop.main.js',
    tokens: [
      'questionCarousel',
      'elicitationSerialized',
      'toolInvocationSerialized',
      'pending-confirmation',
      'pending-result-confirmation',
      'auth-required',
      'chat/inputCompleted',
      'chat/toolCallConfirmed',
      'chat/toolCallResultConfirmed',
      'chat/turnCancelled',
      'authenticateMcpServer',
      'mcpAuthenticationRequired',
    ],
  },
  {
    relativePath: 'out/vs/platform/agentHost/node/agentHostMain.js',
    tokens: [
      'pending-confirmation',
      'pending-result-confirmation',
      'auth-required',
      'chat/inputCompleted',
      'chat/toolCallConfirmed',
      'chat/toolCallResultConfirmed',
      'chat/turnCancelled',
      'editedToolInput',
      'requiresResultConfirmation',
      'insufficientScope',
    ],
  },
];
const PRIVACY_PATTERNS = [
  ['home path', /\/(?:Users|home)\//],
  ['file URI', /file:\/\//i],
  ['raw UUID', /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i],
  ['JWT-like token', /eyJ[A-Za-z0-9_-]{40}/],
  ['absolute timestamp', /20\d\d-\d\d-\d\dT\d\d:/],
  ['authorization header', /authorization\s*:/i],
  ['bearer token', /bearer\s+\S+/i],
  ['OAuth token field', /(?:access_token|refresh_token|client_secret)/i],
];

function usage() {
  return `Usage: npm run verify:vscode-update -- [options]

Options:
  --app <path>    VS Code .app bundle (defaults to Stable, then Insiders)
  --skip-tests    Skip npm test; intended only for verifier development
  --help          Show this help
`;
}

export function parseArgs(argv) {
  const options = { skipTests: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--help') return { help: true, skipTests: false };
    if (argument === '--skip-tests') {
      options.skipTests = true;
      continue;
    }
    if (argument === '--app') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error('--app requires a path');
      options.app = path.resolve(value);
      continue;
    }
    throw new Error(`unknown argument ${argument}`);
  }
  return options;
}

export function findVscodeApp(explicitApp, candidates = DEFAULT_APPS) {
  if (explicitApp) {
    if (!fs.statSync(explicitApp, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error(`VS Code app does not exist: ${explicitApp}`);
    }
    return explicitApp;
  }
  const app = candidates.find((candidate) =>
    fs.statSync(candidate, { throwIfNoEntry: false })?.isDirectory()
  );
  if (!app) {
    throw new Error('VS Code Stable or Insiders was not found; pass --app <path>');
  }
  return app;
}

export function readVscodeBuild(appPath) {
  const resources = path.join(appPath, 'Contents', 'Resources', 'app');
  const packagePath = path.join(resources, 'package.json');
  let packageJson;
  try {
    packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read VS Code metadata at ${packagePath}: ${error.message}`);
  }
  if (typeof packageJson.version !== 'string' || packageJson.version.length === 0) {
    throw new Error(`VS Code metadata has no version: ${packagePath}`);
  }
  const commit = packageJson.distro ?? packageJson.commit ?? null;
  return { appPath, resources, version: packageJson.version, commit };
}

export function verifyBundleContracts(resources, contracts = BUNDLE_CONTRACTS) {
  const checked = [];
  for (const contract of contracts) {
    const file = path.join(resources, contract.relativePath);
    let source;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch (error) {
      throw new Error(`cannot read installed VS Code bundle ${file}: ${error.message}`);
    }
    const missing = contract.tokens.filter((token) => !source.includes(token));
    if (missing.length > 0) {
      throw new Error(
        `${contract.relativePath} is missing AgentKeys contract token(s): ${missing.join(', ')}`
      );
    }
    checked.push({ file: contract.relativePath, tokenCount: contract.tokens.length });
  }
  return checked;
}

export function auditFixtures(manifestPath = MANIFEST_PATH) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const fixtureRoot = path.dirname(manifestPath);
  const manifestFiles = manifest.fixtures.map(({ file }) => file);
  const declaredFiles = new Set(manifestFiles);
  if (declaredFiles.size !== manifestFiles.length) {
    throw new Error('fixture manifest contains duplicate file entries');
  }
  const fixtureFiles = fs.readdirSync(fixtureRoot)
    .filter((file) => file.endsWith('.json') && file !== path.basename(manifestPath));
  for (const file of fixtureFiles) {
    if (!declaredFiles.has(file)) throw new Error(`unlisted fixture file: ${file}`);
  }
  for (const file of manifestFiles) {
    if (!fixtureFiles.includes(file)) throw new Error(`missing fixture file: ${file}`);
  }
  for (const entry of manifest.fixtures) {
    const file = path.join(fixtureRoot, entry.file);
    const contents = fs.readFileSync(file, 'utf8');
    if (Buffer.byteLength(contents) >= 100_000) {
      throw new Error(`${entry.file}: fixture exceeds 100 KB`);
    }
    for (const [label, pattern] of PRIVACY_PATTERNS) {
      if (pattern.test(contents)) throw new Error(`${entry.file}: fixture contains ${label}`);
    }
  }
  return {
    version: manifest.capturedFrom.version,
    commit: manifest.capturedFrom.commit,
    fixtureCount: manifest.fixtures.length,
  };
}

function runTests() {
  const result = spawnSync('npm', ['test'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) throw new Error(`could not run npm test: ${result.error.message}`);
  if (result.status !== 0) {
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    throw new Error(`npm test failed with exit code ${result.status}`);
  }
  const testCount = /(?:^|\n).*?tests\s+(\d+)(?:\n|$)/.exec(result.stdout)?.[1];
  return testCount ? `${testCount} tests passed` : 'full suite passed';
}

export function sameBuild(installed, evidence) {
  if (installed.version !== evidence.version) return false;
  if (!installed.commit || !evidence.commit) return false;
  return installed.commit === evidence.commit;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  process.stdout.write('[1/4] Discovering installed VS Code...\n');
  const appPath = findVscodeApp(options.app ?? process.env.VSCODE_APP);
  const installed = readVscodeBuild(appPath);
  process.stdout.write(`      ${installed.version} (${installed.commit ?? 'commit unavailable'})\n`);

  process.stdout.write('[2/4] Checking consumed VS Code bundle contracts...\n');
  const checked = verifyBundleContracts(installed.resources);
  process.stdout.write(
    `      ${checked.reduce((sum, item) => sum + item.tokenCount, 0)} tokens in ${checked.length} bundles\n`
  );

  process.stdout.write('[3/4] Running AgentKeys build and tests...\n');
  if (options.skipTests) {
    process.stdout.write('      skipped by --skip-tests\n');
  } else {
    process.stdout.write(`      ${runTests()}\n`);
  }

  process.stdout.write('[4/4] Auditing captured fixture privacy and provenance...\n');
  const evidence = auditFixtures();
  process.stdout.write(`      ${evidence.fixtureCount} fixtures from VS Code ${evidence.version}\n`);

  process.stdout.write(options.skipTests
    ? '\nVS Code update marker checks passed; tests were skipped.\n'
    : '\nVS Code update structural verification passed.\n');
  process.stdout.write(`Runtime contract markers: present in ${installed.version}\n`);
  if (sameBuild(installed, evidence)) {
    process.stdout.write('Evidence corpus: current for this exact build\n');
  } else {
    process.stdout.write(
      `Evidence corpus: pinned to ${evidence.version}; retained as historical production evidence\n`
    );
    process.stdout.write(
      'No fixture provenance was rewritten. Recapture only when adding empirical coverage.\n'
    );
    process.stdout.write(
      'Structural probes do not detect semantic changes or newly available producer paths.\n'
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`\nVS Code update verification failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}