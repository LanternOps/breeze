import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default async function globalSetup() {
  const sqlPath = path.resolve(__dirname, '../seed-fixtures.sql');
  try {
    execFileSync(
      'docker',
      ['exec', '-i', 'breeze-postgres', 'psql', '-U', 'breeze', '-d', 'breeze'],
      {
        input: readFileSync(sqlPath, 'utf8'),
        stdio: ['pipe', 'inherit', 'inherit'],
      }
    );
  } catch (err) {
    console.error('[globalSetup] seed-fixtures.sql failed:', err);
    throw err;
  }
}
