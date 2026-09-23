import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * Same harness as ticketSlaReport.test.ts: `runInReportScope` is REAL, and the
 * DB mock models only which context each statement ran in. Every statement is
 * compiled with `PgDialect.sqlToQuery`, so assertions are on the real SQL text
 * and the real bound params (ruling P5).
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

import type { TechnicianTimeSummary } from '@breeze/shared';
import { db } from '../../db';
import { ReportScopeMismatchError } from '../reportScope';
import type { ReportGenerationAuthority } from '../siteScope';
import { PARTNER_ORG_LIST_NOTE, SITE_RESTRICTED_NOTE } from './common';
import { generateTechnicianTimeBillabilityReport } from './technicianTimeReport';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const PARTNER = '44444444-4444-4444-8444-444444444444';
const TECH_1 = '55555555-5555-4555-8555-555555555555';
const TECH_IDLE = '66666666-6666-4666-8666-666666666666';
/** August 2026 in UTC: Sat 1st … Mon 31st = 21 weekdays. */
const AUGUST = { kind: 'custom' as const, start: '2026-08-01', end: '2026-08-31' };
const AUGUST_CAPACITY_40H = 21 * 8 * 60; // 10,080

const dialect = new PgDialect();
type Call = { sql: string; params: unknown[]; contextScope: unknown };
const calls: Call[] = [];

/** Statement order: grouped minutes, grouped money, overall, overall money, detail. */
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

function minutes(o: Partial<Record<string, number>> = {}) {
  return {
    logged_minutes: 0, billable_minutes: 0, included_minutes: 0, non_billable_minutes: 0,
    billable_quantity_minutes: 0, billed_minutes: 0, entry_count: 0, ...o,
  };
}
const TECH_ROWS = [
  { group_key: TECH_1, group_label: 'Dana Tech',
    ...minutes({ logged_minutes: 2400, billable_minutes: 1500, included_minutes: 600, non_billable_minutes: 300,
      billable_quantity_minutes: 1600, billed_minutes: 1200, entry_count: 20 }) },
  { group_key: TECH_IDLE, group_label: 'Idle Tech', ...minutes() },
];
const OVERALL = [{
  ...minutes({ logged_minutes: 2400, billable_minutes: 1500, included_minutes: 600, non_billable_minutes: 300,
    billable_quantity_minutes: 1600, billed_minutes: 1200, entry_count: 20 }),
  technician_count: 2, zero_time_technicians: 1, scope_org_name: null,
}];

function detailRow(i: number) {
  return {
    id: `e${i}`, started_at: '2026-08-04T09:00:00.000Z', user_id: TECH_1, user_name: 'Dana Tech',
    org_id: null, org_name: null, work_type_name: null, duration_minutes: 120, billable_minutes: 120,
    coverage: 'billable', billing_status: 'billed', is_approved: true, hourly_rate: '150.00', currency_code: 'USD',
  };
}

const summaryOf = (r: { summary?: unknown }) => r.summary as TechnicianTimeSummary;

describe('generateTechnicianTimeBillabilityReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    ctx.current = undefined;
    ctx.systemOpens = 0;
  });

  it('utilization = logged ÷ prorated capacity (2,400 of 21 × 8h × 60 = 10,080)', async () => {
    queueExecute(TECH_ROWS, [], OVERALL, [], []);
    const s = summaryOf(await generateTechnicianTimeBillabilityReport(partnerScope(), { period: AUGUST }, partnerAuthority));
    expect(s.workingDays).toBe(21);
    expect(s.weeklyCapacityHours).toBe(40);
    expect(s.groups[0]).toMatchObject({ groupKey: TECH_1, capacityMinutes: AUGUST_CAPACITY_40H });
    expect(s.groups[0]!.utilization).toBeCloseTo(0.2381, 4);
    // Team capacity is per-tech capacity × every technician row (idle ones too).
    expect(s.overall.capacityMinutes).toBe(2 * AUGUST_CAPACITY_40H);
    expect(s.overall.utilization).toBeCloseTo(2400 / (2 * AUGUST_CAPACITY_40H), 6);
  });

  it('weeklyCapacityHours prorates capacity', async () => {
    queueExecute(TECH_ROWS, [], OVERALL, [], []);
    const s = summaryOf(await generateTechnicianTimeBillabilityReport(partnerScope(),
      { period: AUGUST, weeklyCapacityHours: 20 }, partnerAuthority));
    expect(s.groups[0]!.capacityMinutes).toBe(21 * 4 * 60);
    expect(s.notes.join(' ')).toMatch(/uniform 20h week prorated over 21 working days/);
  });

  it('a zero-time technician is a MEASURED zero: utilization 0, but billable % and conversion are null', async () => {
    queueExecute(TECH_ROWS, [], OVERALL, [], []);
    const s = summaryOf(await generateTechnicianTimeBillabilityReport(partnerScope(), { period: AUGUST }, partnerAuthority));
    expect(s.groups[1]).toMatchObject({
      groupKey: TECH_IDLE, groupLabel: 'Idle Tech', loggedMinutes: 0, utilization: 0,
      billablePercent: null, billingConversion: null, billableValue: [], averageRate: [],
    });
    expect(s.zeroTimeTechnicians).toBe(1);
  });

  it('technician axis starts FROM the roster (techs ∪ users with entries) LEFT JOIN entries', async () => {
    queueExecute(TECH_ROWS, [], OVERALL, [], []);
    await generateTechnicianTimeBillabilityReport(partnerScope(), { period: AUGUST }, partnerAuthority);
    expect(calls[0]!.sql).toMatch(/FROM roster r\s+LEFT JOIN entries e ON e\.user_id = r\.user_id/);
    // Mirrors roleGrantsReportAction: '*' rows survive so Partner Admin counts.
    expect(calls[0]!.sql).toContain(`p.resource IN ('time_entries', '*')`);
    expect(calls[0]!.sql).toContain(`p.action IN ('read', '*')`);
    expect(calls[0]!.sql).toContain(`u.status = 'active'`);
    expect(calls[0]!.sql).toContain(`r.scope = 'partner'`);
  });

  it('billability splits on coverage and falls back to is_billable when coverage is NULL', async () => {
    queueExecute(TECH_ROWS, [], OVERALL, [], []);
    await generateTechnicianTimeBillabilityReport(partnerScope(), { period: AUGUST }, partnerAuthority);
    for (const call of calls) {
      expect(call.sql).toContain(
        `COALESCE(te.coverage, CASE WHEN te.is_billable THEN 'billable' ELSE 'non_billable' END) AS eff_coverage`,
      );
      expect(call.sql).toContain('te.ended_at IS NOT NULL');
    }
    expect(calls[0]!.sql).toMatch(/SUM\(e\.duration_minutes\) FILTER \(WHERE e\.eff_coverage = 'included'\)/);
  });

  it('included minutes are their own column and are NOT in billable minutes or billable %', async () => {
    queueExecute(TECH_ROWS, [], OVERALL, [], []);
    const s = summaryOf(await generateTechnicianTimeBillabilityReport(partnerScope(), { period: AUGUST }, partnerAuthority));
    expect(s.groups[0]).toMatchObject({ billableMinutes: 1500, includedMinutes: 600, nonBillableMinutes: 300 });
    expect(s.groups[0]!.billablePercent).toBeCloseTo(1500 / 2400, 6);
  });

  it('billing conversion = billed ÷ billable QUANTITY (post-rounding both sides), not ÷ duration', async () => {
    queueExecute(TECH_ROWS, [], OVERALL, [], []);
    const s = summaryOf(await generateTechnicianTimeBillabilityReport(partnerScope(), { period: AUGUST }, partnerAuthority));
    expect(s.groups[0]!.billedMinutes).toBe(1200);
    expect(s.groups[0]!.billingConversion).toBeCloseTo(1200 / 1600, 6);
    expect(calls[0]!.sql).toMatch(/e\.is_approved AND e\.billing_status IN \('billed', 'contract'\)/);
  });

  it('billable value is one entry per currency — never collapsed — as numeric strings', async () => {
    const money = [
      { group_key: TECH_1, currency_code: 'EUR', billable_value: '90.00', average_rate: '90.00' },
      { group_key: TECH_1, currency_code: 'USD', billable_value: '300.00', average_rate: '150.00' },
    ];
    const overallMoney = [
      { currency_code: 'EUR', billable_value: '90.00', average_rate: '90.00' },
      { currency_code: 'USD', billable_value: '300.00', average_rate: '150.00' },
    ];
    queueExecute(TECH_ROWS, money, OVERALL, overallMoney, []);
    const s = summaryOf(await generateTechnicianTimeBillabilityReport(partnerScope(), { period: AUGUST }, partnerAuthority));
    expect(s.groups[0]!.billableValue).toEqual([
      { currencyCode: 'EUR', amount: '90.00' },
      { currencyCode: 'USD', amount: '300.00' },
    ]);
    expect(s.groups[0]!.averageRate).toEqual([
      { currencyCode: 'EUR', amount: '90.00' },
      { currencyCode: 'USD', amount: '150.00' },
    ]);
    expect(s.overall.billableValue).toHaveLength(2);
    // Same rounding shape as getTicketBillingSummary: hours to 2dp, one ROUND
    // per row at the currency's minor unit (zero-decimal codes → 0), then SUM.
    expect(calls[1]!.sql).toMatch(
      /SUM\(ROUND\(ROUND\(COALESCE\(e\.billable_minutes, e\.duration_minutes\)::numeric \/ 60, 2\) \* e\.hourly_rate, CASE WHEN e\.currency_code IN \(/,
    );
    expect(calls[1]!.params).toContain('JPY');
    expect(calls[1]!.sql).toMatch(/GROUP BY 1, 2/);
    expect(calls[3]!.sql).toMatch(/GROUP BY e\.currency_code/);
  });

  it('groupBy work_type: capacity and utilization are null on every row; NULL work type → unassigned', async () => {
    const rows = [
      { group_key: 'unassigned', group_label: 'Unassigned', ...minutes({ logged_minutes: 60 }) },
      { group_key: 'wt-1', group_label: 'Onsite', ...minutes({ logged_minutes: 120 }) },
    ];
    queueExecute(rows, [], OVERALL, [], []);
    const s = summaryOf(await generateTechnicianTimeBillabilityReport(partnerScope(),
      { period: AUGUST, groupBy: 'work_type' }, partnerAuthority));
    expect(s.groupBy).toBe('work_type');
    for (const g of s.groups) {
      expect(g.capacityMinutes).toBeNull();
      expect(g.utilization).toBeNull();
    }
    expect(calls[0]!.sql).toContain(`COALESCE(e.work_type_id::text, 'unassigned')`);
    expect(calls[0]!.sql).toMatch(/FROM entries e\s+LEFT JOIN work_types wt/);
    expect(calls[0]!.sql).not.toContain('FROM roster');
    // The zero-time count still comes from the overall statement.
    expect(s.zeroTimeTechnicians).toBe(1);
  });

  it('groupBy organization: org-less entries land in a "no organization" row, no roster phantom rows', async () => {
    queueExecute([], [], OVERALL, [], []);
    await generateTechnicianTimeBillabilityReport(partnerScope(), { period: AUGUST, groupBy: 'organization' }, partnerAuthority);
    expect(calls[0]!.sql).toContain(`COALESCE(e.org_id::text, 'no_organization')`);
    expect(calls[0]!.sql).toContain(`'No organization'`);
    expect(calls[0]!.sql).not.toContain('FROM roster');
  });

  it('partner scope binds partnerId AND each org id as a uuid param in EVERY statement, and admits org-less entries', async () => {
    queueExecute(TECH_ROWS, [], OVERALL, [], []);
    await generateTechnicianTimeBillabilityReport(partnerScope(), { period: AUGUST }, partnerAuthority);
    expect(calls).toHaveLength(5);
    for (const call of calls) {
      expect(call.sql).toMatch(/te\.partner_id = \$\d+/);
      expect(call.sql).toMatch(/\(te\.org_id IS NULL OR te\.org_id = ANY\(ARRAY\[\$\d+::uuid, \$\d+::uuid\]\)\)/);
      expect(call.params).toContain(PARTNER);
      expect(call.params).toContain(ORG_A);
      expect(call.params).toContain(ORG_B);
      expect(call.params).toContain('2026-08-01T00:00:00.000Z');
      expect(call.params).toContain('2026-09-01T00:00:00.000Z');
      expect(call.sql).not.toMatch(/\(\$\d+, \$\d+\)::uuid\[\]/);
    }
  });

  it('org scope binds the org id, keeps te.partner_id = the ORG\'s partner (resolved in SQL), never binds a partner id', async () => {
    queueExecute([], [], [{ ...OVERALL[0], technician_count: 0, zero_time_technicians: 0, scope_org_name: 'Acme' }], [], []);
    const s = summaryOf(await generateTechnicianTimeBillabilityReport(orgScope, { period: AUGUST }, orgAuthority));
    for (const call of calls) {
      expect(call.sql).toMatch(/te\.org_id = \$\d+/);
      expect(call.sql).toMatch(/te\.partner_id = \(SELECT o\.partner_id FROM organizations o WHERE o\.id = \$\d+\)/);
      expect(call.sql).not.toContain('ARRAY[');
      expect(call.sql).not.toContain('te.org_id IS NULL');
      expect(call.params).toContain(ORG_A);
      expect(call.params).not.toContain(PARTNER);
    }
    // No partner axis to enumerate: technicians are the users in the org's own entries.
    expect(calls[0]!.sql).not.toContain('partner_users');
    expect(s.scope).toEqual({ kind: 'organization', orgId: ORG_A, orgName: 'Acme' });
  });

  it('org scope notes carry the spec label and the org-token disclosure (P7)', async () => {
    queueExecute([], [], OVERALL, [], []);
    const s = summaryOf(await generateTechnicianTimeBillabilityReport(orgScope, { period: AUGUST }, orgAuthority));
    expect(s.notes).toContain(
      'Organization-scoped: ticket-linked time only. Time entries with no organization are not included, and technicians who logged none of this organization\'s time do not appear.',
    );
    expect(s.notes.join(' ')).toMatch(/partner-internal.*organization-scoped sign-in/i);
    expect(s.notes).not.toContain(PARTNER_ORG_LIST_NOTE);
  });

  it('org scope discloses that utilization is the share of each technician\'s capacity spent on this organization', async () => {
    queueExecute([], [], OVERALL, [], []);
    const s = summaryOf(await generateTechnicianTimeBillabilityReport(orgScope, { period: AUGUST }, orgAuthority));
    expect(s.notes).toContain(
      'Utilization at organization scope is the share of each technician\'s capacity spent on this organization, not their overall utilization.',
    );
  });

  it('partner roster note: users with time who are disabled or lack time-entry access still appear and add capacity', async () => {
    queueExecute(TECH_ROWS, [], OVERALL, [], []);
    const s = summaryOf(await generateTechnicianTimeBillabilityReport(partnerScope(), { period: AUGUST }, partnerAuthority));
    expect(s.notes.join(' ')).toMatch(
      /disabled or without time-entry access.*included.*add their capacity/i,
    );
  });

  it('prints the capacity and billing-conversion notes, and the org-list note at partner scope', async () => {
    queueExecute(TECH_ROWS, [], OVERALL, [], []);
    const s = summaryOf(await generateTechnicianTimeBillabilityReport(partnerScope(), { period: AUGUST }, partnerAuthority));
    expect(s.notes).toContain(
      'Utilization assumes a uniform 40h week prorated over 21 working days; PTO, part-time schedules and public holidays are not modelled.',
    );
    expect(s.notes).toContain(
      'Billing conversion is approved-and-billed minutes over billable minutes. It is not financial realization — no fee-schedule baseline exists to compute one.',
    );
    expect(s.notes).toContain(PARTNER_ORG_LIST_NOTE);
  });

  it('caps detail rows at 5000; available is the full entry count', async () => {
    const detail = Array.from({ length: 5001 }, (_, i) => detailRow(i));
    queueExecute(TECH_ROWS, [], [{ ...OVERALL[0], entry_count: 7250 }], [], detail);
    const result = await generateTechnicianTimeBillabilityReport(partnerScope(), { period: AUGUST }, partnerAuthority);
    const s = summaryOf(result);
    expect(s.detail).toEqual({ cap: 5000, stored: 5000, available: 7250, truncated: true });
    expect(s.rows).toHaveLength(5000);
    expect(result.rowCount).toBe(5000);
    expect(calls[4]!.params).toContain(5001);
    expect(calls[4]!.sql).toMatch(/ORDER BY e\.started_at DESC, e\.id\s+LIMIT \$\d+/);
  });

  it('maps detail rows to the shared TechnicianTimeDetailRow field names', async () => {
    queueExecute(TECH_ROWS, [], OVERALL, [], [detailRow(1)]);
    const s = summaryOf(await generateTechnicianTimeBillabilityReport(partnerScope(), { period: AUGUST }, partnerAuthority));
    expect(s.rows[0]).toEqual({
      entryId: 'e1', startedAt: '2026-08-04T09:00:00.000Z', userId: TECH_1, userName: 'Dana Tech',
      orgId: null, orgName: null, workTypeName: null, durationMinutes: 120, billableMinutes: 120,
      coverage: 'billable', billingStatus: 'billed', isApproved: true, hourlyRate: '150.00', currencyCode: 'USD',
    });
    expect(s.detail).toEqual({ cap: 5000, stored: 1, available: 1, truncated: false });
  });

  it('runs every statement inside ONE system context when there is no ambient context', async () => {
    queueExecute(TECH_ROWS, [], OVERALL, [], []);
    await generateTechnicianTimeBillabilityReport(partnerScope(), { period: AUGUST }, partnerAuthority);
    expect(ctx.systemOpens).toBe(1);
    expect(calls.every((c) => c.contextScope === 'system')).toBe(true);
  });

  it('refuses an ambient org context that cannot see the org, before any query', async () => {
    ctx.current = { scope: 'organization', accessibleOrgIds: [ORG_B] };
    queueExecute();
    await expect(generateTechnicianTimeBillabilityReport(orgScope, { period: AUGUST }, orgAuthority))
      .rejects.toBeInstanceOf(ReportScopeMismatchError);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('a partner with no active orgs still reports its org-less (internal) time — ARRAY[]::uuid[], not a short-circuit', async () => {
    queueExecute(TECH_ROWS, [], OVERALL, [], []);
    const s = summaryOf(await generateTechnicianTimeBillabilityReport(partnerScope([]), { period: AUGUST }, partnerAuthority));
    expect(calls).toHaveLength(5);
    expect(calls[0]!.sql).toContain('(te.org_id IS NULL OR te.org_id = ANY(ARRAY[]::uuid[]))');
    expect(s.scope).toEqual({ kind: 'partner', partnerId: PARTNER, orgCount: 0 });
    expect(s.notes.join(' ')).toMatch(/no active or trial organizations.*no organization/i);
  });

  it('a site-restricted authority (with sites) queries NOTHING — time entries have no site axis', async () => {
    queueExecute();
    const restricted: ReportGenerationAuthority = {
      ...orgAuthority, scope: { version: 1, kind: 'restricted', orgId: ORG_A, siteIds: ['77777777-7777-4777-8777-777777777777'] },
    };
    const result = await generateTechnicianTimeBillabilityReport(orgScope, { period: AUGUST }, restricted);
    expect(db.execute).not.toHaveBeenCalled();
    expect(ctx.systemOpens).toBe(0);
    expect(summaryOf(result).notes).toEqual([SITE_RESTRICTED_NOTE]);
    expect(result.rowCount).toBe(0);
  });

  it.each([
    [{ weeklyCapacityHours: 0 }],
    [{ weeklyCapacityHours: 81 }],
    [{ groupBy: 'priority' }],
  ])('rejects a config the schema refuses: %j', async (config) => {
    queueExecute();
    await expect(generateTechnicianTimeBillabilityReport(partnerScope(), config, partnerAuthority)).rejects.toThrow();
    expect(db.execute).not.toHaveBeenCalled();
  });
});
