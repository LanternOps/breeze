/**
 * #9828 W3 — client_profitability against REAL Postgres as the forced-RLS
 * `breeze_app` role, through `generateReport` (registry dispatch). Proofs:
 * partner scope sees both of its orgs and never a foreign partner's; org scope
 * sees one org and its invoices as detail rows; internal (no-organization)
 * time prints once at partner scope; the worked labor-estimate fixture holds
 * on real rows; request-context vs system-context parity.
 */
import './setup';

import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClientProfitabilitySummary } from '@breeze/shared';
import { withDbAccessContext, type DbAccessContext } from '../../db';
import { invoiceLines, invoices, timeEntries } from '../../db/schema';
import { buildDbAccessContext, computeAccessibleOrgIds } from '../../middleware/auth';
import { generateReport, type ReportResult } from '../../services/reportGenerationService';
import { organizationScope, reportScopeFromAuthority } from '../../services/reportScope';
import {
  resolveLivePartnerReportAuthority,
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
const NOW = new Date('2026-09-10T12:00:00.000Z');
const AUGUST = { period: { kind: 'custom', start: '2026-08-01', end: '2026-08-31' } };
let seq = 0;

async function seedInvoice(o: { partnerId: string; orgId: string; currencyCode?: string; status?: 'sent' | 'paid' | 'draft'; issueDate: string; lines: Array<{ sourceType: string; quantity: string; unitPrice: string; costBasis: string | null }> }) {
  const [inv] = await getTestDb().insert(invoices).values({
    partnerId: o.partnerId, orgId: o.orgId, currencyCode: o.currencyCode ?? 'USD', status: o.status ?? 'paid',
    issueDate: o.issueDate, invoiceNumber: `CPR-${Date.now()}-${++seq}`,
  } as never).returning({ id: invoices.id });
  for (const l of o.lines) {
    await getTestDb().insert(invoiceLines).values({
      invoiceId: inv!.id, orgId: o.orgId, sourceType: l.sourceType, description: l.sourceType,
      quantity: l.quantity, unitPrice: l.unitPrice, costBasis: l.costBasis,
      lineTotal: (Number(l.quantity) * Number(l.unitPrice)).toFixed(2), taxable: false, sortOrder: ++seq,
    } as never);
  }
  return inv!.id;
}

async function seedEntry(o: { partnerId: string; orgId: string | null; userId: string; startedAt: string; minutes: number; coverage: 'billable' | 'included' | 'non_billable'; currencyCode?: string | null }) {
  const start = new Date(o.startedAt);
  await getTestDb().insert(timeEntries).values({
    partnerId: o.partnerId, orgId: o.orgId, userId: o.userId, description: 'Work', isBillable: o.coverage === 'billable',
    startedAt: start, endedAt: new Date(start.getTime() + o.minutes * 60_000), durationMinutes: o.minutes, coverage: o.coverage,
    currencyCode: o.currencyCode === undefined ? (o.orgId ? 'USD' : null) : o.currencyCode,
  } as never);
}

async function seedFixture() {
  const partner = await createPartner({});
  const acme = await createOrganization({ partnerId: partner.id, name: 'Acme' });
  const globex = await createOrganization({ partnerId: partner.id, name: 'Globex' });
  const otherPartner = await createPartner({});
  const foreignOrg = await createOrganization({ partnerId: otherPartner.id, name: 'Initech' });

  const user = await createUser({ partnerId: partner.id, name: 'Dana Tech', email: `profitability-${randomUUID()}@example.com` });
  const role = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(role.id, [
    { resource: 'reports', action: 'read' },
    { resource: 'invoices', action: 'read' },
    { resource: 'time_entries', action: 'read' },
  ]);
  await assignUserToPartner(user.id, partner.id, role.id, 'all');
  const foreignUser = await createUser({ partnerId: otherPartner.id, name: 'Other Tech', email: `profitability-other-${randomUUID()}@example.com` });

  // Acme: the worked fixture — recurring 1000.00 with no cost + a product 500.00 at cost 300.00; 10 h.
  await seedInvoice({ partnerId: partner.id, orgId: acme.id, issueDate: '2026-08-05', lines: [
    { sourceType: 'contract', quantity: '1.00', unitPrice: '1000.00', costBasis: null },
    { sourceType: 'catalog', quantity: '1.00', unitPrice: '500.00', costBasis: '300.00' },
  ] });
  await seedEntry({ partnerId: partner.id, orgId: acme.id, userId: user.id, startedAt: '2026-08-10T15:00:00Z', minutes: 300, coverage: 'billable' });
  await seedEntry({ partnerId: partner.id, orgId: acme.id, userId: user.id, startedAt: '2026-08-11T15:00:00Z', minutes: 240, coverage: 'included' });
  await seedEntry({ partnerId: partner.id, orgId: acme.id, userId: user.id, startedAt: '2026-08-12T15:00:00Z', minutes: 60, coverage: 'non_billable' });
  // Globex: labor only.
  await seedInvoice({ partnerId: partner.id, orgId: globex.id, issueDate: '2026-08-20', lines: [
    { sourceType: 'time_entry', quantity: '2.00', unitPrice: '100.00', costBasis: null },
  ] });
  await seedEntry({ partnerId: partner.id, orgId: globex.id, userId: user.id, startedAt: '2026-08-21T15:00:00Z', minutes: 120, coverage: 'billable' });
  // Internal time: no organization.
  await seedEntry({ partnerId: partner.id, orgId: null, userId: user.id, startedAt: '2026-08-22T15:00:00Z', minutes: 90, coverage: 'non_billable' });
  // A draft that must not count.
  await seedInvoice({ partnerId: partner.id, orgId: acme.id, status: 'draft', issueDate: '2026-08-06', lines: [
    { sourceType: 'catalog', quantity: '1.00', unitPrice: '999.00', costBasis: '1.00' },
  ] });
  // The foreign partner: never visible.
  await seedInvoice({ partnerId: otherPartner.id, orgId: foreignOrg.id, issueDate: '2026-08-07', lines: [
    { sourceType: 'catalog', quantity: '1.00', unitPrice: '7777.00', costBasis: '1.00' },
  ] });
  await seedEntry({ partnerId: otherPartner.id, orgId: foreignOrg.id, userId: foreignUser.id, startedAt: '2026-08-08T15:00:00Z', minutes: 600, coverage: 'billable' });
  await seedEntry({ partnerId: otherPartner.id, orgId: null, userId: foreignUser.id, startedAt: '2026-08-08T15:00:00Z', minutes: 45, coverage: 'non_billable' });

  return { partner, acme, globex, otherPartner, foreignOrg, user };
}
type Fixture = Awaited<ReturnType<typeof seedFixture>>;

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

async function runPartner(f: Fixture, config: Record<string, unknown> = AUGUST): Promise<ReportResult> {
  const authority = await livePartnerAuthority(f);
  const scope = await reportScopeFromAuthority({ partnerId: f.partner.id }, authority);
  return generateReport('client_profitability', scope, config, authority);
}

const summaryOf = (r: ReportResult) => r.summary as unknown as ClientProfitabilitySummary;
const withoutGeneratedAt = (result: ReportResult): unknown => {
  const summary = { ...(result.summary ?? {}) } as Record<string, unknown>;
  delete summary.generatedAt;
  return { rows: result.rows, rowCount: result.rowCount, summary };
};

describe('client_profitability — real Postgres (#9828 W3)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  runDb('partner scope sees both orgs and not the foreign partner\'s; internal hours print once', async () => {
    const f = await seedFixture();
    const s = summaryOf(await runPartner(f, { ...AUGUST, laborCostPerHour: { amount: '45.00', currencyCode: 'USD' } }));

    expect(s.scope).toEqual({ kind: 'partner', partnerId: f.partner.id, orgCount: 2 });
    expect(s.orgs.map((o) => o.orgName)).toEqual(['Acme', 'Globex']);
    expect(s.orgs.some((o) => o.orgId === f.foreignOrg.id)).toBe(false);
    expect(s.byCurrency.map((c) => [c.currencyCode, c.revenue, c.cost])).toEqual([['USD', '1700.00', '300.00']]);

    const acme = s.orgs.find((o) => o.orgId === f.acme.id)!;
    expect(acme.hoursAttribution).toBe('single_currency');
    expect(acme.hours).toEqual({ total: 10, billable: 5, included: 4, nonBillable: 1 });
    expect(acme.money[0]).toMatchObject({
      grossMargin: '200.00', estimatedLaborCost: '450.00', estimatedContributionAfterLabor: '750.00', nullCostRecurringRevenue: '1000.00',
    });

    // Internal time: this partner's 90 minutes, once — never the foreign partner's 45.
    expect(s.unattributedHours).toEqual({ total: 1.5, billable: 0, included: 0, nonBillable: 1.5 });
    expect(s.rows.filter((r) => r.orgId === null)).toHaveLength(1);
    expect(JSON.stringify(s)).not.toContain('7777');
  });

  runDb('org scope sees one org; invoices are the detail rows; no internal-time row', async () => {
    const f = await seedFixture();
    const result = await generateReport('client_profitability', organizationScope(f.acme.id), AUGUST, orgAuthority(f.acme.id, f.user.id));
    const s = summaryOf(result);
    expect(s.scope).toEqual({ kind: 'organization', orgId: f.acme.id, orgName: 'Acme' });
    expect(s.orgs.map((o) => o.orgId)).toEqual([f.acme.id]);
    expect(s.unattributedHours).toBeNull();
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]).toMatchObject({ orgId: f.acme.id, revenue: '1500.00', cost: '300.00', recurringRevenue: '1000.00', productRevenue: '500.00', hoursTotal: null });
    expect(s.rows[0]!.invoiceId).toBeTruthy();
  });

  runDb('request-context parity: the partner request context produces the same summary as the system context', async () => {
    const f = await seedFixture();
    const system = await runPartner(f);
    const ctx = await partnerRequestContext(f);
    const request = await withDbAccessContext(ctx, () => runPartner(f));
    expect(withoutGeneratedAt(request)).toEqual(withoutGeneratedAt(system));
  });
});
