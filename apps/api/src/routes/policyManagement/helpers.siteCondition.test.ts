import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('../../db', () => ({ db: {} }));

import { complianceSiteCondition } from './helpers';

const dialect = new PgDialect();

describe('complianceSiteCondition (#4880)', () => {
  it('returns no predicate for an unrestricted caller', () => {
    expect(complianceSiteCondition(undefined)).toBeUndefined();
    expect(complianceSiteCondition(null)).toBeUndefined();
  });

  it('correlates on the compliance row device and binds every allowed site', () => {
    const a = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const b = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const { sql, params } = dialect.sqlToQuery(complianceSiteCondition([a, b])!);
    expect(sql).toContain('exists (');
    expect(sql).toContain('"devices"."id" = "automation_policy_compliance"."device_id"');
    expect(sql).toContain('"devices"."site_id" in ($1, $2)');
    expect(params).toEqual([a, b]);
  });

  it('compiles an empty allowlist to a predicate that matches nothing', () => {
    // Callers short-circuit before this, but the fallback must fail closed.
    const { sql } = dialect.sqlToQuery(complianceSiteCondition([])!);
    expect(sql).toContain('false');
  });
});
