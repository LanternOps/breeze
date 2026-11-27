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
    expect(sql).toContain('"tickets"."ticket_number" ilike $3');
    expect(sql).toMatch(/"tickets"\."id" IN \(SELECT "ticket_external_refs"\."ticket_id" FROM "ticket_external_refs" WHERE \("ticket_external_refs"\."org_id" in \(\$4\) and "ticket_external_refs"\."external_number" is not null and lower\("ticket_external_refs"\."external_number"\) = lower\(\$5\)\)\)/);
    // The substring term is ILIKE-escaped; the source number is matched whole and trimmed.
    // Pasted padding is trimmed for every field: a technician never means the spaces.
    expect(params).toEqual(['%ZM-41023%', '%ZM-41023%', '%ZM-41023%', ORG_A, 'ZM-41023']);
  });

  it('drops surrounding whitespace and ONE leading # for the customer-facing number only', () => {
    const { params } = dialect.sqlToQuery(ticketSearchCondition(' #PYNN5Y1GLB ', [ORG_A]));
    // subject / internal_number keep the # (a subject can contain it); ticket_number does not.
    expect(params.slice(0, 3)).toEqual(['%#PYNN5Y1GLB%', '%#PYNN5Y1GLB%', '%PYNN5Y1GLB%']);
    expect(dialect.sqlToQuery(ticketSearchCondition('# PYNN5Y1GLB', [ORG_A])).params[2]).toBe('%PYNN5Y1GLB%');
    // Only one # is stripped.
    expect(dialect.sqlToQuery(ticketSearchCondition('##AB', [ORG_A])).params[2]).toBe('%#AB%');
  });

  it('still escapes wildcards in the customer-number term', () => {
    expect(dialect.sqlToQuery(ticketSearchCondition('#A%_B', [ORG_A])).params[2]).toBe('%A\\%\\_B%');
  });

  it('a term of only # or only whitespace cannot match every ticket', () => {
    for (const term of ['#', '  #  ', '   ', '']) {
      const { sql, params } = dialect.sqlToQuery(ticketSearchCondition(term, [ORG_A]));
      expect(params).not.toContain('%%');
      expect(sql).not.toMatch(/ticket_number" ilike/);
    }
  });

  it('escapes ILIKE wildcards in the substring term', () => {
    const { params } = dialect.sqlToQuery(ticketSearchCondition('50%_off', [ORG_A]));
    expect(params[0]).toBe('%50\\%\\_off%');
    expect(params.slice(0, 3)).toEqual(Array(3).fill('%50\\%\\_off%'));
  });

  it('matches no ref for a caller with no visible org, and does not bound a system-scope caller', () => {
    expect(dialect.sqlToQuery(ticketSearchCondition('ZM-1', [])).sql).toMatch(/WHERE \(false and /);
    expect(dialect.sqlToQuery(ticketSearchCondition('ZM-1', null)).sql).not.toContain('"org_id" in');
  });

  it('a blank term adds no source-number clause', () => {
    expect(dialect.sqlToQuery(ticketSearchCondition('   ', [ORG_A])).sql).not.toContain('ticket_external_refs');
  });
});
