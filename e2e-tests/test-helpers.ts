import { execFileSync } from 'node:child_process';

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
 */
export function clearRefreshState() {
  try {
    const args = ['exec', 'breeze-redis', 'redis-cli'];
    if (process.env.REDIS_PASSWORD) {
      args.push('-a', process.env.REDIS_PASSWORD, '--no-auth-warning');
    }
    args.push(
      'EVAL',
      "local k=redis.call('KEYS','refresh:*'); for _,v in ipairs(k) do redis.call('DEL',v) end; local r=redis.call('KEYS','token:refresh:revoked:*'); for _,v in ipairs(r) do redis.call('DEL',v) end; return #k+#r",
      '0'
    );
    execFileSync('docker', args, { stdio: 'ignore' });
  } catch (err) {
    // Non-fatal — if redis is unreachable, the test will surface a clearer
    // 401 / login-redirect error.
    console.warn('[test-helpers] clearRefreshState failed (is breeze-redis running?):', err);
  }
}
