import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { sqlTimestamp, sqlTimestamptz, sqlUuidArray, sqlValue } from './sqlValues';

const dialect = new PgDialect();
const AT = new Date('2026-08-10T06:14:42.123Z');

describe('sqlValues (#3369)', () => {
  /**
   * The defect these helpers exist to prevent: a bare value in a Drizzle `sql`
   * template is wrapped in a `Param` with the NOOP encoder, so a `Date` object
   * reaches postgres.js untouched and its Bind step throws
   * ERR_INVALID_ARG_TYPE. This test fails against a bare interpolation, which
   * is what makes it a real guard rather than a restatement of the code.
   */
  it('a bare Date interpolation really does bind a Date — the behaviour being guarded against', () => {
    const { params } = dialect.sqlToQuery(sql`x < ${AT}`);
    expect(params[0]).toBeInstanceOf(Date);
  });

  it('sqlTimestamp binds an ISO string with no cast', () => {
    const { sql: text, params } = dialect.sqlToQuery(sql`x < ${sqlTimestamp(AT)}`);

    expect(params).toEqual(['2026-08-10T06:14:42.123Z']);
    expect(params[0]).not.toBeInstanceOf(Date);
    // The absence of a cast is the point, not an oversight. `devices.last_seen_at`
    // is `timestamp` WITHOUT time zone; casting the parameter to `timestamptz`
    // would make Postgres reinterpret the naive column in the session time zone
    // and silently shift every comparison off UTC deployments.
    expect(text).not.toContain('::');
  });

  it('sqlTimestamp preserves millisecond precision', () => {
    // Truncating here would silently move a boundary comparison by up to 1ms,
    // which is exactly the class of drift that makes keyset paging skip rows.
    const { params } = dialect.sqlToQuery(sqlTimestamp(new Date('2026-08-10T06:14:42.007Z')));
    expect(params[0]).toBe('2026-08-10T06:14:42.007Z');
  });

  it('sqlTimestamptz binds an ISO string cast to timestamptz', () => {
    const { sql: text, params } = dialect.sqlToQuery(sql`GREATEST(c, ${sqlTimestamptz(AT)})`);

    expect(params).toEqual(['2026-08-10T06:14:42.123Z']);
    expect(text).toContain('::timestamptz');
  });

  it('sqlValue serialises a Date and leaves every other scalar alone', () => {
    const cases: Array<[unknown, unknown]> = [
      [AT, '2026-08-10T06:14:42.123Z'],
      ['hello', 'hello'],
      [42, 42],
      [0, 0],
      [true, true],
      [false, false],
      [null, null],
    ];

    for (const [input, expected] of cases) {
      const { params } = dialect.sqlToQuery(sql`x = ${sqlValue(input)}`);
      expect(params, `input ${String(input)}`).toEqual([expected]);
      expect(params[0]).not.toBeInstanceOf(Date);
    }
  });

  it('drops `undefined` rather than binding it — a pre-existing Drizzle footgun, recorded not fixed', () => {
    // Drizzle skips an `undefined` interpolation entirely, so the fragment
    // renders with NO parameter and the surrounding predicate becomes malformed
    // SQL. `sqlValue` does not change that, and `FilterValue` excludes
    // `undefined`, so nothing here is reachable today — but the behaviour is
    // surprising enough to pin, so a future caller widening the type finds it.
    const { params } = dialect.sqlToQuery(sql`x = ${sqlValue(undefined)}`);
    expect(params).toEqual([]);
  });

  it('sqlValue keeps each value a separate bound parameter rather than inlining it', () => {
    // Inlining would turn a filter value into SQL text — an injection surface.
    const { sql: text, params } = dialect.sqlToQuery(
      sql`x = ${sqlValue("'); DROP TABLE devices; --")}`,
    );

    expect(params).toEqual(["'); DROP TABLE devices; --"]);
    expect(text).not.toContain('DROP TABLE');
  });
});

describe('sqlUuidArray (#3198 W02 ruling P5)', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';

  it('a bare JS array interpolation expands to a parenthesised list — the behaviour being guarded against', () => {
    // `ANY(${arr}::uuid[])` renders as `ANY(($1, $2)::uuid[])`, a syntax error
    // in Postgres. This pins WHY the helper exists.
    const { sql: text } = dialect.sqlToQuery(sql`x = ANY(${[A, B]}::uuid[])`);
    expect(text).toContain('($1, $2)::uuid[]');
  });

  it('binds each id as its own uuid-cast parameter inside an ARRAY constructor', () => {
    const { sql: text, params } = dialect.sqlToQuery(sql`x = ANY(${sqlUuidArray([A, B])})`);
    expect(text).toBe('x = ANY(ARRAY[$1::uuid, $2::uuid])');
    expect(params).toEqual([A, B]);
  });

  it('renders an empty list as a typed empty array, never `ARRAY[]` or `()`', () => {
    const { sql: text, params } = dialect.sqlToQuery(sql`x = ANY(${sqlUuidArray([])})`);
    expect(text).toBe('x = ANY(ARRAY[]::uuid[])');
    expect(params).toEqual([]);
  });

  it('never inlines an id as SQL text', () => {
    const { sql: text, params } = dialect.sqlToQuery(sqlUuidArray(["x'); DROP TABLE tickets; --"]));
    expect(text).not.toContain('DROP TABLE');
    expect(params).toEqual(["x'); DROP TABLE tickets; --"]);
  });
});
