import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// apps/api/src/config -> repo root is 4 levels up (same as proxyTrustCompose.test.ts).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * Why this test exists
 * --------------------
 * Neither compose file uses `env_file: .env` — they hand-thread each variable
 * into a service `environment:` block as `${VAR:-default}`. That is deliberate
 * (least-privilege per container, `:?required` fail-fast, baked defaults,
 * derived values, file-backed secrets), but it has a sharp edge: a variable
 * documented in the paired `.env.example` that nobody added to a service block
 * is **silently inert** — setting it in `.env` does nothing.
 *
 * This has shipped bad deploys repeatedly (IS_HOSTED / #570, the release key,
 * and — the reason this test exists — a self-hoster whose CORS/2FA/platform-admin
 * settings all no-op'd because they were never threaded through Compose).
 *
 * The guard, per env-example ↔ compose pair: every active variable in the
 * `.env.example` MUST be either
 *   (a) referenced in the compose file (mapped into a container, sourced into a
 *       secret, or used for interpolation), or
 *   (b) listed in that pair's allow-list below with a reason.
 * Adding a documented var without doing one of those two fails CI here, in the
 * required test-api job, instead of silently in someone's production deploy.
 */

// Variables intentionally NOT threaded into the self-host (root) stack's
// containers. Every entry needs a reason; a stale entry (no longer in
// .env.example) or a redundant one (already mapped) also fails this suite, so
// the list can't rot.
const ROOT_ALLOWLIST: Record<string, string> = {
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

  // REDIS_URL is not consumed by the API container (it derives its connection
  // from REDIS_HOST/REDIS_PORT + the file-backed redis_password secret).
  // REDIS_PASSWORD is NOT here: it sources the redis_password secret via
  // `environment: REDIS_PASSWORD`, which isReferencedInCompose() detects.
  REDIS_URL: 'API derives its Redis connection from REDIS_HOST/REDIS_PORT + the file secret',

  // Web (Astro) build-time values. The web image is prebuilt in CI, so PUBLIC_*
  // and the web Sentry vars are baked at build time and cannot be set at runtime
  // on a pulled image. Threading them into the web `environment:` block would be
  // misleading, not functional.
  PUBLIC_RELEASE_VERSION: 'web build-time (baked into the prebuilt web image)',
  PUBLIC_TICKET_MAILBOX_APP_ID: 'web build-time PUBLIC_ var (baked into the prebuilt web image)',
  ENABLE_SENTRY_SMOKE: 'web build/SSR smoke flag (baked into the prebuilt web image)',
  SENTRY_DSN_WEB_SERVER: 'web SSR Sentry DSN (baked into the prebuilt web image)',
  SENTRY_AUTH_TOKEN: 'build-time source-map upload (CI only, never a runtime container env)',
  SENTRY_ORG: 'build-time source-map upload (CI only)',
  SENTRY_PROJECT: 'build-time source-map upload (CI only)',
};

// The digest-pinned droplet stack. Its api block is well-maintained; after
// wiring the parity gaps, nothing here needs an intentional exception.
const PROD_ALLOWLIST: Record<string, string> = {};

interface Pair {
  name: string;
  envExample: string;
  compose: string;
  allowlist: Record<string, string>;
}

const PAIRS: Pair[] = [
  {
    name: 'self-host (root .env.example ↔ docker-compose.yml)',
    envExample: '.env.example',
    compose: 'docker-compose.yml',
    allowlist: ROOT_ALLOWLIST,
  },
  {
    name: 'droplet (deploy/.env.example ↔ deploy/docker-compose.prod.yml)',
    envExample: 'deploy/.env.example',
    compose: 'deploy/docker-compose.prod.yml',
    allowlist: PROD_ALLOWLIST,
  },
];

function activeEnvExampleVars(relPath: string): string[] {
  const text = readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
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
  if (new RegExp(`^\\s*${esc}:(\\s|$)`, 'm').test(compose)) return true;
  // (b) `${VAR}` / `${VAR:-x}` / `${VAR:?x}` / `${VAR-x}` interpolation
  if (new RegExp(`\\$\\{${esc}[-:}]`).test(compose)) return true;
  // (c) short-form passthrough / secret sourcing: `environment: VAR` or `- VAR`
  if (new RegExp(`\\benvironment:\\s*${esc}\\b`).test(compose)) return true;
  if (new RegExp(`^\\s*-\\s*${esc}(=|\\s*$)`, 'm').test(compose)) return true;
  return false;
}

describe.each(PAIRS)('.env.example ↔ compose parity: $name', ({ envExample, compose, allowlist }) => {
  const composeText = readFileSync(path.join(REPO_ROOT, compose), 'utf8');
  const envVars = activeEnvExampleVars(envExample);

  it('every documented variable is either mapped in compose or explicitly allow-listed', () => {
    const unwired = envVars.filter(
      (v) => !isReferencedInCompose(v, composeText) && !(v in allowlist),
    );
    expect(
      unwired,
      `These vars are in ${envExample} but never reach a container (setting them in .env is a silent no-op). ` +
        `Add each to a service 'environment:' block in ${compose}, or to the allow-list with a reason:\n  ` +
        unwired.join('\n  '),
    ).toEqual([]);
  });

  it('has no stale allow-list entries (every allow-listed var still exists in the .env.example)', () => {
    const envSet = new Set(envVars);
    const stale = Object.keys(allowlist).filter((v) => !envSet.has(v));
    expect(
      stale,
      `These vars are allow-listed but no longer active in ${envExample} — remove them from the allow-list:\n  ` +
        stale.join('\n  '),
    ).toEqual([]);
  });

  it('does not redundantly allow-list a var that is already referenced in compose', () => {
    const redundant = Object.keys(allowlist).filter((v) => isReferencedInCompose(v, composeText));
    expect(
      redundant,
      `These vars are BOTH referenced in ${compose} and allow-listed — drop them from the allow-list:\n  ` +
        redundant.join('\n  '),
    ).toEqual([]);
  });
});
