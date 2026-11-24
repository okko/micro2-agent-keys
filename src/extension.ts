import * as path from 'node:path';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { Coordinator } from './coordinator.js';
import { AgentKeysRuntime, errorMessage } from './runtime.js';
import { secretCredentials } from './input-credentials.js';
import { StatusView } from './status-view.js';
import { LAYER_KEY_COUNT } from './layer.js';
import { slotIdentifier } from './lighting.js';

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
  command('eu.okko.agentkeys.addLayer', async () => {
    const snapshot = provider.state.snapshot;
    const keyCount = snapshot?.keyCount ?? null;
    if (keyCount === null) throw new Error('Choose AgentKeys: Configure Keys first');
    const target = snapshot?.layerTarget ?? null;
    if (!target) throw new Error('Connect the keyboard and wait for Input to report its current profile');
    const mapped = Math.min(keyCount, LAYER_KEY_COUNT);
    const keys = mapped === 1 ? slotIdentifier(0) : `${slotIdentifier(0)}–${slotIdentifier(mapped - 1)}`;
    const detail = [
      `Device: ${target.deviceType}${target.serial ? ` (${target.serial})` : ''}`,
      `Profile: ${target.profileIndex + 1}`,
      `Keys: ${keys}, row by row from the top left; all other controls do nothing.`,
      keyCount > mapped
        ? `The layer has ${LAYER_KEY_COUNT} keys. Map ${slotIdentifier(mapped)}–${slotIdentifier(keyCount - 1)} manually as API Smart Actions.`
        : undefined,
      'Existing layers are not changed. Input refuses if the profile already has six layers.',
      'The layer is not updated if you change the key count later. Fewer keys is harmless; for more, add another layer or map them manually.',
    ].filter(Boolean).join('\n');
    const result = await vscode.window.showWarningMessage(
      `Add a new Agent Keys layer with ${mapped} ${mapped === 1 ? 'key' : 'keys'} to the keyboard?`,
      { modal: true, detail }, 'Add Layer',
    );
    if (result !== 'Add Layer') return;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'AgentKeys: Adding layer in Input...' },
      () => current.execute({ type: 'addLayer', keyCount, ...target }),
    );
    void vscode.window.showInformationMessage(
      'AgentKeys: Layer added. Switch to it on the keyboard or in Input. If Input\'s window is open, it saves after its usual countdown.',
    );
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
