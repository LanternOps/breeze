import { chromium, type FullConfig } from '@playwright/test';
import { AUTH_DIR, loginAndSaveState } from './auth-state';
import { clearLoginRateLimit } from './test-helpers';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/**
 * The run-level login's storageState. Tests do NOT consume this any more —
 * each worker logs in for itself (`workerStorageState` in fixtures.ts) so it
 * owns its own refresh-token family. This login stays as a fail-fast probe
 * that the stack accepts the E2E credentials before any worker starts.
 */
export const STORAGE_STATE = path.join(AUTH_DIR, 'user.json');

export default async function globalSetup(config: FullConfig) {
  // Resolve the optional stack descriptor written by the wt-stack tooling.
  const stackFile = process.env.E2E_STACK_FILE ?? path.resolve(__dirname, '..', '.breeze-stack.json');
  const stackRaw = existsSync(stackFile) ? readFileSync(stackFile, 'utf8') : null;
  const stack = stackRaw ? JSON.parse(stackRaw) : null;
  const project = stack?.project as string | undefined;
  const repoRoot = path.resolve(__dirname, '..');
  const composeBase = project
    ? ['compose', '-p', project, '--env-file', '.env', '--env-file', '.env.stack',
       '-f', 'docker-compose.yml', '-f', 'docker-compose.override.yml.dev', '-f', 'docker-compose.override.yml.worktree']
    : null;

  // 1. Seed the database (idempotent fixtures used across the suite)
  const sqlPath = path.resolve(__dirname, 'seed-fixtures.sql');
  try {
    const psqlArgs = composeBase
      ? [...composeBase, 'exec', '-T', 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'breeze', '-d', 'breeze']
      : ['exec', '-i', 'breeze-postgres', 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'breeze', '-d', 'breeze'];
    execFileSync('docker', psqlArgs, {
      cwd: repoRoot,
      input: readFileSync(sqlPath, 'utf8'),
      stdio: ['pipe', 'inherit', 'inherit'],
    });
  } catch (err) {
    console.error('[globalSetup] seed-fixtures.sql failed:', err);
    throw err;
  }

  // 2. Clear the login rate limiters so a stale window from a prior run
  // doesn't 429 the probe login below.
  clearLoginRateLimit();

  // 3. Fail fast if the stack rejects the E2E credentials. Workers each log
  // in again for their own storageState; see fixtures.ts.
  const baseURL =
    process.env.E2E_BASE_URL ?? config.projects[0]?.use?.baseURL ?? 'http://localhost:4321';
  const browser = await chromium.launch();
  try {
    await loginAndSaveState(browser, baseURL, STORAGE_STATE);
  } finally {
    await browser.close();
  }
}
