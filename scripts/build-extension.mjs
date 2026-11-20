import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

await build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['vscode'],
  outfile: 'dist/extension.cjs',
});
await mkdir('dist/licenses', { recursive: true });
for (const [source, target] of [
  ['node_modules/ws/LICENSE', 'ws-LICENSE'],
  ['node_modules/@worklouder/input-kit/LICENSE', 'input-kit-LICENSE'],
  ['node_modules/@worklouder/input-kit/NOTICE', 'input-kit-NOTICE'],
  ['licenses/agent-host-protocol-LICENSE', 'agent-host-protocol-LICENSE'],
]) {
  await copyFile(source, `dist/licenses/${target}`);
}
