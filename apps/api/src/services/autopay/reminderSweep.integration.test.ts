import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTestDb } from '../../__tests__/integration/setup';
import { eq, inArray, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import {
  partners, organizations, invoices, billingPaymentSettings,
  orgAutopayEnrollments, invoiceAutopaySchedules, billingNoticeOutbox, stripeConnectAccounts,
  orgPaymentMethods, invoiceCollectionAttempts,
} from '../../db/schema';
import { STALE_REMINDER_REASON } from './reminderValidation';
import { runInvoiceReminderSweep } from './reminderSweep';
import { dispatchPendingBillingNotices } from './noticeOutbox';
const { send } = vi.hoisted(() => ({ send: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../email', () => ({ getEmailService: () => ({ sendEmail: send }) }));
beforeEach(() => send.mockClear());

async function fixture(labels?: string[]) {
  return withSystemDbAccessContext(async () => {
    const suffix = randomUUID();
    const [partner] = await db.insert(partners).values({
      name: 'Reminder Lab', slug: `reminder-${suffix}`, type: 'msp', plan: 'pro',
      status: 'active', currencyCode: 'USD', autopayEnabled: false,
    }).returning();
    await db.insert(billingPaymentSettings).values({
      partnerId: partner!.id, orgId: null, remindersEnabled: true,
      reminderBeforeDueDays: 3, reminderRepeatDays: 1, overdueReminderEveryDays: 7,
    });
    const [connection] = await db.insert(stripeConnectAccounts).values({
      partnerId: partner!.id, stripeAccountId: `acct_${suffix}`, apiKey: 'enc:synthetic', keyLast4: 'test',
      status: 'connected', livemode: false,
    }).returning();
    const created: { id: string; orgId: string; label: string }[] = [];
    const cases = labels ?? [
      'sent', 'partially_paid', 'overdue', 'archived', 'purging', 'merging',
      'disabled', 'missing-contact', 'invalid-contact', 'paid', 'void', 'zero', 'null-date',
      'awaiting_notice', 'scheduled', 'collecting', 'retry_scheduled',
      'failed', 'action_required', 'skipped_by_client',
    ];
    for (const label of cases) {
      const lifecycle = ['archived', 'purging', 'merging'].includes(label);
      const [org] = await db.insert(organizations).values({
        partnerId: partner!.id, currencyCode: 'EUR', name: label, slug: `${label}-${suffix}`,
        status: lifecycle ? label as 'archived' | 'purging' | 'merging' : 'active',
        billingContact: label === 'missing-contact' ? null : { email: label === 'invalid-contact' ? '@' : `${label}@example.test` },
      }).returning();
      if (label === 'disabled') await db.insert(billingPaymentSettings).values({
        orgId: org!.id, partnerId: null, remindersEnabled: false,
      });
      const [invoice] = await db.insert(invoices).values({
        partnerId: partner!.id, orgId: org!.id, invoiceNumber: `INV-${created.length}`,
        currencyCode: 'EUR', issueDate: '2026-09-01',
        dueDate: label === 'null-date' ? null : label === 'overdue' ? '2026-09-28' : '2026-10-08',
        status: ['sent', 'partially_paid', 'overdue', 'paid', 'void'].includes(label)
          ? label as 'sent' | 'partially_paid' | 'overdue' | 'paid' | 'void' : 'sent',
        subtotal: '100.00', total: '100.00',
        amountPaid: label === 'partially_paid' ? '74.95' : ['zero', 'paid'].includes(label) ? '100.00' : '0.00',
        balance: ['zero', 'paid'].includes(label) ? '0.00' : label === 'partially_paid' ? '25.05' : '100.00',
      }).returning();
      if (['awaiting_notice', 'scheduled', 'collecting', 'retry_scheduled', 'failed', 'action_required', 'skipped_by_client'].includes(label)) {
        const [enrollment] = await db.insert(orgAutopayEnrollments).values({
          partnerId: partner!.id, orgId: org!.id, status: 'requested', generation: 1,
          stripeConnectionId: connection!.id, stripeAccountId: connection!.stripeAccountId,
        }).returning();
        await db.insert(invoiceAutopaySchedules).values({
          orgId: org!.id, invoiceId: invoice!.id, enrollmentId: enrollment!.id,
          enrollmentGeneration: 1, eligible: true, collectOn: '2026-10-08', termsSnapshot: {},
          state: label as 'awaiting_notice' | 'scheduled' | 'collecting' | 'retry_scheduled' | 'failed' | 'action_required' | 'skipped_by_client',
        });
      }
      created.push({ id: invoice!.id, orgId: org!.id, label });
    }
    return { created, partnerId: partner!.id };
  });
}

describe('invoice reminder sweep against PostgreSQL', () => {
  it('allocates exactly one outbox row per kind/seq across concurrent sweeps', async () => {
    const f = await fixture();
    const now = new Date('2026-10-05T06:18:00Z');
    // Separate connections/transactions: never put Promise.all inside one system scope.
    const results = await Promise.all([runInvoiceReminderSweep(now), runInvoiceReminderSweep(now)]);
    expect(results.reduce((sum, result) => sum + result.enqueued, 0)).toBe(6);
    const rows = await withSystemDbAccessContext(() => db.select().from(billingNoticeOutbox)
      .where(inArray(billingNoticeOutbox.invoiceId, f.created.map(row => row.id))));
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map(row => row.dedupeKey)).size).toBe(6);
    const sentLabels = rows.map(row => f.created.find(i => i.id === row.invoiceId)!.label).sort();
    expect(sentLabels).toEqual(['action_required', 'failed', 'overdue', 'partially_paid', 'sent', 'skipped_by_client']);
    for (const row of rows) {
      expect(row.seq).toBe(1);
      expect(row.dedupeKey).toBe(`invoice:${row.invoiceId}:${row.kind}:1`);
      expect(row.toEmail).toBe(`${f.created.find(i => i.id === row.invoiceId)!.label}@example.test`);
      expect(row.status).toBe('pending');
    }
    const partial = rows.find(row => row.invoiceId === f.created.find(i => i.label === 'partially_paid')!.id)!;
    expect(partial.rendered).toMatchObject({ frozen: { amount: '25.05', currency: 'EUR' } });
    expect(await runInvoiceReminderSweep(now)).toEqual({ enqueued: 0, skippedNoContact: 2 });

    // Pending/failed are already allocated, even though not yet sent.
    await withSystemDbAccessContext(() => db.update(billingNoticeOutbox).set({ status: 'failed' })
      .where(eq(billingNoticeOutbox.id, partial.id)));
    expect(await runInvoiceReminderSweep(now)).toEqual({ enqueued: 0, skippedNoContact: 2 });
    await withSystemDbAccessContext(() => db.update(billingNoticeOutbox).set({ status: 'pending' })
      .where(eq(billingNoticeOutbox.id, partial.id)));
    const dispatched = await Promise.all([
      dispatchPendingBillingNotices(new Date(Date.now() + 1000)),
      dispatchPendingBillingNotices(new Date(Date.now() + 1000)),
    ]);
    expect(dispatched.reduce((sum, result) => sum + result.sent, 0)).toBe(6);
    expect(send).toHaveBeenCalledTimes(6);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'billing.notice' }));
    await dispatchPendingBillingNotices(new Date(Date.now() + 1000));
    expect(send).toHaveBeenCalledTimes(6);

    const next = await Promise.all([
      runInvoiceReminderSweep(new Date('2026-10-06T06:18:00Z')),
      runInvoiceReminderSweep(new Date('2026-10-06T06:18:00Z')),
    ]);
    expect(next.reduce((sum, result) => sum + result.enqueued, 0)).toBe(5);
    const second = await withSystemDbAccessContext(() => db.select().from(billingNoticeOutbox)
      .where(eq(billingNoticeOutbox.seq, 2)));
    expect(second).toHaveLength(5);
    expect(second.every(row => row.kind === 'payment_reminder')).toBe(true);
    await dispatchPendingBillingNotices(new Date(Date.now() + 1000));
    expect(send).toHaveBeenCalledTimes(11);
  });
  it('stops allocating after payment', async () => {
    const f = await fixture();
    await runInvoiceReminderSweep(new Date('2026-10-05T06:18:00Z'));
    await withSystemDbAccessContext(() => db.update(invoices)
      .set({ status: 'paid', amountPaid: '100.00', balance: '0.00' })
      .where(inArray(invoices.id, f.created.map(row => row.id))));
    expect(await runInvoiceReminderSweep(new Date('2026-10-06T06:18:00Z'))).toEqual({ enqueued: 0, skippedNoContact: 0 });
  });
});

// Hold a real payment transaction open until the sweep has discovered the invoice
// and is waiting for its row lock. No query or service is mocked here.
describe('eligibility changes between discovery and locking', () => {
  it.each(['paid', 'void'] as const)('does not allocate after a concurrent %s update', async (status) => {
    expect(runInvoiceReminderSweep).toBeTypeOf('function');
    const f = await fixture();
    const target = f.created.find(row => row.label === 'sent')!;
    let blockerPid = 0;
    let release!: () => void;
    let locked!: () => void;
    const ready = new Promise<void>(resolve => { locked = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const payment = withSystemDbAccessContext(async () => {
      const [backend] = await db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      blockerPid = backend!.pid;
      await db.select().from(invoices).where(eq(invoices.id, target.id)).for('update');
      locked();
      await resume;
      await db.update(invoices).set(status === 'paid'
        ? { status, amountPaid: '100.00', balance: '0.00' } : { status })
        .where(eq(invoices.id, target.id));
    });
    await ready;
    const sweep = runInvoiceReminderSweep(new Date('2026-10-05T06:18:00Z'));
    // Attach rejection immediately so an early implementation failure is observed.
    const settled = sweep.then(value => ({ value }), error => ({ error }));
    try {
      await expect.poll(async () => {
        const waiting = await getTestDb().execute(sql`
          SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database()
            AND ${blockerPid} = ANY(pg_blocking_pids(pid))
        `);
        return waiting.length;
      }, { timeout: 5000 }).toBeGreaterThan(0);
    } finally {
      release();
      await payment;
      await settled;
    }
    expect(await sweep).toEqual({ enqueued: 5, skippedNoContact: 2 });
    const rows = await withSystemDbAccessContext(() => db.select().from(billingNoticeOutbox)
      .where(eq(billingNoticeOutbox.invoiceId, target.id)));
    expect(rows).toHaveLength(0);
  });
});

const nonLiveStates = [
  ...(['suspended', 'churned', 'offboarding', 'merging', 'archived', 'purging', 'deleted'] as const)
    .map(state => ({ axis: 'org' as const, state })),
  ...(['pending', 'suspended', 'churned', 'offboarding', 'deleted'] as const)
    .map(state => ({ axis: 'partner' as const, state })),
];
async function makeNonLive(f: Awaited<ReturnType<typeof fixture>>, axis: 'org' | 'partner', state: string) {
  await withSystemDbAccessContext(async () => {
    if (axis === 'org') await db.update(organizations).set(state === 'deleted'
      ? { deletedAt: new Date() } : { status: state as typeof organizations.$inferSelect.status })
      .where(eq(organizations.id, f.created[0]!.orgId));
    else await db.update(partners).set(state === 'deleted'
      ? { deletedAt: new Date() } : { status: state as typeof partners.$inferSelect.status })
      .where(eq(partners.id, f.partnerId));
  });
}

describe('reminder liveness and dispatch validation', () => {
  it.each(nonLiveStates)('excludes $axis $state with a live trial control', async ({ axis, state }) => {
    const blocked = await fixture(['sent']);
    const live = await fixture(['sent']);
    await makeNonLive(blocked, axis, state);
    await withSystemDbAccessContext(() => db.update(organizations).set({ status: 'trial' })
      .where(eq(organizations.id, live.created[0]!.orgId)));
    expect(await runInvoiceReminderSweep(new Date('2026-10-05T06:18:00Z'))).toEqual({ enqueued: 1, skippedNoContact: 0 });
    const rows = await withSystemDbAccessContext(() => db.select().from(billingNoticeOutbox));
    expect(rows.map(row => row.invoiceId)).toEqual([live.created[0]!.id]);
  });
  it.each(['paid', 'void', 'draft', 'zero', 'negative', 'open'] as const)('revalidates queued reminders when invoice is %s', async state => {
    const f = await fixture(['sent', 'overdue']);
    await runInvoiceReminderSweep(new Date('2026-10-05T06:18:00Z'));
    if (state !== 'open') await withSystemDbAccessContext(() => db.update(invoices).set(
      state === 'zero' || state === 'negative' ? { balance: state === 'zero' ? '0.00' : '-1.00' }
        : { status: state, ...(state === 'paid' ? { balance: '0.00', amountPaid: '100.00' } : {}) },
    ).where(inArray(invoices.id, f.created.map(row => row.id))));
    expect(await dispatchPendingBillingNotices(new Date(Date.now() + 1000))).toEqual({ sent: state === 'open' ? 2 : 0, failed: 0 });
    const rows = await withSystemDbAccessContext(() => db.select().from(billingNoticeOutbox));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe(state === 'open' ? 'sent' : 'cancelled');
      if (state !== 'open') { expect(row.lastError).toBeTruthy(); }
    }
    await dispatchPendingBillingNotices(new Date(Date.now() + 86400000));
    expect(send).toHaveBeenCalledTimes(state === 'open' ? 2 : 0);
  });
  it.each(nonLiveStates)('cancels queued reminders after $axis becomes $state', async ({ axis, state }) => {
    const f = await fixture(['sent']);
    await runInvoiceReminderSweep(new Date('2026-10-05T06:18:00Z'));
    await makeNonLive(f, axis, state);
    expect(await dispatchPendingBillingNotices(new Date(Date.now() + 1000))).toEqual({ sent: 0, failed: 0 });
    expect(send).not.toHaveBeenCalled();
    const [row] = await withSystemDbAccessContext(() => db.select().from(billingNoticeOutbox));
    expect(row).toMatchObject({ status: 'cancelled' });
    expect(row!.lastError).toBeTruthy();
  });
  it('keeps overdue sequence independent after upcoming sequences 1–3 have sent', async () => {
    const f = await fixture(['sent']);
    for (const day of ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-15', '2026-10-22']) {
      expect(await runInvoiceReminderSweep(new Date(`${day}T06:18:00Z`))).toEqual({ enqueued: 1, skippedNoContact: 0 });
      expect(await dispatchPendingBillingNotices(new Date(Date.now() + 1000))).toEqual({ sent: 1, failed: 0 });
    }
    const rows = await withSystemDbAccessContext(() => db.select().from(billingNoticeOutbox)
      .where(eq(billingNoticeOutbox.invoiceId, f.created[0]!.id)));
    expect(rows.map(row => `${row.kind}:${row.seq}:${row.status}`).sort()).toEqual([
      'payment_overdue:1:sent', 'payment_overdue:2:sent',
      'payment_reminder:1:sent', 'payment_reminder:2:sent', 'payment_reminder:3:sent',
    ]);
    expect(send).toHaveBeenCalledTimes(5);
  });
});

// G: a reminder must not say "View & pay" while a payment is already in flight
// (e.g. "Pay by bank and set up autopay" creates an unscheduled ACH attempt).
async function inFlightAttempt(f: Awaited<ReturnType<typeof fixture>>, label: string,
  state: 'processing' | 'requires_action' = 'processing') {
  const target = f.created.find(row => row.label === label)!;
  return withSystemDbAccessContext(async () => {
    const [connection] = await db.select().from(stripeConnectAccounts).where(eq(stripeConnectAccounts.partnerId, f.partnerId));
    // An off-session attempt belongs to the fixture's own schedule (e.g. an 'action_required' 3DS wait).
    const [schedule] = await db.select().from(invoiceAutopaySchedules).where(eq(invoiceAutopaySchedules.invoiceId, target.id));
    const [enrollment] = schedule
      ? await db.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.id, schedule.enrollmentId!))
      : await db.insert(orgAutopayEnrollments).values({
        partnerId: f.partnerId, orgId: target.orgId, status: 'active', generation: 1,
        stripeConnectionId: connection!.id, stripeAccountId: connection!.stripeAccountId,
        stripeCustomerId: `cus_${target.id}`, effectiveFrom: new Date('2026-01-01'), requestedAt: new Date('2026-01-01'),
      }).returning();
    const [method] = await db.insert(orgPaymentMethods).values({ orgId: target.orgId, enrollmentId: enrollment!.id,
      stripePaymentMethodId: `pm_${target.id}`, type: 'us_bank_account', bankName: 'Test bank', bankLast4: '6789',
      accountHolderType: 'company', status: 'active', isAutopayMethod: true }).returning();
    const [attempt] = await db.insert(invoiceCollectionAttempts).values({ orgId: target.orgId, invoiceId: target.id,
      scheduleId: schedule?.id ?? null, attemptNo: 1, paymentMethodId: method!.id, stripePaymentIntentId: `pi_${target.id}`,
      idempotencyKey: `reminder_in_flight_${target.id}`, principalAmount: '100.00', feeAmount: '0.00', currency: 'EUR',
      state, initiatedBy: schedule ? 'scheduler' : 'client_on_session' }).returning();
    return { target, attemptId: attempt!.id };
  });
}
describe('reminders while a payment is in flight', () => {
  it('does not enqueue a reminder for an invoice with a processing bank payment', async () => {
    const f = await fixture(['sent']);
    await inFlightAttempt(f, 'sent');
    expect(await runInvoiceReminderSweep(new Date('2026-10-05T06:18:00Z'))).toEqual({ enqueued: 0, skippedNoContact: 0 });
  });
  it('cancels a queued reminder at dispatch once a payment is in flight, then resumes after it fails', async () => {
    const f = await fixture(['sent']);
    expect(await runInvoiceReminderSweep(new Date('2026-10-05T06:18:00Z'))).toEqual({ enqueued: 1, skippedNoContact: 0 });
    const { target, attemptId } = await inFlightAttempt(f, 'sent');
    expect(await dispatchPendingBillingNotices(new Date(Date.now() + 1000))).toEqual({ sent: 0, failed: 0 });
    expect(send).not.toHaveBeenCalled();
    const [row] = await withSystemDbAccessContext(() => db.select().from(billingNoticeOutbox)
      .where(eq(billingNoticeOutbox.invoiceId, target.id)));
    expect(row).toMatchObject({ status: 'cancelled', lastError: 'Payment in progress' });
    await withSystemDbAccessContext(() => db.update(invoiceCollectionAttempts)
      .set({ state: 'failed', failureClass: 'nsf' }).where(eq(invoiceCollectionAttempts.id, attemptId)));
    expect(await runInvoiceReminderSweep(new Date('2026-10-06T06:18:00Z'))).toEqual({ enqueued: 1, skippedNoContact: 0 });
  });
  // A payment waiting on the client's bank (3DS) completes only if they act, and the
  // invoice page offers "Continue to payment": the reminder must still go out.
  it('still enqueues a reminder while an off-session payment waits on bank confirmation', async () => {
    const f = await fixture(['action_required']);
    await inFlightAttempt(f, 'action_required', 'requires_action');
    expect(await runInvoiceReminderSweep(new Date('2026-10-05T06:18:00Z'))).toEqual({ enqueued: 1, skippedNoContact: 0 });
    expect(await dispatchPendingBillingNotices(new Date(Date.now() + 1000))).toEqual({ sent: 1, failed: 0 });
  });
  it('sends a queued reminder at dispatch when the payment then waits on bank confirmation', async () => {
    const f = await fixture(['action_required']);
    expect(await runInvoiceReminderSweep(new Date('2026-10-05T06:18:00Z'))).toEqual({ enqueued: 1, skippedNoContact: 0 });
    const { target } = await inFlightAttempt(f, 'action_required', 'requires_action');
    expect(await dispatchPendingBillingNotices(new Date(Date.now() + 1000))).toEqual({ sent: 1, failed: 0 });
    const [row] = await withSystemDbAccessContext(() => db.select().from(billingNoticeOutbox)
      .where(eq(billingNoticeOutbox.invoiceId, target.id)));
    expect(row).toMatchObject({ status: 'sent', lastError: null });
  });
});

// H: a reminder states the balance and due date frozen at enqueue. If they change
// before dispatch it is cancelled, and the next sweep sends a current replacement.
async function reminderRows(invoiceId: string) {
  const rows = await withSystemDbAccessContext(() => db.select().from(billingNoticeOutbox)
    .where(eq(billingNoticeOutbox.invoiceId, invoiceId)));
  return rows.sort((a, b) => a.dedupeKey.localeCompare(b.dedupeKey));
}
describe('stale reminder replacement', () => {
  it('cancels an overdue reminder after a partial payment and replaces it on the next sweep', async () => {
    const f = await fixture(['overdue']);
    const target = f.created[0]!;
    expect(await runInvoiceReminderSweep(new Date('2026-10-05T06:18:00Z'))).toEqual({ enqueued: 1, skippedNoContact: 0 });
    await withSystemDbAccessContext(() => db.update(invoices).set({ amountPaid: '40.00', balance: '60.00' })
      .where(eq(invoices.id, target.id)));
    expect(await dispatchPendingBillingNotices(new Date(Date.now() + 1000))).toEqual({ sent: 0, failed: 0 });
    expect(send).not.toHaveBeenCalled();
    expect((await reminderRows(target.id))[0]).toMatchObject({ status: 'cancelled', lastError: STALE_REMINDER_REASON });

    // 10-06 is not a cadence day, but the cancelled step is replaced with current values.
    expect(await runInvoiceReminderSweep(new Date('2026-10-06T06:18:00Z'))).toEqual({ enqueued: 1, skippedNoContact: 0 });
    const [, replacement] = await reminderRows(target.id);
    expect(replacement).toMatchObject({ kind: 'payment_overdue', seq: 1, status: 'pending',
      dedupeKey: `invoice:${target.id}:payment_overdue:1:r1`, rendered: { frozen: { amount: '60.00', daysOverdue: 8 } } });
    expect(await dispatchPendingBillingNotices(new Date(Date.now() + 1000))).toEqual({ sent: 1, failed: 0 });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('60.00') }));

    expect(await runInvoiceReminderSweep(new Date('2026-10-07T06:18:00Z'))).toEqual({ enqueued: 0, skippedNoContact: 0 });
    expect(await runInvoiceReminderSweep(new Date('2026-10-12T06:18:00Z'))).toEqual({ enqueued: 1, skippedNoContact: 0 });
    const keys = (await reminderRows(target.id)).map(row => `${row.dedupeKey.split(':').slice(2).join(':')}:${row.status}`);
    expect(keys).toEqual(['payment_overdue:1:cancelled', 'payment_overdue:1:r1:sent', 'payment_overdue:2:pending']);
  });
  it('replaces a stale reminder the same day when the sweep runs again', async () => {
    const f = await fixture(['sent']);
    const target = f.created[0]!;
    await runInvoiceReminderSweep(new Date('2026-10-05T06:18:00Z'));
    await withSystemDbAccessContext(() => db.update(invoices).set({ amountPaid: '10.00', balance: '90.00' }).where(eq(invoices.id, target.id)));
    await dispatchPendingBillingNotices(new Date(Date.now() + 1000));
    expect((await reminderRows(target.id))[0]).toMatchObject({ status: 'cancelled', lastError: STALE_REMINDER_REASON });
    expect(await runInvoiceReminderSweep(new Date('2026-10-05T07:30:00Z'))).toEqual({ enqueued: 1, skippedNoContact: 0 });
    const [, replacement] = await reminderRows(target.id);
    expect(replacement).toMatchObject({ dedupeKey: `invoice:${target.id}:payment_reminder:1:r1`,
      rendered: { frozen: { amount: '90.00', dueDate: '2026-10-08' } } });
  });
  it('cancels a reminder for a moved due date and reminds on the new cadence', async () => {
    const f = await fixture(['sent']);
    const target = f.created[0]!;
    await runInvoiceReminderSweep(new Date('2026-10-05T06:18:00Z'));
    await withSystemDbAccessContext(() => db.update(invoices).set({ dueDate: '2026-10-09' }).where(eq(invoices.id, target.id)));
    await dispatchPendingBillingNotices(new Date(Date.now() + 1000));
    expect(send).not.toHaveBeenCalled();
    expect((await reminderRows(target.id))[0]).toMatchObject({ status: 'cancelled', lastError: STALE_REMINDER_REASON });
    // Three days before the new due date is 10-06; nothing is due for it on 10-05.
    expect(await runInvoiceReminderSweep(new Date('2026-10-05T07:30:00Z'))).toEqual({ enqueued: 0, skippedNoContact: 0 });
    expect(await runInvoiceReminderSweep(new Date('2026-10-06T06:18:00Z'))).toEqual({ enqueued: 1, skippedNoContact: 0 });
    const [, replacement] = await reminderRows(target.id);
    expect(replacement).toMatchObject({ seq: 1, rendered: { frozen: { dueDate: '2026-10-09' } } });
    await dispatchPendingBillingNotices(new Date(Date.now() + 1000));
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('does not backfill a missed off-cadence step that was never cancelled as stale', async () => {
    const f = await fixture(['overdue']);
    expect(await runInvoiceReminderSweep(new Date('2026-10-06T06:18:00Z'))).toEqual({ enqueued: 0, skippedNoContact: 0 });
    expect(await reminderRows(f.created[0]!.id)).toHaveLength(0);
  });
});
