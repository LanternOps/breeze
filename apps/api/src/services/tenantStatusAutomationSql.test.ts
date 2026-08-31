/**
 * Compiled-SQL contract for the fleet-wide-sweep org-status predicate
 * (org-lifecycle Wave 4, final review fix C-A.2).
 *
 * Compiled, not shape-asserted: a sweep unit test that seeds rows straight past
 * the WHERE clause cannot tell a present predicate from an absent one, and an
 * `and()` that quietly received `undefined` selects the whole table.
 */
import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('../db', () => ({
  db: {},
  getCurrentDbAccessContext: vi.fn(() => undefined),
  runOutsideDbContext: vi.fn(),
  withSystemDbAccessContext: vi.fn(),
}));
vi.mock('./redis', () => ({ getRedis: vi.fn(() => null) }));

import { invoices, contracts } from '../db/schema';
import {
  AUTOMATION_ELIGIBLE_ORG_STATUSES,
  buildAutomationEligibleOrgPredicate,
} from './tenantStatus';

const dialect = new PgDialect();

describe('buildAutomationEligibleOrgPredicate (compiled SQL)', () => {
  it('excludes EXACTLY the three lifecycle-frozen statuses', () => {
    // The complement is the contract: adding a status to the enum must be a
    // deliberate decision, and archived/purging/merging must never be in.
    expect([...AUTOMATION_ELIGIBLE_ORG_STATUSES].sort()).toEqual(
      ['active', 'churned', 'offboarding', 'suspended', 'trial'],
    );
    expect(AUTOMATION_ELIGIBLE_ORG_STATUSES).not.toContain('archived');
    expect(AUTOMATION_ELIGIBLE_ORG_STATUSES).not.toContain('purging');
    expect(AUTOMATION_ELIGIBLE_ORG_STATUSES).not.toContain('merging');
  });

  it('compiles to an EXISTS correlated on the caller org column, with bound statuses', () => {
    const query = dialect.sqlToQuery(buildAutomationEligibleOrgPredicate(invoices.orgId));

    expect(query.sql).toContain('EXISTS');
    expect(query.sql).toContain('"organizations" AS automation_eligible_org');
    expect(query.sql).toContain('automation_eligible_org.id = "invoices"."org_id"');
    expect(query.sql).toContain('automation_eligible_org.status::text IN');
    // Statuses are BOUND parameters, never interpolated text.
    expect(query.params).toEqual([...AUTOMATION_ELIGIBLE_ORG_STATUSES]);
    expect(query.sql).not.toContain("'archived'");
  });

  it('correlates on whichever org column it is handed (contracts, not just invoices)', () => {
    const query = dialect.sqlToQuery(buildAutomationEligibleOrgPredicate(contracts.orgId));
    expect(query.sql).toContain('automation_eligible_org.id = "contracts"."org_id"');
  });
});
