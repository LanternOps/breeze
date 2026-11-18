import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const ctx = vi.hoisted(() => ({
  current: undefined as undefined | Record<string, unknown>,
  timeZone: 'UTC',
}));

vi.mock('../../db', () => ({
  db: { execute: vi.fn() },
  getCurrentDbAccessContext: () => ctx.current,
  hasDbAccessContext: () => ctx.current !== undefined,
  withSystemDbAccessContext: async <T,>(fn: () => Promise<T>): Promise<T> => {
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
  resolveOrgTimezone: vi.fn(async () => ctx.timeZone),
  resolvePartnerTimezone: vi.fn(async () => ctx.timeZone),
}));
vi.mock('../contractMrr', () => ({ resolveContractMrrRows: vi.fn() }));

import type { MrrRenewalsSummary } from '@breeze/shared';
import { db } from '../../db';
import { resolveContractMrrRows, type ContractMrrRow, type ContractMrrRows } from '../contractMrr';
import { mrrRenewalsConfigSchema } from '../reportConfigSchemas';
import type { ReportGenerationAuthority } from '../siteScope';
import { NO_ORGS_NOTE, PARTNER_ORG_LIST_NOTE, SITE_RESTRICTED_NOTE } from './common';
import {
  AS_OF_RUN_TIME_NOTE, BILLED_SERIES_NOTE, FINAL_TERM_NOTE, HISTORY_STARTS_NOTE, LIVE_QUANTITIES_NOTE,
  SUSPENDED_ORGS_MRR_NOTE, UNKNOWN_ORG_NOTE, deletedGroupNote, excludedContractsNote, generateMrrRenewalsReport,
} from './mrrRenewalsReport';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const PARTNER = '44444444-4444-4444-8444-444444444444';

const dialect = new PgDialect();
type Call = { name: string; sql: string; params: unknown[] };
const calls: Call[] = [];
type Rows = Partial<Record<'org_names' | 'renewal_notices' | 'billed_recurring', unknown[]>>;

function respond(rows: Rows = {}) {
  vi.mocked(db.execute).mockImplementation((async (q: SQL) => {
    const compiled = dialect.sqlToQuery(q);
    const name = /\/\* mrr:(\w+) \*\//.exec(compiled.sql)?.[1] ?? 'unknown';
    calls.push({ name, sql: compiled.sql, params: compiled.params });
    return (rows as Record<string, unknown[] | undefined>)[name] ?? [];
  }) as never);
}
const call = (name: string) => {
  const found = calls.find((c) => c.name === name);
  if (!found) throw new Error(`statement ${name} was not run; ran ${calls.map((c) => c.name).join(', ')}`);
  return found;
};

function resolved(over: Partial<ContractMrrRows> = {}) {
  vi.mocked(resolveContractMrrRows).mockResolvedValue({ rows: [], skipped: [], activeNotInTerm: [], ...over });
}
const row = (over: Partial<ContractMrrRow> = {}): ContractMrrRow => ({
  contractId: 'c1', orgId: ORG_A, name: 'Managed services', status: 'active', basis: 'active',
  currencyCode: 'USD', intervalMonths: 1, baseMonthly: '100.00', overageMonthly: '0.00', mrr: '100.00',
  startDate: '2026-01-01', endDate: null, autoRenew: false, renewalTermMonths: null, unresolvedGroup: false,
  ...over,
});

const partnerAuthority: ReportGenerationAuthority = {
  principalKind: 'user', principalUserId: USER,
  scope: { version: 1, kind: 'partner_wide', partnerId: PARTNER },
  capturedAt: new Date('2026-09-01T00:00:00Z'), fingerprint: 'a'.repeat(64),
};
const orgAuthority: ReportGenerationAuthority = {
  principalKind: 'user', principalUserId: USER,
  scope: { version: 1, kind: 'unrestricted', orgId: ORG_A },
  capturedAt: new Date('2026-09-01T00:00:00Z'), fingerprint: 'f'.repeat(64),
};
const restrictedAuthority: ReportGenerationAuthority = {
  principalKind: 'user', principalUserId: USER,
  scope: { version: 1, kind: 'restricted', orgId: ORG_A, siteIds: ['55555555-5555-4555-8555-555555555555'] } as never,
  capturedAt: new Date('2026-09-01T00:00:00Z'), fingerprint: 'e'.repeat(64),
};
const partnerScope = (orgIds: string[] = [ORG_A, ORG_B]) => ({ kind: 'partner' as const, partnerId: PARTNER, orgIds });
const orgScope = { kind: 'organization' as const, orgId: ORG_A };
const NAMES = [{ id: ORG_A, name: 'Alpha' }, { id: ORG_B, name: 'Bravo' }];

const summaryOf = (r: { summary?: unknown }) => r.summary as MrrRenewalsSummary;
/** The bound values of every `<column> = $n` in a compiled statement. */
const boundTo = (c: Call, column: string): unknown[] =>
  [...c.sql.matchAll(new RegExp(`${column.replace('.', '\\.')} = \\$(\\d+)`, 'g'))].map((m) => c.params[Number(m[1]) - 1]);
const NOW = new Date('2026-06-15T12:00:00.000Z');

describe('mrrRenewalsConfigSchema', () => {
  it('config refuses asOf and period with the run-time message', () => {
    for (const key of ['asOf', 'period']) {
      const r = mrrRenewalsConfigSchema.safeParse({ [key]: key === 'asOf' ? '2026-01-01' : { kind: 'last_full_month' } });
      expect(r.success, key).toBe(false);
      expect(JSON.stringify(r.error?.issues), key).toContain(`${key} is not supported for mrr_renewals; it is measured at run time`);
    }
    expect(mrrRenewalsConfigSchema.safeParse({ asOf: null, period: undefined }).success).toBe(true);
  });

  it('accepts only the known groupBy and horizon values, with no defaults', () => {
    expect(mrrRenewalsConfigSchema.parse({})).toEqual({});
    expect(mrrRenewalsConfigSchema.safeParse({ groupBy: 'contract', renewalHorizonDays: 180 }).success).toBe(true);
    expect(mrrRenewalsConfigSchema.safeParse({ renewalHorizonDays: 45 }).success).toBe(false);
    expect(mrrRenewalsConfigSchema.safeParse({ groupBy: 'currency' }).success).toBe(false);
  });
});

describe('generateMrrRenewalsReport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    ctx.current = undefined;
    ctx.timeZone = 'UTC';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses a stored period or asOf before any query', async () => {
    resolved();
    respond();
    await expect(generateMrrRenewalsReport(orgScope, { period: { kind: 'last_full_month' } }, orgAuthority)).rejects.toThrow(/measured at run time/);
    expect(resolveContractMrrRows).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('resolves rows at partner scope with the org allowlist, partner id, paused and draft', async () => {
    resolved();
    respond({ org_names: NAMES });
    await generateMrrRenewalsReport(partnerScope(), {}, partnerAuthority);
    expect(resolveContractMrrRows).toHaveBeenCalledWith([ORG_A, ORG_B], NOW, { include: ['paused', 'draft'], partnerId: PARTNER });
    // Every statement binds the allowlist; the partner-axis tables also bind partner_id.
    expect(call('org_names').params).toEqual(expect.arrayContaining([ORG_A, ORG_B, PARTNER]));
    expect(call('billed_recurring').params).toEqual(expect.arrayContaining([ORG_A, ORG_B, PARTNER]));
    // …and the partner id is bound to the partner column, not merely present somewhere.
    expect(boundTo(call('org_names'), 'o.partner_id')).toEqual([PARTNER]);
    // In the outer WHERE and in every copy of the CTE's invoice sub-select — each bound to the partner.
    const billedPartner = boundTo(call('billed_recurring'), 'i.partner_id');
    expect(billedPartner.length).toBeGreaterThanOrEqual(2);
    expect(new Set(billedPartner)).toEqual(new Set([PARTNER]));
  });

  it('the renewal-notice read is fenced by the org allowlist as well as the contract ids', async () => {
    resolved({ rows: [row({ endDate: '2026-07-01' })] });
    respond({ org_names: [NAMES[0]] });
    await generateMrrRenewalsReport(orgScope, {}, orgAuthority);
    expect(call('renewal_notices').sql).toMatch(/n\.org_id = ANY\(ARRAY\[\$\d+::uuid\]\)/);
  });

  it('org scope reads one org and binds no partner id', async () => {
    resolved();
    respond({ org_names: [NAMES[0]] });
    const s = summaryOf(await generateMrrRenewalsReport(orgScope, {}, orgAuthority));
    expect(resolveContractMrrRows).toHaveBeenCalledWith([ORG_A], NOW, { include: ['paused', 'draft'], partnerId: undefined });
    expect(call('billed_recurring').params).toContain(ORG_A);
    expect(call('billed_recurring').params).not.toContain(PARTNER);
    expect(call('billed_recurring').sql).not.toContain('partner_id =');
    expect(s.scope).toEqual({ kind: 'organization', orgId: ORG_A, orgName: 'Alpha' });
  });

  it('annual advance contract mid-term is in MRR; after end_date it is not (T8)', async () => {
    // The resolver owns the in-term rule (contractMrr.test.ts); the generator
    // must count a billed_final_term row in MRR and in finalTermMrr.
    resolved({ rows: [row({ contractId: 'annual', status: 'expired', basis: 'billed_final_term', intervalMonths: 12, baseMonthly: '100.00', overageMonthly: null, mrr: '100.00', endDate: '2027-01-01' })] });
    respond({ org_names: [NAMES[0]] });
    const s = summaryOf(await generateMrrRenewalsReport(orgScope, {}, orgAuthority));
    expect(s.byCurrency).toEqual([expect.objectContaining({
      currencyCode: 'USD', mrr: '100.00', baseMrr: '100.00', overageMrr: '0.00', finalTermMrr: '100.00', arr: '1200.00', contractCount: 1,
    })]);
    expect(s.notes).toContain(FINAL_TERM_NOTE);

    resolved({ activeNotInTerm: [{ contractId: 'annual', orgId: ORG_A, name: 'Managed services', startDate: '2026-01-01', endDate: '2026-06-01', reason: 'ended_awaiting_expiry' }] });
    const after = summaryOf(await generateMrrRenewalsReport(orgScope, {}, orgAuthority));
    expect(after.byCurrency).toEqual([]);
    expect(after.activeNotInTerm).toEqual([{ contractId: 'annual', contractName: 'Managed services', orgName: 'Alpha', reason: 'ended_awaiting_expiry', startDate: '2026-01-01', endDate: '2026-06-01' }]);
  });

  it('paused and draft are reported beside MRR, never in it', async () => {
    resolved({ rows: [
      row({ contractId: 'live', mrr: '100.00', baseMonthly: '100.00' }),
      row({ contractId: 'paused', status: 'paused', basis: 'paused', mrr: '40.00', baseMonthly: '40.00' }),
      row({ contractId: 'draft', status: 'draft', basis: 'draft', mrr: '25.00', baseMonthly: '25.00', endDate: '2026-07-01' }),
    ] });
    respond({ org_names: [NAMES[0]] });
    const s = summaryOf(await generateMrrRenewalsReport(orgScope, {}, orgAuthority));
    expect(s.byCurrency).toEqual([expect.objectContaining({
      currencyCode: 'USD', mrr: '100.00', arr: '1200.00', contractCount: 1,
      pausedMrr: '40.00', pausedCount: 1, pendingActivationMrr: '25.00', pendingActivationCount: 1,
    })]);
    // A draft ending inside the horizon is not a renewal.
    expect(s.renewals.contractIds).toEqual([]);
    expect(s.rows.map((r) => [r.contractId, r.basis])).toEqual(expect.arrayContaining([['paused', 'paused'], ['draft', 'draft']]));
  });

  it('skipped contracts are listed and the exclusion note printed (T3)', async () => {
    resolved({ rows: [row()], skipped: [
      { contractId: 'broken', orgId: ORG_A, name: 'Broken', status: 'active', reason: 'group_evaluation_failed' },
      { contractId: 'voided', orgId: ORG_A, name: 'Voided', status: 'expired', reason: 'final_term_invoice_voided' },
    ] });
    respond({ org_names: [NAMES[0]] });
    const s = summaryOf(await generateMrrRenewalsReport(orgScope, {}, orgAuthority));
    expect(s.skipped).toEqual([
      { contractId: 'broken', contractName: 'Broken', orgName: 'Alpha', reason: 'group_evaluation_failed' },
      { contractId: 'voided', contractName: 'Voided', orgName: 'Alpha', reason: 'final_term_invoice_voided' },
    ]);
    expect(s.notes).toContain(excludedContractsNote(2));
    expect(excludedContractsNote(2)).toContain('2 contracts');

    resolved({ rows: [row()] });
    const clean = summaryOf(await generateMrrRenewalsReport(orgScope, {}, orgAuthority));
    expect(clean.notes.some((n) => n.startsWith('MRR excludes'))).toBe(false);
  });

  it('renewal window is [asOf, asOf+horizon) and splits auto vs manual', async () => {
    resolved({ rows: [
      row({ contractId: 'auto', name: 'Auto', autoRenew: true, renewalTermMonths: 12, endDate: '2026-07-01', mrr: '50.00', baseMonthly: '50.00' }),
      row({ contractId: 'manual', name: 'Manual', endDate: '2026-06-20', mrr: '30.00', baseMonthly: '30.00' }),
      row({ contractId: 'edge', name: 'Edge', endDate: '2026-07-15', mrr: '10.00', baseMonthly: '10.00' }), // asOf + 30 → outside
      row({ contractId: 'far', name: 'Far', endDate: '2026-12-31', mrr: '10.00', baseMonthly: '10.00' }),
      row({ contractId: 'open', name: 'Open', endDate: null, mrr: '10.00', baseMonthly: '10.00' }),
    ] });
    respond({ org_names: [NAMES[0]] });
    const s = summaryOf(await generateMrrRenewalsReport(orgScope, { renewalHorizonDays: 30 }, orgAuthority));
    expect(s.renewalHorizonDays).toBe(30);
    expect(s.renewals.contractIds).toEqual(['manual', 'auto']); // end_date ascending
    expect(s.renewals.totals).toEqual([{ currencyCode: 'USD', autoRenewMrr: '50.00', autoRenewCount: 1, manualMrr: '30.00', manualCount: 1 }]);
    const byId = new Map(s.rows.map((r) => [r.contractId, r]));
    expect(byId.get('manual')).toMatchObject({ inRenewalWindow: true, daysRemaining: 5 });
    expect(byId.get('edge')).toMatchObject({ inRenewalWindow: false, daysRemaining: 30 });
    expect(byId.get('open')).toMatchObject({ inRenewalWindow: false, daysRemaining: null });
    expect(s.byCurrency[0]).toMatchObject({ evergreenMrr: '10.00', evergreenCount: 1 });
  });

  it('horizon defaults to 90 days and groupBy to organization', async () => {
    resolved({ rows: [row({ endDate: '2026-09-12' }), row({ contractId: 'c2', endDate: '2026-09-13' })] });
    respond({ org_names: [NAMES[0]] });
    const s = summaryOf(await generateMrrRenewalsReport(orgScope, {}, orgAuthority));
    expect(s.renewalHorizonDays).toBe(90);
    expect(s.groupBy).toBe('organization');
    expect(s.renewals.contractIds).toEqual(['c1']); // 2026-06-15 + 90 = 2026-09-13, exclusive
  });

  it("advance notice is matched on the contract's own end_date", async () => {
    resolved({ rows: [
      row({ contractId: 'c1', endDate: '2026-07-01' }),
      row({ contractId: 'c2', endDate: '2026-07-10' }),
    ] });
    respond({
      org_names: [NAMES[0]],
      renewal_notices: [
        { contract_id: 'c1', end_date: '2026-07-01', sent_at: '2026-06-01T09:00:00.000Z' },
        { contract_id: 'c2', end_date: '2025-07-10', sent_at: '2025-06-01T09:00:00.000Z' }, // a previous term's notice
      ],
    });
    const s = summaryOf(await generateMrrRenewalsReport(orgScope, {}, orgAuthority));
    const byId = new Map(s.rows.map((r) => [r.contractId, r]));
    expect(byId.get('c1')!.advanceNoticeSentAt).toBe('2026-06-01T09:00:00.000Z');
    expect(byId.get('c2')!.advanceNoticeSentAt).toBeNull();
    const notices = call('renewal_notices');
    expect(notices.params).toEqual(expect.arrayContaining(['c1', 'c2', ORG_A]));
    expect(notices.sql).toContain("kind = 'advance'");
  });

  it('runs no notice query when no contract is in the renewal window', async () => {
    resolved({ rows: [row()] });
    respond({ org_names: [NAMES[0]] });
    await generateMrrRenewalsReport(orgScope, {}, orgAuthority);
    expect(calls.map((c) => c.name)).not.toContain('renewal_notices');
  });

  it('annual period invoice spreads over 12 months; interactive invoice lands in its issue month; spread sums to line_total exactly', async () => {
    resolved();
    respond({
      org_names: [NAMES[0]],
      billed_recurring: [
        // 1000.00 over 12 months from 2025-09: 83.33 × 11 + 83.37 in the last month (2026-08, outside the window end? no — inside).
        { line_total: '1000.00', currency_code: 'USD', issue_date: '2025-08-25', period_start: '2025-09-01', period_end: '2026-09-01' },
        { line_total: '45.50', currency_code: 'USD', issue_date: '2026-03-10', period_start: null, period_end: null },
      ],
    });
    const s = summaryOf(await generateMrrRenewalsReport(orgScope, {}, orgAuthority));
    expect(s.billedRecurring.map((m) => m.month)).toEqual([
      '2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12',
      '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06',
    ]);
    const amount = (month: string) => s.billedRecurring.find((m) => m.month === month)!.amount;
    expect(amount('2025-08')).toBe('0.00');
    expect(amount('2025-09')).toBe('83.33');
    expect(amount('2026-03')).toBe('128.83'); // 83.33 + 45.50
    expect(amount('2026-06')).toBe('83.33');
    expect(s.billedRecurring.filter((m) => m.partial).map((m) => m.month)).toEqual(['2026-06']);
    // The spread is exact: the two months after the window hold the rest (83.33 + 83.37).
    const inWindow = s.billedRecurring.reduce((t, m) => t + Math.round(Number(m.amount) * 100), 0);
    expect(inWindow).toBe(100000 - 8333 - 8337 + 4550);
    expect(s.notes).toContain(BILLED_SERIES_NOTE);
  });

  it('a JPY annual invoice spreads in whole yen', async () => {
    resolved();
    respond({ org_names: [NAMES[0]], billed_recurring: [
      { line_total: '1000.00', currency_code: 'JPY', issue_date: '2026-01-01', period_start: '2026-01-01', period_end: '2027-01-01' },
    ] });
    const s = summaryOf(await generateMrrRenewalsReport(orgScope, {}, orgAuthority));
    const jpy = s.billedRecurring.filter((m) => m.currencyCode === 'JPY');
    expect(jpy.find((m) => m.month === '2026-01')!.amount).toBe('83.00');
    for (const m of jpy) expect(Number(m.amount) % 1).toBe(0);
  });

  it('block-overage contract line is excluded from billed recurring', async () => {
    resolved();
    respond({ org_names: [NAMES[0]] });
    await generateMrrRenewalsReport(orgScope, {}, orgAuthority);
    const billed = call('billed_recurring');
    expect(billed.sql).toContain('block_overage_lines');
    expect(billed.sql).toMatch(/il\.id NOT IN \(SELECT line_id FROM block_overage_lines\)/);
    expect(billed.sql).toContain("il.source_type = 'contract'");
    expect(billed.sql).toContain('il.parent_line_id IS NULL');
    // Window start − 60 months (the longest contract interval) and the end of the run month.
    expect(billed.params).toEqual(expect.arrayContaining(['2020-07-01', '2026-07-01']));
    // Only issued invoices count; draft and void never do.
    expect(billed.sql).toContain("i.status IN ('sent', 'partially_paid', 'overdue', 'paid')");
    // A reissued invoice takes its billing period through the void → reissue chain.
    expect(billed.sql).toMatch(/p\.invoice_id IN \(SELECT ancestor_id FROM block_overage_chain WHERE invoice_id = i\.id\)/);
  });

  it('USD and EUR contracts in one org produce two currency rows', async () => {
    resolved({ rows: [
      row({ contractId: 'usd', mrr: '100.00', baseMonthly: '90.00', overageMonthly: '10.00' }),
      row({ contractId: 'eur', currencyCode: 'EUR', mrr: '80.00', baseMonthly: '80.00' }),
    ] });
    respond({ org_names: [NAMES[0]] });
    const s = summaryOf(await generateMrrRenewalsReport(orgScope, {}, orgAuthority));
    expect(s.byCurrency.map((c) => [c.currencyCode, c.mrr, c.baseMrr, c.overageMrr])).toEqual([
      ['EUR', '80.00', '80.00', '0.00'], ['USD', '100.00', '90.00', '10.00'],
    ]);
    expect(s.groups.map((g) => [g.groupKey, g.groupLabel, g.currencyCode, g.mrr])).toEqual([
      [ORG_A, 'Alpha', 'EUR', '80.00'], [ORG_A, 'Alpha', 'USD', '100.00'],
    ]);
  });

  it('groups by contract when asked', async () => {
    resolved({ rows: [row({ contractId: 'c2', name: 'Zeta' }), row({ contractId: 'c1', name: 'Alpha plan' })] });
    respond({ org_names: [NAMES[0]] });
    const s = summaryOf(await generateMrrRenewalsReport(orgScope, { groupBy: 'contract' }, orgAuthority));
    expect(s.groups.map((g) => [g.groupKey, g.groupLabel])).toEqual([['c1', 'Alpha plan'], ['c2', 'Zeta']]);
  });

  it('sums per-row rounded figures exactly (no float drift)', async () => {
    resolved({ rows: Array.from({ length: 10 }, (_, i) => row({ contractId: `c${i}`, mrr: '0.10', baseMonthly: '0.10' })) });
    respond({ org_names: [NAMES[0]] });
    const s = summaryOf(await generateMrrRenewalsReport(orgScope, {}, orgAuthority));
    expect(s.byCurrency[0]).toMatchObject({ mrr: '1.00', arr: '12.00' });
  });

  it('asOf is the UTC date even when the owner timezone is ahead', async () => {
    vi.setSystemTime(new Date('2026-08-31T22:00:00.000Z'));
    ctx.timeZone = 'Pacific/Auckland'; // already 2026-09-01 there
    resolved();
    respond({ org_names: [NAMES[0]] });
    const s = summaryOf(await generateMrrRenewalsReport(orgScope, {}, orgAuthority));
    expect(s.asOf).toBe('2026-08-31');
    expect(s.timeZone).toBe('Pacific/Auckland');
    // The billed series' run month is the owner's month.
    expect(s.billedRecurring).toEqual([]);
    expect(call('billed_recurring').params).toEqual(expect.arrayContaining(['2020-10-01', '2026-10-01']));
    expect(s.notes).toContain(AS_OF_RUN_TIME_NOTE);
  });

  it('prints the run-time, live-quantity, billed-series and history notes; partner scope adds the org-list notes', async () => {
    resolved();
    respond({ org_names: NAMES });
    const p = summaryOf(await generateMrrRenewalsReport(partnerScope(), {}, partnerAuthority));
    for (const note of [AS_OF_RUN_TIME_NOTE, LIVE_QUANTITIES_NOTE, BILLED_SERIES_NOTE, HISTORY_STARTS_NOTE, PARTNER_ORG_LIST_NOTE, SUSPENDED_ORGS_MRR_NOTE]) {
      expect(p.notes).toContain(note);
    }
    const o = summaryOf(await generateMrrRenewalsReport(orgScope, {}, orgAuthority));
    expect(o.notes).not.toContain(PARTNER_ORG_LIST_NOTE);
    expect(o.notes).not.toContain(SUSPENDED_ORGS_MRR_NOTE);
  });

  it('site-restricted → SITE_RESTRICTED_NOTE, nothing queried', async () => {
    resolved();
    respond();
    const s = summaryOf(await generateMrrRenewalsReport(orgScope, {}, restrictedAuthority));
    expect(s.notes).toEqual([SITE_RESTRICTED_NOTE]);
    expect(s.asOf).toBe('2026-06-15');
    expect(s.byCurrency).toEqual([]);
    expect(resolveContractMrrRows).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('no orgs → NO_ORGS_NOTE', async () => {
    resolved();
    respond();
    const s = summaryOf(await generateMrrRenewalsReport(partnerScope([]), {}, partnerAuthority));
    expect(s.notes[0]).toBe(NO_ORGS_NOTE);
    expect(resolveContractMrrRows).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalled();
    expect(s.scope).toEqual({ kind: 'partner', partnerId: PARTNER, orgCount: 0 });
  });

  it('detail cap truncates rows, not totals', async () => {
    resolved({ rows: Array.from({ length: 5001 }, (_, i) => row({ contractId: `c${String(i).padStart(5, '0')}`, name: `C${String(i).padStart(5, '0')}`, mrr: '1.00', baseMonthly: '1.00' })) });
    respond({ org_names: [NAMES[0]] });
    const s = summaryOf(await generateMrrRenewalsReport(orgScope, {}, orgAuthority));
    expect(s.rows).toHaveLength(5000);
    expect(s.detail).toEqual({ cap: 5000, stored: 5000, available: 5001, truncated: true });
    expect(s.byCurrency[0]).toMatchObject({ mrr: '5001.00', contractCount: 5001 });
  });

  it('detail rows carry org names and sort by org, then contract', async () => {
    resolved({ rows: [
      row({ contractId: 'b2', orgId: ORG_B, name: 'Zulu' }),
      row({ contractId: 'a2', orgId: ORG_A, name: 'Yankee' }),
      row({ contractId: 'a1', orgId: ORG_A, name: 'Xray' }),
    ] });
    respond({ org_names: NAMES });
    const s = summaryOf(await generateMrrRenewalsReport(partnerScope(), {}, partnerAuthority));
    expect(s.rows.map((r) => [r.orgName, r.contractName])).toEqual([['Alpha', 'Xray'], ['Alpha', 'Yankee'], ['Bravo', 'Zulu']]);
    expect(s.rows[0]).toEqual({
      contractId: 'a1', contractName: 'Xray', orgId: ORG_A, orgName: 'Alpha', status: 'active', basis: 'active',
      intervalMonths: 1, currencyCode: 'USD', baseMonthly: '100.00', overageMonthly: '0.00', mrr: '100.00',
      startDate: '2026-01-01', endDate: null, daysRemaining: null, autoRenew: false, renewalTermMonths: null,
      inRenewalWindow: false, advanceNoticeSentAt: null,
    });
  });

  it('a deleted device group is disclosed in the notes, singular and plural; absent otherwise', async () => {
    respond({ org_names: [NAMES[0]] });
    resolved({ rows: [row({ unresolvedGroup: true })] });
    expect(summaryOf(await generateMrrRenewalsReport(orgScope, {}, orgAuthority)).notes).toContain(deletedGroupNote(1));
    resolved({ rows: [row({ unresolvedGroup: true }), row({ contractId: 'c2', unresolvedGroup: true })] });
    expect(summaryOf(await generateMrrRenewalsReport(orgScope, {}, orgAuthority)).notes).toContain(deletedGroupNote(2));
    expect(deletedGroupNote(2)).toContain('2 contracts bill');
    resolved({ rows: [row()] });
    const clean = summaryOf(await generateMrrRenewalsReport(orgScope, {}, orgAuthority));
    expect(clean.notes.some((n) => n.includes('deleted device group'))).toBe(false);
  });

  it('an unusable owner timezone falls back to UTC and says so', async () => {
    ctx.timeZone = 'Not/AZone';
    resolved();
    respond({ org_names: [NAMES[0]] });
    const s = summaryOf(await generateMrrRenewalsReport(orgScope, {}, orgAuthority));
    expect(s.timeZone).toBe('UTC');
    expect(s.notes.some((n) => n.includes('Not/AZone') && n.includes('UTC'))).toBe(true);
  });

  it('an org missing from the name lookup keeps its own group, labelled with its id, and is disclosed', async () => {
    resolved({ rows: [row({ orgId: ORG_A }), row({ contractId: 'c2', orgId: ORG_B })] });
    respond({ org_names: [] });
    const s = summaryOf(await generateMrrRenewalsReport(partnerScope(), {}, partnerAuthority));
    expect(s.groups.map((g) => g.groupLabel)).toEqual([
      `Unknown organization (${ORG_A.slice(0, 8)})`, `Unknown organization (${ORG_B.slice(0, 8)})`,
    ]);
    expect(s.notes).toContain(UNKNOWN_ORG_NOTE);
  });

  it('records whether anything was measured: a real run yes; restricted and no-orgs no', async () => {
    resolved();
    respond({ org_names: [NAMES[0]] });
    expect(summaryOf(await generateMrrRenewalsReport(orgScope, {}, orgAuthority)).measured).toBe(true);
    expect(summaryOf(await generateMrrRenewalsReport(orgScope, {}, restrictedAuthority)).measured).toBe(false);
    expect(summaryOf(await generateMrrRenewalsReport(partnerScope([]), {}, partnerAuthority)).measured).toBe(false);
  });

  it.each([
    // [label, line, expected amounts by month (only the listed months are checked), sum of all window months]
    ['sub-month period lands whole in its start month', { line_total: '30.00', period_start: '2026-03-01', period_end: '2026-03-15' }, { '2026-03': '30.00', '2026-04': '0.00' }, 3000],
    ['a credit spreads with the right sign and sums exactly', { line_total: '-100.00', period_start: '2026-01-01', period_end: '2026-04-01' }, { '2026-01': '-33.33', '2026-02': '-33.33', '2026-03': '-33.34' }, -10000],
    ['a quarter straddling the window start keeps only its in-window months', { line_total: '300.00', period_start: '2025-06-01', period_end: '2025-09-01' }, { '2025-07': '100.00', '2025-08': '100.00' }, 20000],
    ['a period starting after the run month lands nothing', { line_total: '500.00', period_start: '2026-07-01', period_end: '2026-08-01' }, {}, 0],
    ['a 24-month prepay issued 18 months back still spreads into the window', { line_total: '2400.00', period_start: '2024-12-01', period_end: '2026-12-01' }, { '2025-07': '100.00', '2026-06': '100.00' }, 120000],
  ] as const)('billed spread: %s', async (_label, line, expected, windowSum) => {
    resolved();
    respond({ org_names: [NAMES[0]], billed_recurring: [{ currency_code: 'USD', issue_date: '2024-12-01', ...line }] });
    const s = summaryOf(await generateMrrRenewalsReport(orgScope, {}, orgAuthority));
    const amount = (month: string) => s.billedRecurring.find((m) => m.month === month)?.amount;
    for (const [month, value] of Object.entries(expected)) expect(amount(month), month).toBe(value);
    expect(s.billedRecurring.reduce((t, m) => t + Math.round(Number(m.amount) * 100), 0)).toBe(windowSum);
  });
});
