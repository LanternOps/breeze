import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ENV_SCHEMA_KEYS } from './validate';

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
 * The guard, per env-example ↔ compose pair: every variable DOCUMENTED in the
 * `.env.example` — live assignments AND commented-out defaults alike, see
 * documentedEnvExampleVars() — MUST be either
 *   (a) referenced in the compose file (mapped into a container, sourced into a
 *       secret, or used for interpolation), or
 *   (b) listed in that pair's allow-list below with a reason.
 * Adding a documented var without doing one of those two fails CI here, in the
 * required test-api job, instead of silently in someone's production deploy.
 *
 * Mapping a var in costs nothing when the operator leaves it unset: the
 * `${VAR:-}` form passes an empty string, which every consumer below treats as
 * "unset" and falls back to its own default. Where a consumer did NOT treat ''
 * that way, the consumer was fixed rather than the var left unmapped — see
 * resolveAuthCookieSameSite() in routes/auth/helpers.ts, which resolves its
 * override chain with nested envStr() instead of `??` for exactly this reason
 * (#3239).
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
  COMPOSE_PROFILES: 'read by the `docker compose` CLI itself to select profiles — host-level, never a container env',

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
  PUBLIC_DOCS_URL: 'web build-time PUBLIC_ var (apps/web/astro.config.mjs — baked into the prebuilt web image)',
  ENABLE_SENTRY_SMOKE: 'web build/SSR smoke flag (baked into the prebuilt web image)',
  SENTRY_DSN_WEB_SERVER: 'web SSR Sentry DSN (baked into the prebuilt web image)',
  SENTRY_AUTH_TOKEN: 'build-time source-map upload (CI only, never a runtime container env)',
  SENTRY_ORG: 'build-time source-map upload (CI only)',
  SENTRY_PROJECT: 'build-time source-map upload (CI only)',

  // Documented but read by NO code in this repo, so there is nothing to thread
  // them into — mapping them would manufacture a knob that still does nothing.
  // Listed here (rather than deleted from .env.example) so the dead
  // documentation stays visible and the decision to keep or drop each line
  // stays the maintainer's; see #3239.
  C2C_M365_CERT_THUMBPRINT: 'no consumer — .env.example marks it "Future: certificate-based auth"',
  C2C_M365_CERT_PRIVATE_KEY_PATH: 'no consumer — .env.example marks it "Future: certificate-based auth"',
  USE_AGENT_SDK: 'no consumer anywhere in the repo (documented in deploy/environment.mdx only)',
  BUSINESS_EMAIL_ALLOW_OVERRIDES:
    'no consumer — the shipped business-email gate reads SIGNUP_REQUIRE_BUSINESS_EMAIL / SIGNUP_BUSINESS_EMAIL_CONTACT_URL instead',
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

/**
 * Every variable the `.env.example` DOCUMENTS — both live assignments
 * (`FOO=bar`) and commented-out ones (`# FOO=bar`).
 *
 * Commenting a line out is how this repo documents an OPTIONAL tuning knob
 * while leaving the code's own default in force, so the commented form carries
 * exactly the same promise to the operator as the uncommented one: "set this in
 * .env and it takes effect". Reading only uncommented lines therefore exempted
 * the entire optional-knob surface from the guard — the class most likely to be
 * forgotten, since an unmapped optional var still boots fine and just silently
 * ignores the operator (#3239; #3236 was one instance, #3224 got wired only by
 * hand).
 *
 * Only `# NAME=` is collected, not prose. A comment has to look like an
 * assignment to count, so ordinary explanatory text above a var is not mistaken
 * for a documented knob.
 *
 * Prose that OPENS with `# SOME_VAR=value` — e.g. the sentence at
 * `.env.example` "# OAUTH_DCR_ALLOW_ANONYMOUS=true. The API refuses to boot…" —
 * does match, and that is the deliberate bias. Such a line is indistinguishable
 * from a real documented default without parsing English, and this guard exists
 * to fail LOUD: a spurious hit costs one allow-list line, while the miss it
 * would otherwise permit is a knob that silently ignores the operator forever.
 * (That particular line is a no-op anyway — the var is genuinely documented a
 * few lines below and the Set de-duplicates.)
 */
export function parseDocumentedVars(text: string): string[] {
  const names = new Set<string>();
  for (const line of text.split('\n')) {
    // `FOO=…` (live) or `# FOO=…` / `#FOO=…` (documented default, commented out)
    const m = /^(?:#\s*)?([A-Z][A-Z0-9_]*)=/.exec(line);
    if (m?.[1]) names.add(m[1]);
  }
  return [...names].sort();
}

function documentedEnvExampleVars(relPath: string): string[] {
  return parseDocumentedVars(readFileSync(path.join(REPO_ROOT, relPath), 'utf8'));
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
  const envVars = documentedEnvExampleVars(envExample);

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

/**
 * The parity check above is one-directional: it starts from
 * `documentedEnvExampleVars()`, i.e. names already IN `.env.example`. A
 * variable that `validate.ts` accepts (is in `ENV_SCHEMA_KEYS`) but that
 * nobody ever added to `.env.example` is invisible to it — not caught by any
 * allow-list, because the guard never looks at it in the first place. That is
 * exactly how `LLM_PROVIDER_CATALOG_ENABLED` (#4113/#4116) shipped validated
 * in `validate.ts` but unmapped in `docker-compose.yml` and undocumented in
 * `.env.example`: the parity suite above stayed green throughout, because it
 * only ever iterated the (incomplete) `.env.example` list.
 *
 * Closing that gap for every one of the ~90 `ENV_SCHEMA_KEYS` is a separate,
 * larger audit (a first pass turned up ~24 pre-existing schema keys that are
 * validated but not documented in the root `.env.example` — mostly
 * hosted-only integrations such as STRIPE_*, QBO_*, DELEGANT_*, CF_ACCESS_*,
 * MCP_LLM_*, each needing its own classification before it could safely join
 * an allow-list) and is out of scope for this fix. This block instead pins
 * the one flag this fix is about, on both axes, so it cannot silently
 * regress again — found by the 2026-08-28 pre-release sweep
 * (docs/testing/release-sweeps/).
 */
describe('LLM_PROVIDER_CATALOG_ENABLED regression (#4113/#4116)', () => {
  const REPO_ROOT_COMPOSE = readFileSync(path.join(REPO_ROOT, 'docker-compose.yml'), 'utf8');

  it('is declared in the validate.ts schema', () => {
    expect(ENV_SCHEMA_KEYS).toContain('LLM_PROVIDER_CATALOG_ENABLED');
  });

  it('is documented in the root .env.example', () => {
    expect(documentedEnvExampleVars('.env.example')).toContain('LLM_PROVIDER_CATALOG_ENABLED');
  });

  it('is threaded through a docker-compose.yml service environment block', () => {
    expect(isReferencedInCompose('LLM_PROVIDER_CATALOG_ENABLED', REPO_ROOT_COMPOSE)).toBe(true);
  });
});

/**
 * QuickBooks (final-review finding I). The Phase C sandbox walkthrough needed a
 * manual container override for exactly this reason: all five QBO_* vars were
 * validated in `validate.ts` and read by `config/env.ts`, but documented
 * nowhere and mapped into no service block — so setting them in `.env` was a
 * silent no-op and the integration simply stayed dark. Pinned on all three axes,
 * for both the self-host and droplet compose files, so they cannot drift apart
 * again.
 */
describe('QuickBooks QBO_* env plumbing (finding I)', () => {
  const ROOT_COMPOSE = readFileSync(path.join(REPO_ROOT, 'docker-compose.yml'), 'utf8');
  const PROD_COMPOSE = readFileSync(path.join(REPO_ROOT, 'deploy/docker-compose.prod.yml'), 'utf8');
  const QBO_VARS = [
    'QBO_CLIENT_ID',
    'QBO_CLIENT_SECRET',
    'QBO_REDIRECT_URI',
    'QBO_ENVIRONMENT',
    'QBO_WEBHOOK_VERIFIER_TOKEN',
  ] as const;

  it.each(QBO_VARS)('%s is declared in the validate.ts schema', (name) => {
    expect(ENV_SCHEMA_KEYS).toContain(name);
  });

  it.each(QBO_VARS)('%s is documented in the root .env.example', (name) => {
    expect(documentedEnvExampleVars('.env.example')).toContain(name);
  });

  it.each(QBO_VARS)('%s reaches the api container in docker-compose.yml', (name) => {
    expect(isReferencedInCompose(name, ROOT_COMPOSE)).toBe(true);
  });

  it.each(QBO_VARS)('%s reaches the api container in deploy/docker-compose.prod.yml', (name) => {
    expect(isReferencedInCompose(name, PROD_COMPOSE)).toBe(true);
  });
});

describe('parseDocumentedVars — what counts as a documented variable (#3239)', () => {
  it('collects commented-out assignments, the form used for optional knobs', () => {
    expect(parseDocumentedVars('# MCP_REQUIRE_EXECUTE_ADMIN=true')).toEqual([
      'MCP_REQUIRE_EXECUTE_ADMIN',
    ]);
    expect(parseDocumentedVars('#NO_SPACE_AFTER_HASH=1')).toEqual(['NO_SPACE_AFTER_HASH']);
    expect(parseDocumentedVars('#   INDENTED=1')).toEqual(['INDENTED']);
  });

  it('still collects live assignments, and de-duplicates against the commented form', () => {
    expect(parseDocumentedVars('LIVE=1\n# LIVE=2\nOTHER=3')).toEqual(['LIVE', 'OTHER']);
  });

  it('ignores prose comments — a comment must LOOK like an assignment to count', () => {
    const prose = [
      '# Set this to harden the deploy. See docs/deploy/environment.mdx.',
      '# Values: strict, lax, none',
      '#   Mail.Read, Files.Read.All, Sites.Read.All',
      '# lowercase_name=1',
      '# 9NUMERIC_LEAD=1',
      '',
    ].join('\n');
    expect(parseDocumentedVars(prose)).toEqual([]);
  });

  it('does not treat an indented non-comment line as an assignment', () => {
    expect(parseDocumentedVars('    INDENTED_NO_HASH=1')).toEqual([]);
  });

  it('REGRESSION: the guard would be vacuous on a .env.example of only optional knobs', () => {
    // Before #3239 this returned [] and the whole file sailed past the parity
    // assertions — which is exactly how ~39 documented knobs stayed unmapped.
    const optionalKnobsOnly = '# A_KNOB=1\n# B_KNOB=2\n# C_KNOB=3';
    expect(parseDocumentedVars(optionalKnobsOnly)).toEqual(['A_KNOB', 'B_KNOB', 'C_KNOB']);
  });
});
