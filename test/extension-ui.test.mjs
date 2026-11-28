import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';

const require = createRequire(import.meta.url);

test('bundled extension activates, renders live key rows, and disposes without starting Input before setup', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentkeys-extension-ui-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const registered = new Map();
  const errors = [];
  let provider;
  const vscode = {
    EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
    TreeItem: class { constructor(label) { this.label = label; } },
    ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
    ThemeColor: class { constructor(id) { this.id = id; } },
    window: {
      createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
      createTreeView(_id, options) { provider = options.treeDataProvider; return { dispose() {} }; },
      async showErrorMessage(message) { errors.push(message); },
    },
    commands: {
      registerCommand(id, handler) { registered.set(id, handler); return { dispose() {} }; },
      async executeCommand() {},
    },
    workspace: {
      getConfiguration: () => ({ get: () => '' }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
    },
    env: { uriScheme: 'vscode-insiders' },
  };
  const context = {
    asAbsolutePath: (relative) => path.resolve(relative),
    subscriptions: [],
    globalStorageUri: { fsPath: path.join(directory, 'Code', 'User', 'globalStorage', 'okko.agent-keys') },
    secrets: { async get() { assert.fail('unconfigured extension must not read credentials'); } },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(new URL('../dist/extension.cjs', import.meta.url), 'utf8'), {
    module, exports: module.exports,
    require(name) {
      if (name === 'vscode') return vscode;
      if (name === 'node:os') return { ...os, homedir: () => directory };
      if (name === 'node:http') return {
        ...http,
        createServer(...args) {
          const server = http.createServer(...args);
          const listen = server.listen;
          server.listen = function (_port, ...rest) { return listen.call(this, 0, ...rest); };
          return server;
        },
      };
      return require(name);
    },
    process, Buffer, URL, AbortController, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate, console,
  });
  t.after(async () => {
    await module.exports.deactivate();
    for (const subscription of context.subscriptions) subscription.dispose();
  });
  module.exports.activate(context);
  for (let attempt = 0; attempt < 100 && !provider.state.snapshot; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(provider.state.role, 'owner', JSON.stringify(provider.state));
  assert.ok(provider.getChildren().some((row) => row.label === 'Configure your keys to begin'));
  assert.ok(registered.has('eu.okko.agentkeys.reset'));
  assert.ok(registered.has('eu.okko.agentkeys.restart'));
  await registered.get('eu.okko.agentkeys.openKey')('invalid');
  assert.match(errors[0], /Select a bound key/);
  provider.update({
    role: 'follower', error: null,
    snapshot: {
      keyCount: 2, connected: true, connecting: false, inputError: null,
      registryPath: directory, availableSessions: 1, trackedSessions: 1, logs: [],
      slots: [
        { slot: 0, state: 'input', label: 'project', sessionId: 'session', cwd: '/tmp/project', runError: null },
        { slot: 1, state: 'idle' },
      ],
    },
  });
  const keys = provider.getChildren().filter((row) => row.id?.startsWith('eu.okko.agentkeys.slot-'));
  assert.deepEqual(Array.from(keys, (row) => row.label), ['vscode00', 'vscode01']);
  assert.equal(keys[0].description, 'input - project');
  assert.equal(keys[0].command.command, 'eu.okko.agentkeys.openKey');
  assert.equal(keys[0].command.arguments[0], 0);
  assert.equal(keys[0].iconPath.color.id, 'charts.orange');
  assert.equal(keys[1].command, undefined);
  assert.match(keys[0].tooltip, /\/tmp\/project/);
});
