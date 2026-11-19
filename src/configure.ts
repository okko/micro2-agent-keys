import { createInterface } from 'node:readline';
import { CONFIG_PATH, readConfig, writeConfig } from './config.js';
import { INTEGRATION_SLOT_COUNT } from './states.js';
import { slotIdentifier } from './lighting.js';

async function configure(): Promise<void> {
  const current = readConfig();
  console.log('Choose how many API Smart Action keys you have activated in Input.');
  console.log('Use consecutive identifiers starting at vscode00; at least one key is required.');
  const prompt = `Activated keys (1-${INTEGRATION_SLOT_COUNT})${current ? ` [${current.keyCount}]` : ''}: `;
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(prompt);
    for await (const line of lines) {
      const answer = line.trim();
      const count = answer === '' && current ? current.keyCount : /^\d+$/.test(answer) ? Number(answer) : NaN;
      if (!Number.isInteger(count) || count < 1 || count > INTEGRATION_SLOT_COUNT) {
        console.error(`Enter a whole number from 1 to ${INTEGRATION_SLOT_COUNT}.`);
        process.stdout.write(prompt);
        continue;
      }
      writeConfig({ keyCount: count });
      console.log(`Enabled ${count} keys: vscode00 through ${slotIdentifier(count - 1)}.`);
      console.log(`Saved ${CONFIG_PATH}. Restart the daemon to apply changes.`);
      return;
    }
    throw new Error('No key count supplied; configuration was not changed. Run the installer in a terminal.');
  } finally {
    lines.close();
  }
}

void configure().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
