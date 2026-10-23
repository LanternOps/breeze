/**
 * #9828 W2 — quote lineage queries against REAL Postgres (T5 / T5b, spec §3.3).
 * Proofs: decline → revise → accept is ONE won lineage; a stale `sent` quote
 * past its expiry is expired at read time; a draft revision leaves the sent
 * parent's outcome standing; a never-sent lineage is excluded; the cohort is by
 * FIRST sent_at; a two-quote cycle is counted as `unreachable = 2` and the
 * query still returns; the walk never leaves the caller's orgs or partner.
 */
import './setup';

import { describe, expect, it } from 'vitest';

import { db, withSystemDbAccessContext } from '../../db';
import { quotes } from '../../db/schema';
import { eq } from 'drizzle-orm';
import {
  lineageByCurrencyQuery,
  lineageCte,
  lineageDetailQuery,
  lineageDiagnosticsQuery,
  lineageOverallQuery,
} from '../../services/businessReports/quoteWinRateQueries';
import { createOrganization, createPartner } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(Boolean(process.env.DATABASE_URL));

const PERIOD_START = new Date('2026-08-01T00:00:00.000Z');
const PERIOD_END = new Date('2026-09-01T00:00:00.000Z');
const AS_OF = '2026-09-15';

type Row = Record<string, unknown>;
const rowsOf = (r: unknown): Row[] => ((r as { rows?: Row[] }).rows ?? (r as Row[]));

async function seedQuote(o: {
  partnerId: string; orgId: string; status: 'draft' | 'sent' | 'viewed' | 'accepted' | 'declined' | 'expired' | 'converted' | 'superseded';
  number: string; sentAt?: string | null; revisionOf?: string | null; revisionNumber?: number;
  expiryDate?: string | null; oneTime?: string; monthly?: string; annual?: string; currency?: string;
  viewedAt?: string | null; acceptedAt?: string | null; declinedAt?: string | null;
}): Promise<string> {
  const [q] = await getTestDb().insert(quotes).values({
    partnerId: o.partnerId, orgId: o.orgId, status: o.status, quoteNumber: o.number,
    currencyCode: o.currency ?? 'USD',
    sentAt: o.sentAt === undefined ? null : (o.sentAt ? new Date(o.sentAt) : null),
    firstViewedAt: o.viewedAt ? new Date(o.viewedAt) : null,
    acceptedAt: o.acceptedAt ? new Date(o.acceptedAt) : null,
    declinedAt: o.declinedAt ? new Date(o.declinedAt) : null,
    revisionOfQuoteId: o.revisionOf ?? null, revisionNumber: o.revisionNumber ?? 1,
    expiryDate: o.expiryDate ?? null,
    oneTimeTotal: o.oneTime ?? '0', monthlyRecurringTotal: o.monthly ?? '0', annualRecurringTotal: o.annual ?? '0',
  }).returning({ id: quotes.id });
  return q!.id;
}

async function seedWorld() {
  const partner = await createPartner({});
  const acme = await createOrganization({ partnerId: partner.id, name: 'Acme' });
  const globex = await createOrganization({ partnerId: partner.id, name: 'Globex' });
  const otherPartner = await createPartner({});
  const foreign = await createOrganization({ partnerId: otherPartner.id, name: 'Initech' });
  return { partner, acme, globex, otherPartner, foreign };
}

type World = Awaited<ReturnType<typeof seedWorld>>;
const partnerArgs = (w: World, orgIds?: string[]) => ({
  partnerId: w.partner.id, orgIds: orgIds ?? [w.acme.id, w.globex.id], periodStart: PERIOD_START, periodEnd: PERIOD_END,
});
const cteOf = (w: World, orgIds?: string[]) => lineageCte({ ...partnerArgs(w, orgIds), asOfUtcDate: AS_OF });
const run = async (q: ReturnType<typeof lineageDetailQuery>) => rowsOf(await withSystemDbAccessContext(() => db.execute(q)));

describe('quote lineage queries — real Postgres (#9828 W2)', () => {
  runDb('T5: decline → revise → accept is ONE won lineage; the draft revision beside a sent parent leaves the parent standing', async () => {
    const w = await seedWorld();
    const v1 = await seedQuote({ partnerId: w.partner.id, orgId: w.acme.id, number: 'Q-1', status: 'declined', sentAt: '2026-08-02T10:00:00Z', declinedAt: '2026-08-05T10:00:00Z', oneTime: '500' });
    const v2 = await seedQuote({ partnerId: w.partner.id, orgId: w.acme.id, number: 'Q-1-R2', status: 'accepted', sentAt: '2026-08-06T10:00:00Z', acceptedAt: '2026-08-10T10:00:00Z', revisionOf: v1, revisionNumber: 2, oneTime: '450', monthly: '30', annual: '120' });
    // Separate lineage: a sent parent with a DRAFT revision on top.
    const p1 = await seedQuote({ partnerId: w.partner.id, orgId: w.acme.id, number: 'Q-2', status: 'sent', sentAt: '2026-08-03T10:00:00Z', expiryDate: '2026-12-31', oneTime: '100' });
    await seedQuote({ partnerId: w.partner.id, orgId: w.acme.id, number: 'Q-2-R2', status: 'draft', revisionOf: p1, revisionNumber: 2, oneTime: '999' });

    const rows = await run(lineageDetailQuery(cteOf(w), 100));
    expect(rows).toHaveLength(2);
    const q1 = rows.find((r) => r.quote_number === 'Q-1-R2')!;
    expect(q1).toMatchObject({ outcome: 'won', versions: 2, root_quote_id: v1, terminal_quote_id: v2 });
    expect(Number(q1.one_time_total)).toBe(450);
    expect(Number(q1.monthly_recurring_value)).toBe(40); // 30 + 120/12
    expect(q1.first_sent_at).toBe('2026-08-02T10:00:00.000Z');
    expect(q1.outcome_at).toBe('2026-08-10T10:00:00.000Z');
    const q2 = rows.find((r) => r.quote_number === 'Q-2')!;
    expect(q2).toMatchObject({ outcome: 'open', versions: 2, terminal_quote_id: p1 });
    expect(Number(q2.one_time_total)).toBe(100); // the draft's 999 never counts
  });

  runDb('T5b: a stale sent quote past its expiry_date is expired at read time; one still in date is open', async () => {
    const w = await seedWorld();
    await seedQuote({ partnerId: w.partner.id, orgId: w.acme.id, number: 'Q-stale', status: 'sent', sentAt: '2026-08-02T10:00:00Z', expiryDate: '2026-09-10' });
    await seedQuote({ partnerId: w.partner.id, orgId: w.acme.id, number: 'Q-fresh', status: 'viewed', sentAt: '2026-08-02T11:00:00Z', expiryDate: '2026-09-15' });
    const rows = await run(lineageDetailQuery(cteOf(w), 100));
    expect(Object.fromEntries(rows.map((r) => [r.quote_number, r.outcome]))).toEqual({ 'Q-stale': 'expired', 'Q-fresh': 'open' });
    expect(rows.find((r) => r.quote_number === 'Q-stale')!.outcome_at).toBe('2026-09-10T00:00:00.000Z');
    const [counts] = rowsOf(await withSystemDbAccessContext(() => db.execute(lineageOverallQuery(cteOf(w)))));
    expect(counts).toMatchObject({ lineages: 2, won: 0, lost: 0, expired: 1, open: 1, anomalies: 0 });
  });

  runDb('never-sent lineages drop out and the cohort is selected by FIRST sent_at, not the terminal version\'s', async () => {
    const w = await seedWorld();
    await seedQuote({ partnerId: w.partner.id, orgId: w.acme.id, number: 'Q-draft', status: 'draft' });
    // First sent in July (outside), terminal version sent in August: NOT in the August cohort.
    const a = await seedQuote({ partnerId: w.partner.id, orgId: w.acme.id, number: 'Q-old', status: 'declined', sentAt: '2026-07-20T10:00:00Z', declinedAt: '2026-07-25T10:00:00Z' });
    await seedQuote({ partnerId: w.partner.id, orgId: w.acme.id, number: 'Q-old-R2', status: 'accepted', sentAt: '2026-08-05T10:00:00Z', acceptedAt: '2026-08-06T10:00:00Z', revisionOf: a, revisionNumber: 2 });
    // First sent in August: in.
    await seedQuote({ partnerId: w.partner.id, orgId: w.acme.id, number: 'Q-in', status: 'declined', sentAt: '2026-08-31T23:59:59Z', declinedAt: '2026-09-02T10:00:00Z' });
    const rows = await run(lineageDetailQuery(cteOf(w), 100));
    expect(rows.map((r) => r.quote_number)).toEqual(['Q-in']);
  });

  runDb('a terminal superseded version is reported as an anomaly and excluded from lineages and money', async () => {
    const w = await seedWorld();
    await seedQuote({ partnerId: w.partner.id, orgId: w.acme.id, number: 'Q-anom', status: 'superseded', sentAt: '2026-08-02T10:00:00Z', oneTime: '777' });
    await seedQuote({ partnerId: w.partner.id, orgId: w.acme.id, number: 'Q-won', status: 'converted', sentAt: '2026-08-02T10:00:00Z', acceptedAt: '2026-08-04T10:00:00Z', oneTime: '10' });
    const [counts] = rowsOf(await withSystemDbAccessContext(() => db.execute(lineageOverallQuery(cteOf(w)))));
    expect(counts).toMatchObject({ lineages: 1, won: 1, anomalies: 1 });
    const money = rowsOf(await withSystemDbAccessContext(() => db.execute(lineageByCurrencyQuery(cteOf(w)))));
    expect(money).toHaveLength(1);
    expect(Number(money[0]!.quoted_one_time)).toBe(10);
    expect((await run(lineageDetailQuery(cteOf(w), 100))).find((r) => r.quote_number === 'Q-anom')).toMatchObject({ outcome: 'anomaly' });
  });

  runDb('a two-quote cycle has no root: unreachable = 2 and every statement still returns', async () => {
    const w = await seedWorld();
    const a = await seedQuote({ partnerId: w.partner.id, orgId: w.acme.id, number: 'Q-cyc-A', status: 'sent', sentAt: '2026-08-02T10:00:00Z', expiryDate: '2026-12-31' });
    const b = await seedQuote({ partnerId: w.partner.id, orgId: w.acme.id, number: 'Q-cyc-B', status: 'sent', sentAt: '2026-08-03T10:00:00Z', expiryDate: '2026-12-31', revisionOf: a, revisionNumber: 2 });
    await getTestDb().update(quotes).set({ revisionOfQuoteId: b, revisionNumber: 3 }).where(eq(quotes.id, a));

    // A foreign partner's sent quote must not leak into the diagnostics count.
    await seedQuote({ partnerId: w.otherPartner.id, orgId: w.foreign.id, number: 'Q-foreign-sent', status: 'sent', sentAt: '2026-08-04T10:00:00Z', expiryDate: '2026-12-31', revisionOf: null });
    const [diag] = rowsOf(await withSystemDbAccessContext(() => db.execute(lineageDiagnosticsQuery(partnerArgs(w)))));
    expect(diag).toMatchObject({ unreachable: 2, depth_capped: 0 });
    // A sibling org outside the allowlist is not counted either.
    const [narrow] = rowsOf(await withSystemDbAccessContext(() => db.execute(lineageDiagnosticsQuery(partnerArgs(w, [w.globex.id])))));
    expect(narrow).toMatchObject({ unreachable: 0, depth_capped: 0 });
    expect(await run(lineageDetailQuery(cteOf(w), 100))).toEqual([]);
  });

  runDb('depth guard: a 50-version chain is fully walked, a 51st version is counted as depth_capped', async () => {
    const w = await seedWorld();
    let prev = await seedQuote({ partnerId: w.partner.id, orgId: w.acme.id, number: 'Q-d1', status: 'sent', sentAt: '2026-08-02T10:00:00Z', expiryDate: '2026-12-31' });
    for (let i = 2; i <= 50; i += 1) {
      prev = await seedQuote({ partnerId: w.partner.id, orgId: w.acme.id, number: `Q-d${i}`, status: 'sent', sentAt: '2026-08-02T10:00:00Z', expiryDate: '2026-12-31', revisionOf: prev, revisionNumber: i });
    }
    const [at50] = rowsOf(await withSystemDbAccessContext(() => db.execute(lineageDiagnosticsQuery(partnerArgs(w)))));
    expect(at50).toMatchObject({ unreachable: 0, depth_capped: 0 });
    await seedQuote({ partnerId: w.partner.id, orgId: w.acme.id, number: 'Q-d51', status: 'sent', sentAt: '2026-08-02T10:00:00Z', expiryDate: '2026-12-31', revisionOf: prev, revisionNumber: 51 });
    const [at51] = rowsOf(await withSystemDbAccessContext(() => db.execute(lineageDiagnosticsQuery(partnerArgs(w)))));
    expect(at51).toMatchObject({ unreachable: 1, depth_capped: 1 });
  });

  runDb('a superseded v1 followed by an accepted v2 is one won lineage, not an anomaly', async () => {
    const w = await seedWorld();
    const v1 = await seedQuote({ partnerId: w.partner.id, orgId: w.acme.id, number: 'Q-s1', status: 'superseded', sentAt: '2026-08-02T10:00:00Z' });
    await seedQuote({ partnerId: w.partner.id, orgId: w.acme.id, number: 'Q-s1-R2', status: 'accepted', sentAt: '2026-08-03T10:00:00Z', acceptedAt: '2026-08-05T10:00:00Z', revisionOf: v1, revisionNumber: 2 });
    const [counts] = rowsOf(await withSystemDbAccessContext(() => db.execute(lineageOverallQuery(cteOf(w)))));
    expect(counts).toMatchObject({ lineages: 1, won: 1, anomalies: 0 });
  });

  runDb('the walk never leaves the caller\'s orgs or partner: allowlist narrows to one org, a foreign partner is invisible', async () => {
    const w = await seedWorld();
    await seedQuote({ partnerId: w.partner.id, orgId: w.acme.id, number: 'Q-acme', status: 'declined', sentAt: '2026-08-02T10:00:00Z', declinedAt: '2026-08-03T10:00:00Z' });
    await seedQuote({ partnerId: w.partner.id, orgId: w.globex.id, number: 'Q-globex', status: 'declined', sentAt: '2026-08-02T10:00:00Z', declinedAt: '2026-08-03T10:00:00Z' });
    await seedQuote({ partnerId: w.otherPartner.id, orgId: w.foreign.id, number: 'Q-foreign', status: 'accepted', sentAt: '2026-08-02T10:00:00Z', acceptedAt: '2026-08-03T10:00:00Z', oneTime: '999' });

    expect((await run(lineageDetailQuery(cteOf(w), 100))).map((r) => r.quote_number).sort()).toEqual(['Q-acme', 'Q-globex']);
    expect((await run(lineageDetailQuery(cteOf(w, [w.acme.id]), 100))).map((r) => r.quote_number)).toEqual(['Q-acme']);
    // Poisoned allowlist: the foreign org id is named, but the partner predicate still fences it.
    const poisoned = await run(lineageDetailQuery(cteOf(w, [w.acme.id, w.foreign.id]), 100));
    expect(poisoned.map((r) => r.quote_number)).toEqual(['Q-acme']);
  });
});
