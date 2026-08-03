import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

writeFileSync(new URL('../dist/build-id', import.meta.url), `${randomUUID()}\n`);