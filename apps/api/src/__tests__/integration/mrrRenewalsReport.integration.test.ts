/**
 * #9828 W1 — mrr_renewals against REAL Postgres as the forced-RLS `breeze_app`
 * role. Proofs: partner scope sees both of its orgs and never a foreign
 * partner's (explicit predicate AND RLS); org scope sees one org; an annual
 * advance contract flipped to `expired` by its only invoice stays in MRR mid
 * term (T8 on real billing state) and its issued invoice spreads over the
 * billed-recurring months; request-context vs system-context PARITY; the
 * schedule baseline path hands the second run the first run's byCurrency.
 */
import './setup';

import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/contractEvents', () => ({ emitContractEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import type { MrrRenewalsSummary } from '@breeze/shared';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { contractBillingPeriods, contractLines, contractRenewalNotices, contracts, invoices, reportRuns, reports } from '../../db/schema';
import { buildDbAccessContext, computeAccessibleOrgIds } from '../../middleware/auth';
import { generateDueInvoice } from '../../services/contractService';
import { issueInvoice, voidInvoice } from '../../services/invoiceService';
import { generateReport, previousBaselineFor, type ReportResult } from '../../services/reportGenerationService';
import { organizationScope, reportScopeFromAuthority } from '../../services/reportScope';
import {
  persistedSystemSiteScopeValues,
  resolveLivePartnerReportAuthority,
  systemReportAuthority,
  type ReportExecutionAuthority,
  type UserReportExecutionAuthority,
} from '../../services/siteScope';
import {
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(Boolean(process.env.DATABASE_URL));
const NOW = new Date('2026-06-15T12:00:00.000Z');

type Fixture = Awaited<ReturnType<typeof seedFixture>>;

async function seedContract(o: {
  partnerId: string; orgId: string; name: string; currencyCode?: string; status?: 'active' | 'paused' | 'draft';
  intervalMonths?: number; startDate?: string; endDate?: string | null; nextBillingAt?: string | null;
  unitPrice: string; autoRenew?: boolean;
}): Promise<string> {
  const [c] = await getTestDb().insert(contracts).values({
    partnerId: o.partnerId, orgId: o.orgId, name: o.name, status: o.status ?? 'active',
    intervalMonths: o.intervalMonths ?? 1, billingTiming: 'advance',
    startDate: o.startDate ?? '2026-01-01', endDate: o.endDate ?? null,
    nextBillingAt: o.nextBillingAt === undefined ? '2026-07-01' : o.nextBillingAt,
    currencyCode: o.currencyCode ?? 'USD', autoRenew: o.autoRenew ?? false,
  }).returning({ id: contracts.id });
  await getTestDb().insert(contractLines).values({
    contractId: c!.id, orgId: o.orgId, lineType: 'flat', description: 'Managed services', unitPrice: o.unitPrice, taxable: false,
  });
  return c!.id;
}

async function seedFixture() {
  const partner = await createPartner({});
  const acme = await createOrganization({ partnerId: partner.id, name: 'Acme' });
  const globex = await createOrganization({ partnerId: partner.id, name: 'Globex', currencyCode: 'EUR' });
  const otherPartner = await createPartner({});
  const foreignOrg = await createOrganization({ partnerId: otherPartner.id, name: 'Initech' });

  const user = await createUser({ partnerId: partner.id, name: 'Dana Tech', email: `mrr-report-${randomUUID()}@example.com` });
  const role = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(role.id, [
    { resource: 'reports', action: 'read' },
    { resource: 'contracts', action: 'read' },
  ]);
  await assignUserToPartner(user.id, partner.id, role.id, 'all');

  const acmeMonthly = await seedContract({ partnerId: partner.id, orgId: acme.id, name: 'Acme monthly', unitPrice: '100.00', endDate: '2026-07-10', autoRenew: true });
  const globexMonthly = await seedContract({ partnerId: partner.id, orgId: globex.id, name: 'Globex monthly', currencyCode: 'EUR', unitPrice: '50.00' });
  const globexPaused = await seedContract({ partnerId: partner.id, orgId: globex.id, name: 'Globex paused', currencyCode: 'EUR', status: 'paused', unitPrice: '20.00' });
  const foreign = await seedContract({ partnerId: otherPartner.id, orgId: foreignOrg.id, name: 'Initech monthly', unitPrice: '999.00' });
  // Annual, billed in advance: its only invoice flips it to `expired` (T8).
  const acmeAnnual = await seedContract({
    partnerId: partner.id, orgId: acme.id, name: 'Acme annual', intervalMonths: 12,
    startDate: '2026-01-01', endDate: '2027-01-01', nextBillingAt: '2026-01-01', unitPrice: '1200.00',
  });

  return { partner, acme, globex, otherPartner, foreignOrg, user, acmeMonthly, globexMonthly, globexPaused, foreign, acmeAnnual };
}

/** Bill the annual contract's only period (→ expired) and issue the invoice. */
async function billAnnual(f: Fixture): Promise<void> {
  const r = await withSystemDbAccessContext(() => generateDueInvoice(f.acmeAnnual, new Date('2026-01-01T06:00:00Z')));
  expect(r.generated).toBe(true);
  await withSystemDbAccessContext(() => issueInvoice(r.invoiceId!, { userId: f.user.id, partnerId: f.partner.id, accessibleOrgIds: [f.acme.id] }));
  const [c] = await withSystemDbAccessContext(() => db.select({ status: contracts.status }).from(contracts).where(eq(contracts.id, f.acmeAnnual)));
  expect(c!.status).toBe('expired');
}

async function livePartnerAuthority(f: Fixture): Promise<UserReportExecutionAuthority> {
  const result = await resolveLivePartnerReportAuthority(f.user.id, f.partner.id, 'read');
  if (!result.ok) throw new Error(`partner authority refused: ${result.reason}`);
  return result.authority;
}

async function partnerRequestContext(f: Fixture): Promise<DbAccessContext> {
  const { orgIds } = await computeAccessibleOrgIds('partner', f.partner.id, null, f.user.id);
  return buildDbAccessContext({ scope: 'partner', orgId: null, accessibleOrgIds: orgIds, partnerId: f.partner.id, userId: f.user.id });
}

function orgAuthority(orgId: string, userId: string): ReportExecutionAuthority {
  return { principalKind: 'user', principalUserId: userId, scope: { version: 1, kind: 'unrestricted', orgId }, capturedAt: new Date(), fingerprint: 'f'.repeat(64) };
}

async function runPartner(f: Fixture, config: Record<string, unknown> = {}): Promise<ReportResult> {
  const authority = await livePartnerAuthority(f);
  const scope = await reportScopeFromAuthority({ partnerId: f.partner.id }, authority);
  return generateReport('mrr_renewals', scope, config, authority);
}

const summaryOf = (r: ReportResult) => r.summary as unknown as MrrRenewalsSummary;
const withoutGeneratedAt = (result: ReportResult): unknown => {
  const summary = { ...(result.summary ?? {}) } as Record<string, unknown>;
  delete summary.generatedAt;
  return { rows: result.rows, rowCount: result.rowCount, summary };
};

describe('mrr_renewals — real Postgres (#9828 W1)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  runDb('partner scope sees both orgs and not the foreign partner\'s; paused sits beside MRR', async () => {
    const f = await seedFixture();
    await billAnnual(f);

    const s = summaryOf(await runPartner(f));
    expect(s.asOf).toBe('2026-06-15');
    expect(s.scope).toEqual({ kind: 'partner', partnerId: f.partner.id, orgCount: 2 });
    expect(s.byCurrency.map((c) => [c.currencyCode, c.mrr, c.contractCount, c.pausedMrr, c.pausedCount])).toEqual([
      ['EUR', '50.00', 1, '20.00', 1],
      ['USD', '200.00', 2, '0.00', 0],
    ]);
    expect(s.groups.map((g) => [g.groupLabel, g.currencyCode, g.mrr])).toEqual([
      ['Acme', 'USD', '200.00'], ['Globex', 'EUR', '50.00'],
    ]);
    const everything = JSON.stringify(s);
    expect(everything).not.toContain('Initech');
    expect(everything).not.toContain(f.foreignOrg.id);
    expect(everything).not.toContain('999.00');
  });

  runDb('an annual-advance contract flipped to expired mid-term is in MRR (T8) and its invoice spreads over the billed months', async () => {
    const f = await seedFixture();
    await billAnnual(f);

    const s = summaryOf(await runPartner(f));
    const annual = s.rows.find((r) => r.contractId === f.acmeAnnual)!;
    expect(annual).toMatchObject({ status: 'expired', basis: 'billed_final_term', mrr: '100.00', overageMonthly: null });
    expect(s.byCurrency.find((c) => c.currencyCode === 'USD')).toMatchObject({ finalTermMrr: '100.00' });
    const usd = s.billedRecurring.filter((m) => m.currencyCode === 'USD');
    expect(usd.map((m) => [m.month, m.amount])).toEqual([
      ['2025-07', '0.00'], ['2025-08', '0.00'], ['2025-09', '0.00'], ['2025-10', '0.00'], ['2025-11', '0.00'], ['2025-12', '0.00'],
      ['2026-01', '100.00'], ['2026-02', '100.00'], ['2026-03', '100.00'], ['2026-04', '100.00'], ['2026-05', '100.00'], ['2026-06', '100.00'],
    ]);
    expect(usd.at(-1)!.partial).toBe(true);
  });

  runDb('the renewal window lists the auto-renewing monthly contract ending inside the horizon, with the notice for THIS end date', async () => {
    const f = await seedFixture();
    await getTestDb().insert(contractRenewalNotices).values([
      { contractId: f.acmeMonthly, orgId: f.acme.id, endDate: '2026-07-10', kind: 'advance', sentAt: new Date('2026-06-01T09:00:00Z') },
      // A previous term's notice must not be read as this term's.
      { contractId: f.globexMonthly, orgId: f.globex.id, endDate: '2025-07-10', kind: 'advance', sentAt: new Date('2025-06-01T09:00:00Z') },
    ]);
    await getTestDb().update(contracts).set({ endDate: '2026-07-05' }).where(eq(contracts.id, f.globexMonthly));

    const s = summaryOf(await runPartner(f, { renewalHorizonDays: 30 }));
    expect(s.renewals.contractIds).toEqual([f.globexMonthly, f.acmeMonthly]);
    expect(s.renewals.totals).toEqual([
      { currencyCode: 'EUR', autoRenewMrr: '0.00', autoRenewCount: 0, manualMrr: '50.00', manualCount: 1 },
      { currencyCode: 'USD', autoRenewMrr: '100.00', autoRenewCount: 1, manualMrr: '0.00', manualCount: 0 },
    ]);
    const byId = new Map(s.rows.map((r) => [r.contractId, r]));
    expect(byId.get(f.acmeMonthly)!.advanceNoticeSentAt).toBe('2026-06-01T09:00:00.000Z');
    expect(byId.get(f.globexMonthly)!.advanceNoticeSentAt).toBeNull();
  });

  runDb('billed recurring: draft and foreign-partner invoices never count; a reissued annual invoice still spreads over its period', async () => {
    const f = await seedFixture();
    await billAnnual(f);
    // Reissue the annual invoice: the period row keeps pointing at the voided original.
    const [period] = await getTestDb().select({ invoiceId: contractBillingPeriods.invoiceId })
      .from(contractBillingPeriods).where(eq(contractBillingPeriods.contractId, f.acmeAnnual));
    const actor = { userId: f.user.id, partnerId: f.partner.id, accessibleOrgIds: [f.acme.id] };
    await withSystemDbAccessContext(() => voidInvoice(period!.invoiceId!, 'correction', { reissue: true }, actor));
    const [voided] = await getTestDb().select({ replacedBy: invoices.replacedByInvoiceId }).from(invoices).where(eq(invoices.id, period!.invoiceId!));
    await withSystemDbAccessContext(() => issueInvoice(voided!.replacedBy!, actor));
    // A DRAFT June invoice for Acme's monthly contract: not billed revenue.
    await getTestDb().update(contracts).set({ nextBillingAt: '2026-06-01' }).where(eq(contracts.id, f.acmeMonthly));
    const draft = await withSystemDbAccessContext(() => generateDueInvoice(f.acmeMonthly, new Date('2026-06-01T06:00:00Z')));
    expect(draft.generated).toBe(true);
    // An ISSUED May invoice in the foreign partner's org.
    await getTestDb().update(contracts).set({ nextBillingAt: '2026-05-01' }).where(eq(contracts.id, f.foreign));
    const foreign = await withSystemDbAccessContext(() => generateDueInvoice(f.foreign, new Date('2026-05-01T06:00:00Z')));
    await withSystemDbAccessContext(() => issueInvoice(foreign.invoiceId!, { userId: null, partnerId: f.otherPartner.id, accessibleOrgIds: [f.foreignOrg.id] }));

    const s = summaryOf(await runPartner(f));
    const usd = Object.fromEntries(s.billedRecurring.filter((m) => m.currencyCode === 'USD').map((m) => [m.month, m.amount]));
    expect(usd).toMatchObject({
      '2025-12': '0.00', '2026-01': '100.00', '2026-02': '100.00', '2026-03': '100.00',
      '2026-04': '100.00', '2026-05': '100.00', '2026-06': '100.00',
    });
    expect(JSON.stringify(s.billedRecurring)).not.toContain('999');
  });

  runDb('org scope sees one org', async () => {
    const f = await seedFixture();
    const s = await withDbAccessContext(await partnerRequestContext(f), async () =>
      summaryOf(await generateReport('mrr_renewals', organizationScope(f.globex.id), {}, orgAuthority(f.globex.id, f.user.id))));
    expect(s.scope).toEqual({ kind: 'organization', orgId: f.globex.id, orgName: 'Globex' });
    expect(s.rows.every((r) => r.orgId === f.globex.id)).toBe(true);
    expect(s.byCurrency.map((c) => c.currencyCode)).toEqual(['EUR']);
  });

  runDb('the explicit predicate fences with no RLS: a partner scope naming one org never sees its sibling', async () => {
    const f = await seedFixture();
    const authority = await livePartnerAuthority(f);
    const s = summaryOf(await generateReport('mrr_renewals', { kind: 'partner', partnerId: f.partner.id, orgIds: [f.acme.id] }, {}, authority));
    expect(s.rows.map((r) => r.orgName)).toEqual(['Acme', 'Acme']);
    expect(JSON.stringify(s)).not.toContain('Globex');
  });

  runDb('PARITY: a partner-scope RLS request context and the system context produce identical reports', async () => {
    const f = await seedFixture();
    await billAnnual(f);
    const authority = await livePartnerAuthority(f);
    const scope = await reportScopeFromAuthority({ partnerId: f.partner.id }, authority);
    const viaRequest = await withDbAccessContext(await partnerRequestContext(f), () => generateReport('mrr_renewals', scope, {}, authority));
    const viaSystem = await generateReport('mrr_renewals', scope, {}, authority);
    expect(withoutGeneratedAt(viaRequest)).toEqual(withoutGeneratedAt(viaSystem));
  });

  runDb('two runs: the second run\'s previous.summary.byCurrency equals the first run\'s (schedule baseline path)', async () => {
    const f = await seedFixture();
    const first = await generateReport('mrr_renewals', organizationScope(f.acme.id), {}, orgAuthority(f.acme.id, f.user.id));
    const scopeValues = persistedSystemSiteScopeValues(systemReportAuthority(f.acme.id));
    const [report] = await getTestDb().insert(reports).values({
      orgId: f.acme.id, name: 'MRR', type: 'mrr_renewals', config: {}, schedule: 'monthly', format: 'pdf',
    }).returning({ id: reports.id });
    await getTestDb().insert(reportRuns).values({
      reportId: report!.id, status: 'completed', completedAt: new Date(),
      result: { ...first, generatedAt: first.generatedAt },
      requestedByKind: 'system',
      ...scopeValues,
    });

    const fingerprint = scopeValues.executionScopeFingerprint;
    expect(fingerprint).toBeTruthy();
    const previous = await withSystemDbAccessContext(() => previousBaselineFor(report!.id, fingerprint!));
    expect((previous?.summary as unknown as MrrRenewalsSummary).byCurrency).toEqual(summaryOf(first).byCurrency);
  });
});
