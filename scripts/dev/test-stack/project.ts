// scripts/dev/test-stack/project.ts
//
// Per-worktree compose project naming for the integration-test stack
// (docker-compose.test.yml). Mirrors scripts/dev/wt-stack/project.ts but with
// its own `breeze-test-` prefix so `docker compose ls` distinguishes dev
// stacks from test stacks at a glance.
import { createHash } from 'node:crypto';
import path from 'node:path';

/** The project name `docker compose -f docker-compose.test.yml` uses when no
 *  `-p` is passed (directory basename) — i.e. the historical shared stack. */
export const SHARED_TEST_PG_CONTAINER = 'breeze-postgres-test';

/** Compose project names must be lowercase [a-z0-9_-], starting al/num. */
function slug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function deriveTestProjectName(opts: { worktreePath: string; branch?: string }): string {
  const base = opts.branch ? slug(opts.branch) : '';
  if (base) {
    const full = `breeze-test-${base}`;
    if (full.length <= 50) return full;
    // Too long: truncate and append a short stable suffix for uniqueness.
    const suffix = createHash('sha1').update(base).digest('hex').slice(0, 6);
    return `breeze-test-${base.slice(0, 50 - 'breeze-test-'.length - 7)}-${suffix}`;
  }
  const hash = createHash('sha1').update(opts.worktreePath).digest('hex').slice(0, 8);
  return `breeze-test-${hash}`;
}

/** Container/network names derived from the project so two projects never
 *  collide on the fixed defaults baked into docker-compose.test.yml. */
export function stackEnv(project: string): Record<string, string> {
  return {
    // 0 = ask the kernel for an ephemeral host port; read back via
    // `docker compose port` after `up`.
    BREEZE_TEST_PG_PORT: '0',
    BREEZE_TEST_REDIS_PORT: '0',
    BREEZE_TEST_PG_CONTAINER: `${project}-postgres`,
    BREEZE_TEST_REDIS_CONTAINER: `${project}-redis`,
    BREEZE_TEST_NETWORK: `${project}-net`,
  };
}

export function envTestPath(worktreePath: string): string {
  return path.join(worktreePath, '.env.test');
}

/**
 * Parse the host port out of `docker compose port <service> <port>` output.
 * Docker may emit an IPv4 line (`0.0.0.0:54321`), an IPv6 line
 * (`[::]:54321`), or both — the port is the same, so the first non-empty
 * line wins. Throws on anything unrecognizable rather than writing a garbage
 * port into .env.test (which would only surface one layer later as a vitest
 * connection error).
 */
export function parsePublishedPort(output: string): number {
  const line = output.split('\n').map((l) => l.trim()).find(Boolean);
  const m = line?.match(/:(\d+)$/);
  if (!m) throw new Error(`Could not find a published port in compose output: ${JSON.stringify(output)} (no published port)`);
  return Number(m[1]);
}
