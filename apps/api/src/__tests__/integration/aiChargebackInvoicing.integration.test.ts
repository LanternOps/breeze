/**
 * W10 (#7608) Task 10: AI usage charges become invoice lines under the same
 * double-bill guard as time entries and parts — assemble gathers not_billed
 * charges, issue locks them LAST in the source order and flips them billed,
 * void releases them. Plus the close-vs-issue concurrency contract: the
 * monthly close never touches an existing charge, so it never waits on (or
 * deadlocks with) an issue that holds one.
 */
import './setup';
import { afterAll, describe, expect, it, vi } from 'vitest';

// Same side-effect mocks as services/invoiceService.issue.integration.test.ts:
// lifecycle events, PDF render and accounting push/void are BullMQ producers,
// not the correctness under test.
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/accountingSyncWorker', () => ({
  enqueueAccountingInvoicePush: vi.fn().mockResolvedValue(undefined),
  enqueueAccountingInvoiceVoid: vi.fn().mockResolvedValue(undefined),
  enqueueAccountingPaymentPush: vi.fn().mockResolvedValue(true),
  enqueueAccountingPaymentDelete: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../services/accounting/accountingConnectionService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/accounting/accountingConnectionService')>()),
  resolveActiveConnectionFor: vi.fn().mockResolvedValue({ id: 'c1', provider: 'quickbooks' }),
}));
vi.mock('../../services/catalogEvents', () => ({ emitCatalogEvent: vi.fn().mockResolvedValue(undefined) }));

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { partners, organizations, users, timeEntries } from '../../db/schema';
import * as svc from '../../services/invoiceService';
import { gatherOrgAiUsageCharges } from '../../services/invoiceAssembly';
import type { InvoiceActor } from '../../services/invoiceTypes';
import { runOrgChargePeriod } from '../../services/aiChargeback/chargeRun';
import { monthPeriod } from '../../services/aiChargeback/chargePeriods';
import { closeRegistryFixtures, fixtureSql } from './aiModelRegistryFixtures';
import { seedAiCard, seedChargeableInvocation } from './aiChargebackFixtures';
import { getTestDb } from './setup';

const RUN = !!process.env.DATABASE_URL;
afterAll(closeRegistryFixtures);

const NOW = new Date('2026-12-02T06:00:00Z'); // October and November are closed

async function seed(currency = 'USD', opts: { taxRate?: string } = {}) {
  const suffix = randomUUID().slice(0, 8);
  return withSystemDbAccessContext(async () => {
    const [p] = await db.insert(partners).values({ name: `W10 ${suffix}`, slug: `w10-${suffix}`, type: 'msp', plan: 'pro', status: 'active' }).returning({ id: partners.id });
    const [o] = await db.insert(organizations).values({
      currencyCode: currency, partnerId: p!.id, name: `W10 Org ${suffix}`, slug: `w10-org-${suffix}`,
      taxRate: opts.taxRate ?? null,
    }).returning({ id: organizations.id });
    const [u] = await db.insert(users).values({ partnerId: p!.id, orgId: o!.id, email: `w10-${suffix}@example.test`, name: 'W10', status: 'active' }).returning({ id: users.id });
    return { partnerId: p!.id, orgId: o!.id, userId: u!.id };
  });
}
type F = Awaited<ReturnType<typeof seed>>;
const actor = (f: F): InvoiceActor => ({ userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] });
const ctx = (f: F): DbAccessContext => ({ scope: 'partner', orgId: null, accessibleOrgIds: [f.orgId], accessiblePartnerIds: [f.partnerId], userId: f.userId });

/** A charge row seeded directly (superuser), the shape the monthly close writes. */
async function charge(f: F, over: { status?: string; amount?: string | null; currency?: string; period?: string } = {}): Promise<string> {
  const amount = over.amount === undefined ? '41.27' : over.amount;
  const status = over.status ?? (amount === null ? 'unpriced' : 'not_billed');
  const { periodStart, periodEnd } = monthPeriod(over.period ?? '2026-11-01');
  const [row] = await fixtureSql`INSERT INTO ai_usage_charges (org_id, partner_id, run_id, period_start, period_end, usage_period_start,
    currency_code, served_model, model_label, priced, invocation_count, amount_exact, amount, billing_status)
    VALUES (${f.orgId}, ${f.partnerId}, gen_random_uuid(), ${periodStart}, ${periodEnd}, ${periodStart}, ${over.currency ?? 'USD'},
      ${'w10-test-' + randomUUID()}, 'W10 Test', ${amount !== null}, 10, ${amount}, ${amount}, ${status}) RETURNING id`;
  return String(row!.id);
}
const status = async (id: string) => (await fixtureSql`SELECT billing_status FROM ai_usage_charges WHERE id = ${id}`)[0]!.billing_status;
const assemble = (f: F, from = '2026-11-01', to = '2026-11-30') =>
  withDbAccessContext(ctx(f), () => svc.assembleDraftFromOrg({ orgId: f.orgId, from, to }, actor(f)));
const issue = (f: F, invoiceId: string) => withDbAccessContext(ctx(f), () => svc.issueInvoice(invoiceId, actor(f)));
const voidIt = (f: F, invoiceId: string, reissue = false) =>
  withDbAccessContext(ctx(f), () => svc.voidInvoice(invoiceId, 'test', { reissue }, actor(f)));
type Line = { sourceType: string; sourceId: string | null; quantity: string; unitPrice: string; lineTotal: string; taxable: boolean };
const aiLines = (draft: { lines: Line[] }) => draft.lines.filter((l) => l.sourceType === 'ai_usage');
const closeMonth = (orgId: string, periodStart: string) =>
  withSystemDbAccessContext(() => runOrgChargePeriod({ orgId, periodStart, now: NOW }));

/** A competing superuser session with one connection (no RLS). */
const openHolder = () => postgres(process.env.DATABASE_URL ?? '', { max: 1, onnotice: () => {} });

/**
 * Settle `work` while proving it never waits on a lock held by `holderPid`:
 * polls pg_blocking_pids until `work` settles and fails the moment any backend
 * is blocked by the holder. A detector, not a sleep — `work` completing is the
 * only way out on the happy path.
 */
async function settleWithoutBlockingOn<T>(holderPid: number, work: Promise<T>): Promise<T> {
  let done = false;
  const tracked = work.finally(() => { done = true; });
  tracked.catch(() => undefined);
  const deadline = Date.now() + 15_000;
  while (!done) {
    const rows = await getTestDb().execute<{ waiting: number }>(sql`
      SELECT count(*)::int AS waiting FROM pg_catalog.pg_stat_activity
      WHERE datname = current_database() AND ${holderPid}::int = ANY(pg_catalog.pg_blocking_pids(pid))`);
    if ((rows[0]?.waiting ?? 0) > 0) throw new Error(`a backend blocked on the lock held by pid ${holderPid}`);
    if (Date.now() > deadline) throw new Error('work did not settle within 15s');
    await new Promise((r) => setTimeout(r, 10));
  }
  return tracked;
}

describe.runIf(RUN)('AI usage charges on invoices (#7608)', () => {
  it('assembly turns a not_billed charge into one non-taxable ai_usage line; issue marks it billed', async () => {
    const f = await seed('USD', { taxRate: '0.10000' });
    const id = await charge(f);
    const draft = await assemble(f);
    expect(aiLines(draft)).toEqual([expect.objectContaining({
      sourceId: id, quantity: '1.00', unitPrice: '41.27', lineTotal: '41.27', taxable: false,
      description: expect.stringMatching(/^AI usage — W10 Test — 2026-11 · 10 requests · 0 tokens$/),
    })]);
    const issued = await issue(f, draft.invoice.id);
    // The org has a 10% rate; the AI line is non-taxable (decided 2026-10-02, #7598).
    expect(issued).toMatchObject({ status: 'sent', subtotal: '41.27', taxTotal: '0.00', total: '41.27' });
    expect(await status(id)).toBe('billed');
  });

  it('two drafts, one charge: second issue fails SOURCE_ALREADY_BILLED', async () => {
    const f = await seed(); const id = await charge(f);
    const a = await assemble(f); const b = await assemble(f);
    await issue(f, a.invoice.id);
    await expect(issue(f, b.invoice.id)).rejects.toMatchObject({ code: 'SOURCE_ALREADY_BILLED' });
    expect(await status(id)).toBe('billed');
  });

  it('two drafts issued SIMULTANEOUSLY over one charge: exactly one wins (lock contention on ai_usage_charges)', async () => {
    const f = await seed(); const id = await charge(f);
    const a = await assemble(f); const b = await assemble(f);
    const results = await Promise.allSettled([issue(f, a.invoice.id), issue(f, b.invoice.id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'SOURCE_ALREADY_BILLED' });
    expect(await status(id)).toBe('billed');
  }, 30_000);

  it('issue → void → re-issue: the charge sits on exactly one live invoice', async () => {
    const f = await seed(); const id = await charge(f);
    const first = await assemble(f);
    await issue(f, first.invoice.id);
    await expect(assemble(f)).rejects.toMatchObject({ code: 'NOTHING_TO_INVOICE' }); // nothing unbilled now
    await voidIt(f, first.invoice.id);
    const third = await assemble(f);
    await issue(f, third.invoice.id);
    expect(await status(id)).toBe('billed');
    const [lines] = await fixtureSql`SELECT count(*)::int AS n FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
      WHERE l.source_type = 'ai_usage' AND l.source_id = ${id} AND i.status <> 'void'`;
    expect(lines!.n).toBe(1);
  }, 30_000);

  it('void releases the charge and re-assembly picks it up', async () => {
    const f = await seed(); const id = await charge(f);
    const draft = await assemble(f);
    await issue(f, draft.invoice.id);
    await voidIt(f, draft.invoice.id);
    expect(await status(id)).toBe('not_billed');
    const again = await assemble(f);
    expect(aiLines(again).map((l) => l.sourceId)).toEqual([id]);
  });

  it('void with reissue clones the ai_usage line; issuing the clone bills the charge again', async () => {
    const f = await seed(); const id = await charge(f);
    const draft = await assemble(f);
    await issue(f, draft.invoice.id);
    const clone = await voidIt(f, draft.invoice.id, true);
    expect(await status(id)).toBe('not_billed');
    expect(aiLines(clone).map((l) => [l.sourceId, l.lineTotal])).toEqual([[id, '41.27']]);
    await issue(f, clone.invoice.id);
    expect(await status(id)).toBe('billed');
  }, 30_000);

  it('time entries and AI charges on one draft flip together at issue and release together at void', async () => {
    const f = await seed(); const id = await charge(f);
    const [te] = await withSystemDbAccessContext(() => db.insert(timeEntries).values({
      partnerId: f.partnerId, orgId: f.orgId, userId: f.userId,
      startedAt: new Date('2026-11-10T10:00:00Z'), endedAt: new Date('2026-11-10T11:00:00Z'),
      durationMinutes: 60, description: 'Work', isBillable: true, hourlyRate: '100.00',
      billingStatus: 'not_billed', isApproved: true, currencyCode: 'USD',
    }).returning({ id: timeEntries.id }));
    const teStatus = async () => (await fixtureSql`SELECT billing_status FROM time_entries WHERE id = ${te!.id}`)[0]!.billing_status;
    const draft = await assemble(f);
    expect(draft.lines.map((l: Line) => l.sourceType).sort()).toEqual(['ai_usage', 'time_entry']);
    const issued = await issue(f, draft.invoice.id);
    expect(issued.subtotal).toBe('141.27');
    expect([await status(id), await teStatus()]).toEqual(['billed', 'billed']);
    await voidIt(f, draft.invoice.id);
    expect([await status(id), await teStatus()]).toEqual(['not_billed', 'not_billed']);
  }, 30_000);

  it('unpriced and no_charge charges are never gathered', async () => {
    const f = await seed();
    await charge(f, { amount: null });
    await charge(f, { amount: '0.00', status: 'no_charge' });
    await expect(assemble(f)).rejects.toMatchObject({ code: 'NOTHING_TO_INVOICE' });
  });

  it('a billed charge is never gathered again', async () => {
    const f = await seed();
    await charge(f, { status: 'billed' });
    await expect(assemble(f)).rejects.toMatchObject({ code: 'NOTHING_TO_INVOICE' });
  });

  it('EUR charge on a USD draft is blocked, never converted', async () => {
    const f = await seed('USD');
    await charge(f, { currency: 'EUR' });
    await expect(assemble(f)).rejects.toMatchObject({
      code: 'ALL_BLOCKED_BY_CURRENCY',
      details: { blockedByCurrency: [{ currencyCode: 'EUR', count: 1, amount: '41.27' }] },
    });
  });

  it('assembly picks charges by billing period inside [from, to] (UTC dates, like time entries)', async () => {
    const f = await seed();
    const nov = await charge(f, { period: '2026-11-01' });
    const oct = await charge(f, { period: '2026-10-01' });
    const dec = await charge(f, { period: '2026-12-01' });
    const draft = await assemble(f, '2026-11-01', '2026-11-30');
    expect(aiLines(draft).map((l) => l.sourceId)).toEqual([nov]);
    // A draft flips nothing, so the November charge is still unbilled and a wider range takes all three.
    const wide = await assemble(f, '2026-10-01', '2026-12-31');
    expect(aiLines(wide).map((l) => l.sourceId).sort()).toEqual([oct, nov, dec].sort());
    const octOnly = await assemble(f, '2026-10-01', '2026-10-31');
    expect(aiLines(octOnly).map((l) => l.sourceId)).toEqual([oct]);
  });

  it('the gather runs under the caller\'s RLS: another tenant\'s context sees none of this org\'s charges', async () => {
    const f = await seed(); const id = await charge(f);
    const other = await seed();
    const from = new Date('2026-11-01T00:00:00Z'); const to = new Date('2026-11-30T23:59:59Z');
    const mine = await withDbAccessContext(ctx(f), () => gatherOrgAiUsageCharges(f.orgId, from, to, 'USD'));
    expect(mine.included.map((s) => s.sourceId)).toEqual([id]);
    const theirs = await withDbAccessContext(ctx(other), () => gatherOrgAiUsageCharges(f.orgId, from, to, 'USD'));
    expect(theirs).toEqual({ included: [], blockedByCurrency: {}, missingRate: [] });
  });

  describe('the monthly close vs an issue in flight', () => {
    /** Org with a closed October charge X on draft D, plus November ledger rows not yet closed. */
    async function closeVsIssueFixture() {
      const f = await seed();
      const card = await seedAiCard(f.partnerId);
      await seedChargeableInvocation({ orgId: f.orgId, cardId: card, createdAt: '2026-10-15T12:00:00Z', amount: '41.270000' });
      for (let i = 0; i < 3; i++) {
        await seedChargeableInvocation({ orgId: f.orgId, cardId: card, createdAt: '2026-11-0' + (i + 3) + 'T12:00:00Z', amount: '2.500000' });
      }
      expect(await closeMonth(f.orgId, '2026-10-01')).toMatchObject({ kind: 'charged', invocationCount: 1 });
      const [x] = await fixtureSql`SELECT id FROM ai_usage_charges WHERE org_id = ${f.orgId} AND period_start = '2026-10-01'`;
      const xId = String(x!.id);
      const draft = await assemble(f, '2026-10-01', '2026-10-31');
      expect(aiLines(draft).map((l) => [l.sourceId, l.lineTotal])).toEqual([[xId, '41.27']]);
      return { f, xId, draftId: draft.invoice.id as string };
    }
    async function novemberCharge(orgId: string) {
      return fixtureSql`SELECT id, billing_status, amount::text FROM ai_usage_charges WHERE org_id = ${orgId} AND period_start = '2026-11-01'`;
    }
    async function claimsVsLedger(orgId: string) {
      const [c] = await fixtureSql`SELECT count(*)::int AS n FROM ai_usage_charge_claims WHERE org_id = ${orgId}`;
      const [l] = await fixtureSql`SELECT count(*)::int AS n FROM ai_invocations WHERE org_id = ${orgId} AND chargeable`;
      const [d] = await fixtureSql`SELECT count(*)::int AS n FROM (SELECT invocation_id FROM ai_usage_charge_claims
        WHERE org_id = ${orgId} GROUP BY invocation_id HAVING count(*) > 1) dup`;
      return { claims: c!.n as number, ledger: l!.n as number, duplicated: d!.n as number };
    }

    it('(a) lock held on the charge (issue mid-flight): the close completes without waiting and creates a new not_billed charge', async () => {
      const { f, xId, draftId } = await closeVsIssueFixture();
      const holder = openHolder();
      let release!: () => void;
      const go = new Promise<void>((r) => { release = r; });
      let locked!: (pid: number) => void;
      const holding = new Promise<number>((r) => { locked = r; });
      const held = holder.begin(async (t) => {
        const [me] = await t`SELECT pg_backend_pid() AS pid`;
        // Exactly the lock issueInvoice takes on an ai_usage source row.
        await t`SELECT id FROM ai_usage_charges WHERE id = ${xId} FOR UPDATE`;
        locked(Number(me!.pid)); // readiness barrier: the row lock is held BEFORE the close starts
        await go;
      });
      const holderPid = await holding;
      try {
        const result = await settleWithoutBlockingOn(holderPid, withSystemDbAccessContext(async () => {
          // Belt and braces: a regression that waits on X fails fast (55P03) instead of hanging.
          await db.execute(sql`SET LOCAL lock_timeout = '3s'`);
          return runOrgChargePeriod({ orgId: f.orgId, periodStart: '2026-11-01', now: NOW });
        }));
        expect(result).toMatchObject({ kind: 'charged', invocationCount: 3, chargeCount: 1 });
        // The holder's transaction was still open (lock still held) when the close committed.
        const [h] = await fixtureSql`SELECT state FROM pg_stat_activity WHERE pid = ${holderPid}`;
        expect(h!.state).toBe('idle in transaction');
        expect(await novemberCharge(f.orgId)).toEqual([expect.objectContaining({ billing_status: 'not_billed', amount: '7.50' })]);
        expect(await status(xId)).toBe('not_billed'); // the close never touched X
      } finally {
        release();
        await held;
        await holder.end();
      }
      await issue(f, draftId);
      expect(await status(xId)).toBe('billed');
      const [y] = await novemberCharge(f.orgId);
      expect(y!.billing_status).toBe('not_billed');
      const nov = await assemble(f, '2026-11-01', '2026-11-30');
      expect(aiLines(nov).map((l) => [l.sourceId, l.lineTotal])).toEqual([[String(y!.id), '7.50']]);
      expect(await claimsVsLedger(f.orgId)).toEqual({ claims: 4, ledger: 4, duplicated: 0 });
    }, 30_000);

    it('(b) issue and close at the same time: both succeed, no deadlock, no double-claim', async () => {
      const { f, xId, draftId } = await closeVsIssueFixture();
      const warn = vi.spyOn(console, 'warn');
      let results: [Awaited<ReturnType<typeof issue>>, Awaited<ReturnType<typeof closeMonth>>];
      try {
        results = await Promise.all([issue(f, draftId), closeMonth(f.orgId, '2026-11-01')]);
        // issueInvoice retries a 40P01/40001 once and logs it: a silent retry
        // would hide a lock-order regression, so assert none happened.
        expect(warn.mock.calls.filter((c) => String(c[0]).includes('transient lock error'))).toEqual([]);
      } finally {
        warn.mockRestore();
      }
      expect(results[0]).toMatchObject({ status: 'sent' });
      expect(results[1]).toMatchObject({ kind: 'charged', invocationCount: 3 });
      expect(await status(xId)).toBe('billed');
      const [y] = await novemberCharge(f.orgId);
      expect(y!.billing_status).toBe('not_billed');
      const [onD] = await fixtureSql`SELECT count(*)::int AS n FROM invoice_lines WHERE invoice_id = ${draftId} AND source_id = ${y!.id}`;
      expect(onD!.n).toBe(0);
      const nov = await assemble(f, '2026-11-01', '2026-11-30');
      expect(aiLines(nov).map((l) => l.sourceId)).toEqual([String(y!.id)]);
      await issue(f, nov.invoice.id);
      expect(await status(String(y!.id))).toBe('billed');
      await expect(assemble(f, '2026-10-01', '2026-11-30')).rejects.toMatchObject({ code: 'NOTHING_TO_INVOICE' });
      expect(await claimsVsLedger(f.orgId)).toEqual({ claims: 4, ledger: 4, duplicated: 0 });
    }, 30_000);

    it('(c) a close in flight (uncommitted run, charge and claims) never blocks an issue', async () => {
      const { f, xId, draftId } = await closeVsIssueFixture();
      // The holder performs the close's writes for November and holds them
      // uncommitted: the run slot, a charge, and claims whose FK checks take
      // FOR KEY SHARE on the org row and the new charge — the locks a real close holds.
      const holder = openHolder();
      let release!: () => void;
      const go = new Promise<void>((r) => { release = r; });
      let ready!: (pid: number) => void;
      const holding = new Promise<number>((r) => { ready = r; });
      const held = holder.begin(async (t) => {
        const [me] = await t`SELECT pg_backend_pid() AS pid`;
        const [run] = await t`INSERT INTO ai_usage_charge_runs (org_id, partner_id, period_start, period_end)
          VALUES (${f.orgId}, ${f.partnerId}, '2026-11-01', '2026-12-01') RETURNING id`;
        const [ch] = await t`INSERT INTO ai_usage_charges (org_id, partner_id, run_id, period_start, period_end, usage_period_start,
          currency_code, served_model, model_label, priced, invocation_count, amount_exact, amount, billing_status)
          VALUES (${f.orgId}, ${f.partnerId}, ${run!.id}, '2026-11-01', '2026-12-01', '2026-11-01', 'USD', 'w10-test-model',
            'w10-test-model', true, 3, 7.5, 7.5, 'not_billed') RETURNING id`;
        await t`INSERT INTO ai_usage_charge_claims (invocation_id, org_id, run_id, charge_id)
          SELECT i.id, i.org_id, ${run!.id}, ${ch!.id} FROM ai_invocations i
          WHERE i.org_id = ${f.orgId} AND i.created_at >= '2026-11-01T00:00:00Z'`;
        ready(Number(me!.pid)); // readiness barrier: the close's locks are held BEFORE the issue starts
        await go;
        throw new Error('rollback'); // the in-flight close never commits
      }).catch(() => undefined);
      const holderPid = await holding;
      try {
        const issued = await settleWithoutBlockingOn(holderPid, issue(f, draftId));
        expect(issued).toMatchObject({ status: 'sent' });
        expect(await status(xId)).toBe('billed');
      } finally {
        release();
        await held;
        await holder.end();
      }
      // The rolled-back close left nothing; the real close then runs cleanly.
      expect(await novemberCharge(f.orgId)).toEqual([]);
      expect(await closeMonth(f.orgId, '2026-11-01')).toMatchObject({ kind: 'charged', invocationCount: 3 });
      expect(await claimsVsLedger(f.orgId)).toEqual({ claims: 4, ledger: 4, duplicated: 0 });
    }, 30_000);
  });
});
