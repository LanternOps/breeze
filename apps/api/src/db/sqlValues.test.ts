import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { sqlTimestamp, sqlTimestamptz, sqlValue } from './sqlValues';

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

  it('sqlValue keeps each value a separate bound parameter rather than inlining it', () => {
    // Inlining would turn a filter value into SQL text — an injection surface.
    const { sql: text, params } = dialect.sqlToQuery(
      sql`x = ${sqlValue("'); DROP TABLE devices; --")}`,
    );

    expect(params).toEqual(["'); DROP TABLE devices; --"]);
    expect(text).not.toContain('DROP TABLE');
  });
});
