/**
 * Compiled-SQL assertions for the update-ring partner-level device fan-out (#3954).
 *
 * WHY COMPILED SQL AND NOT A DRIZZLE MOCK: the bug being guarded here lived
 * entirely inside the `.where()` clause — a partner-level assignment's
 * `targetId` (a PARTNER id) was pushed into the same bucket as org-level
 * targets and then matched against `devices.org_id`, which matches zero rows.
 * The repo's usual chainable Drizzle mock never inspects the argument passed to
 * `.where()`, so it would have passed against both the broken and the fixed
 * code (see memory: vacuous_drizzle_where_clause_assertions). These tests
 * render the real condition through PgDialect and pin the predicate text, so
 * reverting to `devices.org_id` — or dropping the ephemeral exclusion, or the
 * legacy org clamp — fails loudly.
 */
import { describe, it, expect, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('../db', () => ({ db: {} }));

import { buildPartnerAssignmentCondition, type RingAssignment } from './updateRingsHelpers';

const dialect = new PgDialect();

const PARTNER_A = '11111111-1111-4111-8111-111111111111';
const PARTNER_B = '22222222-2222-4222-8222-222222222222';
const LEGACY_ORG = '33333333-3333-4333-8333-333333333333';

function render(assignments: RingAssignment[]) {
  const condition = buildPartnerAssignmentCondition(assignments);
  if (!condition) throw new Error('expected a SQL condition, got undefined');
  const query = dialect.sqlToQuery(condition);
  return { sql: query.sql, params: query.params };
}

function partnerAssignment(targetId: string, policyOrgId: string | null = null): RingAssignment {
  return { level: 'partner', targetId, policyOrgId };
}

describe('buildPartnerAssignmentCondition — partner-level ring fan-out (#3954)', () => {
  it('returns undefined when there are no partner-level assignments', () => {
    expect(buildPartnerAssignmentCondition([])).toBeUndefined();
  });

  it('matches devices through organizations.partner_id, NOT devices.org_id', () => {
    const { sql, params } = render([partnerAssignment(PARTNER_A)]);

    // The regression guard: the partner id must be compared against the
    // organizations join column. If this ever renders `devices"."org_id" = $1`
    // for a partner-level assignment we are back to DEVICES 0.
    expect(sql).toContain('"organizations"."partner_id" = $1');
    expect(sql).not.toContain('"devices"."org_id" = $1');
    expect(params).toContain(PARTNER_A);
  });

  it('excludes ephemeral Quick Support devices from the partner fan-out', () => {
    const { sql, params } = render([partnerAssignment(PARTNER_A)]);
    expect(sql).toContain('"devices"."is_ephemeral" = $2');
    expect(params[1]).toBe(false);
  });

  it('ORs multiple partner targets into a single predicate', () => {
    const { sql, params } = render([
      partnerAssignment(PARTNER_A),
      partnerAssignment(PARTNER_B),
    ]);
    expect(sql).toContain('"organizations"."partner_id" = $1');
    expect(sql).toContain('"organizations"."partner_id" = $2');
    expect(sql).toMatch(/ or /);
    expect(params.slice(0, 2)).toEqual([PARTNER_A, PARTNER_B]);
  });

  it('deduplicates repeated (targetId, policyOrgId) pairs', () => {
    const { params } = render([
      partnerAssignment(PARTNER_A),
      partnerAssignment(PARTNER_A),
    ]);
    // One partner param + the is_ephemeral flag — the duplicate is dropped.
    expect(params).toEqual([PARTNER_A, false]);
  });

  it('clamps a legacy org-owned policy to its own org, mirroring the scheduler', () => {
    // patchSchedulerWorker.resolveDeviceIdsForAssignment does
    // `if (policyOrgId) conditions.push(eq(devices.orgId, policyOrgId))` on its
    // partner branch. Without the same clamp the DISPLAYED count would exceed
    // the set the scheduler actually patches.
    const { sql, params } = render([partnerAssignment(PARTNER_A, LEGACY_ORG)]);
    expect(sql).toContain('"organizations"."partner_id" = $1');
    expect(sql).toContain('"devices"."org_id" = $2');
    expect(params.slice(0, 2)).toEqual([PARTNER_A, LEGACY_ORG]);
  });

  it('keeps a partner-wide policy unclamped (no devices.org_id predicate)', () => {
    const { sql } = render([partnerAssignment(PARTNER_A, null)]);
    expect(sql).not.toContain('"devices"."org_id"');
  });
});
