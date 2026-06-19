import { writeFileSync } from 'node:fs';
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
  // Caddy/postgres/redis images are digest-pinned in base compose; reuse the
  // values already present in the developer's root .env via compose interpolation.
};

export function writeEnvStack(worktreePath: string): string {
  const p = envStackPath(worktreePath);
  const body = Object.entries(DEV_ENV).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  writeFileSync(p, body, 'utf8');
  return p;
}
