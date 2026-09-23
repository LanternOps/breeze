import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * The DB mock models the ONE property the generator's tenancy rests on: which
 * context each statement ran in. `withSystemDbAccessContext` flips the ambient
 * context to system for the duration of the callback, so `runInReportScope`
 * (real, not mocked) behaves exactly as it does in production — no ambient
 * context → open one system context; ambient context → assert and reuse it.
 */
const ctx = vi.hoisted(() => ({
  current: undefined as undefined | Record<string, unknown>,
  systemOpens: 0,
}));

vi.mock('../../db', () => ({
  db: { execute: vi.fn() },
  getCurrentDbAccessContext: () => ctx.current,
  hasDbAccessContext: () => ctx.current !== undefined,
  withSystemDbAccessContext: async <T,>(fn: () => Promise<T>): Promise<T> => {
    ctx.systemOpens += 1;
    const previous = ctx.current;
    ctx.current = { scope: 'system' };
    try {
      return await fn();
    } finally {
      ctx.current = previous;
    }
  },
}));
vi.mock('../portal/timezone', () => ({
  resolveOrgTimezone: vi.fn(async () => 'UTC'),
  resolvePartnerTimezone: vi.fn(async () => 'UTC'),
}));

import type { TicketSlaSummary } from '@breeze/shared';
import { db } from '../../db';
import { ReportScopeMismatchError } from '../reportScope';
import type { ReportGenerationAuthority } from '../siteScope';
import { SITE_RESTRICTED_NOTE } from './common';
import { generateTicketSlaAttainmentReport } from './ticketSlaReport';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const PARTNER = '44444444-4444-4444-8444-444444444444';
const AUGUST = { kind: 'custom' as const, start: '2026-08-01', end: '2026-08-31' };

const dialect = new PgDialect();
type Call = { sql: string; params: unknown[]; contextScope: unknown };
const calls: Call[] = [];

function queueExecute(...resultSets: unknown[][]) {
  const queue = [...resultSets];
  vi.mocked(db.execute).mockImplementation((async (q: SQL) => {
    const compiled = dialect.sqlToQuery(q);
    calls.push({ sql: compiled.sql, params: compiled.params, contextScope: ctx.current?.scope });
    return queue.shift() ?? [];
  }) as never);
}

const partnerAuthority: ReportGenerationAuthority = {
  principalKind: 'user', principalUserId: USER,
  scope: { version: 1, kind: 'partner_wide', partnerId: PARTNER },
  capturedAt: new Date('2026-09-21T00:00:00Z'), fingerprint: 'a'.repeat(64),
};
const orgAuthority: ReportGenerationAuthority = {
  principalKind: 'user', principalUserId: USER,
  scope: { version: 1, kind: 'unrestricted', orgId: ORG_A },
  capturedAt: new Date('2026-09-21T00:00:00Z'), fingerprint: 'f'.repeat(64),
};
const partnerScope = (orgIds: string[] = [ORG_A, ORG_B]) =>
  ({ kind: 'partner' as const, partnerId: PARTNER, orgIds });
const orgScope = { kind: 'organization' as const, orgId: ORG_A };

const GROUP_ROWS = [
  { group_key: ORG_A, group_label: 'Acme', tickets_total: 12, no_sla_tickets: 2,
    response_eligible: 10, response_met: 9, resolution_eligible: 8, resolution_met: 6, breaches: 3 },
  { group_key: ORG_B, group_label: 'Globex', tickets_total: 4, no_sla_tickets: 4,
    response_eligible: 0, response_met: 0, resolution_eligible: 0, resolution_met: 0, breaches: 0 },
];
const OVERALL = [{ tickets_total: 16, no_sla_tickets: 6, response_eligible: 10, response_met: 9,
  resolution_eligible: 8, resolution_met: 6, breaches: 3,
  recomputed_breach_not_stamped: 2, stamped_not_recomputed_breach: 1, scope_org_name: null }];
const EMPTY_OVERALL = [{ ...OVERALL[0], tickets_total: 0, no_sla_tickets: 0, response_eligible: 0,
  response_met: 0, resolution_eligible: 0, resolution_met: 0, breaches: 0,
  recomputed_breach_not_stamped: 0, stamped_not_recomputed_breach: 0 }];

function detailRow(i: number) {
  return {
    id: `t${i}`, ticket_number: `T-${i}`, internal_number: null, org_id: ORG_A, org_name: 'Acme',
    subject: 's', priority: 'high', category: null, assigned_to_name: null,
    created_at: '2026-08-02T00:00:00.000Z', first_response_at: null, resolved_at: null,
    response_sla_minutes: 60, resolution_sla_minutes: 240, paused: 0,
    response_outcome: 'missed', resolution_outcome: 'missed',
    sla_breached_at: null, sla_breach_reason: null,
  };
}

const summaryOf = (r: { summary?: unknown }) => r.summary as TicketSlaSummary;

const USER_DANA = '88888888-8888-4888-8888-888888888888';

describe('generateTicketSlaAttainmentReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    ctx.current = undefined;
    ctx.systemOpens = 0;
  });

  it('computes attainment as met/eligible and leaves a zero-denominator group NULL', async () => {
    queueExecute(GROUP_ROWS, OVERALL, []);
    const s = summaryOf(await generateTicketSlaAttainmentReport(partnerScope(), { period: AUGUST }, partnerAuthority));
    expect(s.groups[0]!.responseAttainment).toBeCloseTo(0.9, 6);
    expect(s.groups[0]!.resolutionAttainment).toBeCloseTo(0.75, 6);
    // Globex had only no-SLA tickets: NOT MEASURED, not 0% and not 100%.
    expect(s.groups[1]!.responseAttainment).toBeNull();
    expect(s.groups[1]!.resolutionAttainment).toBeNull();
    expect(s.groups[1]!.noSlaTickets).toBe(4);
    expect(s.overall.responseAttainment).toBeCloseTo(0.9, 6);
    expect(s.overall.ticketsTotal).toBe(16);
  });

  it('an overall block with nothing eligible is null, not 0 and not NaN', async () => {
    queueExecute([], EMPTY_OVERALL, []);
    const s = summaryOf(await generateTicketSlaAttainmentReport(orgScope, {}, orgAuthority));
    expect(s.overall.responseAttainment).toBeNull();
    expect(s.overall.resolutionAttainment).toBeNull();
    expect(s.worstGroupLabel).toBeNull();
  });

  it('publishes the recomputed-vs-stamped discrepancy rather than hiding it', async () => {
    queueExecute(GROUP_ROWS, OVERALL, []);
    const s = summaryOf(await generateTicketSlaAttainmentReport(partnerScope([ORG_A]), {}, partnerAuthority));
    expect(s.stampDiscrepancy).toEqual({ recomputedBreachNotStamped: 2, stampedNotRecomputedBreach: 1 });
  });

  it('names the worst group by response attainment among MEASURED groups only', async () => {
    queueExecute(GROUP_ROWS, OVERALL, []);
    const s = summaryOf(await generateTicketSlaAttainmentReport(partnerScope(), {}, partnerAuthority));
    expect(s.worstGroupLabel).toBe('Acme'); // Globex is unmeasured, not worst
  });

  it('binds the partner org allowlist as separate uuid params in EVERY statement, plus the support/deleted/period filters', async () => {
    queueExecute([], EMPTY_OVERALL, []);
    await generateTicketSlaAttainmentReport(partnerScope(), { period: AUGUST }, partnerAuthority);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.sql).toMatch(/t\.org_id = ANY\(ARRAY\[\$\d+::uuid, \$\d+::uuid\]\)/);
      expect(call.params).toEqual(expect.arrayContaining([ORG_A, ORG_B]));
      expect(call.sql).toContain("t.work_kind = 'support'");
      expect(call.sql).toContain('t.deleted_at IS NULL');
      expect(call.sql).toMatch(/t\.created_at >= \$\d+ AND t\.created_at < \$\d+/);
      // [start, end) in the owner's zone (UTC here): the custom end date is inclusive.
      expect(call.params).toEqual(expect.arrayContaining(['2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z']));
      expect(call.params).not.toContain(PARTNER);
    }
  });

  it('binds a single org id at org scope — no ARRAY, never the partner id', async () => {
    queueExecute([], EMPTY_OVERALL, []);
    await generateTicketSlaAttainmentReport(orgScope, {}, orgAuthority);
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.sql).toMatch(/t\.org_id = \$\d+/);
      expect(call.sql).not.toContain('ANY(');
      expect(call.params).toContain(ORG_A);
      expect(call.params).not.toContain(PARTNER);
    }
  });

  it('mirrors the SLA sweep deadline: created_at + (target + paused) minutes', async () => {
    queueExecute([], EMPTY_OVERALL, []);
    await generateTicketSlaAttainmentReport(orgScope, {}, orgAuthority);
    expect(calls[0]!.sql).toContain("s.created_at + (s.response_sla_minutes + s.paused) * interval '1 minute'");
    expect(calls[0]!.sql).toContain("s.created_at + (s.resolution_sla_minutes + s.paused) * interval '1 minute'");
    expect(calls[0]!.sql).toContain('COALESCE(t.sla_paused_minutes, 0) AS paused');
  });

  it('runs every statement inside ONE system context when there is no ambient context', async () => {
    queueExecute([], EMPTY_OVERALL, []);
    await generateTicketSlaAttainmentReport(partnerScope(), {}, partnerAuthority);
    expect(ctx.systemOpens).toBe(1);
    expect(calls.map((c) => c.contextScope)).toEqual(['system', 'system', 'system']);
  });

  it('runs IN an ambient partner context that can see the partner, opening no second context', async () => {
    ctx.current = { scope: 'partner', accessiblePartnerIds: [PARTNER], accessibleOrgIds: [ORG_A, ORG_B] };
    queueExecute([], EMPTY_OVERALL, []);
    await generateTicketSlaAttainmentReport(partnerScope(), {}, partnerAuthority);
    expect(ctx.systemOpens).toBe(0);
    expect(calls.map((c) => c.contextScope)).toEqual(['partner', 'partner', 'partner']);
  });

  it('refuses an ambient org context that cannot see the org, before any query', async () => {
    ctx.current = { scope: 'organization', accessibleOrgIds: [ORG_B] };
    queueExecute([], EMPTY_OVERALL, []);
    await expect(generateTicketSlaAttainmentReport(orgScope, {}, orgAuthority))
      .rejects.toBeInstanceOf(ReportScopeMismatchError);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('defaults groupBy to organization at partner scope and priority at org scope', async () => {
    queueExecute([], EMPTY_OVERALL, []);
    const partner = summaryOf(await generateTicketSlaAttainmentReport(partnerScope([ORG_A]), {}, partnerAuthority));
    expect(partner.groupBy).toBe('organization');
    expect(calls[0]!.sql).toContain("COALESCE(org.name, 'Unknown organization')");

    calls.length = 0;
    queueExecute([], EMPTY_OVERALL, []);
    const org = summaryOf(await generateTicketSlaAttainmentReport(orgScope, {}, orgAuthority));
    expect(org.groupBy).toBe('priority');
    expect(calls[0]!.sql).toContain('o.priority::text AS group_key');
  });

  it('technician grouping keys on the current assignee uuid and labels every row "(current assignee)"', async () => {
    queueExecute([
      { ...GROUP_ROWS[0], group_key: USER, group_label: 'Dana' },
      { ...GROUP_ROWS[1], group_key: 'unassigned', group_label: 'Unassigned' },
    ], OVERALL, []);
    const s = summaryOf(await generateTicketSlaAttainmentReport(orgScope, { groupBy: 'technician' }, orgAuthority));
    expect(calls[0]!.sql).toContain("COALESCE(o.assigned_to::text, 'unassigned')");
    expect(s.groups.map((g) => g.groupKey)).toEqual([USER, 'unassigned']);
    expect(s.groups.map((g) => g.groupLabel)).toEqual(['Dana (current assignee)', 'Unassigned (current assignee)']);
  });

  it('includeNoSla=false filters DETAIL rows only — the aggregate statements are byte-identical', async () => {
    queueExecute([], EMPTY_OVERALL, []);
    await generateTicketSlaAttainmentReport(orgScope, {}, orgAuthority);
    const withNoSla = calls.splice(0);

    queueExecute([], EMPTY_OVERALL, []);
    await generateTicketSlaAttainmentReport(orgScope, { includeNoSla: false }, orgAuthority);
    const without = calls.splice(0);

    const noSlaFilter = "NOT (o.response_outcome = 'no_target' AND o.resolution_outcome = 'no_target')";
    expect(without[0]!.sql).toBe(withNoSla[0]!.sql);
    expect(without[1]!.sql).toBe(withNoSla[1]!.sql);
    expect(withNoSla[2]!.sql).not.toContain(noSlaFilter);
    expect(without[2]!.sql).toContain(noSlaFilter);
  });

  it('caps detail rows at 5000 and reports the truncation with the FULL available count', async () => {
    const detail = Array.from({ length: 5001 }, (_, i) => detailRow(i));
    queueExecute(GROUP_ROWS, [{ ...OVERALL[0], tickets_total: 9000 }], detail);
    const result = await generateTicketSlaAttainmentReport(partnerScope([ORG_A]), {}, partnerAuthority);
    const s = summaryOf(result);
    expect(calls[2]!.params).toContain(5001); // LIMIT cap + 1 is how truncation is known
    expect(result.rows).toHaveLength(5000);
    expect(result.rowCount).toBe(5000);
    expect(s.rows).toHaveLength(5000);
    expect(s.detail).toEqual({ cap: 5000, stored: 5000, available: 9000, truncated: true });
    // The AGGREGATE is over all 9000, not the stored 5000 (§3.2).
    expect(s.overall.ticketsTotal).toBe(9000);
  });

  it('under the cap, stored = available and nothing is truncated', async () => {
    queueExecute(GROUP_ROWS, [{ ...OVERALL[0], tickets_total: 2 }], [detailRow(0), detailRow(1)]);
    const s = summaryOf(await generateTicketSlaAttainmentReport(orgScope, {}, orgAuthority));
    expect(s.detail).toEqual({ cap: 5000, stored: 2, available: 2, truncated: false });
  });

  it('maps detail rows to the shared TicketSlaDetailRow field names', async () => {
    queueExecute([], [{ ...OVERALL[0], tickets_total: 1 }], [{
      ...detailRow(7), assigned_to: USER_DANA, assigned_to_name: 'Dana', first_response_at: '2026-08-02T00:30:00.000Z',
      response_outcome: 'met', resolution_outcome: 'pending', paused: 5,
      sla_breached_at: '2026-08-02T04:00:00.000Z', sla_breach_reason: 'resolution',
    }]);
    const s = summaryOf(await generateTicketSlaAttainmentReport(orgScope, {}, orgAuthority));
    expect(s.rows[0]).toEqual({
      ticketId: 't7', ticketNumber: 'T-7', internalNumber: null, orgId: ORG_A, orgName: 'Acme',
      subject: 's', priority: 'high', category: null, assignedToId: USER_DANA, assignedToName: 'Dana',
      createdAt: '2026-08-02T00:00:00.000Z', firstResponseAt: '2026-08-02T00:30:00.000Z', resolvedAt: null,
      responseSlaMinutes: 60, resolutionSlaMinutes: 240, slaPausedMinutes: 5,
      responseOutcome: 'met', resolutionOutcome: 'pending',
      stampedBreachAt: '2026-08-02T04:00:00.000Z', stampedBreachReason: 'resolution',
    });
  });

  it('fills period and scope metadata (org name at org scope, org count at partner scope)', async () => {
    queueExecute([], [{ ...EMPTY_OVERALL[0], scope_org_name: 'Acme' }], []);
    const org = summaryOf(await generateTicketSlaAttainmentReport(orgScope, { period: AUGUST }, orgAuthority));
    expect(org.scope).toEqual({ kind: 'organization', orgId: ORG_A, orgName: 'Acme' });
    expect(org.period).toEqual({
      kind: 'custom', start: '2026-08-01T00:00:00.000Z', end: '2026-09-01T00:00:00.000Z',
      label: '2026-08-01 to 2026-08-31', timeZone: 'UTC',
    });

    queueExecute([], EMPTY_OVERALL, []);
    const partner = summaryOf(await generateTicketSlaAttainmentReport(partnerScope(), {}, partnerAuthority));
    expect(partner.scope).toEqual({ kind: 'partner', partnerId: PARTNER, orgCount: 2 });
  });

  it('prints the approximation notes the spec requires', async () => {
    queueExecute([], EMPTY_OVERALL, []);
    const s = summaryOf(await generateTicketSlaAttainmentReport(orgScope, {}, orgAuthority));
    const text = s.notes.join(' ');
    expect(text).toMatch(/sla_paused_minutes is a lifetime total/);
    expect(text).toMatch(/recomputed from ticket timestamps/);
    expect(text).toMatch(/CURRENT assignee/);
    expect(text).toMatch(/no SLA target are excluded from the attainment denominators/);
    expect(text).toMatch(/Planned work/);
  });

  it('discloses the partner org-list filter at partner scope only', async () => {
    queueExecute([], EMPTY_OVERALL, []);
    const partner = summaryOf(await generateTicketSlaAttainmentReport(partnerScope(), {}, partnerAuthority));
    expect(partner.notes.join(' ')).toMatch(/suspended.*archived.*excluded/i);

    queueExecute([], EMPTY_OVERALL, []);
    const org = summaryOf(await generateTicketSlaAttainmentReport(orgScope, {}, orgAuthority));
    expect(org.notes.join(' ')).not.toMatch(/suspended/i);
  });

  it('a partner with no active organizations short-circuits to the empty summary without a ticket query', async () => {
    queueExecute();
    const result = await generateTicketSlaAttainmentReport(partnerScope([]), {}, partnerAuthority);
    const s = summaryOf(result);
    expect(db.execute).not.toHaveBeenCalled();
    expect(result.rows).toEqual([]);
    expect(s.overall.ticketsTotal).toBe(0);
    expect(s.overall.responseAttainment).toBeNull();
    expect(s.scope).toEqual({ kind: 'partner', partnerId: PARTNER, orgCount: 0 });
    expect(s.notes.join(' ')).toMatch(/no active or trial organizations/i);
  });

  it('a site-restricted authority (with sites) queries NOTHING — tickets have no site axis', async () => {
    // The dispatcher's zero-safe branch only catches restricted-to-ZERO-sites;
    // restricted-to-some-sites reaches the generator, which must not hand a
    // site-restricted technician the whole org's tickets.
    queueExecute(GROUP_ROWS, OVERALL, [detailRow(0)]);
    const restricted: ReportGenerationAuthority = {
      principalKind: 'user', principalUserId: USER,
      scope: { version: 1, kind: 'restricted', orgId: ORG_A, siteIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] },
      capturedAt: new Date('2026-09-21T00:00:00Z'), fingerprint: 'b'.repeat(64),
    };
    const result = await generateTicketSlaAttainmentReport(orgScope, {}, restricted);
    const s = summaryOf(result);
    expect(db.execute).not.toHaveBeenCalled();
    expect(ctx.systemOpens).toBe(0);
    expect(result.rows).toEqual([]);
    expect(s.overall.responseAttainment).toBeNull();
    expect(s.notes).toEqual([SITE_RESTRICTED_NOTE]);
  });

  it('rejects a config the schema refuses (unknown groupBy)', async () => {
    queueExecute([], EMPTY_OVERALL, []);
    await expect(generateTicketSlaAttainmentReport(orgScope, { groupBy: 'site' }, orgAuthority)).rejects.toThrow();
    expect(db.execute).not.toHaveBeenCalled();
  });

  // #3198 W02 fix round (item 2): breaches are what the report exists to show,
  // so the capped detail set must never drop an OLDER breach to keep a newer
  // met ticket. Breached tickets sort first, newest first within each band.
  it('orders detail rows breaches-first so the cap never displaces a breach', async () => {
    queueExecute([], EMPTY_OVERALL, []);
    await generateTicketSlaAttainmentReport(orgScope, {}, orgAuthority);
    expect(calls[2]!.sql).toMatch(
      /ORDER BY \(o\.response_outcome = 'missed' OR o\.resolution_outcome = 'missed'\) DESC, o\.created_at DESC, o\.id/,
    );
  });

  it('discloses the breaches-first detail ordering in the notes', async () => {
    queueExecute([], EMPTY_OVERALL, []);
    const s = summaryOf(await generateTicketSlaAttainmentReport(orgScope, {}, orgAuthority));
    expect(s.notes.join(' ')).toMatch(/breached tickets first/i);
  });
});
