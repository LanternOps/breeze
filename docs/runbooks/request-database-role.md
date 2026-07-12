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

For a separately managed PostgreSQL service, create or configure the request role
with equivalent attributes to:

```sql
ALTER ROLE breeze_app LOGIN NOSUPERUSER NOBYPASSRLS;
```

Use a unique, strong request-role password. Set either a complete
`DATABASE_URL_APP`, or set `BREEZE_APP_DB_PASSWORD` so Breeze derives a
`breeze_app` URL using the host, port, database, and query parameters from
`DATABASE_URL`. `POSTGRES_PASSWORD` is also accepted as the derivation password
for the standard self-hosted setup.

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
