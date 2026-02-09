import { config } from 'dotenv';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { runManualSqlMigrations } from './migrations/run';

// Load .env from monorepo root (when running from apps/api) or cwd (when running from root)
config({ path: '../../.env' });
config();

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: process.env
    });

    child.on('error', (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error(
          `"${command}" not found. Ensure it is installed (pnpm install) and available on PATH.`
        ));
        return;
      }
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Command failed (${command} ${args.join(' ')}) with exit code ${code}`));
    });
  });
}

async function run(): Promise<void> {
  const drizzleJournalPath = path.resolve(process.cwd(), 'drizzle/meta/_journal.json');
  if (existsSync(drizzleJournalPath)) {
    await runCommand('drizzle-kit', ['migrate']);
  } else {
    console.warn(`[db:migrate] WARNING: skipping drizzle-kit migrate (journal not found at ${drizzleJournalPath})`);
  }

  await runManualSqlMigrations();
}

run().catch((error) => {
  console.error('[db:migrate] failed:', error);
  process.exit(1);
});
