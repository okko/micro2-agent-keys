import * as fs from 'fs';
import {
  NativeChatProjection,
  SOURCE_NATIVE,
  emptyCompatibility,
  updateCompatibility,
  type Compatibility,
  type NativePatch,
  type SessionSource,
  type VSCodeEvent,
} from './vscode-chat-state.js';

export interface WorkspaceMetadata {
  id: string | null;
  cwd: string | null;
  clientName: string | null;
}

function parseYamlScalar(source: string, key: string): string | null {
  const match = source.match(new RegExp(`^${key}:\\s*(.*?)\\s*$`, 'm'));
  if (!match) return null;
  const value = match[1];
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return null;
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

export function workspaceMetadata(source: string): WorkspaceMetadata {
  return {
    id: parseYamlScalar(source, 'id'),
    cwd: parseYamlScalar(source, 'cwd'),
    clientName: parseYamlScalar(source, 'client_name'),
  };
}

export function applyNativeJournalPatches(
  projection: NativeChatProjection,
  patches: NativePatch[],
  rebuild: boolean
): void {
  let startIndex = 0;
  if (rebuild) {
    projection.reset();
    startIndex = -1;
    for (let index = patches.length - 1; index >= 0; index--) {
      if (patches[index].kind === 0) {
        startIndex = index;
        break;
      }
    }
    if (startIndex < 0) return;
  }
  for (let index = startIndex; index < patches.length; index++) projection.apply(patches[index]);
}

export function nativeProjectionFromFile(journalPath: string | null): NativeChatProjection {
  const projection = new NativeChatProjection();
  if (!journalPath) return projection;
  try {
    const patches: NativePatch[] = [];
    for (const line of completeJsonlLines(fs.readFileSync(journalPath, 'utf8'))) {
      if (!line.trim()) continue;
      try {
        patches.push(JSON.parse(line) as NativePatch);
      } catch {
        // Ignore malformed records; the append reader reports them with their offsets.
      }
    }
    applyNativeJournalPatches(projection, patches, true);
  } catch {
    // The normal scan path reports inaccessible session files.
  }
  return projection;
}

function completeJsonlLines(contents: string): string[] {
  const lines = contents.split('\n');
  if (!contents.endsWith('\n')) lines.pop();
  return lines;
}

export function inspectCompatibility(eventsPath: string, source: SessionSource, journalPath: string | null = null): Compatibility {
  const compatibility = emptyCompatibility();
  const contents = fs.readFileSync(eventsPath, 'utf8');
  for (const line of completeJsonlLines(contents)) {
    if (!line.trim()) continue;
    try {
      updateCompatibility(compatibility, JSON.parse(line) as VSCodeEvent, source);
    } catch {
      // Malformed line; ignore for compatibility inspection purposes.
    }
  }
  if (source === SOURCE_NATIVE && journalPath) {
    const projection = new NativeChatProjection();
    const journal = fs.readFileSync(journalPath, 'utf8');
    for (const line of completeJsonlLines(journal)) {
      if (!line.trim()) continue;
      try {
        projection.apply(JSON.parse(line) as NativePatch);
        if (projection.snapshot().terminal) {
          updateCompatibility(compatibility, { type: 'request.completed' }, source);
          break;
        }
      } catch {
        // Malformed line; ignore.
      }
    }
  }
  return compatibility;
}
