import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { decidedTargetsQuery, openedCountsQuery } from './ticketSlaPerformanceQueries';

const ORG = '11111111-1111-4111-8111-111111111111';
const START = new Date('2026-10-01T00:00:00.000Z');
const END = new Date('2026-11-01T00:00:00.000Z');
const START_ISO = START.toISOString();
const END_ISO = END.toISOString();

const dialect = new PgDialect();
const decided = (includeSubjects = false) =>
  dialect.sqlToQuery(decidedTargetsQuery(ORG, { start: START, end: END }, includeSubjects));
const opened = () => dialect.sqlToQuery(openedCountsQuery(ORG, { start: START, end: END }));
const count = (haystack: readonly unknown[], needle: unknown) => haystack.filter((p) => p === needle).length;
const countText = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe('decidedTargetsQuery', () => {
  it('binds the org id once per arm and never an array', () => {
    const { sql, params } = decided();
    expect(count(params, ORG)).toBe(2);
    expect(countText(sql, 't.org_id = $')).toBe(2);
    expect(sql).not.toContain('ANY(');
    expect(sql).not.toContain('ARRAY[');
  });

  it('decided window is [start, end) on LEAST(completed, due) in both arms', () => {
    const { sql, params } = decided();
    // Postgres LEAST ignores NULL, so an unanswered target is decided at its due time.
    expect(countText(sql, 'LEAST(')).toBeGreaterThanOrEqual(2);
    expect(countText(sql, 'd.decided_at >= $')).toBe(1);
    expect(countText(sql, 'd.decided_at < $')).toBe(1);
    expect(sql).toMatch(/LEAST\(t\.first_response_at,/);
    expect(sql).toMatch(/LEAST\(t\.resolved_at,/);
    expect(params).toEqual(expect.arrayContaining([START_ISO, END_ISO]));
  });

  it('a target with no SLA is not a decided target, in either arm', () => {
    const { sql } = decided();
    expect(sql).toContain('t.response_sla_minutes IS NOT NULL');
    expect(sql).toContain('t.resolution_sla_minutes IS NOT NULL');
  });

  it('met is completion on or before due, and open targets are never met', () => {
    const { sql } = decided();
    expect(sql).toContain('t.first_response_at IS NOT NULL AND t.first_response_at <= ');
    expect(sql).toContain('t.resolved_at IS NOT NULL AND t.resolved_at <= ');
  });

  it('uses the shared stored-or-fallback due in both arms', () => {
    const { sql } = decided();
    expect(sql).toContain('COALESCE(t.response_due_at, t.created_at');
    expect(sql).toContain('COALESCE(t.resolution_due_at, t.created_at');
  });

  it('without includeSubjects the breach query selects no subject', () => {
    const { sql } = decided(false);
    expect(sql).not.toContain('t.subject');
    expect(countText(sql, 'NULL::text AS subject')).toBe(2);
  });

  it('with includeSubjects both arms select the subject', () => {
    const { sql } = decided(true);
    expect(countText(sql, 't.subject AS subject')).toBe(2);
    expect(sql).not.toContain('NULL::text AS subject');
  });

  it('never selects an internal number, an assignee or the sweep stamp', () => {
    const { sql } = decided(true);
    expect(sql).not.toContain('internal_number');
    expect(sql).not.toContain('assigned_to');
    expect(sql).not.toContain('sla_breached_at');
  });

  it('carries the calendar snapshot and orders by due, id, target', () => {
    const { sql } = decided();
    expect(countText(sql, 't.sla_calendar_revision_id')).toBe(2);
    expect(sql).toMatch(/ORDER BY d\.due_at, d\.id, d\.target\s*$/);
  });

  it('labels each arm with its own target kind', () => {
    const { sql } = decided();
    expect(sql).toContain("'response'");
    expect(sql).toContain("'resolution'");
  });
});

describe('openedCountsQuery', () => {
  it('counts eligible tickets created in [start, end) for one bound org, per priority', () => {
    const { sql, params } = opened();
    expect(count(params, ORG)).toBe(1);
    expect(sql).toMatch(/t\.created_at >= \$\d+ AND t\.created_at < \$\d+/);
    expect(params).toEqual(expect.arrayContaining([START_ISO, END_ISO]));
    expect(sql).toContain('GROUP BY t.priority');
    expect(sql).not.toContain('ANY(');
  });

  it('a ticket without target has neither a response nor a resolution target', () => {
    expect(opened().sql).toContain(
      'COUNT(*) FILTER (WHERE t.response_sla_minutes IS NULL AND t.resolution_sla_minutes IS NULL)',
    );
  });
});

describe('both statements', () => {
  it('both statements carry the shared eligibility fragment', () => {
    for (const { sql } of [decided(), opened()]) {
      expect(sql).toContain('t.deleted_at IS NULL');
      expect(sql).toContain('t.merged_into_ticket_id IS NULL');
      expect(sql).toContain("t.work_kind = 'support'");
    }
    // Once per arm of the UNION.
    expect(countText(decided().sql, 't.deleted_at IS NULL')).toBe(2);
  });
});
