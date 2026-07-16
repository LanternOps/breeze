# Request database role

Breeze uses two PostgreSQL connection roles in production:

- `DATABASE_URL` is the administrator/system connection required for migrations,
  role setup, and other system initialization.
- The request pool is the unprivileged connection used by API request contexts.
  PostgreSQL row-level security depends on this role being both `NOSUPERUSER`
  and `NOBYPASSRLS`.

At startup, Breeze queries `current_user`, `rolsuper`, and `rolbypassrls` through
the exact module-scope request pool that backs the exported API database client.
Production startup fails if that effective role is a `SUPERUSER`, has
`BYPASSRLS`, or cannot be identified.

## Supported production configuration

| Configuration | Request pool result |
|---|---|
| `DATABASE_URL_APP` set | Used exactly as supplied; startup probes that pool |
| No `DATABASE_URL_APP`, `BREEZE_APP_DB_PASSWORD` set | Derive `breeze_app` URL from `DATABASE_URL` |
| No `DATABASE_URL_APP`, only `POSTGRES_PASSWORD` set | Derive `breeze_app` URL from `DATABASE_URL` |
| Neither explicit URL nor app password available | Production startup refuses to use `DATABASE_URL` |

`DATABASE_URL` remains required even when `DATABASE_URL_APP` is set because
migrations and system setup use the administrator connection. `AUTO_MIGRATE=false`
skips migrations only; it does not skip the production request-role assertion.

## Pre-deploy role provisioning

When `AUTO_MIGRATE=false`, provision the request role before starting the new API
image. The following administrator-side block is idempotent and only creates a
missing role. It deliberately does not alter capability attributes on an
existing role: managed PostgreSQL administrators may be forbidden from changing
`SUPERUSER`, even for a no-op `NOSUPERUSER` change.

```sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'breeze_app') THEN
    CREATE ROLE breeze_app LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT;
  END IF;
END
$$;
```

For an existing role, verify rather than blindly alter it:

```sql
SELECT rolname, rolcanlogin, rolsuper, rolbypassrls
FROM pg_roles
WHERE rolname = 'breeze_app';
```

The row must exist with `rolcanlogin=t`, `rolsuper=f`, and `rolbypassrls=f`.
If it does not, use a sufficiently privileged operator or the provider's role
management workflow to correct it. `ALTER ROLE breeze_app LOGIN NOSUPERUSER
NOBYPASSRLS NOINHERIT` is appropriate only when that operator is allowed to
change those attributes. Do not suppress the startup probe to work around a
managed-service permission error.

Set a unique, strong password through a secret-safe administrative channel. For
example, run `psql` as the administrator and use `\password breeze_app`; do not
put the password in a committed SQL file or command history. The configured
request credential must match this role password. Existing migrations grant the
role's schema/table privileges, so a separately managed database must also have
all migrations applied before the API starts.

## Compose credential mapping

The standard root `docker-compose.yml` deliberately does not pass
`DATABASE_URL_APP` to the API container. It passes `DATABASE_URL`,
`POSTGRES_PASSWORD`, and optional `BREEZE_APP_DB_PASSWORD`. Both role setup and
the canonical request resolver use this effective password precedence:

1. non-empty `BREEZE_APP_DB_PASSWORD`;
2. otherwise `POSTGRES_PASSWORD`.

The resolver rewrites only the username/password of the single-host
`DATABASE_URL`, preserving its scheme, host, port, database, query parameters,
and TLS settings. This keeps role setup and request-pool authentication aligned
when the app role uses a password distinct from the administrator.

`deploy/docker-compose.prod.yml` is the separately managed production path. It
passes `DATABASE_URL_APP` and `BREEZE_APP_DB_PASSWORD` as explicit optional
inputs. Configure at least one of them; production validation rejects an
administrator-only `DATABASE_URL` configuration.

For postgres.js HA/multi-host connections, set an explicit
`DATABASE_URL_APP`. Comma-separated hosts, per-host ports, and their supported
percent-encoded authority forms are accepted and passed unchanged to
postgres.js. Breeze intentionally does not derive credentials from a multi-host
administrator URL; startup returns fixed guidance to set `DATABASE_URL_APP`
instead.

## Rollout and startup verification

Before deployment:

1. Apply migrations and provision `breeze_app`; this is mandatory before an
   `AUTO_MIGRATE=false` startup.
2. Render the selected Compose file with safe placeholder values using
   `docker compose ... config` and verify the mappings described above.
3. Confirm the request credential authenticates without printing it or the full
   connection URL.

On startup, expect exactly one sanitized configuration-source message:

```text
[database] Request pool configuration source: explicit
```

or `derived` for standard Compose. The message never includes a URL or password.
The API must then reach its normal healthy/listening state. Any message saying
the effective request role could not be queried or identified, or that it has
`SUPERUSER`/`BYPASSRLS`, is a fatal failure; do not bypass the check or substitute
the administrator URL.

## Verify the effective role

Connect using the same request URL supplied to Breeze. Avoid putting a password
directly in shell history; use a protected service file, a password manager, or
an ephemeral `PGPASSWORD` value appropriate for your environment.

```sh
psql "$DATABASE_URL_APP" -c 'SELECT current_user;'
psql "$DATABASE_URL_APP" -c \
  'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;'
```

The expected result identifies the intended request role and reports `f` for
both `rolsuper` and `rolbypassrls`. Either flag being `t` is fatal to Breeze API
startup because that capability can bypass forced tenant RLS protections.

When the URL is derived instead of supplied explicitly, construct the equivalent
`breeze_app` connection for the check without logging its password. Confirm its
host, port, database, and TLS parameters match `DATABASE_URL`.

## Rollback

Keep the new request-role configuration in place during rollback. In particular,
before starting an older API binary, retain an explicit, verified-safe
`DATABASE_URL_APP` unless you have proved from that exact older version's source
and startup behavior that it cannot resume using privileged `DATABASE_URL` for
request handlers. Older binaries may lack the fail-closed resolver and role
probe; removing `DATABASE_URL_APP` during rollback can silently restore a
superuser request pool.

After rollback, repeat the `pg_roles` verification above through the connection
actually used by request handlers and confirm both capability flags remain `f`.
If that cannot be demonstrated, keep the API stopped and restore the safe app
URL rather than accepting a privileged fallback.
