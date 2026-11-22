/**
 * #3803 item 9: invoice lifecycle events are published only after the
 * transaction that made the change has COMMITTED, and a rolled-back change
 * publishes nothing.
 *
 * Before the fix, recordPayment / voidPayment awaited the BullMQ enqueue right
 * after their savepoint returned. On the request path that savepoint sits inside
 * the request-wide transaction, so (a) the invoice row lock was still held while
 * Redis answered, and (b) a request that rolled back afterwards had already
 * announced a payment that never existed. emitInvoiceEvent now registers the
 * enqueue with runAfterDbContextCommit.
 *
 * Harness: BullMQ's Queue is replaced by an in-memory recorder. Each publish
 * also reads the invoice's amount_paid on the superuser test connection (a
 * different backend), so a publish made while the transaction is still open
 * sees the pre-change value.
 *
 * Prerequisites: a live test database (`pnpm test-stack up`).
 */
import './setup';
import { describe, expect, it, vi, beforeEach } from 'vitest';

type Published = { queue: string; type: string; data: Record<string, unknown>; amountPaidSeenByOthers?: string | null };
const published = vi.hoisted(() => [] as Published[]);
const readCommittedAmountPaid = vi.hoisted(() => ({ fn: null as null | ((invoiceId: string) => Promise<string | null>) }));

vi.mock('bullmq', async (importOriginal) => {
  const actual = await importOriginal<typeof import('bullmq')>();
  class RecordingQueue {
    constructor(public readonly name: string) {}
    async add(type: string, data: Record<string, unknown>) {
      // Recorded synchronously, before any await, so a publish started inside
      // the transaction is captured even if the caller rolls back right after.
      const entry: Published = { queue: this.name, type, data };
      published.push(entry);
      if (typeof data?.invoiceId === 'string' && readCommittedAmountPaid.fn) {
        entry.amountPaidSeenByOthers = await readCommittedAmountPaid.fn(data.invoiceId);
      }
      return { id: `job-${published.length}` };
    }
    async close() {}
    on() { return this; }
  }
  return { ...actual, Queue: RecordingQueue };
});
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import { eq } from 'drizzle-orm';
import {
  db,
  runAfterDbContextExit,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { invoicePayments, invoices, organizations, partners, users } from '../../db/schema';
import { recordPayment, voidPayment } from '../../services/invoiceService';
import { INVOICE_EVENTS_QUEUE } from '../../services/invoiceEvents';
import type { InvoiceActor } from '../../services/invoiceTypes';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

interface Fixture { partnerId: string; orgId: string; userId: string; invoiceId: string }

async function seed(total = '100.00'): Promise<Fixture> {
  const suffix = Math.random().toString(36).slice(2, 10);
  return withSystemDbAccessContext(async () => {
    const [p] = await db.insert(partners).values({
      name: `EvtCommit ${suffix}`, slug: `evt-commit-${suffix}`, type: 'msp', plan: 'pro', status: 'active', currencyCode: 'USD',
    }).returning({ id: partners.id });
    const [o] = await db.insert(organizations).values({
      partnerId: p!.id, name: `Org ${suffix}`, slug: `evt-commit-org-${suffix}`, currencyCode: 'USD',
    }).returning({ id: organizations.id });
    const [u] = await db.insert(users).values({
      partnerId: p!.id, orgId: o!.id, email: `evt-${suffix}@example.test`, name: `Tech ${suffix}`, status: 'active',
    }).returning({ id: users.id });
    const [inv] = await db.insert(invoices).values({
      partnerId: p!.id, orgId: o!.id, status: 'sent', currencyCode: 'USD',
      invoiceNumber: `INV-EVT-${suffix.toUpperCase()}`, issueDate: '2026-08-01', dueDate: '2099-01-01',
      subtotal: total, taxTotal: '0.00', total, amountPaid: '0.00', balance: total,
    }).returning({ id: invoices.id });
    return { partnerId: p!.id, orgId: o!.id, userId: u!.id, invoiceId: inv!.id };
  });
}

const actor = (f: Fixture): InvoiceActor => ({ userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] });
// Mirrors authMiddleware's request transaction for a partner-scope technician.
const ctx = (f: Fixture): DbAccessContext => ({
  scope: 'partner', orgId: null, accessibleOrgIds: [f.orgId], accessiblePartnerIds: [f.partnerId], userId: f.userId,
});

const eventsFor = (invoiceId: string) =>
  published.filter((e) => e.queue === INVOICE_EVENTS_QUEUE && e.data.invoiceId === invoiceId);

/**
 * Registers an always-run task AFTER the work under test, in the same request
 * transaction, and resolves when it runs. Deferred tasks start in registration
 * order once the transaction settles, so when this resolves every earlier
 * after-commit task has either been started or dropped.
 */
function settledMarker(): { register: () => void; settled: Promise<void> } {
  let resolve!: () => void;
  const settled = new Promise<void>((r) => { resolve = r; });
  return { register: () => runAfterDbContextExit('test: settled marker', () => resolve()), settled };
}

async function paymentRows(invoiceId: string) {
  return withSystemDbAccessContext(() =>
    db.select({ id: invoicePayments.id }).from(invoicePayments).where(eq(invoicePayments.invoiceId, invoiceId)));
}

const recordInput = { amount: '100.00', method: 'check', receivedAt: '2026-08-21' } as never;

describe('invoice events are published only after COMMIT (#3803 item 9)', () => {
  beforeEach(() => {
    published.length = 0;
    readCommittedAmountPaid.fn = async (invoiceId) => {
      const [row] = await getTestDb().select({ amountPaid: invoices.amountPaid }).from(invoices).where(eq(invoices.id, invoiceId));
      return row?.amountPaid ?? null;
    };
  });

  runDb('recordPayment: nothing is published while the request transaction is open; both events follow the commit', async () => {
    const f = await seed();

    await withDbAccessContext(ctx(f), async () => {
      await recordPayment(f.invoiceId, recordInput, actor(f));
      // Still inside the request transaction: the invoice lock is held and the
      // payment is invisible to every other connection.
      expect(eventsFor(f.invoiceId)).toEqual([]);
    });

    await vi.waitFor(() => expect(eventsFor(f.invoiceId)).toHaveLength(2));
    const events = eventsFor(f.invoiceId);
    expect(events.map((e) => e.type)).toEqual(['payment.recorded', 'invoice.paid']);
    expect(events[0]!.data).toMatchObject({ type: 'payment.recorded', invoiceId: f.invoiceId, orgId: f.orgId, partnerId: f.partnerId, actorUserId: f.userId });
    // Every subscriber reading the invoice when the event lands sees the payment.
    await vi.waitFor(() => expect(events.map((e) => e.amountPaidSeenByOthers)).toEqual(['100.00', '100.00']));
  });

  runDb('recordPayment: a request that rolls back after the payment publishes nothing', async () => {
    const f = await seed();
    const marker = settledMarker();

    await expect(withDbAccessContext(ctx(f), async () => {
      await recordPayment(f.invoiceId, recordInput, actor(f));
      marker.register();
      // e.g. the route's audit write or a later validation failing.
      throw new Error('rollback after recordPayment');
    })).rejects.toThrow('rollback after recordPayment');

    await marker.settled;
    expect(eventsFor(f.invoiceId)).toEqual([]);
    // Positive control: the payment really was rolled back.
    expect(await paymentRows(f.invoiceId)).toEqual([]);
  });

  runDb('voidPayment: publishes payment.voided only after the void commits', async () => {
    const f = await seed();
    await withDbAccessContext(ctx(f), () => recordPayment(f.invoiceId, recordInput, actor(f)));
    const [payment] = await paymentRows(f.invoiceId);
    await vi.waitFor(() => expect(eventsFor(f.invoiceId)).toHaveLength(2));
    published.length = 0;

    await withDbAccessContext(ctx(f), async () => {
      await voidPayment(payment!.id, actor(f));
      expect(eventsFor(f.invoiceId)).toEqual([]);
    });

    await vi.waitFor(() => expect(eventsFor(f.invoiceId)).toHaveLength(1));
    const [event] = eventsFor(f.invoiceId);
    expect(event!.type).toBe('payment.voided');
    expect(event!.data).toMatchObject({ invoiceId: f.invoiceId, paymentId: payment!.id, actorUserId: f.userId });
    await vi.waitFor(() => expect(event!.amountPaidSeenByOthers).toBe('0.00'));
  });

  runDb('voidPayment: a request that rolls back after the void publishes nothing', async () => {
    const f = await seed();
    await withDbAccessContext(ctx(f), () => recordPayment(f.invoiceId, recordInput, actor(f)));
    const [payment] = await paymentRows(f.invoiceId);
    await vi.waitFor(() => expect(eventsFor(f.invoiceId)).toHaveLength(2));
    published.length = 0;
    const marker = settledMarker();

    await expect(withDbAccessContext(ctx(f), async () => {
      await voidPayment(payment!.id, actor(f));
      marker.register();
      throw new Error('rollback after voidPayment');
    })).rejects.toThrow('rollback after voidPayment');

    await marker.settled;
    expect(eventsFor(f.invoiceId)).toEqual([]);
    // Positive control: the void really was rolled back.
    expect(await paymentRows(f.invoiceId)).toEqual([{ id: payment!.id }]);
  });
});
