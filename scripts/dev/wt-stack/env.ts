import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { envStackPath } from './project';

/** Deterministic dev defaults — NOT secrets, local-only. Keeps a fresh worktree
 *  from booting with a partial env (the missing-.env.test → vacuous-RLS trap). */
const DEV_ENV: Record<string, string> = {
  POSTGRES_USER: 'breeze',
  POSTGRES_PASSWORD: 'breeze',
  POSTGRES_DB: 'breeze',
  ENROLLMENT_KEY_PEPPER: 'dev-enrollment-pepper-0000000000000000',
  MFA_RECOVERY_CODE_PEPPER: 'dev-mfa-pepper-00000000000000000000',
  TURN_SECRET: 'dev-turn-secret',
  IS_HOSTED: 'false',
  ENABLE_REGISTRATION: 'true',
  BINARY_SOURCE: 'github',
  CADDY_SITE_ADDRESS: ':80',
  BREEZE_PORTAL_IMAGE_REF: 'breeze-portal:dev',
  // The next four are required by `x-api-env` (docker-compose.yml) with no
  // default and postdate several developers' root .env — a stale .env leaves
  // a fresh worktree unable to boot at all. Values match .env.example's own
  // documented defaults.
  REMOTE_ACCESS_ADMISSION_MODE: 'open',
  EVENT_PERMISSION_EPOCH_MODE: 'compat',
  REMOTE_WS_AUTH_MODE: 'post_upgrade',
  REMOTE_WS_REDIS_TOPOLOGY: 'standalone-single-primary',
  // #5266 — the seeded system Partner Admin role stores `force_mfa = true`
  // (#4491), and this stack's only login is the bootstrap `admin@breeze.local`,
  // which holds that role. If enforcement is left to the API's shipping default
  // that admin is minted `mfa: false`, gets `428 mfa_enrollment_required` on its
  // first protected request, and Playwright's globalSetup lands on
  // /auth/mfa/setup instead of the dashboard — every spec then dies before it
  // runs. Pin the relief valve OFF here so the dev stack is deterministic
  // regardless of the shipping default (off this release, back ON once #5306's
  // grace-window feature lands) and regardless of what the developer's root
  // .env says — .env.stack is passed LAST, so it wins. This mirrors what the
  // portal-dev-e2e CI job already writes into its own .env. It suppresses only
  // the role-force component; settings-driven `security.requireMfa` still
  // applies, so MFA-policy specs are unaffected.
  MFA_FORCE_FOR_PARTNER_ADMIN: 'false',
  // Caddy/postgres/redis images are digest-pinned in base compose; reuse the
  // values already present in the developer's root .env via compose interpolation.
};

export function writeEnvStack(worktreePath: string): string {
  const p = envStackPath(worktreePath);
  const body = Object.entries(DEV_ENV).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  writeFileSync(p, body, 'utf8');
  return p;
}

/**
 * #5266 — read a value the way compose resolves it for this stack:
 * `--env-file .env --env-file .env.stack`, later file wins.
 *
 * Host-side tooling needs a few of these. `wt-stack test` has to hand
 * `REDIS_PASSWORD` to Playwright, because `e2e-tests/global-setup.ts` clears the
 * per-email login rate limiter with `redis-cli -a $REDIS_PASSWORD` and this
 * stack's redis requires auth — without it the DEL is rejected, a stale window
 * survives, and the one login globalSetup gets is answered `429 Too many login
 * attempts`, killing every spec exactly as the forced-MFA wall does.
 */
export function readStackEnvValue(worktreePath: string, key: string): string | undefined {
  let found: string | undefined;
  for (const file of ['.env', '.env.stack']) {
    const p = path.join(worktreePath, file);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (m?.[1] === key) found = m[2].replace(/^(["'])(.*)\1$/, '$2');
    }
  }
  return found;
}
