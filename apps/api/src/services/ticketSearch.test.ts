import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { ticketSearchCondition } from './ticketSearch';

const dialect = new PgDialect();
const ORG_A = '22222222-2222-4222-8222-222222222222';

describe('ticketSearchCondition (staff search box; #8313 spec §5)', () => {
  it('matches subject and Breeze number substrings, or the whole source number in the visible orgs', () => {
    const { sql, params } = dialect.sqlToQuery(ticketSearchCondition('  ZM-41023 ', [ORG_A]));
    expect(sql).toContain('"tickets"."subject" ilike $1');
    expect(sql).toContain('"tickets"."internal_number" ilike $2');
    expect(sql).toMatch(/"tickets"\."id" IN \(SELECT "ticket_external_refs"\."ticket_id" FROM "ticket_external_refs" WHERE \("ticket_external_refs"\."org_id" in \(\$3\) and "ticket_external_refs"\."external_number" is not null and lower\("ticket_external_refs"\."external_number"\) = lower\(\$4\)\)\)/);
    // The substring term is ILIKE-escaped; the source number is matched whole and trimmed.
    expect(params).toEqual(['%  ZM-41023 %', '%  ZM-41023 %', ORG_A, 'ZM-41023']);
  });

  it('escapes ILIKE wildcards in the substring term', () => {
    const { params } = dialect.sqlToQuery(ticketSearchCondition('50%_off', [ORG_A]));
    expect(params[0]).toBe('%50\\%\\_off%');
  });

  it('matches no ref for a caller with no visible org, and does not bound a system-scope caller', () => {
    expect(dialect.sqlToQuery(ticketSearchCondition('ZM-1', [])).sql).toMatch(/WHERE \(false and /);
    expect(dialect.sqlToQuery(ticketSearchCondition('ZM-1', null)).sql).not.toContain('"org_id" in');
  });

  it('a blank term adds no source-number clause', () => {
    expect(dialect.sqlToQuery(ticketSearchCondition('   ', [ORG_A])).sql).not.toContain('ticket_external_refs');
  });
});
