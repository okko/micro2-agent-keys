import * as vscode from 'vscode';
import type { CoordinatorState } from './coordinator.js';
import { slotIdentifier } from './lighting.js';

const ICONS: Record<string, [string, string]> = {
  idle: ['circle-outline', 'descriptionForeground'],
  running: ['sync~spin', 'charts.blue'],
  input: ['question', 'charts.orange'],
  done: ['pass-filled', 'charts.green'],
  error: ['error', 'errorForeground'],
};

export class StatusView implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changes.event;
  state: CoordinatorState = { role: 'connecting', snapshot: null, error: null };

  update(state: CoordinatorState): void {
    this.state = state;
    this.changes.fire();
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }

  getChildren(): vscode.TreeItem[] {
    const { snapshot, role, error } = this.state;
    const rows: vscode.TreeItem[] = [];
    if (error) {
      const item = new vscode.TreeItem(error);
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('errorForeground'));
      item.command = { command: 'eu.okko.agentkeys.showLogs', title: 'Show Logs' };
      rows.push(item);
    }
    if (!snapshot) {
      rows.push(new vscode.TreeItem('Connecting to AgentKeys...'));
      return rows;
    }
    const connection = new vscode.TreeItem(snapshot.connected ? 'Input connected' : snapshot.connecting ? 'Connecting to Input...' : 'Input disconnected');
    connection.description = role === 'owner' ? 'this window owns the connection' : 'shared with another window';
    connection.tooltip = snapshot.inputError ?? 'Keep Input running. Approve AgentKeys in Input on the first connection.';
    connection.iconPath = new vscode.ThemeIcon(snapshot.connected ? 'plug' : 'debug-disconnect');
    connection.command = { command: 'eu.okko.agentkeys.showLogs', title: 'Show Logs' };
    rows.push(connection);
    if (snapshot.inputError) {
      const item = new vscode.TreeItem(snapshot.inputError);
      item.iconPath = new vscode.ThemeIcon('warning');
      item.command = { command: 'eu.okko.agentkeys.showLogs', title: 'Show Logs' };
      rows.push(item);
    }
    const sessions = new vscode.TreeItem(`AHP: ${snapshot.availableSessions} available sessions`);
    sessions.description = `${snapshot.trackedSessions} tracked`;
    sessions.tooltip = `Endpoint registry: ${snapshot.registryPath}\nOnly host-advertised local sessions are supported.`;
    rows.push(sessions);
    const configure = new vscode.TreeItem(snapshot.keyCount === null ? 'Configure your keys to begin' : `${snapshot.keyCount} configured keys`);
    configure.iconPath = new vscode.ThemeIcon('settings-gear');
    configure.command = { command: 'eu.okko.agentkeys.configureKeys', title: 'Configure Keys' };
    rows.push(configure);
    for (const slot of snapshot.slots) {
      const item = new vscode.TreeItem(slotIdentifier(slot.slot));
      item.id = `eu.okko.agentkeys.slot-${slot.slot}`;
      item.description = `${slot.state} - ${slot.label ?? 'unbound'}`;
      item.tooltip = [
        `${slotIdentifier(slot.slot)}: ${slot.state}`,
        slot.cwd,
        slot.sessionId ? `Session: ${slot.sessionId}` : 'No session bound',
        slot.stateChangedAt ? `Updated: ${slot.stateChangedAt}` : undefined,
        slot.runError,
      ].filter(Boolean).join('\n');
      const [icon, color] = ICONS[slot.state];
      item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
      if (slot.sessionId) item.command = { command: 'eu.okko.agentkeys.openKey', title: 'Open Session', arguments: [slot.slot] };
      rows.push(item);
    }
    return rows;
  }

  dispose(): void { this.changes.dispose(); }
}
