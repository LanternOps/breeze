// Side-effect-only module: load .env.test from the monorepo root (if it
// exists) before any other module in the integration test graph is
// evaluated. Imported as the very first line of setup.ts so that
// DATABASE_URL / DATABASE_URL_APP / REDIS_URL / JWT_SECRET are visible on
// `process.env` by the time `apps/api/src/db/index.ts` (or anything
// transitively imported from it) runs its module-body `postgres(...)`
// initialization.
//
// Load order (first win):
//   1. Variables already on process.env (CI-provided, shell export, etc.)
//   2. Variables from .env.test at the monorepo root (developer override)
//   3. Hard-coded defaults matching docker-compose.test.yml below
import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

function thisDir(): string {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd();
  }
}

// apps/api/src/__tests__/integration → monorepo root
const envPath = path.resolve(thisDir(), '..', '..', '..', '..', '..', '.env.test');
config({ path: envPath });

// Hard-coded defaults matching docker-compose.test.yml. These take effect
// only if neither the host environment nor .env.test supplied a value
// (dotenv does not overwrite, and `||=` only assigns when unset). Without
// DATABASE_URL_APP, `db/index.ts` would fall back to DATABASE_URL — the
// superuser — which bypasses RLS and would render the RLS regression
// tests meaningless.
process.env.DATABASE_URL ||= 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';
process.env.DATABASE_URL_APP ||= 'postgresql://breeze_app:breeze_test@localhost:5433/breeze_test';
process.env.BREEZE_APP_DB_PASSWORD ||= 'breeze_test';
process.env.POSTGRES_PASSWORD ||= 'breeze_test';
process.env.REDIS_URL ||= 'redis://localhost:6380';
process.env.JWT_SECRET ||= 'test-jwt-secret-must-be-at-least-32-characters-long';
process.env.NODE_ENV ||= 'test';

// OAuth defaults for integration tests. The OAuth integration test
// (oauth-code-flow.integration.test.ts) needs MCP_OAUTH_ENABLED=true plus
// a deterministic JWKS so the in-process bearer middleware can verify
// tokens minted by the in-process oidc-provider. The JWK below is a
// throwaway Ed25519 keypair generated specifically for tests — never use
// it for real signing.
process.env.MCP_OAUTH_ENABLED ||= 'true';
process.env.OAUTH_ISSUER ||= 'http://localhost:3001';
process.env.OAUTH_RESOURCE_URL ||= 'http://localhost:3001/api/v1/mcp/message';
process.env.OAUTH_CONSENT_URL_BASE ||= 'http://localhost:3000';
process.env.OAUTH_COOKIE_SECRET ||= 'test-cookie-secret-must-be-at-least-32-characters-long';
process.env.OAUTH_JWKS_PRIVATE_JWK ||= JSON.stringify({
  crv: 'Ed25519',
  d: 'i65-HB14z0XAmoTR-QqKUWfFXn5UQcNgXyY9vBmY8-A',
  x: 'hZXoVEnGO7JlnBUvE8Jeb2X2ULW2AvMwt9KDNRQuwEE',
  kty: 'OKP',
  kid: 'test-eddsa-key',
  alg: 'EdDSA',
  use: 'sig',
});
