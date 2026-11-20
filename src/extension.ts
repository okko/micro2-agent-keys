import * as path from 'node:path';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { Coordinator } from './coordinator.js';
import { AgentKeysRuntime, errorMessage } from './runtime.js';
import { secretCredentials } from './input-credentials.js';
import { StatusView } from './status-view.js';

let coordinator: Coordinator | undefined;

function registryPath(context: vscode.ExtensionContext): string {
  const configured = vscode.workspace.getConfiguration('eu.okko.agentkeys').get<string>('agentHostRegistry');
  if (configured) {
    if (!path.isAbsolute(configured)) throw new Error('AgentKeys: Agent Host Registry must be an absolute path');
    return configured;
  }
  // globalStorageUri also respects --user-data-dir and VS Code profiles.
  let directory = context.globalStorageUri.fsPath;
  while (path.dirname(directory) !== directory) {
    if (path.basename(directory) === 'User') return path.join(path.dirname(directory), 'agent-host', 'local-endpoint');
    directory = path.dirname(directory);
  }
  throw new Error('Cannot locate VS Code user data; configure AgentKeys: Agent Host Registry in Settings');
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('AgentKeys');
  const provider = new StatusView();
  const view = vscode.window.createTreeView('eu.okko.agentkeys.keys', { treeDataProvider: provider, showCollapseAll: false });
  const log = (message: string): void => output.appendLine(message);
  context.subscriptions.push(output, provider, view);
  const credentials = secretCredentials(context.secrets);
  // Hardware and slot identities are shared across windows, workspaces, and profiles.
  const directory = path.join(os.homedir(), '.local', 'state', 'eu.okko.agentkeys');
  let lastFollowerLog: string | undefined;
  coordinator = new Coordinator({
    directory,
    log,
    createRuntime: () => new AgentKeysRuntime({
      directory,
      registryPath: registryPath(context),
      uriScheme: vscode.env.uriScheme,
      credentials,
      log,
      launch: async (url) => {
        if (!await vscode.env.openExternal(vscode.Uri.parse(url))) {
          throw new Error('VS Code could not open the session link; the key binding was retained');
        }
      },
    }),
    onChange: (state) => {
      provider.update(state);
      view.description = state.snapshot?.connected ? 'Input connected' : 'Not connected';
      if (state.role === 'follower' && state.snapshot) {
        const logs = state.snapshot.logs;
        const from = lastFollowerLog ? logs.indexOf(lastFollowerLog) + 1 : 0;
        for (const line of logs.slice(from)) log(line);
        lastFollowerLog = logs.at(-1);
      }
    },
  });
  const current = coordinator;
  const command = (name: string, action: (...args: unknown[]) => Promise<unknown> | unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(name, async (...args: unknown[]) => {
      try { return await action(...args); }
      catch (error) {
        const message = errorMessage(error);
        log(message);
        await vscode.window.showErrorMessage(`AgentKeys: ${message}`);
        return undefined;
      }
    }));
  };
  command('eu.okko.agentkeys.showStatus', () => vscode.commands.executeCommand('eu.okko.agentkeys.keys.focus'));
  command('eu.okko.agentkeys.showLogs', () => output.show());
  command('eu.okko.agentkeys.configureKeys', async () => {
    const count = await vscode.window.showInputBox({
      title: 'AgentKeys: Configure Keys',
      prompt: 'Number of consecutive API Smart Actions mapped in Input (vscode00 onward)',
      value: provider.state.snapshot?.keyCount?.toString() ?? '',
      validateInput: (value) => /^(?:[1-9]|1\d|20)$/.test(value) ? undefined : 'Enter a whole number from 1 to 20.',
    });
    if (count === undefined) return;
    await current.execute({ type: 'configure', keyCount: Number(count) });
  });
  command('eu.okko.agentkeys.reset', async () => {
    const result = await vscode.window.showWarningMessage(
      'Clear all AgentKeys bindings and return configured keys to idle? Existing turns will stay unbound until new work starts.',
      { modal: true }, 'Reset Keys',
    );
    if (result === 'Reset Keys') await current.execute({ type: 'reset' });
  });
  command('eu.okko.agentkeys.restart', () => current.execute({ type: 'restart' }));
  command('eu.okko.agentkeys.forgetAuthorization', async () => {
    const result = await vscode.window.showWarningMessage(
      'Forget saved Input authorization and request approval again in Input?',
      { modal: true }, 'Forget Authorization',
    );
    if (result === 'Forget Authorization') await current.execute({ type: 'forgetAuthorization' });
  });
  command('eu.okko.agentkeys.openKey', async (slot) => {
    if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 0 || slot >= 20) {
      throw new Error('Select a bound key in the AgentKeys sidebar');
    }
    await current.execute({ type: 'open', slot });
  });
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('eu.okko.agentkeys.agentHostRegistry')) {
      void vscode.window.showInformationMessage('AgentKeys: Reload all VS Code windows to apply the AHP registry change.');
    }
  }));
  current.start();
}

export async function deactivate(): Promise<void> {
  await coordinator?.stop();
  coordinator = undefined;
}
