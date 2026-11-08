import './setup';
import { describe, it, expect, vi } from 'vitest';

// Lifecycle events + PDF render are fire-and-forget side effects, not the
// correctness under test. Mocked so payments don't open a BullMQ socket to the
// test Redis (same rationale as invoiceIssueRace.integration).
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn().mockResolvedValue(undefined) }));

import { eq, sql } from 'drizzle-orm';
import postgres, { type Sql } from 'postgres';
import { db, withSystemDbAccessContext, withDbAccessContext, type DbAccessContext } from '../../db';
import { partners, organizations, users, invoices, invoicePayments } from '../../db/schema';
import { invoiceStripePayments } from '../../db/schema/stripePayments';
import * as svc from '../../services/invoiceService';
import { recordStripePayment } from '../../services/stripeReconcile';
import type { InvoiceActor } from '../../services/invoiceTypes';
import { emitInvoiceEvent } from '../../services/invoiceEvents';
import { getTestDb } from './setup';

const RUN = !!process.env.DATABASE_URL;
const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';

// ---------------------------------------------------------------------------
// Race harness (pattern: invoiceIssueRace / configPolicyReferenceConcurrency)
// — a dedicated admin postgres.js client pre-holds the contended row lock, the
// racers are started against the app pool, and pg_blocking_pids makes the
// interleaving deterministic before the holder releases. No sleeps.
//
// The barrier works BOTH pre- and post-fix: post-fix every payment writer's
// first statement is the invoice-row FOR UPDATE (blocks immediately); pre-fix
// the racers block later, on recomputeInvoiceStatus's UPDATE invoices (manual)
// or the mapping UPDATE (Stripe) — i.e. AFTER both have already inserted their
// payment rows, which is exactly the bug.
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
    throw new AggregateError(failures, 'failed to close payment race client(s)');
  }
}

/**
 * Wait until at least `min` backends in this database are actively blocked on
 * a lock. The holder itself is idle-in-transaction (never blocked), so the only
 * backends that can match are the racers queued behind it.
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
 * Run `racers` with the given row lock pre-held by a dedicated client, release
 * only after all racers are demonstrably queued on a lock, and return the
 * settled results. `holdLock` runs inside the holder's transaction.
 */
async function raceUnderHeldLock(
  holdLock: (tx: postgres.TransactionSql) => Promise<void>,
  racers: Array<() => Promise<unknown>>,
): Promise<PromiseSettledResult<unknown>[]> {
  const locksHeld = deferred<void>();
  const releaseLocks = deferred<void>();
  const holder = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  let holderWork: Promise<void> | undefined;
  try {
    holderWork = holder.begin(async (tx) => {
      await holdLock(tx);
      locksHeld.resolve();
      await releaseLocks.promise;
    });
    await locksHeld.promise;
    const inFlight = racers.map((r) => r());
    await waitForBlockedBackends(racers.length);
    releaseLocks.resolve();
    await holderWork;
    return await Promise.allSettled(inFlight);
  } finally {
    releaseLocks.resolve();
    if (holderWork) await Promise.allSettled([holderWork]);
    await closeRaceClients(holder);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Fixture {
  partnerId: string;
  orgId: string;
  userId: string;
}

async function seedFixture(currency: string): Promise<Fixture> {
  const suffix = Math.random().toString(36).slice(2, 10);
  return withSystemDbAccessContext(async () => {
    const [p] = await db.insert(partners).values({
      name: `PayRace ${suffix}`, slug: `pay-race-${suffix}`, type: 'msp', plan: 'pro', status: 'active',
      currencyCode: currency
    }).returning({ id: partners.id });
    const partnerId = p!.id;
    const [o] = await db.insert(organizations).values({
      partnerId, name: `Org ${suffix}`, slug: `pay-race-org-${suffix}`, currencyCode: currency
    }).returning({ id: organizations.id });
    const orgId = o!.id;
    const [u] = await db.insert(users).values({
      partnerId, orgId, email: `tech-${suffix}@example.test`, name: `Tech ${suffix}`, status: 'active'
    }).returning({ id: users.id });
    return { partnerId, orgId, userId: u!.id };
  });
}

function actor(f: Fixture): InvoiceActor {
  return { userId: f.userId, partnerId: f.partnerId, accessibleOrgIds: [f.orgId] };
}
function ctx(f: Fixture): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: [f.orgId], accessiblePartnerIds: [f.partnerId], userId: f.userId };
}

/** Forge an ISSUED (sent) invoice with the given total/balance, no payments yet. */
async function forgeSentInvoice(f: Fixture, currency: string, total: string): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  return withSystemDbAccessContext(async () => {
    const [inv] = await db.insert(invoices).values({
      partnerId: f.partnerId, orgId: f.orgId, status: 'sent', currencyCode: currency,
      invoiceNumber: `INV-RACE-${suffix}`,
      issueDate: '2026-08-01', dueDate: '2099-01-01',
      subtotal: total, taxTotal: '0.00', total, amountPaid: '0.00', balance: total
    }).returning({ id: invoices.id });
    return inv!.id;
  });
}

async function readInvoice(invoiceId: string) {
  return withSystemDbAccessContext(async () => {
    const [inv] = await db.select({
      status: invoices.status, amountPaid: invoices.amountPaid, balance: invoices.balance
    }).from(invoices).where(eq(invoices.id, invoiceId));
    const pays = await db.select({ amount: invoicePayments.amount })
      .from(invoicePayments).where(eq(invoicePayments.invoiceId, invoiceId));
    return { inv: inv!, pays };
  });
}

function errorCode(result: PromiseSettledResult<unknown>): string | undefined {
  if (result.status !== 'rejected') return undefined;
  const reason = result.reason as { code?: string };
  return reason?.code;
}

function recordVia(f: Fixture, invoiceId: string, amount: string) {
  return withDbAccessContext(ctx(f), () =>
    svc.recordPayment(invoiceId, { amount, method: 'check', receivedAt: '2026-08-21' } as never, actor(f)));
}

describe.runIf(RUN)('payment recording race safety (B10)', () => {
  it('two concurrent full-balance payments: exactly one lands, the loser gets OVERPAYMENT after lock-wait', async () => {
    const f = await seedFixture('USD');
    const invoiceId = await forgeSentInvoice(f, 'USD', '100.00');

    const settled = await raceUnderHeldLock(
      async (tx) => { await tx`SELECT id FROM public.invoices WHERE id = ${invoiceId} FOR UPDATE`; },
      [
        () => recordVia(f, invoiceId, '100.00'),
        () => recordVia(f, invoiceId, '100.00'),
      ],
    );

    const fulfilled = settled.filter((r) => r.status === 'fulfilled');
    const rejected = settled.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(errorCode(rejected[0]!)).toBe('OVERPAYMENT');

    const { inv, pays } = await readInvoice(invoiceId);
    expect(pays).toHaveLength(1);
    expect(inv.amountPaid).toBe('100.00');
    expect(inv.balance).toBe('0.00');
    expect(inv.status).toBe('paid');
  }, 30_000);

  it('legacy non-representable JPY balance: concurrent exact payoff + small payment leave NO non-representable residue', async () => {
    // Pre-multi-currency cent math could leave a JPY invoice with balance
    // '1000.50'. The exact payoff is the only permitted payment (a smaller
    // representable payment would strand a residue no payment can clear), and
    // the guard must be evaluated against the LOCKED balance — not a stale read.
    const f = await seedFixture('JPY');
    const invoiceId = await forgeSentInvoice(f, 'JPY', '1000.50');

    const settled = await raceUnderHeldLock(
      async (tx) => { await tx`SELECT id FROM public.invoices WHERE id = ${invoiceId} FOR UPDATE`; },
      [
        () => recordVia(f, invoiceId, '1000.50'), // exact payoff (legacy escape hatch)
        () => recordVia(f, invoiceId, '500'),     // representable, but would strand '500.50'
      ],
    );

    // The small payment must NEVER land on the non-representable balance —
    // whichever order the lock grants, it is rejected (INVALID_AMOUNT against
    // the untouched balance; OVERPAYMENT against the zero balance after payoff).
    const [payoff, small] = settled;
    expect(payoff!.status).toBe('fulfilled');
    expect(small!.status).toBe('rejected');
    expect(['INVALID_AMOUNT', 'OVERPAYMENT']).toContain(errorCode(small!));

    const { inv, pays } = await readInvoice(invoiceId);
    expect(pays).toHaveLength(1);
    expect(pays[0]!.amount).toBe('1000.50');
    expect(inv.amountPaid).toBe('1000.50');
    expect(inv.balance).toBe('0.00'); // no '500.50'-style residue survives
    expect(inv.status).toBe('paid');
  }, 30_000);

  it('double Stripe webhook delivery for the same object: exactly one payment row, second delivery is a no-op', async () => {
    // Two deliveries can both read the mapping with invoice_payment_id NULL
    // before either records — the mapping must be re-read FOR UPDATE after the
    // invoice lock, and the link written with a guarded UPDATE.
    const f = await seedFixture('USD');
    const invoiceId = await forgeSentInvoice(f, 'USD', '100.00');
    const stripeObjectId = `cs_race_${Math.random().toString(36).slice(2, 10)}`;
    await withSystemDbAccessContext(async () => {
      await db.insert(invoiceStripePayments).values({
        orgId: f.orgId, invoiceId, invoicePaymentId: null,
        stripeAccountId: 'acct_race', stripeObjectType: 'checkout_session',
        stripeObjectId, stripePaymentIntentId: null,
        amount: '100.00', currency: 'USD', status: 'pending'
      });
    });

    const capture = {
      stripeObjectId, stripePaymentIntentId: 'pi_race_1', stripeAccountId: 'acct_race',
      amount: '100.00', currency: 'USD'
    };
    const settled = await raceUnderHeldLock(
      async (tx) => {
        await tx`SELECT id FROM public.invoice_stripe_payments WHERE stripe_object_id = ${stripeObjectId} FOR UPDATE`;
      },
      [
        () => recordStripePayment(capture),
        () => recordStripePayment(capture),
      ],
    );

    // Both deliveries resolve cleanly (webhook must 2xx on redelivery)…
    expect(settled.every((r) => r.status === 'fulfilled')).toBe(true);
    for (const r of settled) {
      expect((r as PromiseFulfilledResult<{ invoiceId: string }>).value.invoiceId).toBe(invoiceId);
    }

    // …but exactly ONE payment row exists and the mapping links it.
    const { inv, pays } = await readInvoice(invoiceId);
    expect(pays).toHaveLength(1);
    expect(inv.amountPaid).toBe('100.00');
    expect(inv.balance).toBe('0.00');
    expect(inv.status).toBe('paid');
    const mapping = await withSystemDbAccessContext(async () => {
      const [m] = await db.select({ invoicePaymentId: invoiceStripePayments.invoicePaymentId, status: invoiceStripePayments.status })
        .from(invoiceStripePayments).where(eq(invoiceStripePayments.stripeObjectId, stripeObjectId));
      return m!;
    });
    expect(mapping.invoicePaymentId).not.toBeNull();
    expect(mapping.status).toBe('succeeded');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// #3803 item 4 — manual payment idempotency. The invoice lock alone cannot stop
// a retried PARTIAL payment from landing twice: 40 + 40 still fits a 100
// balance, so the second retry passes every amount check the lock serializes.
// A caller-supplied key, unique per invoice, is what makes the retry land once.
// ---------------------------------------------------------------------------

type RecordResult = Awaited<ReturnType<typeof svc.recordPayment>>;

function recordKeyed(
  f: Fixture, invoiceId: string, amount: string, idempotencyKey: string,
  extra: Record<string, unknown> = {},
) {
  return withDbAccessContext(ctx(f), () =>
    svc.recordPayment(invoiceId, {
      amount, method: 'check', receivedAt: '2026-08-21', idempotencyKey, ...extra,
    } as never, actor(f)));
}

function fulfilledValue(r: PromiseSettledResult<unknown>): RecordResult {
  if (r.status !== 'fulfilled') throw new Error(`expected fulfilled, got ${String((r as PromiseRejectedResult).reason)}`);
  return r.value as RecordResult;
}

function newKey(): string {
  return `idem-${Math.random().toString(36).slice(2, 12)}`;
}

describe.runIf(RUN)('manual payment idempotency (#3803)', () => {
  it('two concurrent retries of one partial payment with the same key land exactly once', async () => {
    const f = await seedFixture('USD');
    const invoiceId = await forgeSentInvoice(f, 'USD', '100.00');
    const key = newKey();

    const settled = await raceUnderHeldLock(
      async (tx) => { await tx`SELECT id FROM public.invoices WHERE id = ${invoiceId} FOR UPDATE`; },
      [
        () => recordKeyed(f, invoiceId, '40.00', key),
        () => recordKeyed(f, invoiceId, '40.00', key),
      ],
    );

    // Both retries answer success (a retry must not see an error for a payment
    // that landed), and both name the SAME payment.
    const [a, b] = settled.map(fulfilledValue);
    expect([a!.replayed, b!.replayed].sort()).toEqual([false, true]);
    expect(a!.audit.paymentId).toBe(b!.audit.paymentId);

    const { inv, pays } = await readInvoice(invoiceId);
    expect(pays).toHaveLength(1);
    expect(pays[0]!.amount).toBe('40.00');
    expect(inv.amountPaid).toBe('40.00');
    expect(inv.balance).toBe('60.00');
    expect(inv.status).toBe('partially_paid');
  }, 30_000);

  it('control: concurrent partial payments with DIFFERENT keys both land', async () => {
    const f = await seedFixture('USD');
    const invoiceId = await forgeSentInvoice(f, 'USD', '100.00');

    const settled = await raceUnderHeldLock(
      async (tx) => { await tx`SELECT id FROM public.invoices WHERE id = ${invoiceId} FOR UPDATE`; },
      [
        () => recordKeyed(f, invoiceId, '40.00', newKey()),
        () => recordKeyed(f, invoiceId, '40.00', newKey()),
      ],
    );

    expect(settled.map(fulfilledValue).map((r) => r.replayed)).toEqual([false, false]);
    const { inv, pays } = await readInvoice(invoiceId);
    expect(pays).toHaveLength(2);
    expect(inv.amountPaid).toBe('80.00');
    expect(inv.balance).toBe('20.00');
  }, 30_000);

  it('a key reused with a different payment is refused 409 IDEMPOTENCY_KEY_REUSED and records nothing', async () => {
    const f = await seedFixture('USD');
    const invoiceId = await forgeSentInvoice(f, 'USD', '100.00');
    const key = newKey();
    await recordKeyed(f, invoiceId, '40.00', key, { reference: 'CHK-1001' });

    for (const [changed, field] of [
      [{ amount: '45.00' }, 'amount'],
      [{ method: 'ach' }, 'method'],
      [{ receivedAt: '2026-08-22' }, 'receivedAt'],
      [{ reference: 'CHK-1002' }, 'reference'],
      [{ reference: undefined }, 'reference'],
      [{ note: 'second try' }, 'note'],
    ] as const) {
      const { amount = '40.00', ...extra } = changed as { amount?: string };
      await expect(recordKeyed(f, invoiceId, amount, key, { reference: 'CHK-1001', ...extra }))
        .rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED', details: { differingFields: [field] } });
    }

    // The identical request is still a clean replay.
    const replay = await recordKeyed(f, invoiceId, '40.00', key, { reference: 'CHK-1001' });
    expect(replay.replayed).toBe(true);
    const { inv, pays } = await readInvoice(invoiceId);
    expect(pays).toHaveLength(1);
    expect(inv.amountPaid).toBe('40.00');
  }, 30_000);

  it('the same key on a different invoice is a different payment', async () => {
    const f = await seedFixture('USD');
    const first = await forgeSentInvoice(f, 'USD', '100.00');
    const second = await forgeSentInvoice(f, 'USD', '100.00');
    const key = newKey();

    expect((await recordKeyed(f, first, '40.00', key)).replayed).toBe(false);
    expect((await recordKeyed(f, second, '40.00', key)).replayed).toBe(false);
    expect((await readInvoice(first)).pays).toHaveLength(1);
    expect((await readInvoice(second)).pays).toHaveLength(1);
  }, 30_000);

  it('retries of a full payoff are replays, not OVERPAYMENT against the zero balance it left', async () => {
    // The lookup must run before the amount checks on both paths: the
    // concurrent retry reaches the in-lock lookup, the later one the pre-check.
    const f = await seedFixture('USD');
    const invoiceId = await forgeSentInvoice(f, 'USD', '100.00');
    const key = newKey();

    const settled = await raceUnderHeldLock(
      async (tx) => { await tx`SELECT id FROM public.invoices WHERE id = ${invoiceId} FOR UPDATE`; },
      [
        () => recordKeyed(f, invoiceId, '100.00', key),
        () => recordKeyed(f, invoiceId, '100.00', key),
      ],
    );
    expect(settled.map(fulfilledValue).map((r) => r.replayed).sort()).toEqual([false, true]);
    expect((await recordKeyed(f, invoiceId, '100.00', key)).replayed).toBe(true);

    const { inv, pays } = await readInvoice(invoiceId);
    expect(pays).toHaveLength(1);
    expect(inv.balance).toBe('0.00');
    expect(inv.status).toBe('paid');
  }, 30_000);

  it('a replay emits no second payment.recorded event', async () => {
    const f = await seedFixture('USD');
    const invoiceId = await forgeSentInvoice(f, 'USD', '100.00');
    const key = newKey();
    const recordedEvents = () => vi.mocked(emitInvoiceEvent).mock.calls
      .filter(([e]) => e.type === 'payment.recorded' && e.invoiceId === invoiceId);

    await recordKeyed(f, invoiceId, '40.00', key);
    await recordKeyed(f, invoiceId, '40.00', key);
    expect(recordedEvents()).toHaveLength(1);
  }, 30_000);

  it('a replay is refused to an actor without access to the invoice, on both lookup paths', async () => {
    // RLS lets this partner-scope context read the invoice; the app-layer site
    // allowlist does not. A replay returns the invoice and the payment, so it
    // must answer SITE_DENIED exactly as a first recording would.
    const f = await seedFixture('USD');
    const invoiceId = await forgeSentInvoice(f, 'USD', '100.00');
    const key = newKey();
    const restricted: InvoiceActor = { ...actor(f), allowedSiteIds: [crypto.randomUUID()] };
    const recordAsRestricted = () => withDbAccessContext(ctx(f), () =>
      svc.recordPayment(invoiceId, { amount: '40.00', method: 'check', receivedAt: '2026-08-21', idempotencyKey: key } as never, restricted));

    // In-lock path: both retries pass the pre-check before either commits.
    const settled = await raceUnderHeldLock(
      async (tx) => { await tx`SELECT id FROM public.invoices WHERE id = ${invoiceId} FOR UPDATE`; },
      [() => recordKeyed(f, invoiceId, '40.00', key), recordAsRestricted],
    );
    expect(settled[0]!.status).toBe('fulfilled');
    expect(errorCode(settled[1]!)).toBe('SITE_DENIED');

    // Pre-check path: the payment is committed, so the unlocked lookup finds it.
    await expect(recordAsRestricted()).rejects.toMatchObject({ status: 403, code: 'SITE_DENIED' });
    expect((await readInvoice(invoiceId)).pays).toHaveLength(1);
  }, 30_000);

  it('a late replay does not revoke a pay link minted after the original payment', async () => {
    // Recording a payment expires every open Stripe Checkout session on the
    // invoice, and that is irreversible. A replay records nothing, so it must
    // not reach that step: the pay link sent for the remaining 60.00 survives.
    const f = await seedFixture('USD');
    const invoiceId = await forgeSentInvoice(f, 'USD', '100.00');
    const key = newKey();
    await recordKeyed(f, invoiceId, '40.00', key);

    const stripeObjectId = `cs_idem_${Math.random().toString(36).slice(2, 10)}`;
    await withSystemDbAccessContext(async () => {
      await db.insert(invoiceStripePayments).values({
        orgId: f.orgId, invoiceId, invoicePaymentId: null,
        stripeAccountId: 'acct_idem', stripeObjectType: 'checkout_session',
        stripeObjectId, stripePaymentIntentId: null,
        amount: '60.00', currency: 'USD', status: 'pending'
      });
    });
    const readSession = () => withSystemDbAccessContext(async () => {
      const [row] = await db.select({ revocationState: invoiceStripePayments.revocationState, status: invoiceStripePayments.status })
        .from(invoiceStripePayments).where(eq(invoiceStripePayments.stripeObjectId, stripeObjectId));
      return row!;
    });
    const before = await readSession();

    const replay = await recordKeyed(f, invoiceId, '40.00', key);
    expect(replay.replayed).toBe(true);
    expect(await readSession()).toEqual(before);
    expect((await readInvoice(invoiceId)).pays).toHaveLength(1);
  }, 30_000);

  it('a keyed row already inserted when recordPayment takes the lock is seen by the in-lock lookup', async () => {
    // The holder's insert has finished (its FK check holds FOR KEY SHARE on the
    // invoice) but not committed. recordPayment's unlocked pre-check cannot see
    // it, so the replay must come from the lookup it runs once FOR UPDATE is
    // granted, after the holder commits.
    const f = await seedFixture('USD');
    const invoiceId = await forgeSentInvoice(f, 'USD', '100.00');
    const key = newKey();

    const settled = await raceUnderHeldLock(
      async (tx) => {
        await tx`
          INSERT INTO public.invoice_payments (invoice_id, org_id, amount, method, received_at, idempotency_key)
          VALUES (${invoiceId}, ${f.orgId}, '40.00', 'check', '2026-08-21', ${key})`;
      },
      [() => recordKeyed(f, invoiceId, '40.00', key)],
    );

    expect(fulfilledValue(settled[0]!).replayed).toBe(true);
    expect((await readInvoice(invoiceId)).pays).toHaveLength(1);
  }, 30_000);

  it('the index enforces one key per invoice and leaves unkeyed payments unconstrained', async () => {
    const f = await seedFixture('USD');
    const invoiceId = await forgeSentInvoice(f, 'USD', '100.00');
    const admin = getTestDb();
    const key = newKey();
    const insert = (k: string | null) => admin.execute(sql`
      INSERT INTO public.invoice_payments (invoice_id, org_id, amount, method, received_at, idempotency_key)
      VALUES (${invoiceId}, ${f.orgId}, '1.00', 'check', '2026-08-21', ${k})`);

    await insert(null);
    await insert(null);
    await insert(key);
    await expect(insert(key)).rejects.toMatchObject({
      cause: expect.objectContaining({ code: '23505', constraint_name: 'invoice_payments_invoice_idempotency_key_uq' }),
    });
  }, 30_000);
});
