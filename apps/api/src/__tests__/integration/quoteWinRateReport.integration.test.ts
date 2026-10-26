/**
 * #9828 W2 — quote_win_rate against REAL Postgres as the forced-RLS
 * `breeze_app` role. Proofs: partner scope sees both of its orgs and never a
 * foreign partner's (explicit predicate AND RLS); org scope sees one org; the
 * decided-only headline, per-currency money and author grouping on real rows;
 * the explicit predicate fences with no RLS; request-context vs system-context
 * PARITY.
 */
import './setup';

import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { QuoteWinRateSummary } from '@breeze/shared';
import { withDbAccessContext, type DbAccessContext } from '../../db';
import { quotes } from '../../db/schema';
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
const NOW = new Date('2026-09-15T12:00:00.000Z');

type Fixture = Awaited<ReturnType<typeof seedFixture>>;

async function seedQuote(o: {
  partnerId: string; orgId: string; createdBy?: string; number: string;
  status: 'draft' | 'sent' | 'viewed' | 'accepted' | 'declined' | 'expired' | 'converted' | 'superseded';
  sentAt?: string; expiryDate?: string; currency?: string; oneTime?: string; monthly?: string; annual?: string;
  acceptedAt?: string; declinedAt?: string; viewedAt?: string;
}): Promise<string> {
  const [q] = await getTestDb().insert(quotes).values({
    partnerId: o.partnerId, orgId: o.orgId, createdBy: o.createdBy ?? null, quoteNumber: o.number, status: o.status,
    currencyCode: o.currency ?? 'USD',
    sentAt: o.sentAt ? new Date(o.sentAt) : null,
    firstViewedAt: o.viewedAt ? new Date(o.viewedAt) : null,
    acceptedAt: o.acceptedAt ? new Date(o.acceptedAt) : null,
    declinedAt: o.declinedAt ? new Date(o.declinedAt) : null,
    expiryDate: o.expiryDate ?? null,
    oneTimeTotal: o.oneTime ?? '0', monthlyRecurringTotal: o.monthly ?? '0', annualRecurringTotal: o.annual ?? '0',
  }).returning({ id: quotes.id });
  return q!.id;
}

async function seedFixture() {
  const partner = await createPartner({});
  const acme = await createOrganization({ partnerId: partner.id, name: 'Acme' });
  const globex = await createOrganization({ partnerId: partner.id, name: 'Globex', currencyCode: 'EUR' });
  const otherPartner = await createPartner({});
  const foreignOrg = await createOrganization({ partnerId: otherPartner.id, name: 'Initech' });

  const user = await createUser({ partnerId: partner.id, name: 'Dana Tech', email: `qwr-report-${randomUUID()}@example.com` });
  const role = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(role.id, [
    { resource: 'reports', action: 'read' },
    { resource: 'quotes', action: 'read' },
  ]);
  await assignUserToPartner(user.id, partner.id, role.id, 'all');

  const p = partner.id;
  // Acme: one won (decline → revise → accept), one lost, one open (draft revision beside it), USD.
  const w1 = await seedQuote({ partnerId: p, orgId: acme.id, createdBy: user.id, number: 'A-1', status: 'declined', sentAt: '2026-08-02T10:00:00Z', declinedAt: '2026-08-04T10:00:00Z', oneTime: '500' });
  await getTestDb().insert(quotes).values({
    partnerId: p, orgId: acme.id, createdBy: user.id, quoteNumber: 'A-1-R2', status: 'accepted', currencyCode: 'USD',
    sentAt: new Date('2026-08-05T10:00:00Z'), acceptedAt: new Date('2026-08-12T10:00:00Z'), firstViewedAt: new Date('2026-08-06T10:00:00Z'),
    revisionOfQuoteId: w1, revisionNumber: 2, oneTimeTotal: '400', monthlyRecurringTotal: '30', annualRecurringTotal: '120',
  });
  await seedQuote({ partnerId: p, orgId: acme.id, createdBy: user.id, number: 'A-2', status: 'declined', sentAt: '2026-08-03T10:00:00Z', declinedAt: '2026-08-05T10:00:00Z', viewedAt: '2026-08-03T12:00:00Z', oneTime: '600' });
  await seedQuote({ partnerId: p, orgId: acme.id, createdBy: user.id, number: 'A-3', status: 'sent', sentAt: '2026-08-20T10:00:00Z', expiryDate: '2026-12-31', oneTime: '100' });
  // Globex (EUR): one expired by read-time rule (sent, past expiry).
  await seedQuote({ partnerId: p, orgId: globex.id, number: 'G-1', status: 'sent', sentAt: '2026-08-10T10:00:00Z', expiryDate: '2026-09-01', currency: 'EUR', oneTime: '250' });
  // Outside the period (July) — must not count.
  await seedQuote({ partnerId: p, orgId: acme.id, createdBy: user.id, number: 'A-old', status: 'accepted', sentAt: '2026-07-10T10:00:00Z', acceptedAt: '2026-07-12T10:00:00Z', oneTime: '9999' });
  // Foreign partner, accepted in August.
  await seedQuote({ partnerId: otherPartner.id, orgId: foreignOrg.id, number: 'F-1', status: 'accepted', sentAt: '2026-08-02T10:00:00Z', acceptedAt: '2026-08-03T10:00:00Z', oneTime: '777777' });

  return { partner, acme, globex, otherPartner, foreignOrg, user };
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
  return generateReport('quote_win_rate', scope, config, authority);
}

const summaryOf = (r: ReportResult) => r.summary as unknown as QuoteWinRateSummary;
const withoutGeneratedAt = (result: ReportResult): unknown => {
  const summary = { ...(result.summary ?? {}) } as Record<string, unknown>;
  delete summary.generatedAt;
  return { rows: result.rows, rowCount: result.rowCount, summary };
};

describe('quote_win_rate — real Postgres (#9828 W2)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  runDb('partner scope sees both orgs and not the foreign partner\'s; decided-only headline with the open count beside it', async () => {
    const f = await seedFixture();
    const s = summaryOf(await runPartner(f));
    expect(s.scope).toEqual({ kind: 'partner', partnerId: f.partner.id, orgCount: 2 });
    expect(s.groupBy).toBe('organization');
    // Lineages: A-1(+R2) won, A-2 lost, A-3 open, G-1 expired (read-time).
    expect(s.overall).toMatchObject({ lineages: 4, won: 1, lost: 1, expired: 1, open: 1, anomalies: 0, viewed: 2 });
    expect(s.overall.winRate).toBeCloseTo(1 / 3, 10);
    expect(s.overall.closeRate).toBeCloseTo(1 / 4, 10);
    expect(s.groups.map((g) => [g.groupLabel, g.lineages]).sort()).toEqual([['Acme', 3], ['Globex', 1]]);
    // The foreign partner's sent quote is not counted in the diagnostics either.
    expect(s.diagnostics).toEqual({ unreachable: 0, depthCapped: 0 });
    // Won A-1 first sent 8/02 10:00, accepted 8/12 10:00 = 10 days; lost A-2 8/03 -> 8/05 = 2 days.
    expect(s.overall.medianDaysToWin).toBe(10);
    expect(s.overall.medianDaysToLoss).toBe(2);
    const everything = JSON.stringify(s);
    expect(everything).not.toContain('Initech');
    expect(everything).not.toContain(f.foreignOrg.id);
    expect(everything).not.toContain('777777');
    expect(everything).not.toContain('9999');
  });

  runDb('money is per currency, from the terminal version, and never summed across currencies', async () => {
    const f = await seedFixture();
    const s = summaryOf(await runPartner(f));
    const byCur = Object.fromEntries(s.overall.money.map((m) => [m.currencyCode, m]));
    expect(Object.keys(byCur).sort()).toEqual(['EUR', 'USD']);
    // USD: won A-1-R2 (400 one-time, 30 + 120/12 = 40 monthly); lost A-2 600; open A-3 100.
    expect(byCur.USD).toMatchObject({ quotedOneTime: '1100.00', wonOneTime: '400.00', quotedMonthlyRecurring: '40.00', wonMonthlyRecurring: '40.00' });
    // decided = won + lost = (400 + 40) + (600 + 0)
    expect(byCur.USD!.valueWinRate).toBeCloseTo(440 / 1040, 10);
    expect(byCur.EUR).toMatchObject({ quotedOneTime: '250.00', wonOneTime: '0.00', valueWinRate: 0 });
  });

  runDb('detail rows are lineages: the revision pair is one row with 2 versions, and author is the root\'s creator', async () => {
    const f = await seedFixture();
    const s = summaryOf(await runPartner(f, { groupBy: 'author' }));
    const won = s.rows.find((r) => r.quoteNumber === 'A-1-R2')!;
    expect(won).toMatchObject({ versions: 2, outcome: 'won', orgName: 'Acme', authorName: 'Dana Tech' });
    expect(s.rows.filter((r) => r.quoteNumber?.startsWith('A-1'))).toHaveLength(1);
    expect(s.rows.find((r) => r.quoteNumber === 'G-1')).toMatchObject({ outcome: 'expired', authorName: 'Unknown user' });
    expect(s.groups.map((g) => [g.groupLabel, g.lineages]).sort()).toEqual([['Dana Tech', 3], ['Unknown user', 1]]);
  });

  runDb('org scope sees one org and defaults to author grouping', async () => {
    const f = await seedFixture();
    const s = await withDbAccessContext(await partnerRequestContext(f), async () =>
      summaryOf(await generateReport('quote_win_rate', organizationScope(f.globex.id), {}, orgAuthority(f.globex.id, f.user.id))));
    expect(s.scope).toEqual({ kind: 'organization', orgId: f.globex.id, orgName: 'Globex' });
    expect(s.groupBy).toBe('author');
    expect(s.overall).toMatchObject({ lineages: 1, expired: 1 });
    expect(s.rows.every((r) => r.orgId === f.globex.id)).toBe(true);
    expect(JSON.stringify(s)).not.toContain('Acme');
  });

  runDb('the explicit predicate fences with no RLS: a partner scope naming one org never sees its sibling', async () => {
    const f = await seedFixture();
    const authority = await livePartnerAuthority(f);
    const s = summaryOf(await generateReport('quote_win_rate', { kind: 'partner', partnerId: f.partner.id, orgIds: [f.acme.id] }, {}, authority));
    expect(s.overall.lineages).toBe(3);
    expect(JSON.stringify(s)).not.toContain('Globex');
  });

  runDb('PARITY: a partner-scope RLS request context and the system context produce identical reports', async () => {
    const f = await seedFixture();
    const authority = await livePartnerAuthority(f);
    const scope = await reportScopeFromAuthority({ partnerId: f.partner.id }, authority);
    const viaRequest = await withDbAccessContext(await partnerRequestContext(f), () => generateReport('quote_win_rate', scope, {}, authority));
    const viaSystem = await generateReport('quote_win_rate', scope, {}, authority);
    expect(withoutGeneratedAt(viaRequest)).toEqual(withoutGeneratedAt(viaSystem));
  });
});
