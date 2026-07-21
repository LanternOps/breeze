# Wave 2 Effective Request Database Role Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure production request handlers always use one canonically resolved, unprivileged PostgreSQL pool and refuse startup when that exact pool can bypass RLS.

**Architecture:** Move request-connection resolution out of migration code into a small pure module that runs before the exported request pool is constructed. `DATABASE_URL` remains the system/migration URL; `DATABASE_URL_APP` wins when explicitly supplied; otherwise a password-only configuration derives a `breeze_app` URL from `DATABASE_URL`. A production startup initializer runs migrations only when enabled, then probes the exact request client regardless of `AUTO_MIGRATE` and rejects `SUPERUSER` or `BYPASSRLS` roles.

**Tech Stack:** TypeScript, postgres-js, Drizzle ORM, Vitest, PostgreSQL 16 on OrbStack, pnpm 10.33.4.

## Global Constraints

- Implement Wave 2 / SR1-02 only.
- Do not include or duplicate PR #2356 Microsoft 365 mailbox changes.
- `DATABASE_URL` remains the migration/system connection.
- `DATABASE_URL_APP`, when supplied, remains the explicit request connection.
- Resolve the canonical unprivileged request URL before constructing the exported request pool.
- Password-only configuration derives the request URL by replacing the `DATABASE_URL` credentials with `breeze_app` plus `BREEZE_APP_DB_PASSWORD`, falling back to `POSTGRES_PASSWORD` only for the password value.
- Production must fail closed with an actionable configuration error when no explicit or derivable request URL exists; it must not silently fall back to `DATABASE_URL`.
- Production startup must probe the exact postgres-js client used by request handlers and reject roles with `rolsuper=true` or `rolbypassrls=true`.
- The production role probe runs whether `AUTO_MIGRATE` is enabled or set to `false`.
- Existing non-production behavior may retain an explicitly warned compatibility fallback so unit tests and local tooling that never connect can continue importing the DB module.
- Use OrbStack PostgreSQL for real-driver tests and keep the existing RLS coverage contract green.
- The referenced `docs/superpowers/specs/security-auth/2026-07-11-security-review-remediation-design.md` was absent from the dirty checkout, fetched `origin/main` at `0f05c1faa274f9c49b96ef57b829d9dbf2989477`, and all local Breeze worktrees; the user request and SR1-02 finding are the controlling requirements.

---

### Task 1: Canonical request database URL resolution

**Files:**
- Create: `apps/api/src/db/requestDatabaseConfig.ts`
- Create: `apps/api/src/db/requestDatabaseConfig.test.ts`
- Modify: `apps/api/src/db/index.ts:13-39`
- Modify: `apps/api/src/db/autoMigrate.ts:247-269,570-615`
- Modify: `apps/api/src/db/autoMigrate.test.ts:1-140`

**Interfaces:**
- Produces: `deriveAppConnectionString(adminUrl: string, appPassword: string | undefined): string | null`.
- Produces: `resolveRequestDatabaseConfig(env?: NodeJS.ProcessEnv): { url: string; source: 'explicit' | 'derived' | 'development-fallback' }`.
- Consumes: `DATABASE_URL`, `DATABASE_URL_APP`, `BREEZE_APP_DB_PASSWORD`, `POSTGRES_PASSWORD`, and `NODE_ENV`.
- The returned `url` is consumed once by `db/index.ts` before its module-scope postgres-js request client is constructed.

- [ ] **Step 1: Write failing resolver tests**

Add focused tests that assert the following exact behaviors:

```ts
expect(resolveRequestDatabaseConfig({
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://admin:admin-secret@db:5432/breeze',
  BREEZE_APP_DB_PASSWORD: 'request-secret',
}).url).toBe('postgresql://breeze_app:request-secret@db:5432/breeze');

expect(resolveRequestDatabaseConfig({
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://admin:admin-secret@db:5432/breeze',
  DATABASE_URL_APP: 'postgresql://explicit:explicit-secret@request-db:6432/breeze?sslmode=require',
  BREEZE_APP_DB_PASSWORD: 'ignored',
})).toEqual({
  url: 'postgresql://explicit:explicit-secret@request-db:6432/breeze?sslmode=require',
  source: 'explicit',
});

expect(() => resolveRequestDatabaseConfig({
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://admin:admin-secret@db:5432/breeze',
})).toThrow(/DATABASE_URL_APP.*BREEZE_APP_DB_PASSWORD.*POSTGRES_PASSWORD/);
```

Also cover `POSTGRES_PASSWORD`, special-character password encoding, malformed `DATABASE_URL`, and the warned non-production compatibility fallback.

- [ ] **Step 2: Run the resolver tests and verify RED**

Run:

```bash
corepack pnpm -F @breeze/api exec vitest run src/db/requestDatabaseConfig.test.ts
```

Expected: FAIL because `requestDatabaseConfig.ts` and its exports do not exist.

- [ ] **Step 3: Implement the minimal resolver**

Implement a pure module with the following decision order:

```ts
const explicit = env.DATABASE_URL_APP?.trim();
if (explicit) return { url: explicit, source: 'explicit' };

const adminUrl = env.DATABASE_URL?.trim()
  || 'postgresql://breeze:breeze@localhost:5432/breeze';
const password = env.BREEZE_APP_DB_PASSWORD?.trim()
  || env.POSTGRES_PASSWORD?.trim();
const derived = deriveAppConnectionString(adminUrl, password);
if (derived) return { url: derived, source: 'derived' };

if (env.NODE_ENV === 'production') {
  throw new Error(
    '[database] Cannot configure the unprivileged request pool. Set DATABASE_URL_APP to a NOSUPERUSER/NOBYPASSRLS role, or set BREEZE_APP_DB_PASSWORD/POSTGRES_PASSWORD so Breeze can derive the breeze_app URL from DATABASE_URL. Refusing to use DATABASE_URL for request handlers.',
  );
}

return { url: adminUrl, source: 'development-fallback' };
```

Use the resolver result before `postgres(...)` in `db/index.ts`. Log only the source, never a URL or password; emit a warning for `development-fallback`. Remove the duplicate derivation helper and separate app-role probe from `autoMigrate.ts`, and move its resolver tests into the new test file. Keep `autoMigrate()` on `DATABASE_URL` and retain both `ensureAppRole()` calls.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
corepack pnpm -F @breeze/api exec vitest run src/db/requestDatabaseConfig.test.ts src/db/autoMigrate.test.ts
```

Expected: PASS with the resolver cases and existing migration-helper suite green.

- [ ] **Step 5: Commit Task 1**

```bash
git add apps/api/src/db/requestDatabaseConfig.ts apps/api/src/db/requestDatabaseConfig.test.ts apps/api/src/db/index.ts apps/api/src/db/autoMigrate.ts apps/api/src/db/autoMigrate.test.ts
git commit -m "fix(api): resolve unprivileged request database URL"
```

---

### Task 2: Exact request-pool startup enforcement, PostgreSQL regression coverage, and operator docs

**Files:**
- Create: `apps/api/src/db/databaseStartup.ts`
- Create: `apps/api/src/db/databaseStartup.test.ts`
- Create: `apps/api/src/db/requestDatabaseRole.integration.test.ts`
- Create: `apps/api/vitest.config.request-db-role.ts`
- Create: `docs/runbooks/request-database-role.md`
- Modify: `apps/api/src/db/index.ts`
- Modify: `apps/api/src/index.ts:1500-1530`
- Modify: `apps/api/package.json`
- Modify: `apps/api/vitest.config.ts`
- Modify: `apps/api/vitest.integration.config.ts`
- Modify: `.env.example:8-24`
- Modify: `deploy/.env.example:60-66`

**Interfaces:**
- Consumes: the module-scope postgres-js `client` in `apps/api/src/db/index.ts`—the same client backing exported `db` and every request context.
- Produces: `getRequestDatabaseRole(): Promise<{ currentUser: string; isSuperuser: boolean; bypassesRls: boolean }>`.
- Produces: `assertRequestDatabaseRoleSafe(): Promise<RequestDatabaseRole>`; throws an actionable error when no role row is returned, `isSuperuser`, or `bypassesRls` is true.
- Produces: `initializeDatabaseForStartup(options)`; conditionally runs migrations, then always runs the exact-pool role assertion in production.

- [ ] **Step 1: Write failing startup-order unit tests**

Use injected `migrate` and `verifyRequestRole` spies so the tests cover orchestration without importing the full API:

```ts
it('verifies the production request role when AUTO_MIGRATE=false', async () => {
  const migrate = vi.fn();
  const verifyRequestRole = vi.fn().mockRejectedValue(new Error('unsafe request role'));

  await expect(initializeDatabaseForStartup({
    autoMigrateEnabled: false,
    production: true,
    migrate,
    verifyRequestRole,
  })).rejects.toThrow('unsafe request role');

  expect(migrate).not.toHaveBeenCalled();
  expect(verifyRequestRole).toHaveBeenCalledOnce();
});
```

Also cover migrate-before-verify when enabled and no production role probe in non-production.

- [ ] **Step 2: Write failing real-PostgreSQL role tests**

Run these through a dedicated Vitest config without the shared integration truncation setup. Against the isolated OrbStack PostgreSQL 16 database:

```ts
const role = await getRequestDatabaseRole();
expect(role).toEqual({
  currentUser: 'breeze_app',
  isSuperuser: false,
  bypassesRls: false,
});
```

Create a temporary login role with `BYPASSRLS`, load a fresh request-pool module for each connection URL, and assert:

```ts
await expect(assertRequestDatabaseRoleSafe()).rejects.toThrow(/SUPERUSER/);
await expect(assertRequestDatabaseRoleSafe()).rejects.toThrow(/BYPASSRLS/);
```

Finally set `NODE_ENV=production`, `AUTO_MIGRATE=false`, and point the canonical request pool at the admin URL; call `initializeDatabaseForStartup` with the real assertion and verify startup rejects without invoking migrations.

- [ ] **Step 3: Run both new suites and verify RED**

Run:

```bash
corepack pnpm -F @breeze/api exec vitest run src/db/databaseStartup.test.ts
DATABASE_URL='postgresql://breeze_test:breeze_test@127.0.0.1:55432/breeze_test' \
DATABASE_URL_APP='postgresql://breeze_app:breeze_test@127.0.0.1:55432/breeze_test' \
corepack pnpm -F @breeze/api test:request-db-role
```

Expected: FAIL because the startup initializer, exact-pool role exports, config, and script do not exist.

- [ ] **Step 4: Implement exact-pool enforcement and wire startup**

In `db/index.ts`, query the already-created module-scope `client`:

```sql
SELECT current_user AS "currentUser",
       rolsuper AS "isSuperuser",
       rolbypassrls AS "bypassesRls"
FROM pg_roles
WHERE rolname = current_user
```

Reject missing rows and unsafe flags with an error that names the effective role and tells operators to set `DATABASE_URL_APP` to a `NOSUPERUSER NOBYPASSRLS` role or configure `BREEZE_APP_DB_PASSWORD`/`POSTGRES_PASSWORD` for derivation. Do not open a second probe client.

Wire `initializeDatabaseForStartup` immediately after `validateConfig()` in `bootstrap()`:

```ts
await initializeDatabaseForStartup({
  autoMigrateEnabled: process.env.AUTO_MIGRATE !== 'false',
  production: config.NODE_ENV === 'production',
});
```

The default dependencies call `autoMigrate` and `assertRequestDatabaseRoleSafe`. This ordering ensures role setup can happen during migrations but role verification is never inside the `AUTO_MIGRATE` branch.

- [ ] **Step 5: Add operator documentation**

Document the supported production matrix:

| Configuration | Request pool result |
|---|---|
| `DATABASE_URL_APP` set | Used exactly as supplied; startup probes that pool |
| No `DATABASE_URL_APP`, `BREEZE_APP_DB_PASSWORD` set | Derive `breeze_app` URL from `DATABASE_URL` |
| No `DATABASE_URL_APP`, only `POSTGRES_PASSWORD` set | Derive `breeze_app` URL from `DATABASE_URL` |
| Neither explicit URL nor app password available | Production startup refuses to use `DATABASE_URL` |

State that `DATABASE_URL` is still required for migrations/system setup, `AUTO_MIGRATE=false` skips migrations only, and a `SUPERUSER`/`BYPASSRLS` effective request role is fatal. Include safe `psql` verification commands for `current_user`, `rolsuper`, and `rolbypassrls` without real infrastructure values.

- [ ] **Step 6: Run focused and PostgreSQL-backed tests and verify GREEN**

Run:

```bash
corepack pnpm -F @breeze/api exec vitest run \
  src/db/requestDatabaseConfig.test.ts \
  src/db/databaseStartup.test.ts \
  src/db/autoMigrate.test.ts \
  src/config/validate.test.ts

DATABASE_URL='postgresql://breeze_test:breeze_test@127.0.0.1:55432/breeze_test' \
DATABASE_URL_APP='postgresql://breeze_app:breeze_test@127.0.0.1:55432/breeze_test' \
corepack pnpm -F @breeze/api test:request-db-role

DATABASE_URL='postgresql://breeze_test:breeze_test@127.0.0.1:55432/breeze_test' \
DATABASE_URL_APP='postgresql://breeze_app:breeze_test@127.0.0.1:55432/breeze_test' \
corepack pnpm -F @breeze/api test:rls-coverage
```

Expected: all focused tests, all role tests, and all 53 RLS coverage tests pass.

- [ ] **Step 7: Run repository verification**

Run:

```bash
DATABASE_URL='postgresql://breeze_test:breeze_test@127.0.0.1:55432/breeze_test' \
corepack pnpm -F @breeze/api db:check-drift
corepack pnpm -F @breeze/api exec tsc --noEmit
corepack pnpm -F @breeze/api build
corepack pnpm -F @breeze/api lint
git diff --check origin/main...HEAD
```

Expected: drift check, typecheck, build, lint, and whitespace validation all exit 0.

- [ ] **Step 8: Commit Task 2**

```bash
git add apps/api/src/db/databaseStartup.ts apps/api/src/db/databaseStartup.test.ts \
  apps/api/src/db/requestDatabaseRole.integration.test.ts apps/api/src/db/index.ts \
  apps/api/src/index.ts apps/api/vitest.config.request-db-role.ts \
  apps/api/vitest.config.ts apps/api/vitest.integration.config.ts apps/api/package.json \
  .env.example deploy/.env.example docs/runbooks/request-database-role.md
git commit -m "fix(api): enforce effective request database role"
```

---

### Final review and publication gate

- [ ] Generate a whole-branch review package from the merge base and request an independent security review focused on SR1-02, exact-pool identity, startup ordering, secret handling, and Wave 2-only scope.
- [ ] Fix every Critical or Important review finding, re-run the covering tests, and request re-review.
- [ ] Re-run the complete verification commands with fresh output.
- [ ] Push `fix/security-review-request-db-role` and open a draft pull request against `main`; do not merge it.
