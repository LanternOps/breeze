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
