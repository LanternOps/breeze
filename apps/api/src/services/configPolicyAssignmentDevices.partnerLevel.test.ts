/**
 * Compiled-SQL assertions for the partner-level device fan-out (#3954).
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
 *
 * The old OR-multiple-targets and dedupe cases are gone on purpose: the shared
 * resolver expands ONE assignment at a time (#8442), so there is no multi-target
 * OR predicate to combine or de-duplicate any more.
 */
import { describe, it, expect, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('../db', () => ({ db: {} }));

import { buildPartnerLevelCondition } from './configPolicyAssignmentDevices';

const dialect = new PgDialect();

const PARTNER_A = '11111111-1111-4111-8111-111111111111';
const LEGACY_ORG = '33333333-3333-4333-8333-333333333333';

function render(partnerTargetId: string, policyOrgId: string | null = null) {
  const query = dialect.sqlToQuery(buildPartnerLevelCondition(partnerTargetId, policyOrgId));
  return { sql: query.sql, params: query.params };
}

describe('buildPartnerLevelCondition — partner-level fan-out (#3954)', () => {
  it('matches devices through organizations.partner_id, NOT devices.org_id', () => {
    const { sql, params } = render(PARTNER_A);

    // The regression guard: the partner id must be compared against the
    // organizations join column. If this ever renders `devices"."org_id" = $1`
    // for a partner-level assignment we are back to DEVICES 0.
    expect(sql).toContain('"organizations"."partner_id" = $1');
    expect(sql).not.toContain('"devices"."org_id" = $1');
    expect(params).toContain(PARTNER_A);
  });

  it('excludes ephemeral Quick Support devices from the partner fan-out', () => {
    const { sql, params } = render(PARTNER_A);
    expect(sql).toContain('"devices"."is_ephemeral" = $2');
    expect(params[1]).toBe(false);
  });

  it('clamps a legacy org-owned policy to its own org', () => {
    // Without the clamp the DISPLAYED count would exceed the set the scheduler
    // actually patches.
    const { sql, params } = render(PARTNER_A, LEGACY_ORG);
    expect(sql).toContain('"organizations"."partner_id" = $1');
    expect(sql).toContain('"devices"."org_id" = $');
    expect(params).toContain(LEGACY_ORG);
  });

  it('keeps a partner-wide policy unclamped (no devices.org_id predicate)', () => {
    const { sql } = render(PARTNER_A, null);
    expect(sql).not.toContain('"devices"."org_id"');
  });
});

describe('buildPartnerLevelCondition — holding org', () => {
  it('leaves devices parked in a holding org out of a partner-level assignment', () => {
    const { sql, params } = render(PARTNER_A);
    expect(sql).toContain('"organizations"."type" <> $3');
    expect(params[2]).toBe('unassigned_pool');
  });
});
