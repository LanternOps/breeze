/**
 * DB-less compiled-SQL guard for the organization list query (#4004).
 *
 * These assertions run against the string `.toSQL()` actually produces, not
 * against a Drizzle mock's call shape. A `where`/`orderBy` assertion on a mock
 * proves only that *some* argument was handed to a spy — it stays green when
 * the argument is wrong, which is precisely the class of bug this file exists
 * to catch. `.toSQL()` builds the statement synchronously with no connection,
 * so this lives in the ordinary unit suite.
 *
 * The property under test is structural and cross-page: the preferred order
 * must be part of the ORDER BY of the SAME statement that carries LIMIT/OFFSET.
 * Sorting the rows a `created_at, id` LIMIT already selected can never move an
 * organization from page 2 to the top of page 1. The end-to-end proof over real
 * rows across a real page boundary is
 * `__tests__/integration/organizationOrderPagination.integration.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { buildOrganizationListQuery, organizationOrderBy } from './orgs.listQuery';
import { organizations } from '../db/schema';

const PARTNER_ID = '00000000-0000-4000-8000-000000000001';
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const ORG_C = '33333333-3333-4333-8333-333333333333';

const conditions = and(eq(organizations.partnerId, PARTNER_ID), isNull(organizations.deletedAt));

// A NON-ZERO offset on purpose: Drizzle omits `offset 0` from the emitted SQL,
// so compiling page 1 would leave the OFFSET half of these assertions vacuous.
// Page 2 is also the page the bug was actually visible on.
function compile(preferredOrder?: string[] | null) {
  return buildOrganizationListQuery({ conditions, limit: 2, offset: 2, preferredOrder }).toSQL();
}

describe('buildOrganizationListQuery — preferred order participates in page selection', () => {
  it('puts the preferred-order term in the ORDER BY of the same statement as LIMIT/OFFSET', () => {
    const { sql: text } = compile([ORG_C, ORG_A]);

    const orderByAt = text.indexOf('order by');
    const arrayPositionAt = text.indexOf('array_position');
    const limitAt = text.indexOf('limit');
    const offsetAt = text.indexOf('offset');

    expect(orderByAt).toBeGreaterThan(-1);
    expect(limitAt).toBeGreaterThan(-1);
    expect(offsetAt).toBeGreaterThan(-1);
    // The ordering term exists, sits inside the ORDER BY, and precedes both the
    // LIMIT and the OFFSET — i.e. Postgres sorts the whole result set on it
    // before slicing the page, which is what makes a cross-page move
    // expressible at all.
    expect(arrayPositionAt).toBeGreaterThan(orderByAt);
    expect(arrayPositionAt).toBeLessThan(limitAt);
    expect(arrayPositionAt).toBeLessThan(offsetAt);
  });

  it('keeps created_at and id as tiebreakers AFTER the preferred-order term (#3462)', () => {
    const { sql: text } = compile([ORG_C, ORG_A]);
    const orderBy = text.slice(text.indexOf('order by'));

    const arrayPositionAt = orderBy.indexOf('array_position');
    const createdAtAt = orderBy.indexOf('"created_at"');
    const idAt = orderBy.lastIndexOf('"id"');

    // Assert PRESENCE before relative position. `indexOf` returns -1 when the
    // term is absent, and `createdAtAt > -1` holds for any ORDER BY at all —
    // so without this line the whole case passes with the ordering feature
    // removed, which is exactly the vacuous shape this file exists to avoid.
    expect(arrayPositionAt).toBeGreaterThan(-1);
    expect(createdAtAt).toBeGreaterThan(arrayPositionAt);
    expect(idAt).toBeGreaterThan(createdAtAt);
  });

  it('binds each org id as its own parameter rather than interpolating or array-spreading', () => {
    const { sql: text, params } = compile([ORG_C, ORG_A]);

    // The repo's known Drizzle trap: `${jsArray}::uuid[]` emits N positional
    // parameters instead of one array value, which fails at runtime with
    // "cannot cast type record to uuid[]" (routes/devices/core.ts:771). The
    // ARRAY[...] + sql.join form below is the shape that actually executes.
    expect(text).toContain('::uuid[]');
    expect(text).not.toContain(ORG_C);
    expect(params).toContain(ORG_C);
    expect(params).toContain(ORG_A);
    // Preferred-order params keep the caller's sequence: array_position returns
    // the 1-based index, so the array's own order IS the sort.
    expect(params.indexOf(ORG_C)).toBeLessThan(params.indexOf(ORG_A));
  });

  it('falls back to created_at, id alone when no order is stored', () => {
    for (const empty of [undefined, null, [] as string[]]) {
      const { sql: text } = compile(empty);
      expect(text).not.toContain('array_position');
      // Pin the whole term, not just the presence of created_at: the #3462
      // tiebreaker is only load-bearing if `id` is still there behind it.
      expect(text).toContain(
        'order by "organizations"."created_at", "organizations"."id" limit',
      );
    }
  });
});

describe('organizationOrderBy — tolerating a stored order that is not clean', () => {
  function orderTerms(preferredOrder: string[] | null | undefined) {
    return buildOrganizationListQuery({ conditions, limit: 2, offset: 0, preferredOrder }).toSQL();
  }

  it('drops entries that are not UUID-shaped instead of letting the uuid[] cast throw', () => {
    // Pre-fix this list was tolerated by an in-JS sort. A naive SQL port would
    // send 'not-a-uuid' into ::uuid[] and 500 the whole list with 22P02.
    const { sql: text, params } = orderTerms(['not-a-uuid', ORG_B, '', ORG_A]);
    expect(params).not.toContain('not-a-uuid');
    expect(params).toContain(ORG_B);
    expect(params).toContain(ORG_A);
    expect(params.indexOf(ORG_B)).toBeLessThan(params.indexOf(ORG_A));
    expect(text).toContain('array_position');
  });

  it('degrades to created_at, id when every stored entry is junk', () => {
    const { sql: text } = orderTerms(['nope', '']);
    expect(text).not.toContain('array_position');
  });

  it('keeps the first occurrence of a duplicated id, matching array_position semantics', () => {
    const { params } = orderTerms([ORG_B, ORG_A, ORG_B]);
    const bs = params.filter((p) => p === ORG_B);
    expect(bs).toHaveLength(1);
    expect(params.indexOf(ORG_B)).toBeLessThan(params.indexOf(ORG_A));
  });

  it('returns exactly the tiebreaker columns when there is nothing to prefer', () => {
    expect(organizationOrderBy(undefined)).toEqual([organizations.createdAt, organizations.id]);
  });
});
