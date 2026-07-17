import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Clear the per-user refresh-token rate limiter and revoked-JTI set in Redis.
 *
 * Why: every test context starts from the same shared `storageState` produced
 * by `globalSetup`. When a test triggers `/auth/refresh`, the API rotates the
 * token and revokes the prior JTI. The next test using the same storageState
 * cookie would 401. Clearing these keys between tests lets the shared
 * refresh token keep working across contexts.
 *
 * Pair with `test.describe.configure({ mode: 'serial' })` at the top of each
 * spec file — the `beforeEach` clear plus serial execution avoids inter-test
 * refresh races within a file.
 *
 * wt-stack aware: resolves the redis container the same way global-setup.ts
 * does (via the `E2E_STACK_FILE` descriptor's `project`), falling back to the
 * bare `breeze-redis` container name for the singleton/non-worktree stack.
 * Without this, every wt-stack run silently no-ops here (wrong container
 * name — `docker exec breeze-redis` doesn't exist under a
 * `breeze-wt-*` project), and a long-running serial spec eventually 401s
 * once the shared token's JTI gets revoked by an untracked refresh.
 */
export function clearRefreshState() {
  try {
    const stackFile = process.env.E2E_STACK_FILE ?? path.resolve(__dirname, '.breeze-stack.json');
    const stackRaw = existsSync(stackFile) ? readFileSync(stackFile, 'utf8') : null;
    const project = stackRaw ? (JSON.parse(stackRaw) as { project?: string }).project : undefined;
    const repoRoot = path.resolve(__dirname, '..');
    const composeBase = project
      ? ['compose', '-p', project, '--env-file', '.env', '--env-file', '.env.stack',
         '-f', 'docker-compose.yml', '-f', 'docker-compose.override.yml.dev', '-f', 'docker-compose.override.yml.worktree']
      : null;

    const args = composeBase ? [...composeBase, 'exec', '-T', 'redis', 'redis-cli'] : ['exec', 'breeze-redis', 'redis-cli'];
    if (process.env.REDIS_PASSWORD) {
      args.push('-a', process.env.REDIS_PASSWORD, '--no-auth-warning');
    }
    args.push(
      'EVAL',
      "local k=redis.call('KEYS','refresh:*'); for _,v in ipairs(k) do redis.call('DEL',v) end; local r=redis.call('KEYS','token:refresh:revoked:*'); for _,v in ipairs(r) do redis.call('DEL',v) end; return #k+#r",
      '0'
    );
    execFileSync('docker', args, { cwd: repoRoot, stdio: 'ignore' });
  } catch (err) {
    // Non-fatal — if redis is unreachable, the test will surface a clearer
    // 401 / login-redirect error.
    console.warn('[test-helpers] clearRefreshState failed (is redis running?):', err);
  }
}
