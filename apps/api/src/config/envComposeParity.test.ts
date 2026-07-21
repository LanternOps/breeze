import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// apps/api/src/config -> repo root is 4 levels up (same as proxyTrustCompose.test.ts).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const ENV_EXAMPLE_PATH = path.join(REPO_ROOT, '.env.example');
const COMPOSE_PATH = path.join(REPO_ROOT, 'docker-compose.yml');

/**
 * Why this test exists
 * --------------------
 * The stock `docker-compose.yml` does NOT `env_file: .env` — it hand-threads
 * each variable into a service `environment:` block as `${VAR:-default}`. That
 * is deliberate (least-privilege per container, `:?required` fail-fast, baked
 * defaults, derived values, file-backed secrets), but it has a sharp edge: a
 * variable documented in `.env.example` that nobody remembered to add to a
 * service block is **silently inert** — setting it in `.env` does nothing.
 *
 * This has shipped bad deploys repeatedly (IS_HOSTED / #570, the release-key,
 * and — the reason this test exists — a self-hoster whose CORS/2FA/platform-admin
 * settings all no-op'd because they were never threaded through Compose).
 *
 * The guard: every active variable in `.env.example` MUST be either
 *   (a) referenced somewhere in docker-compose.yml (mapped into a container, or
 *       used for interpolation), or
 *   (b) listed in HOST_ONLY_ALLOWLIST below with a reason.
 * Adding a new documented var without doing one of those two fails CI here,
 * instead of silently in someone's production deploy.
 */

// Variables intentionally NOT threaded into the standalone API/web containers.
// Every entry needs a reason; a stale entry (no longer in .env.example) also
// fails this suite, so the list can't rot.
const HOST_ONLY_ALLOWLIST: Record<string, string> = {
  // Host / Compose-level, or consumed by a DIFFERENT service — never the API.
  COMPOSE_PROJECT_NAME: 'Compose project name (host-level, not a container env)',
  POSTGRES_PORT: 'postgres service host port',
  WEB_PORT: 'web service host port',
  MINIO_API_PORT: 'optional MinIO service host port',
  MINIO_CONSOLE_PORT: 'optional MinIO console host port',
  GRAFANA_ADMIN_USER: 'consumed by docker-compose.monitoring.yml, not the core stack',
  GRAFANA_ADMIN_PASSWORD: 'consumed by docker-compose.monitoring.yml, not the core stack',
  BREEZE_API_HOST_PORT: 'guided-setup external-proxy bookkeeping (host bind port)',
  BREEZE_WEB_HOST_PORT: 'guided-setup external-proxy bookkeeping (host bind port)',
  BREEZE_PROXY_BIND_HOST: 'guided-setup external-proxy bookkeeping',
  BREEZE_PROXY_TARGET_HOST: 'guided-setup external-proxy bookkeeping',
  BREEZE_EXTERNAL_PROXY: 'guided-setup external-proxy bookkeeping',
  BREEZE_EXTERNAL_PROXY_CIDRS: 'guided-setup copies this into TRUSTED_PROXY_CIDRS (which IS mapped)',

  // Redis is configured via the file-backed `redis_password` secret plus
  // REDIS_HOST/REDIS_PORT in the api block — raw REDIS_PASSWORD/REDIS_URL are
  // intentionally not passed to the API container.
  REDIS_PASSWORD: 'API uses REDIS_PASSWORD_FILE secret + REDIS_HOST/REDIS_PORT (already mapped)',
  REDIS_URL: 'API derives its Redis connection from REDIS_HOST/REDIS_PORT + the file secret',

  // Web (Astro) build-time values. The web image is prebuilt in CI, so PUBLIC_*
  // and the web Sentry vars are baked at build time and cannot be set at runtime
  // on a pulled image. Threading them into the web `environment:` block would be
  // misleading, not functional. (Tracked separately if runtime override is ever needed.)
  PUBLIC_RELEASE_VERSION: 'web build-time (baked into the prebuilt web image)',
  PUBLIC_TICKET_MAILBOX_APP_ID: 'web build-time PUBLIC_ var (baked into the prebuilt web image)',
  ENABLE_SENTRY_SMOKE: 'web build/SSR smoke flag (baked into the prebuilt web image)',
  SENTRY_DSN_WEB_SERVER: 'web SSR Sentry DSN (baked into the prebuilt web image)',
  SENTRY_AUTH_TOKEN: 'build-time source-map upload (CI only, never a runtime container env)',
  SENTRY_ORG: 'build-time source-map upload (CI only)',
  SENTRY_PROJECT: 'build-time source-map upload (CI only)',

  // Documented in .env.example but NOT read by any code path (verified by grep).
  // Kept here so the guard passes; candidates for removal from .env.example.
  ENABLE_API_DOCS: 'documented but not consumed by the API (vestigial in .env.example)',
  RATE_LIMIT_MAX_REQUESTS: 'documented but not consumed by the API (vestigial in .env.example)',
  RATE_LIMIT_WINDOW_MS: 'documented but not consumed by the API (vestigial in .env.example)',
  SESSION_MAX_AGE: 'documented but not consumed by the API (SESSION_MAX_AGE_MS is a hardcoded constant)',
};

function activeEnvExampleVars(): string[] {
  const text = readFileSync(ENV_EXAMPLE_PATH, 'utf8');
  const names = new Set<string>();
  for (const line of text.split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=/.exec(line); // uncommented assignments only
    if (m) names.add(m[1]);
  }
  return [...names].sort();
}

function isReferencedInCompose(varName: string, compose: string): boolean {
  const esc = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // (a) mapped as a service env key: `      VAR: ...`
  const asKey = new RegExp(`^\\s*${esc}:(\\s|$)`, 'm');
  // (b) used in `${VAR}` / `${VAR:-x}` / `${VAR:?x}` / `${VAR-x}` interpolation
  const asInterp = new RegExp(`\\$\\{${esc}[-:}]`);
  return asKey.test(compose) || asInterp.test(compose);
}

describe('.env.example ↔ docker-compose.yml parity', () => {
  const compose = readFileSync(COMPOSE_PATH, 'utf8');
  const envVars = activeEnvExampleVars();

  it('every documented .env.example variable is either mapped in compose or explicitly allow-listed', () => {
    const unwired = envVars.filter(
      (v) => !isReferencedInCompose(v, compose) && !(v in HOST_ONLY_ALLOWLIST),
    );
    expect(
      unwired,
      `These vars are in .env.example but never reach a container (setting them in .env is a silent no-op). ` +
        `Add each to a service 'environment:' block in docker-compose.yml, or to HOST_ONLY_ALLOWLIST with a reason:\n  ` +
        unwired.join('\n  '),
    ).toEqual([]);
  });

  it('has no stale allow-list entries (every allow-listed var still exists in .env.example)', () => {
    const envSet = new Set(envVars);
    const stale = Object.keys(HOST_ONLY_ALLOWLIST).filter((v) => !envSet.has(v));
    expect(
      stale,
      `These vars are allow-listed but no longer active in .env.example — remove them from HOST_ONLY_ALLOWLIST:\n  ` +
        stale.join('\n  '),
    ).toEqual([]);
  });

  it('does not redundantly allow-list a var that is already mapped in compose', () => {
    const redundant = Object.keys(HOST_ONLY_ALLOWLIST).filter((v) => isReferencedInCompose(v, compose));
    expect(
      redundant,
      `These vars are BOTH mapped in compose and allow-listed — drop them from HOST_ONLY_ALLOWLIST:\n  ` +
        redundant.join('\n  '),
    ).toEqual([]);
  });
});
