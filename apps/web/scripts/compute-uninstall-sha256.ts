import { createHash } from 'crypto';
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const dir = join(import.meta.dirname, '..', 'public', 'scripts');
const files = readdirSync(dir)
  .filter((f) => f.startsWith('uninstall-') && f.endsWith('.sh'))
  .sort();
const lines = files.map((f) => {
  const hash = createHash('sha256').update(readFileSync(join(dir, f))).digest('hex');
  return `${hash}  ${f}`;
});
writeFileSync(join(dir, 'SHA256SUMS'), lines.join('\n') + '\n');
console.log(`Wrote SHA256SUMS for ${files.length} file(s)`);
