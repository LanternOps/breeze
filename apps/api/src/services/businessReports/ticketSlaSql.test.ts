import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { effectiveDueSql, slaTicketEligibilitySql } from './ticketSlaSql';

const dialect = new PgDialect();
const compile = (q: Parameters<PgDialect['sqlToQuery']>[0]) => dialect.sqlToQuery(q);
/** The fragments keep the staff report's exact line breaks; compare expressions, not layout. */
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

describe('ticket SLA SQL fragments', () => {
  it('eligibility excludes deleted, merged and planned work', () => {
    const { sql, params } = compile(slaTicketEligibilitySql('t'));
    expect(sql).toContain('t.deleted_at IS NULL');
    expect(sql).toContain('AND t.merged_into_ticket_id IS NULL');
    expect(sql).toContain("AND t.work_kind = 'support'");
    expect(params).toEqual([]);
  });

  it.each(['response', 'resolution'] as const)(
    'a NULL stored due falls back to created + target + paused (%s)',
    (kind) => {
      const { sql, params } = compile(effectiveDueSql(kind, 't'));
      expect(oneLine(sql)).toBe(
        `COALESCE(t.${kind}_due_at, t.created_at + (t.${kind}_sla_minutes + COALESCE(t.sla_paused_minutes, 0)) * interval '1 minute')`,
      );
      expect(params).toEqual([]);
    },
  );
});
