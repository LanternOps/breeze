# Security Review Wave 2: Effective Request Database Role Design

**Date:** 2026-07-11
**Status:** Approved for planning
**Finding:** SR1-02
**Source:** `internal/security-findings/2026-07-11-playbook-01-multi-tenant-rls-authz.md`
**Reviewed baseline:** `origin/main` at `0f05c1faa274f9c49b96ef57b829d9dbf2989477`

## Objective

Guarantee that every ordinary API request uses the exact PostgreSQL pool whose effective login role
is non-superuser and cannot bypass row-level security. Configuration validation, startup probes,
and exported database clients must all resolve one canonical request connection string before any
pool is constructed.

## Current boundary

The API currently constructs the exported request client in `apps/api/src/db/index.ts` from
`DATABASE_URL_APP || DATABASE_URL`. Separately, auto-migration derives or probes an application-role
URL after migrations have run. In the supported password-only configuration, the probe can verify a
derived `breeze_app` connection while request handlers continue using the earlier privileged
`DATABASE_URL` pool. Disabling automatic migrations also skips the relevant probe.

The defect is pool identity, not an RLS-policy defect. Existing tenant policies remain the required
enforcement layer once the request pool is guaranteed to use a safe role.

## Security invariants

1. The request connection string is resolved exactly once before the exported request pool exists.
2. `DATABASE_URL_APP`, when present, is the authoritative request URL.
3. Without `DATABASE_URL_APP`, `BREEZE_APP_DB_PASSWORD` or `POSTGRES_PASSWORD` derives a URL using
   the `breeze_app` login while preserving host, port, database, query parameters, and TLS settings.
4. `DATABASE_URL` remains the system/migration connection and is never an implicit production
   request fallback.
5. Production startup probes the exact request pool used by `db`, not a temporary look-alike client.
6. Startup refuses to serve when `current_user` is superuser or has `rolbypassrls`.
7. The probe runs whether `AUTO_MIGRATE` is true or false.
8. Logs may include the effective role name and Boolean safety flags, but never credentials or a
   connection URL.

## Architecture

### Canonical configuration resolver

Create a dependency-free database configuration module that exports a pure resolver:

```ts
interface RequestDatabaseConfig {
  systemUrl: string;
  requestUrl: string;
  source: 'explicit-app-url' | 'derived-app-role' | 'development-default';
}

function resolveRequestDatabaseConfig(env: NodeJS.ProcessEnv): RequestDatabaseConfig;
```

The resolver validates URL syntax, derives `breeze_app` credentials before module-scope client
construction, and returns sanitized error messages. Production configuration without an explicit or
derivable request URL fails immediately. A development-only local default may remain, but must still
be probed when the application starts in production mode.

`apps/api/src/db/index.ts` consumes `requestUrl` for the exported request pool. Migration and seed
code consumes `systemUrl` through its existing dedicated clients. No caller reconstructs precedence
rules independently.

### Exact-pool startup assertion

Export a startup assertion that executes through the already-created request client:

```sql
SELECT current_user AS "user", rolsuper, rolbypassrls
FROM pg_roles
WHERE rolname = current_user
```

The assertion runs during API startup after configuration validation but independently of the
auto-migration branch. A missing role row, connection failure, superuser, or BYPASSRLS result is a
fatal startup error. The error identifies the unsafe effective role and explains which configuration
values operators must set without printing secrets.

Auto-migration may retain a post-grant diagnostic, but it must call the same assertion or be clearly
non-authoritative. There must be only one security decision about whether the request pool is safe.

### Testability and module loading

Keep URL resolution pure and pool creation behind a narrow factory so tests can supply environment
objects and fake probe clients without resetting unrelated application modules. Module-import tests
must prove the resolver runs before client construction.

## Configuration contract

| Configuration | Result |
|---|---|
| `DATABASE_URL_APP` set | Use it exactly for requests; probe that pool |
| App URL absent, app password set | Derive `breeze_app` request URL; probe that pool |
| Neither app URL nor derivation password in production | Refuse startup |
| Request role is superuser/BYPASSRLS | Refuse startup |
| `AUTO_MIGRATE=false` | Skip migrations only; still probe request pool |

`DATABASE_URL_APP` documentation must name `breeze_app` as the expected role rather than generic
`app_user`. Password-only examples must state that the role must already exist when migrations are
disabled.

## Failure and rollout behavior

This is intentionally fail closed. A previously bootable but unsafe production deployment may stop
until its application-role credentials are corrected. The release note must include pre-deploy role
creation, credential mapping through Compose, startup-log verification, and rollback instructions.

Rollback is configuration-sensitive: an older binary may silently reuse `DATABASE_URL`. Operators
must keep an explicit safe `DATABASE_URL_APP` in place before rolling back.

## Verification

- Pure resolver tests cover explicit URL, password-only derivation, URL parameter preservation,
  malformed URLs, and missing production credentials.
- Pool-construction tests prove the request factory receives the resolved app URL.
- Startup tests prove the exact exported pool is probed with `AUTO_MIGRATE` both true and false.
- Real PostgreSQL tests cover `breeze_app`, superuser, and a non-superuser role granted BYPASSRLS.
- Existing request-context and RLS integration suites remain green under OrbStack.
- API typecheck, build, configuration documentation checks, and `git diff --check` pass.

## Non-goals

- Redesigning RLS policies or database access-context GUCs.
- Combining request, migration, audit-admin, and background credentials into one role.
- Automatically creating `breeze_app` when migrations are disabled.
- Logging or returning database credentials.
