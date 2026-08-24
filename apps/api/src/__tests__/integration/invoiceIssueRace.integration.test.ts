import './setup';
import { describe, it, expect, vi } from 'vitest';

// Lifecycle events + PDF render are fire-and-forget BullMQ side effects, not
// the correctness under test. Mocked so issuance doesn't open a BullMQ socket
// to the test Redis (same rationale as invoiceService.issue.integration).
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import { inArray, sql } from 'drizzle-orm';
import postgres, { type Sql } from 'postgres';
import { db, withSystemDbAccessContext, withDbAccessContext, type DbAccessContext } from '../../db';
import { partners, organizations, users, timeEntries, invoices, invoiceLines } from '../../db/schema';
import * as svc from '../../services/invoiceService';
import type { InvoiceActor } from '../../services/invoiceTypes';
import { getTestDb } from './setup';

const RUN = !!process.env.DATABASE_URL;
const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';

// ---------------------------------------------------------------------------
// Race harness (pattern: configPolicyReferenceConcurrency.integration.test.ts)
// — a dedicated admin postgres.js client pre-holds the contended row locks,
// the racers are started against the app pool, and pg_blocking_pids makes the
// interleaving deterministic before the holder releases. No sleeps.
// ---------------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function closeRaceClients(...clients: Sql[]): Promise<void> {
  const results = await Promise.allSettled(
    clients.map((client) => client.end({ timeout: 1 })),
  );
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, 'failed to close invoice-issue race client(s)');
  }
}

/**
 * Wait until at least `min` backends in this database are actively blocked on
 * a lock (pg_blocking_pids non-empty). The holder itself is idle-in-transaction
 * (never blocked), so the only backends that can match are the racers queued
 * behind it — seeing them wait makes the release deterministic.
 */
async function waitForBlockedBackends(min: number): Promise<void> {
  const admin = getTestDb();
  const deadline = Date.now() + 10_000;
  for (;;) {
    const rows = await admin.execute<{ waiting: number }>(sql`
      SELECT count(*)::int AS waiting
      FROM pg_catalog.pg_stat_activity
      WHERE datname = current_database()
        AND state = 'active'
        AND cardinality(pg_catalog.pg_blocking_pids(pid)) > 0
    `);
    if ((rows[0]?.waiting ?? 0) >= min) return;
    if (Date.now() > deadline) {
      throw new Error(`expected >= ${min} lock-blocked backends within 10s`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// ---------------------------------------------------------------------------
// Fixtures (forge recipe from invoiceService.issue.integration.test.ts, with
// currency stamped per Task 6 — no DB default remains).
// ---------------------------------------------------------------------------

interface Fixture {
  partnerId: string;
  orgId: string;
  userId: string;
  timeEntryIds: string[];
}

async function seedFixture(entryCount = 2): Promise<Fixture> {
  const suffix = Math.random().toString(36).slice(2, 10);
  return withSystemDbAccessContext(async () => {
    const [p] = await db.insert(partners).values({
      name: `Race ${suffix}`, slug: `race-${suffix}`, type: 'msp', plan: 'pro', status: 'active',
      currencyCode: 'USD'
    }).returning({ id: partners.id });
    const partnerId = p!.id;
    const [o] = await db.insert(organizations).values({
      partnerId, name: `Org ${suffix}`, slug: `race-org-${suffix}`, currencyCode: 'USD'
    }).returning({ id: organizations.id });
    const orgId = o!.id;
    const [u] = await db.insert(users).values({
      partnerId, orgId, email: `tech-${suffix}@example.test`, name: `Tech ${suffix}`, status: 'active'
    }).returning({ id: users.id });
    const userId = u!.id;
    const now = new Date();
    const timeEntryIds: string[] = [];
    for (let i = 0; i < entryCount; i += 1) {
      const [te] = await db.insert(timeEntries).values({
        partnerId, orgId, userId, startedAt: now, endedAt: now,
        durationMinutes: 60, description: 'Work', isBillable: true,
        hourlyRate: '100.00', billingStatus: 'not_billed', isApproved: true,
        currencyCode: 'USD'
      }).returning({ id: timeEntries.id });
      timeEntryIds.push(te!.id);
    }
    return { partnerId, orgId, userId, timeEntryIds };
  });
}

function actor(f: Fixture): InvoiceActor {
  return { userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] };
}
function ctx(f: Fixture): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: [f.orgId], accessiblePartnerIds: [f.partnerId], userId: f.userId };
}

/** Forge a draft whose lines reference the given time entries (customerVisible). */
async function forgeDraftReferencing(f: Fixture, timeEntryIds: string[]): Promise<string> {
  return withSystemDbAccessContext(async () => {
    const [draft] = await db.insert(invoices).values({
      partnerId: f.partnerId, orgId: f.orgId, status: 'draft', currencyCode: 'USD'
    }).returning({ id: invoices.id });
    await db.insert(invoiceLines).values(timeEntryIds.map((teId, i) => ({
      invoiceId: draft!.id, orgId: f.orgId, sourceType: 'time_entry' as const, sourceId: teId,
      catalogItemId: null, parentLineId: null, ticketId: null, description: 'Work',
      quantity: '1.00', unitPrice: '100.00', costBasis: null, taxable: false,
      customerVisible: true, lineTotal: '100.00', isUnapprovedTime: false, sortOrder: i
    })));
    return draft!.id;
  });
}

/** Forge a draft with a single manual line (no source rows). */
async function forgeManualDraft(f: Fixture): Promise<string> {
  return withSystemDbAccessContext(async () => {
    const [draft] = await db.insert(invoices).values({
      partnerId: f.partnerId, orgId: f.orgId, status: 'draft', currencyCode: 'USD'
    }).returning({ id: invoices.id });
    await db.insert(invoiceLines).values({
      invoiceId: draft!.id, orgId: f.orgId, sourceType: 'manual', sourceId: null,
      catalogItemId: null, parentLineId: null, ticketId: null, description: 'Setup',
      quantity: '1.00', unitPrice: '100.00', costBasis: null, taxable: false,
      customerVisible: true, lineTotal: '100.00', isUnapprovedTime: false, sortOrder: 0
    });
    return draft!.id;
  });
}

async function invoiceCounterFor(partnerId: string): Promise<number> {
  const admin = getTestDb();
  const rows = await admin.execute<{ counter: number }>(sql`
    SELECT counter FROM public.partner_invoice_sequences WHERE partner_id = ${partnerId}
  `);
  return rows[0]?.counter ?? 0;
}

function errorCode(result: PromiseSettledResult<unknown>): string | undefined {
  if (result.status !== 'rejected') return undefined;
  const reason = result.reason as { code?: string };
  return reason?.code;
}

describe.runIf(RUN)('issueInvoice race safety (B10)', () => {
  it('two drafts over the SAME not_billed sources: exactly one issues, loser gets SOURCE_ALREADY_BILLED after lock-wait', async () => {
    const f = await seedFixture(2);
    const draftA = await forgeDraftReferencing(f, f.timeEntryIds);
    const draftB = await forgeDraftReferencing(f, f.timeEntryIds);

    const locksHeld = deferred<void>();
    const releaseLocks = deferred<void>();
    const holder = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
    let holderWork: Promise<void> | undefined;
    let settled: PromiseSettledResult<unknown>[] | undefined;
    try {
      // Barrier: pre-hold the contended source-row locks so BOTH issuers are
      // queued behind them before either can validate + flip.
      holderWork = holder.begin(async (tx) => {
        await tx`SELECT id FROM public.time_entries WHERE id = ANY(${f.timeEntryIds}) ORDER BY id FOR UPDATE`;
        locksHeld.resolve();
        await releaseLocks.promise;
      });
      await locksHeld.promise;

      const issueA = withDbAccessContext(ctx(f), () => svc.issueInvoice(draftA, actor(f)));
      const issueB = withDbAccessContext(ctx(f), () => svc.issueInvoice(draftB, actor(f)));
      // Loser must fail only AFTER waiting on the lock — not by a pre-lock read.
      await waitForBlockedBackends(2);
      releaseLocks.resolve();
      await holderWork;
      settled = await Promise.allSettled([issueA, issueB]);
    } finally {
      releaseLocks.resolve();
      if (holderWork) await Promise.allSettled([holderWork]);
      await closeRaceClients(holder);
    }

    const fulfilled = settled!.filter((r) => r.status === 'fulfilled');
    const rejected = settled!.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(errorCode(rejected[0]!)).toBe('SOURCE_ALREADY_BILLED');

    // Sources billed exactly once, and still consistent.
    const te = await withSystemDbAccessContext(() =>
      db.select({ s: timeEntries.billingStatus }).from(timeEntries).where(inArray(timeEntries.id, f.timeEntryIds)));
    expect(te).toHaveLength(2);
    expect(te.every((r) => r.s === 'billed')).toBe(true);

    // Exactly one invoice number consumed; the loser draft stays a draft.
    expect(await invoiceCounterFor(f.partnerId)).toBe(1);
    const rows = await withSystemDbAccessContext(() =>
      db.select({ id: invoices.id, status: invoices.status, invoiceNumber: invoices.invoiceNumber })
        .from(invoices).where(inArray(invoices.id, [draftA, draftB])));
    const issued = rows.filter((r) => r.status === 'sent');
    const drafts = rows.filter((r) => r.status === 'draft');
    expect(issued).toHaveLength(1);
    expect(issued[0]!.invoiceNumber).toMatch(/^INV-\d{4}-0001$/);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.invoiceNumber).toBeNull();
  }, 30_000);

  it('double-issue of the SAME draft: one wins, the loser gets NOT_A_DRAFT off the locked row', async () => {
    const f = await seedFixture(1);
    const draftId = await forgeDraftReferencing(f, f.timeEntryIds);

    const locksHeld = deferred<void>();
    const releaseLocks = deferred<void>();
    const holder = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
    let holderWork: Promise<void> | undefined;
    let settled: PromiseSettledResult<unknown>[] | undefined;
    try {
      holderWork = holder.begin(async (tx) => {
        await tx`SELECT id FROM public.invoices WHERE id = ${draftId} FOR UPDATE`;
        locksHeld.resolve();
        await releaseLocks.promise;
      });
      await locksHeld.promise;

      const issueA = withDbAccessContext(ctx(f), () => svc.issueInvoice(draftId, actor(f)));
      const issueB = withDbAccessContext(ctx(f), () => svc.issueInvoice(draftId, actor(f)));
      await waitForBlockedBackends(2);
      releaseLocks.resolve();
      await holderWork;
      settled = await Promise.allSettled([issueA, issueB]);
    } finally {
      releaseLocks.resolve();
      if (holderWork) await Promise.allSettled([holderWork]);
      await closeRaceClients(holder);
    }

    const fulfilled = settled!.filter((r) => r.status === 'fulfilled');
    const rejected = settled!.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(errorCode(rejected[0]!)).toBe('NOT_A_DRAFT');

    // Exactly one number allocated — the loser must not have burned a counter
    // slot or overwritten the winner's issuance.
    expect(await invoiceCounterFor(f.partnerId)).toBe(1);
    const rows = await withSystemDbAccessContext(() =>
      db.select({ status: invoices.status, invoiceNumber: invoices.invoiceNumber, total: invoices.total })
        .from(invoices).where(inArray(invoices.id, [draftId])));
    expect(rows[0]!.status).toBe('sent');
    expect(rows[0]!.invoiceNumber).toMatch(/^INV-\d{4}-0001$/);
    expect(rows[0]!.total).toBe('100.00');
  }, 30_000);

  it('issue racing addManualLine on the same draft: the line is either in the issued totals or rejected — never invisible', async () => {
    const f = await seedFixture(0);
    const draftId = await forgeManualDraft(f);

    const locksHeld = deferred<void>();
    const releaseLocks = deferred<void>();
    const holder = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
    let holderWork: Promise<void> | undefined;
    let settled: PromiseSettledResult<unknown>[] | undefined;
    try {
      holderWork = holder.begin(async (tx) => {
        await tx`SELECT id FROM public.invoices WHERE id = ${draftId} FOR UPDATE`;
        locksHeld.resolve();
        await releaseLocks.promise;
      });
      await locksHeld.promise;

      const issue = withDbAccessContext(ctx(f), () => svc.issueInvoice(draftId, actor(f)));
      const addLine = withDbAccessContext(ctx(f), () =>
        svc.addManualLine(draftId, { description: 'Extra', quantity: 1, unitPrice: 50, taxable: false }, actor(f)));
      await waitForBlockedBackends(2);
      releaseLocks.resolve();
      await holderWork;
      settled = await Promise.allSettled([issue, addLine]);
    } finally {
      releaseLocks.resolve();
      if (holderWork) await Promise.allSettled([holderWork]);
      await closeRaceClients(holder);
    }

    const [issueResult, addResult] = settled!;
    // issueInvoice must have succeeded either way (the draft was issuable).
    expect(issueResult!.status).toBe('fulfilled');

    const persisted = await withSystemDbAccessContext(async () => {
      const [inv] = await db.select({ status: invoices.status, total: invoices.total })
        .from(invoices).where(inArray(invoices.id, [draftId]));
      const lines = await db.select({ lineTotal: invoiceLines.lineTotal })
        .from(invoiceLines).where(inArray(invoiceLines.invoiceId, [draftId]));
      return { inv: inv!, lines };
    });
    expect(persisted.inv.status).toBe('sent');

    // The invariant: whatever lines exist on the issued invoice are ALL in the
    // frozen totals (no line invisible to totals).
    const lineSumCents = persisted.lines.reduce((s, l) => s + Math.round(Number(l.lineTotal) * 100), 0);
    expect(Math.round(Number(persisted.inv.total) * 100)).toBe(lineSumCents);

    if (addResult!.status === 'rejected') {
      // Issue won the lock: the add must have been rejected against the
      // now-issued row, and the invoice keeps its single original line.
      expect(errorCode(addResult!)).toBe('NOT_A_DRAFT');
      expect(persisted.lines).toHaveLength(1);
      expect(persisted.inv.total).toBe('100.00');
    } else {
      // The add won the lock: the issued totals must include it.
      expect(persisted.lines).toHaveLength(2);
      expect(persisted.inv.total).toBe('150.00');
    }
  }, 30_000);
});
