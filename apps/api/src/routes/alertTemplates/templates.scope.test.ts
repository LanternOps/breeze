/**
 * Security review 2026-08-16 §1.5 (CRITICAL) — cross-org alert-template read.
 *
 * `templateScopeCondition()` used to OR in a bare
 * `alert_templates.partner_id = <caller partner>` as though it selected only
 * partner-wide rows. Org-owned rows were written with BOTH org_id and
 * partner_id, so that disjunct matched every template under the partner and
 * voided the `org_id IN (accessible orgs)` restriction sitting beside it — a
 * genuine cross-org read for a partner-scope caller with orgAccess
 * 'selected'/'none' (partner-axis RLS is flat and does not catch it).
 *
 * These tests render the predicate to real SQL through the Postgres dialect and
 * pin the exact text, so deleting the `org_id IS NULL` conjunct fails them.
 * A substring/token scan would not: the old, vulnerable predicate also
 * contained `partner_id` and `org_id`.
 */
import { describe, it, expect, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('../../db', () => ({ db: {} }));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));

import { templateScopeCondition } from './templates';
import type { AuthContext } from '../../middleware/auth';

const dialect = new PgDialect();

function render(auth: AuthContext) {
  const condition = templateScopeCondition(auth);
  if (condition === undefined || condition === 'no-org-context') {
    throw new Error(`expected a SQL condition, got ${String(condition)}`);
  }
  const query = dialect.sqlToQuery(condition);
  return { sql: query.sql, params: query.params };
}

const PARTNER_ID = '11111111-1111-4111-8111-111111111111';
const ORG_A = '22222222-2222-4222-8222-222222222222';
const ORG_B = '33333333-3333-4333-8333-333333333333';

function partnerAuth(accessibleOrgIds: string[] | null): AuthContext {
  return {
    scope: 'partner',
    orgId: null,
    partnerId: PARTNER_ID,
    accessibleOrgIds,
    canAccessOrg: (id: string) => (accessibleOrgIds ?? []).includes(id),
  } as unknown as AuthContext;
}

function orgAuth(orgId: string | null): AuthContext {
  return {
    scope: 'organization',
    orgId,
    partnerId: PARTNER_ID,
    accessibleOrgIds: orgId ? [orgId] : null,
    canAccessOrg: (id: string) => id === orgId,
  } as unknown as AuthContext;
}

describe('templateScopeCondition — partner-wide means partner_id = X AND org_id IS NULL', () => {
  it('partner scope with orgAccess "selected" cannot reach a non-accessible org through the partner disjunct', () => {
    // The caller can reach ORG_A only. ORG_B belongs to the same partner and is
    // exactly the row the old predicate leaked.
    const { sql, params } = render(partnerAuth([ORG_A]));

    expect(sql).toBe(
      '(("alert_templates"."is_built_in" = $1 and "alert_templates"."org_id" is null) ' +
        'or "alert_templates"."org_id" in ($2) ' +
        'or ("alert_templates"."partner_id" = $3 and "alert_templates"."org_id" is null))',
    );
    expect(params).toEqual([true, ORG_A, PARTNER_ID]);

    // ORG_B must not appear anywhere in the bound parameters — the only org
    // reachable through this predicate is the allowlisted one.
    expect(params).not.toContain(ORG_B);

    // The partner disjunct must never stand alone. Splitting on the top-level
    // ` or ` and finding a partner_id term without the org_id NULL conjunct is
    // precisely the vulnerable shape.
    const partnerDisjuncts = sql
      .slice(1, -1)
      .split(/ or (?![^(]*\))/)
      .filter((d) => d.includes('partner_id'));
    expect(partnerDisjuncts).toHaveLength(1);
    expect(partnerDisjuncts[0]).toContain('"alert_templates"."org_id" is null');
  });

  it('partner scope with orgAccess "none" sees only built-ins and partner-wide rows', () => {
    const { sql, params } = render(partnerAuth([]));

    expect(sql).toBe(
      '(("alert_templates"."is_built_in" = $1 and "alert_templates"."org_id" is null) ' +
        'or ("alert_templates"."partner_id" = $2 and "alert_templates"."org_id" is null))',
    );
    expect(params).toEqual([true, PARTNER_ID]);
    // No org disjunct at all: an orgAccess:'none' partner caller has no org
    // axis, and the partner axis is pinned to org_id IS NULL.
    expect(sql).not.toContain('"org_id" in');
  });

  it('org scope reads its own org plus built-ins plus partner-wide rows only', () => {
    // The org-scope partner branch is deliberate: alert_templates carries an
    // explicit `(org_id IS NULL AND partner_id = breeze_current_partner_id())`
    // RLS SELECT branch (2026-06-13-catalog-partner-read-branch) so org admins
    // can read their MSP's shared templates read-only. It still must not widen
    // to sibling orgs.
    const { sql, params } = render(orgAuth(ORG_A));

    expect(sql).toBe(
      '(("alert_templates"."is_built_in" = $1 and "alert_templates"."org_id" is null) ' +
        'or "alert_templates"."org_id" = $2 ' +
        'or ("alert_templates"."partner_id" = $3 and "alert_templates"."org_id" is null))',
    );
    expect(params).toEqual([true, ORG_A, PARTNER_ID]);
    expect(params).not.toContain(ORG_B);
  });

  it('the built-in disjunct is pinned to org_id IS NULL on every branch', () => {
    // Same class as §1.5, on the OTHER global disjunct: policyAlertBridge
    // auto-creates ORG-OWNED rows with is_built_in true, so a bare
    // `is_built_in = true` term hands out another org's template. Every branch
    // must carry the org_id IS NULL conjunct.
    for (const auth of [partnerAuth([ORG_A]), partnerAuth([]), orgAuth(ORG_A)]) {
      const { sql } = render(auth);
      const builtInDisjuncts = sql
        .slice(1, -1)
        .split(/ or (?![^(]*\))/)
        .filter((d) => d.includes('is_built_in'));
      expect(builtInDisjuncts).toHaveLength(1);
      expect(builtInDisjuncts[0]).toContain('"alert_templates"."org_id" is null');
    }
  });

  it('org scope without an org context returns the 403 sentinel', () => {
    expect(templateScopeCondition(orgAuth(null))).toBe('no-org-context');
  });

  it('system scope is unfiltered', () => {
    expect(templateScopeCondition({ scope: 'system' } as unknown as AuthContext)).toBeUndefined();
  });
});
