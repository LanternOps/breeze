# Security Review Wave 2: Effective Request Database Role Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Ensure the exact PostgreSQL pool exported to request handlers always uses a non-superuser, non-`BYPASSRLS` role, independently of automatic migrations.

**Architecture:** Resolve one canonical request connection string before constructing any pool. Build the request client from that value and probe that exact pool during startup; keep the privileged system URL limited to migrations and system-context work.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, `pg`, Vitest, PostgreSQL through OrbStack.

**Global Constraints:** Preserve `withDbAccessContext` semantics; never silently fall back to a privileged request pool in production; do not expose passwords in logs; keep `DATABASE_URL` available for migrations/system work.

**Finding:** SR1-02.

**Design:** `docs/superpowers/specs/2026-07-11-security-review-wave-02-effective-request-db-role-design.md`

## File map

- Create `apps/api/src/db/requestDatabaseConfig.ts` and adjacent test.
- Modify `apps/api/src/db/index.ts`, `apps/api/src/db/autoMigrate.ts`, and `apps/api/src/index.ts` (startup wiring).
- Modify `apps/api/src/config/validate.ts` and its test.
- Modify `.env.example`, `docker-compose.yml`, and production compose examples that map API database variables.

## Task 1: Canonical request database resolver

- [ ] Add failing table-driven tests in `apps/api/src/db/requestDatabaseConfig.test.ts` for explicit `DATABASE_URL_APP`, derivation from `DATABASE_URL` plus `POSTGRES_APP_PASSWORD`, missing credentials, malformed URLs, and production refusal to use the privileged URL.
- [ ] Run `pnpm --filter=@breeze/api test -- requestDatabaseConfig.test.ts`; expect RED because the module does not exist.
- [ ] Implement:

```ts
export interface RequestDatabaseConfig {
  systemUrl: string;
  requestUrl: string;
  source: 'explicit' | 'derived';
}

export function resolveRequestDatabaseConfig(env: NodeJS.ProcessEnv): RequestDatabaseConfig;
```

Use the existing URL rewrite behavior from `deriveAppConnectionString`; return no configuration containing logged credentials.
- [ ] Move or re-export `deriveAppConnectionString` so `autoMigrate.ts` and the resolver share one implementation.
- [ ] Re-run the focused test; expect GREEN.
- [ ] Commit: `fix(db): resolve canonical request database role`.

## Task 2: Construct the exported pool from the canonical URL

- [ ] Add a failing module-isolation test beside `apps/api/src/db/index.ts` proving `DATABASE_URL_APP` wins and derived `breeze_app` credentials are used when the explicit URL is absent.
- [ ] Refactor `apps/api/src/db/index.ts` so the resolver runs before `Pool` construction and export the resolved non-secret metadata for startup diagnostics.
- [ ] Keep the system URL path confined to `runOutsideDbContext`, migrations, seeds, and explicit system helpers; confirm request `db` is backed only by `requestUrl`.
- [ ] Run the new test plus `pnpm --filter=@breeze/api test -- db/contextlessWriteGuard.test.ts middleware/selfManagedDbContextRoutes.test.ts`; expect GREEN.
- [ ] Commit: `fix(db): bind request client to resolved app role`.

## Task 3: Probe the exact request pool on every startup

- [ ] Add failing tests for `assertRequestPoolEnforcesRls(pool)` covering normal role success, `rolsuper=true`, `rolbypassrls=true`, and query failure.
- [ ] Implement a query against the supplied pool:

```sql
SELECT current_user AS "user", rolsuper, rolbypassrls
FROM pg_roles
WHERE rolname = current_user
```

- [ ] Reject superuser or `BYPASSRLS` with a credential-free startup error. Log only role name, source (`explicit`/`derived`), and safe booleans.
- [ ] Invoke this assertion in `apps/api/src/index.ts` before accepting traffic, regardless of `AUTO_MIGRATE`.
- [ ] Remove the duplicate app-role probe from `autoMigrate.ts` or make it call the shared assertion against the exported request pool; do not retain two independently resolved URLs.
- [ ] Run `pnpm --filter=@breeze/api test -- autoMigrate.test.ts requestDatabaseConfig.test.ts`; expect GREEN.
- [ ] Commit: `fix(api): verify request role before startup`.

## Task 4: Configuration and deployment contract

- [ ] Update `apps/api/src/config/validate.test.ts` first to require either explicit app URL or enough data to derive it, and to reject production configurations that would use privileged credentials for requests.
- [ ] Update `apps/api/src/config/validate.ts` descriptions and validation to match the resolver contract.
- [ ] Map `DATABASE_URL_APP` and `POSTGRES_APP_PASSWORD` through API service environments in `docker-compose.yml`, `deploy/docker-compose.prod.yml`, and applicable examples, using placeholders only.
- [ ] Update `.env.example` with the supported explicit and derived configurations; document that `AUTO_MIGRATE=false` does not disable the request-role check.
- [ ] Run `pnpm --filter=@breeze/api test -- config/validate.test.ts config/env.test.ts`; expect GREEN.
- [ ] Commit: `docs(config): define unprivileged request database contract`.

## Task 5: OrbStack proof and final verification

- [ ] Start the local database with OrbStack using the repository compose stack.
- [ ] Run `pnpm --filter=@breeze/api test -- requestDatabaseConfig.test.ts autoMigrate.test.ts config/validate.test.ts`.
- [ ] Run `pnpm --filter=@breeze/api test:rls-coverage` with `DATABASE_URL` set to the OrbStack PostgreSQL endpoint.
- [ ] Boot once with `AUTO_MIGRATE=false` and `DATABASE_URL_APP` pointing at a privileged role; verify startup fails before the listener opens.
- [ ] Boot with `breeze_app`; verify startup succeeds and a forged cross-tenant query remains denied.
- [ ] Run `pnpm exec tsc --noEmit -p apps/api/tsconfig.json`, `pnpm db:check-drift`, and `git diff --check`.
- [ ] Commit: `test(db): prove effective request role enforcement`.
