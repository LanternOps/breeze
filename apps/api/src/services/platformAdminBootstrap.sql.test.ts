/**
 * SQL-shape regression guard for the platform-admin bootstrap WHERE clause (#2655).
 *
 * The bug: `bootstrapPlatformAdmins` matched admins with
 *   sql`lower(email) = ANY(${emails}::text[])`
 * which binds the whole `string[]` as a SINGLE param cast to `::text[]`. That
 * worked under dev/vitest but the production CJS bundle serialized the array
 * param as a bare string (`conformance@breeze.local`, not `{conformance@...}`),
 * so the `::text[]` cast threw `malformed array literal` at startup and the
 * configured admin was never promoted.
 *
 * The pre-existing suite mocks `../db` and never serializes SQL, so it could
 * not see this. A real-Postgres integration test wouldn't help either: the
 * failure is a *bundle-only* param-serialization difference, so the old query
 * runs fine against Postgres under vitest — it would pass on the broken code.
 *
 * The right guard is on the RENDERED SQL. This file renders the actual WHERE
 * predicate with drizzle's real Postgres dialect (no DB connection needed) and
 * asserts it uses one bound param per email (`in ($1, $2, ...)`) with NO array
 * cast. It FAILS on the old `= ANY(...::text[])` form and PASSES on the fix,
 * and it needs no Docker so it runs in the ordinary unit job.
 *
 * This file deliberately does NOT mock `../db/schema`, so it exercises the real
 * `users` columns the production query builds against.
 */
import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { buildUnpromotedAdminMatch } from './platformAdminBootstrap';

function render(emails: string[]): { sql: string; params: unknown[] } {
  const { sql, params } = new PgDialect().sqlToQuery(
    buildUnpromotedAdminMatch(emails)
  );
  return { sql, params };
}

describe('buildUnpromotedAdminMatch — rendered SQL shape (#2655 regression)', () => {
  it('binds one param per email, never a single ::text[] array param', () => {
    const emails = ['a@x.com', 'b@x.com', 'c@x.com'];
    const { sql, params } = render(emails);

    // The core regression: no array-literal cast, no `= ANY(...)`.
    expect(sql).not.toMatch(/::text\[\]/i);
    expect(sql).not.toMatch(/=\s*any/i);

    // Positive: an IN list with individual placeholders.
    expect(sql.toLowerCase()).toContain('lower(');
    expect(sql.toLowerCase()).toMatch(/in \(\$\d+, \$\d+, \$\d+\)/);

    // Each email is its own bound param (as a plain string), plus the
    // isPlatformAdmin = false comparand. Crucially, NO param is the array
    // itself — that is exactly the value the prod bundle mis-serialized.
    for (const email of emails) {
      expect(params).toContain(email);
    }
    expect(params).not.toContainEqual(emails);
    expect(params).toContain(false);
  });

  it('renders a single-element list as one placeholder (the case that failed live)', () => {
    // The reported failure was a single-element env list
    // (`conformance@breeze.local`) — the array-literal path failed every time.
    const { sql, params } = render(['conformance@breeze.local']);

    expect(sql).not.toMatch(/::text\[\]/i);
    expect(sql.toLowerCase()).toMatch(/in \(\$\d+\)/);
    expect(params).toContain('conformance@breeze.local');
    expect(params).not.toContainEqual(['conformance@breeze.local']);
  });

  it('gates the not-yet-promoted filter into the same predicate', () => {
    const { sql } = render(['a@x.com']);
    // Both halves present: the email match AND the idempotency guard.
    expect(sql.toLowerCase()).toContain('is_platform_admin');
    expect(sql.toLowerCase()).toContain(' and ');
  });
});
