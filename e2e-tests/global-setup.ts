import { chromium, type FullConfig } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const STORAGE_STATE = path.resolve(__dirname, '.auth/user.json');

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
      ? [...composeBase, 'exec', '-T', 'postgres', 'psql', '-U', 'breeze', '-d', 'breeze']
      : ['exec', '-i', 'breeze-postgres', 'psql', '-U', 'breeze', '-d', 'breeze'];
    execFileSync('docker', psqlArgs, {
      cwd: repoRoot,
      input: readFileSync(sqlPath, 'utf8'),
      stdio: ['pipe', 'inherit', 'inherit'],
    });
  } catch (err) {
    console.error('[globalSetup] seed-fixtures.sql failed:', err);
    throw err;
  }

  // 2. Clear the per-email login rate limiter so a stale window from a prior
  // run doesn't 429 the single login below.
  try {
    const args = composeBase
      ? [...composeBase, 'exec', '-T', 'redis', 'redis-cli']
      : ['exec', 'breeze-redis', 'redis-cli'];
    if (process.env.REDIS_PASSWORD) {
      args.push('-a', process.env.REDIS_PASSWORD, '--no-auth-warning');
    }
    args.push(
      'EVAL',
      "local k=redis.call('KEYS','login:*'); for _,v in ipairs(k) do redis.call('DEL',v) end; return #k",
      '0'
    );
    execFileSync('docker', args, { cwd: repoRoot, stdio: 'ignore' });
  } catch {
    // Non-fatal — login below will surface a clearer error if redis is unreachable.
  }

  // 3. Log in once and persist storage state for every test to share.
  const baseURL =
    process.env.E2E_BASE_URL ?? config.projects[0]?.use?.baseURL ?? 'http://localhost:4321';
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error('[globalSetup] E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD must be set');
  }

  mkdirSync(path.dirname(STORAGE_STATE), { recursive: true });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ baseURL });
  const page = await ctx.newPage();
  try {
    await page.goto('/login');
    await page.locator('[data-testid="login-email-input"]').fill(email);
    await page.locator('[data-testid="login-password-input"]').fill(password);
    await page.locator('[data-testid="login-submit"]').click();
    await page.waitForURL('/', { timeout: 30_000 });
    await ctx.storageState({ path: STORAGE_STATE });
  } finally {
    await browser.close();
  }
}
