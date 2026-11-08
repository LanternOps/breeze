import './setup';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// invoice.overdue is a fire-and-forget BullMQ side effect; mocked so the sweep
// never opens a socket to the test Redis, and so the test can assert WHICH
// invoices the sweep announced.
const { emitInvoiceEventMock } = vi.hoisted(() => ({
  emitInvoiceEventMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../services/invoiceEvents', () => ({ emitInvoiceEvent: emitInvoiceEventMock }));

import { eq, sql } from 'drizzle-orm';
import postgres, { type Sql } from 'postgres';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, invoices } from '../../db/schema';
import { runOverdueSweep } from '../../services/invoiceService';
import { getTestDb } from './setup';

const RUN = !!process.env.DATABASE_URL;
const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';

// ---------------------------------------------------------------------------
// Race harness (pattern: invoiceIssueRace / paymentOverpayRace) — a dedicated
// superuser postgres.js client holds the invoice row lock while it commits a
// concurrent writer's change (a payment that settles the invoice, a void, a
// due-date push-out); the sweep is started against the app pool, and
// pg_blocking_pids proves it is queued on that lock before the holder commits.
// No fixed sleeps: a bounded poll waits on pg_blocking_pids.
// ---------------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

async function closeRaceClients(...clients: Sql[]): Promise<void> {
  const results = await Promise.allSettled(clients.map((client) => client.end({ timeout: 1 })));
  const failures = results.flatMap((r) => (r.status === 'rejected' ? [r.reason] : []));
  if (failures.length > 0) throw new AggregateError(failures, 'failed to close overdue-sweep race client(s)');
}

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
    if (Date.now() > deadline) throw new Error(`expected >= ${min} lock-blocked backends within 10s`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AS_OF = new Date('2026-03-15T12:00:00.000Z');
const PAST_DUE = '2026-03-01';
const FUTURE_DUE = '2026-04-30';

interface Fixture { partnerId: string; orgId: string }

async function seedFixture(): Promise<Fixture> {
  const suffix = Math.random().toString(36).slice(2, 10);
  return withSystemDbAccessContext(async () => {
    const [p] = await db.insert(partners).values({
      name: `Overdue ${suffix}`, slug: `overdue-${suffix}`, type: 'msp', plan: 'pro', status: 'active',
      currencyCode: 'USD',
    }).returning({ id: partners.id });
    const [o] = await db.insert(organizations).values({
      partnerId: p!.id, name: `Org ${suffix}`, slug: `overdue-org-${suffix}`, currencyCode: 'USD',
    }).returning({ id: organizations.id });
    return { partnerId: p!.id, orgId: o!.id };
  });
}

/** Forge an issued, unpaid, past-due invoice — a sweep candidate. */
async function forgeOpenPastDueInvoice(f: Fixture, invoiceNumber: string): Promise<string> {
  return withSystemDbAccessContext(async () => {
    const [inv] = await db.insert(invoices).values({
      partnerId: f.partnerId, orgId: f.orgId, currencyCode: 'USD',
      invoiceNumber, status: 'sent', issueDate: '2026-02-01', dueDate: PAST_DUE,
      subtotal: '100.00', total: '100.00', amountPaid: '0.00', balance: '100.00',
    }).returning({ id: invoices.id });
    return inv!.id;
  });
}

async function readInvoice(id: string) {
  const [row] = await withSystemDbAccessContext(() => db.select({
    status: invoices.status, markedOverdueAt: invoices.markedOverdueAt,
  }).from(invoices).where(eq(invoices.id, id)).limit(1));
  return row!;
}

/**
 * Run the sweep while `concurrentWrite` holds the contended invoice's row lock
 * (taken FOR UPDATE first, as the locking invoice writers do). The writer
 * commits only once the sweep is demonstrably blocked behind it.
 */
async function sweepRacingWriter(
  invoiceId: string,
  concurrentWrite: (tx: postgres.TransactionSql) => Promise<unknown>,
): Promise<number> {
  const locked = deferred<void>();
  const release = deferred<void>();
  const holder = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  let holderWork: Promise<void> | undefined;
  try {
    holderWork = holder.begin(async (tx) => {
      await tx`SELECT id FROM public.invoices WHERE id = ${invoiceId} FOR UPDATE`;
      await concurrentWrite(tx);
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const sweep = runOverdueSweep(AS_OF);
    await waitForBlockedBackends(1);
    release.resolve();
    await holderWork;
    return await sweep;
  } finally {
    release.resolve();
    if (holderWork) await Promise.allSettled([holderWork]);
    await closeRaceClients(holder);
  }
}

function overdueEventInvoiceIds(): string[] {
  return emitInvoiceEventMock.mock.calls
    .map(([event]) => event as { type: string; invoiceId: string })
    .filter((event) => event.type === 'invoice.overdue')
    .map((event) => event.invoiceId);
}

describe.runIf(RUN)('runOverdueSweep vs a concurrent invoice writer (#3803 item 2)', () => {
  beforeEach(() => {
    emitInvoiceEventMock.mockClear();
  });

  it.each([
    {
      name: 'a payment that settles the invoice',
      write: (tx: postgres.TransactionSql, id: string) => tx`
        UPDATE public.invoices
           SET status = 'paid', amount_paid = 100.00, balance = 0.00, paid_at = now(), updated_at = now()
         WHERE id = ${id}`,
      expected: 'paid',
    },
    {
      name: 'a void',
      write: (tx: postgres.TransactionSql, id: string) => tx`
        UPDATE public.invoices
           SET status = 'void', voided_at = now(), void_reason = 'race', updated_at = now()
         WHERE id = ${id}`,
      expected: 'void',
    },
    {
      name: 'a due-date push-out',
      write: (tx: postgres.TransactionSql, id: string) => tx`
        UPDATE public.invoices SET due_date = ${FUTURE_DUE}, updated_at = now() WHERE id = ${id}`,
      expected: 'sent',
    },
  ])('does not stamp overdue over $name committed while the sweep waited', async ({ write, expected }) => {
    const f = await seedFixture();
    const contended = await forgeOpenPastDueInvoice(f, 'RACE-1');
    // Uncontended control: proves the sweep still flips a genuinely past-due
    // invoice in the same run (the guard must not neuter the sweep).
    const control = await forgeOpenPastDueInvoice(f, 'RACE-2');

    const swept = await sweepRacingWriter(contended, (tx) => write(tx, contended));

    const contendedRow = await readInvoice(contended);
    expect(contendedRow.status).toBe(expected);
    expect(contendedRow.markedOverdueAt).toBeNull();
    expect((await readInvoice(control)).status).toBe('overdue');

    expect(swept).toBe(1);
    expect(overdueEventInvoiceIds()).toEqual([control]);
  });
});
