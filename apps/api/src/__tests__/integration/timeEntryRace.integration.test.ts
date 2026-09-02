import './setup';
import { describe, it, expect, vi } from 'vitest';

// Lifecycle events + PDF render are fire-and-forget BullMQ side effects, not
// the correctness under test (same rationale as invoiceIssueRace).
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../services/timeEntryEvents', () => ({ emitTimeEntryEvent: vi.fn().mockResolvedValue(undefined) }));

import { eq, sql } from 'drizzle-orm';
import postgres, { type Sql } from 'postgres';
import { db, withSystemDbAccessContext, withDbAccessContext, type DbAccessContext } from '../../db';
import {
  partners, organizations, users, tickets, timeEntries, ticketParts, invoices, invoiceLines
} from '../../db/schema';
import * as invoiceSvc from '../../services/invoiceService';
import * as timeSvc from '../../services/timeEntryService';
import type { InvoiceActor } from '../../services/invoiceTypes';
import type { TimeEntryActor } from '../../services/timeEntryService';
import { getTestDb } from './setup';

const RUN = !!process.env.DATABASE_URL;
const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';

// ---------------------------------------------------------------------------
// Race harness — verbatim from invoiceIssueRace.integration.test.ts: a
// dedicated postgres.js client pre-holds the contended row lock, the racers
// are started under withDbAccessContext against the app pool, and
// pg_blocking_pids makes the interleaving deterministic before the holder
// releases. No sleeps.
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
    throw new AggregateError(failures, 'failed to close time-entry race client(s)');
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

/**
 * Runs `racers` while `holder` pre-holds the lock taken by `lockSql`; both
 * racers must be observed blocked before the holder releases.
 */
async function raceBehindLock(
  lockSql: (tx: Sql) => Promise<unknown>,
  racers: () => Promise<unknown>[],
): Promise<PromiseSettledResult<unknown>[]> {
  const locksHeld = deferred<void>();
  const releaseLocks = deferred<void>();
  const holder = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  let holderWork: Promise<void> | undefined;
  try {
    holderWork = holder.begin(async (tx) => {
      await lockSql(tx as unknown as Sql);
      locksHeld.resolve();
      await releaseLocks.promise;
    });
    await locksHeld.promise;
    const started = racers();
    await waitForBlockedBackends(started.length);
    releaseLocks.resolve();
    await holderWork;
    return await Promise.allSettled(started);
  } finally {
    releaseLocks.resolve();
    if (holderWork) await Promise.allSettled([holderWork]);
    await closeRaceClients(holder);
  }
}

// ---------------------------------------------------------------------------
// Fixtures — invoiceIssueRace recipe plus a ticket in the USD org and a second
// org in EUR under the same partner (the cross-currency move target).
// ---------------------------------------------------------------------------

interface Fixture {
  partnerId: string;
  orgId: string;
  eurOrgId: string;
  userId: string;
  ticketId: string;
}

async function seedFixture(): Promise<Fixture> {
  const suffix = Math.random().toString(36).slice(2, 10);
  return withSystemDbAccessContext(async () => {
    const [p] = await db.insert(partners).values({
      name: `TERace ${suffix}`, slug: `terace-${suffix}`, type: 'msp', plan: 'pro', status: 'active',
      currencyCode: 'USD'
    }).returning({ id: partners.id });
    const partnerId = p!.id;
    const [o] = await db.insert(organizations).values({
      partnerId, name: `Org USD ${suffix}`, slug: `terace-usd-${suffix}`, currencyCode: 'USD'
    }).returning({ id: organizations.id });
    const [eur] = await db.insert(organizations).values({
      partnerId, name: `Org EUR ${suffix}`, slug: `terace-eur-${suffix}`, currencyCode: 'EUR'
    }).returning({ id: organizations.id });
    const [u] = await db.insert(users).values({
      partnerId, orgId: o!.id, email: `tech-${suffix}@example.test`, name: `Tech ${suffix}`, status: 'active'
    }).returning({ id: users.id });
    const [t] = await db.insert(tickets).values({
      orgId: o!.id, partnerId, ticketNumber: `TER-${suffix}`, subject: `Race ticket ${suffix}`, source: 'manual'
    }).returning({ id: tickets.id });
    return { partnerId, orgId: o!.id, eurOrgId: eur!.id, userId: u!.id, ticketId: t!.id };
  });
}

async function seedEntry(f: Fixture): Promise<string> {
  return withSystemDbAccessContext(async () => {
    const now = new Date();
    const [te] = await db.insert(timeEntries).values({
      partnerId: f.partnerId, orgId: f.orgId, ticketId: f.ticketId, userId: f.userId,
      startedAt: new Date(now.getTime() - 3_600_000), endedAt: now,
      durationMinutes: 60, description: 'Work', isBillable: true,
      hourlyRate: '100.00', billingStatus: 'not_billed', isApproved: true, currencyCode: 'USD'
    }).returning({ id: timeEntries.id });
    return te!.id;
  });
}

async function seedPart(f: Fixture): Promise<string> {
  return withSystemDbAccessContext(async () => {
    const [part] = await db.insert(ticketParts).values({
      ticketId: f.ticketId, orgId: f.orgId, description: 'SSD', quantity: '1.00', unitPrice: '100.00',
      currencyCode: 'USD', isBillable: true, billingStatus: 'not_billed', addedBy: f.userId
    }).returning({ id: ticketParts.id });
    return part!.id;
  });
}

function invoiceActor(f: Fixture): InvoiceActor {
  return { userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId, f.eurOrgId] };
}
function timeActor(f: Fixture): TimeEntryActor {
  return { userId: f.userId, partnerId: f.partnerId, manageAll: true, accessibleOrgIds: [f.orgId, f.eurOrgId] };
}
function ctx(f: Fixture): DbAccessContext {
  return {
    scope: 'partner', orgId: null, accessibleOrgIds: [f.orgId, f.eurOrgId],
    accessiblePartnerIds: [f.partnerId], userId: f.userId
  };
}

/** Forge a USD draft whose single line references the given source row. */
async function forgeDraftReferencing(f: Fixture, sourceType: 'time_entry' | 'part', sourceId: string): Promise<string> {
  return withSystemDbAccessContext(async () => {
    const [draft] = await db.insert(invoices).values({
      partnerId: f.partnerId, orgId: f.orgId, status: 'draft', currencyCode: 'USD'
    }).returning({ id: invoices.id });
    await db.insert(invoiceLines).values({
      invoiceId: draft!.id, orgId: f.orgId, sourceType, sourceId,
      catalogItemId: null, parentLineId: null, ticketId: f.ticketId, description: 'Work',
      quantity: '1.00', unitPrice: '100.00', costBasis: null, taxable: false,
      customerVisible: true, lineTotal: '100.00', isUnapprovedTime: false, sortOrder: 0
    });
    return draft!.id;
  });
}

function errorCode(result: PromiseSettledResult<unknown>): string | undefined {
  if (result.status !== 'rejected') return undefined;
  const reason = result.reason as { code?: string };
  return reason?.code;
}

describe.runIf(RUN)('time entry / part race safety (wave 4, Task 7)', () => {
  // Task 13's locked moveTicketOrg guard (TICKET_MOVE_CURRENCY_BLOCKED) makes
  // the interleaving deterministic in either order.
  it('(a) create vs move: the new entry is never stranded in the old currency under the new org', async () => {
    const f = await seedFixture();
    const { moveTicketOrg } = await import('../../services/ticketService');

    const settled = await raceBehindLock(
      (tx) => tx`SELECT id FROM public.tickets WHERE id = ${f.ticketId} FOR UPDATE`,
      () => [
        withDbAccessContext(ctx(f), () => timeSvc.createTimeEntry({
          ticketId: f.ticketId, hourlyRate: 100, isBillable: true,
          startedAt: new Date(Date.now() - 3_600_000), endedAt: new Date()
        }, timeActor(f))),
        withDbAccessContext(ctx(f), () => moveTicketOrg(f.ticketId, f.eurOrgId, { userId: f.userId })),
      ],
    );
    const [createResult, moveResult] = settled;

    const entries = await withSystemDbAccessContext(() =>
      db.select({ orgId: timeEntries.orgId, currencyCode: timeEntries.currencyCode })
        .from(timeEntries).where(eq(timeEntries.ticketId, f.ticketId)));

    // Forbidden state, asserted explicitly: an entry under the EUR org stamped USD.
    expect(entries.some((e) => e.orgId === f.eurOrgId && e.currencyCode === 'USD')).toBe(false);

    if (moveResult!.status === 'rejected') {
      // Create ran first: the move saw the new USD money under its guard and blocked.
      expect(createResult!.status).toBe('fulfilled');
      expect(errorCode(moveResult!)).toBe('TICKET_MOVE_CURRENCY_BLOCKED');
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ orgId: f.orgId, currencyCode: 'USD' });
    } else {
      // Move ran first: the create re-resolved under the lock and landed in EUR.
      expect(createResult!.status).toBe('fulfilled');
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ orgId: f.eurOrgId, currencyCode: 'EUR' });
    }
  }, 30_000);

  it('(b) edit vs issue: the entry ends billed; a rate edit either lands before issue or is rejected ENTRY_BILLED', async () => {
    const f = await seedFixture();
    const entryId = await seedEntry(f);
    const draftId = await forgeDraftReferencing(f, 'time_entry', entryId);

    const settled = await raceBehindLock(
      (tx) => tx`SELECT id FROM public.time_entries WHERE id = ${entryId} FOR UPDATE`,
      () => [
        withDbAccessContext(ctx(f), () => invoiceSvc.issueInvoice(draftId, invoiceActor(f))),
        withDbAccessContext(ctx(f), () => timeSvc.updateTimeEntry(entryId, { hourlyRate: 200 }, timeActor(f))),
      ],
    );
    const [issueResult, updateResult] = settled;
    expect(issueResult!.status).toBe('fulfilled');

    const [row] = await withSystemDbAccessContext(() =>
      db.select({ billingStatus: timeEntries.billingStatus, hourlyRate: timeEntries.hourlyRate, currencyCode: timeEntries.currencyCode })
        .from(timeEntries).where(eq(timeEntries.id, entryId)));
    expect(row!.billingStatus).toBe('billed');
    expect(row!.currencyCode).toBe('USD'); // never restamped by either path

    if (updateResult!.status === 'rejected') {
      // Issue took the lock first: the edit re-read a billed row and refused.
      expect(errorCode(updateResult!)).toBe('ENTRY_BILLED');
      expect(row!.hourlyRate).toBe('100.00');
    } else {
      // The edit committed before issue took the lock.
      expect(row!.hourlyRate).toBe('200.00');
    }
  }, 30_000);

  it('(c) part edit vs issue: the part ends billed; a price edit either lands before issue or is rejected PART_BILLED', async () => {
    const f = await seedFixture();
    const partId = await seedPart(f);
    const draftId = await forgeDraftReferencing(f, 'part', partId);

    const settled = await raceBehindLock(
      (tx) => tx`SELECT id FROM public.ticket_parts WHERE id = ${partId} FOR UPDATE`,
      () => [
        withDbAccessContext(ctx(f), () => invoiceSvc.issueInvoice(draftId, invoiceActor(f))),
        withDbAccessContext(ctx(f), () => timeSvc.updateTicketPart(partId, { unitPrice: 5 }, timeActor(f))),
      ],
    );
    const [issueResult, updateResult] = settled;
    expect(issueResult!.status).toBe('fulfilled');

    const [row] = await withSystemDbAccessContext(() =>
      db.select({ billingStatus: ticketParts.billingStatus, unitPrice: ticketParts.unitPrice, currencyCode: ticketParts.currencyCode })
        .from(ticketParts).where(eq(ticketParts.id, partId)));
    expect(row!.billingStatus).toBe('billed');
    expect(row!.currencyCode).toBe('USD');

    if (updateResult!.status === 'rejected') {
      expect(errorCode(updateResult!)).toBe('PART_BILLED');
      expect(row!.unitPrice).toBe('100.00');
    } else {
      expect(row!.unitPrice).toBe('5.00');
    }
  }, 30_000);
});
