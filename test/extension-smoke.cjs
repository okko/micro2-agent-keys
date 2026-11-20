const assert = require('node:assert/strict');
const vscode = require('vscode');

exports.run = async () => {
  assert.equal(typeof globalThis.WebSocket, 'function', 'InputKit requires the host WebSocket implementation');
  const extension = vscode.extensions.getExtension('okko.agent-keys');
  assert.ok(extension, 'AgentKeys must be discovered by the real extension host');
  await extension.activate();
  assert.equal(extension.isActive, true);
  const commands = await vscode.commands.getCommands(true);
  for (const command of ['showStatus', 'configureKeys', 'reset', 'restart', 'showLogs', 'forgetAuthorization']) {
    assert.ok(commands.includes(`eu.okko.agentkeys.${command}`), `Missing command: ${command}`);
  }
  assert.ok(commands.includes('workbench.view.extension.eu-okko-agentkeys'), 'Activity Bar container must be registered, not silently moved to Explorer');
  await vscode.commands.executeCommand('workbench.view.extension.eu-okko-agentkeys');
  await vscode.commands.executeCommand('eu.okko.agentkeys.showStatus');
  console.log('AgentKeys extension-host smoke test passed: activated, commands registered, sidebar opened.');
};
