import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { INTEGRATION_SLOT_COUNT } from './states.js';

export const CONFIG_PATH = path.join(os.homedir(), '.local', 'state', 'agentkeys', 'config.json');

export interface Config {
  keyCount: number;
}

function validateConfig(value: unknown): Config {
  if (
    typeof value !== 'object' || value === null ||
    !('keyCount' in value) || typeof value.keyCount !== 'number' ||
    !Number.isInteger(value.keyCount) || value.keyCount < 1 || value.keyCount > INTEGRATION_SLOT_COUNT
  ) {
    throw new Error(`keyCount must be an integer from 1 to ${INTEGRATION_SLOT_COUNT}`);
  }
  return { keyCount: value.keyCount };
}

export function readConfig(file = CONFIG_PATH): Config | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Cannot read AgentKeys configuration at ${file}: ${(error as Error).message}`);
  }
  try {
    return validateConfig(JSON.parse(text));
  } catch (error) {
    throw new Error(`Invalid AgentKeys configuration at ${file}: ${(error as Error).message}`);
  }
}

export function writeConfig(config: Config, file = CONFIG_PATH): void {
  const validated = validateConfig(config);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(validated, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
