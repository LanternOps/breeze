import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  active: vi.fn(),
  resolve: vi.fn(),
  notice: vi.fn(),
  staff: vi.fn(),
  confirmation: vi.fn(),
}));
vi.mock('./stripeCapabilities', () => ({
  getAutopayStripeReadiness: vi
    .fn()
    .mockResolvedValue({ ready: true, stripeAccountId: 'account', accountCountry: 'US' }),
}));
vi.mock('./paymentMethods', () => ({
  getAutopayMethod: vi
    .fn()
    .mockResolvedValue({
      id: 'method', orgId:'org',enrollmentId:'enrollment',isAutopayMethod:true,
      type: 'card',
      status: 'active',
      cardFunding: 'credit',
      cardLast4: '4242',
      accountHolderType: null,
    }),
}));
vi.mock('./reservation', () => ({ assertNoActiveCollection: h.active }));
vi.mock('./linkTokens', () => ({ resolveBillingLinkToken: h.resolve }));
vi.mock('./chargingNotice', () => ({ enqueueAutopayNotice: h.notice }));
vi.mock('./staffNotifications', () => ({ enqueueAutopayStaffNotifications: h.staff }));
vi.mock('./noticeOutbox', () => ({ enqueueBillingNotice: h.confirmation }));
vi.mock('../invoiceLinkToken', () => ({
  getOrMintInvoiceLink: vi.fn().mockResolvedValue({ token: 'secret' }),
  buildPublicInvoiceUrl: () => 'https://portal.example.test/invoice/secret',
}));
vi.mock('./renderBillingNotice', () => ({
  renderBillingNotice: vi
    .fn()
    .mockResolvedValue({
      subject: 'Reminder',
      html: '<p>Invoice</p>',
      text: 'Invoice',
      frozen: {},
    }),
}));
import {
  assertControllable,
  renoticeSchedule,
  skipInvoice,
  setInvoiceAutopayExcluded,
  getInvoiceAutopayView,
} from './invoiceControls';
import { planAutopayForInvoice } from './scheduler';
import { collectionFenced, finalizeInvoiceControl } from './collectionControl';
import { InvoiceServiceError } from '../invoiceTypes';
import {
  invoices,
  invoiceAutopaySchedules,
  invoiceCollectionAttempts,
  billingNoticeOutbox,
  invoiceLines,
  orgAutopayEnrollments,
  organizations,
  partners,
} from '../../db/schema';
const invoice = {
  id: '10000000-0000-4000-8000-000000000001',
  orgId: 'org',
  partnerId: 'partner',
  siteId: null,
  status: 'sent',
  issueDate: '2026-10-01',
  dueDate: '2026-10-15',
  balance: '10.00',
  currencyCode: 'USD',
  invoiceNumber: 'INV-1',
  autopayExcluded: false,
  updatedAt: new Date('2026-10-01'),
  total: '10.00',
};
const schedule = {
  id: 'schedule',
  invoiceId: invoice.id,
  orgId: 'org',
  state: 'scheduled',
  enrollmentId: 'enrollment',
  enrollmentGeneration: 1,
  eligible: true,
  ineligibleReason: null,
  clientSkippedAt: null,
  mspExcludedAt: null,
  stateReason: null,
  noticeOutboxId: 'notice',
  termsSnapshot: { issuedAt:'2026-10-01T00:00:00Z',offsetDays:0,rule:'later',cap:{enabled:false},noticeLeadDays:1,noticeSeq:1,methodId:'method',methodType:'card',accountHolderType:null,last4:'4242',methodLabel:'Card',principal:'10.00',currency:'USD',feeAmount:'0.00',feeKind:'none',cardFeeBps:0,achFeeAmount:'0.00',chargeDate:'2026-10-15' },
  noticeSentAt: new Date(),
  collectOn: '2026-10-15',
};
const actor = {
  userId: 'user',
  partnerId: 'partner',
  accessibleOrgIds: null,
  allowedSiteIds: null,
} as any;
function fixture(over: Record<string, unknown> = {}, attempts: unknown[] = []) {
  const inv = { ...invoice };
  const sched = { ...schedule, ...over };
  const writes: { table: unknown; patch: any }[] = [];
  const data = new Map<unknown, any[]>([
    [invoices, [inv]],
    [invoiceAutopaySchedules, [sched]],
    [invoiceCollectionAttempts, attempts],
    [
      orgAutopayEnrollments,
      [
        {
          id: 'enrollment',
          orgId: 'org',
          generation: 1,
          status: 'active',
          effectiveFrom: new Date('2026-09-01'),
          stripeAccountId: 'account',
        },
      ],
    ],
    [organizations, [{ status:'active',deletedAt:null,name: 'Customer', billingContact: { email: 'billing@example.test' } }]],
    [partners, [{ enabled: true, name: 'Partner', settings: {} }]],
  ]);
  const tx: any = {
    select: () => chain(),
    update: (table: unknown) => chain(table, true),
    insert: (table: unknown) => ({
      values: (value: unknown) => ({
        returning: async () => {
          const row = { ...sched, ...(value as object) };
          data.set(table, [row]);
          return [row];
        },
      }),
    }),
  };
  function chain(table?: unknown, update = false) {
    let patch: any;
    const c: any = {};
    for (const method of ['where', 'limit', 'for', 'innerJoin']) c[method] = () => c;
    c.from = (t: unknown) => {
      table = t;
      return c;
    };
    c.set = (p: any) => {
      patch = p;
      return c;
    };
    c.returning = () => c;
    c.then = (resolve: any, reject: any) =>
      Promise.resolve()
        .then(() => {
          if (update) {
            writes.push({ table, patch });
            for (const row of data.get(table) ?? []) Object.assign(row, patch);
            return data.get(table) ?? [];
          }
          return data.get(table) ?? [];
        })
        .then(resolve, reject);
    return c;
  }
  return { tx, inv, sched, writes, data };
}
beforeEach(() => {
  vi.clearAllMocks();
  h.resolve.mockResolvedValue({
    id: 'token',
    invoiceId: invoice.id,
    orgId: 'org',
    enrollmentId: 'enrollment',
    generation: 1,
  });
});
it('refuses unsafe restoration while money is reserved', async () => {
  h.active.mockRejectedValueOnce(
    Object.assign(new Error('Payment is processing'), {
      status: 409,
      code: 'COLLECTION_IN_PROGRESS',
    }),
  );
  await expect(assertControllable({} as never, invoice.id)).rejects.toMatchObject({
    code: 'COLLECTION_IN_PROGRESS',
  });
});
it('does not restore a merged schedule with no enrollment', async () => {
  const f = fixture({ enrollmentId: null });
  await renoticeSchedule(f.tx, invoice.id);
  expect(f.writes).toEqual([]);
});
it.each([
  'skipped_by_client',
  'retry_scheduled',
  'cancelled',
  'failed',
  'succeeded',
  'excluded_by_msp',
])('does not replan %s', async (state) => {
  const f = fixture({ state });
  await renoticeSchedule(f.tx, invoice.id);
  expect(f.writes).toEqual([]);
  expect(h.notice).not.toHaveBeenCalled();
});
it('clears notice authority and increments sequence for a scheduled due-date edit', async () => {
  const f = fixture();
  await renoticeSchedule(f.tx, invoice.id);
  expect(f.sched).toMatchObject({
    state: 'awaiting_notice',
    noticeSentAt: null,
    noticeOutboxId: null,
    termsSnapshot: { noticeSeq: 2 },
  });
  expect(h.notice).toHaveBeenCalledExactlyOnceWith(f.tx, 'schedule');
});
it.each(['reserved', 'created', 'confirming', 'processing', 'requires_action'])(
  'fences %s without releasing or confirming money; replay is idempotent',
  async (state) => {
    const f = fixture({}, [{ id: 'attempt', state }]);
    const first = await skipInvoice(f.tx, 'token');
    expect(first).toMatchObject({ status: 'pending', control: 'skip' });
    expect(f.sched.clientSkippedAt).toBeInstanceOf(Date);
    expect(f.sched).toMatchObject({ state: 'scheduled', stateReason: 'control_pending:skip' });
    const n = f.writes.length;
    expect(await skipInvoice(f.tx, 'token')).toMatchObject({ status: 'pending', control: 'skip' });
    expect(f.writes).toHaveLength(n);
    expect(f.writes.some((w) => w.table === invoiceCollectionAttempts)).toBe(false);
    expect(h.confirmation).not.toHaveBeenCalled();
    expect(h.staff).not.toHaveBeenCalled();
  },
);
it('finalizes once, enqueues seq zero confirmation and one staff event, replay has no writes', async () => {
  const f = fixture();
  expect(await skipInvoice(f.tx, 'token')).toMatchObject({ status: 'skipped' });
  expect(f.sched).toMatchObject({ state: 'skipped_by_client', nextAttemptAt: null });
  expect(h.confirmation).toHaveBeenCalledExactlyOnceWith(
    f.tx,
    expect.objectContaining({
      kind: 'payment_reminder',
      seq: 0,
      dedupeKey: `invoice:${invoice.id}:skip:1`,
    }),
  );
  expect(h.staff).toHaveBeenCalledExactlyOnceWith(
    f.tx,
    expect.objectContaining({
      event: 'autopay.skipped',
      dedupeKey: `autopay:${invoice.id}:skipped`,
    }),
  );
  const n = f.writes.length;
  expect(await skipInvoice(f.tx, 'token')).toMatchObject({ status: 'skipped' });
  expect(f.writes).toHaveLength(n);
  expect(h.confirmation).toHaveBeenCalledOnce();
});
it.each([{ enrollmentId: null }, { state: 'succeeded' }, { state: 'failed' }])(
  'rejects unavailable or terminal skip %j',
  async (over) => {
    const f = fixture(over);
    await expect(skipInvoice(f.tx, 'token')).rejects.toBeInstanceOf(InvoiceServiceError);
    expect(f.writes).toEqual([]);
  },
);
it('rejects stale enrollment generation before any fence', async () => {
  const f = fixture({ enrollmentGeneration: 2 });
  await expect(skipInvoice(f.tx, 'token')).rejects.toMatchObject({ status: 404 });
  expect(f.writes).toEqual([]);
});
it.each([{ accessibleOrgIds: ['other'] }, { allowedSiteIds: ['other'] }])(
  'preserves actor access gates %j',
  async (restricted) => {
    const f = fixture();
    f.inv.siteId = 'site' as any;
    await expect(
      setInvoiceAutopayExcluded(f.tx, invoice.id, true, { ...actor, ...restricted }),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.writes).toEqual([]);
  },
);
it('rejects missing invoice', async () => {
  const f = fixture();
  f.data.set(invoices, []);
  await expect(setInvoiceAutopayExcluded(f.tx, invoice.id, true, actor)).rejects.toMatchObject({
    status: 404,
  });
});
it('exclusion fences outstanding action-required money and cannot be removed while pending', async () => {
  const f = fixture({}, [{ state: 'requires_action' }]);
  expect(await setInvoiceAutopayExcluded(f.tx, invoice.id, true, actor)).toMatchObject({
    status: 'pending',
    control: 'exclude',
  });
  expect(f.inv.autopayExcluded).toBe(true);
  expect(f.sched.mspExcludedAt).toBeInstanceOf(Date);
  h.active.mockRejectedValueOnce(Object.assign(new Error('processing'), { status: 409 }));
  await expect(setInvoiceAutopayExcluded(f.tx, invoice.id, false, actor)).rejects.toMatchObject({
    status: 409,
  });
  expect(f.inv.autopayExcluded).toBe(true);
});
it('never replans a client skip on MSP reinclusion', async () => {
  const f = fixture({ state: 'skipped_by_client', clientSkippedAt: new Date() });
  await setInvoiceAutopayExcluded(f.tx, invoice.id, false, actor);
  expect(f.sched.state).toBe('skipped_by_client');
  expect(h.notice).not.toHaveBeenCalled();
});
it('fence predicate covers each authority marker', () => {
 const base={schedule:{clientSkippedAt:null,mspExcludedAt:null},invoice:{autopayExcluded:false},enrollment:{status:'active' as const}};
 expect(collectionFenced(base)).toBe(false);
 for(const patch of [{schedule:{...base.schedule,clientSkippedAt:new Date()}},{schedule:{...base.schedule,mspExcludedAt:new Date()}},{invoice:{autopayExcluded:true}},{enrollment:{status:'cancelled' as const}}])expect(collectionFenced({...base,...patch})).toBe(true);
});

it('retains a read-only processing/unapplied projection after rollout disable', async () => {
  const f = fixture({}, [{ state: 'processing' }, { state: 'unapplied' }]);
  f.data.set(partners, [{ enabled: false }]);
  expect(await getInvoiceAutopayView(f.tx, f.inv as any)).toMatchObject({
    processing: true,
    unapplied: true,
    canExclude: false,
    canChargeNow: false,
  });
});
it('hides disabled idle autopay', async () => {
  const f = fixture();
  f.data.set(partners, [{ enabled: false }]);
  expect(await getInvoiceAutopayView(f.tx, f.inv as any)).toBeNull();
});

it.each([null, 'succeeded', 'failed', 'cancelled', 'excluded_by_msp', 'skipped_by_client', 'not_needed'])(
  'keeps exclusion pending for invoice-wide reservations with schedule %s',
  async (state) => {
    const attempt = {
      id: 'attempt',
      invoiceId: invoice.id,
      state: 'requires_action',
      scheduleId: null,
    };
    const f = fixture({ state, enrollmentId: null }, [attempt]);
    const history = { ...f.sched };
    if (state === null) f.data.set(invoiceAutopaySchedules, []);
    if (state === 'excluded_by_msp') f.inv.autopayExcluded = true;

    const result = await setInvoiceAutopayExcluded(f.tx, invoice.id, true, actor);

    expect(result).toEqual({ status: 'pending', control: 'exclude' });
    expect(f.inv.autopayExcluded).toBe(true);
    if (state !== null) {
      expect(f.sched).toEqual(history);
    } else {
      expect(f.data.get(invoiceAutopaySchedules)).toEqual([]);
    }
    expect(f.data.get(invoiceCollectionAttempts)).toEqual([attempt]);
    expect(f.writes.some((write) => write.table === invoiceCollectionAttempts)).toBe(false);
    expect(f.writes.some((write) => write.table === invoiceAutopaySchedules)).toBe(false);
    const writes = f.writes.length;

    expect(await setInvoiceAutopayExcluded(f.tx, invoice.id, true, actor)).toEqual(result);
    expect(f.writes).toHaveLength(writes);
    expect(h.notice).not.toHaveBeenCalled();
    expect(h.confirmation).not.toHaveBeenCalled();
    expect(h.staff).not.toHaveBeenCalled();
  },
);

it('projects a schedule-less pending exclusion through the invoice fence and attempt', async () => {
  const f = fixture({}, [{ state: 'requires_action' }]);
  f.data.set(invoiceAutopaySchedules, []);
  f.inv.autopayExcluded = true;

  const view = await getInvoiceAutopayView(f.tx, f.inv as any);

  expect(view).toMatchObject({
    reason: 'control_pending:exclude',
    excluded: true,
    canExclude: false,
  });
});

it('reincludes an invoice excluded before issuance using its existing issuance snapshot', async () => {
  const f = fixture();
  f.inv.status = 'draft';
  f.data.set(invoiceAutopaySchedules, []);
  await setInvoiceAutopayExcluded(f.tx, invoice.id, true, actor);
  expect(f.inv.autopayExcluded).toBe(true);

  f.inv.status = 'sent';
  const issued = await planAutopayForInvoice(f.tx, invoice.id);
  expect(issued).toMatchObject({
    state: 'not_needed',
    eligible: false,
    ineligibleReason: 'excluded_invoice',
  });
  expect(h.notice).not.toHaveBeenCalled();

  const result = await setInvoiceAutopayExcluded(f.tx, invoice.id, false, actor);

  expect(result).toEqual({ status: 'included' });
  expect(f.inv.autopayExcluded).toBe(false);
  expect(f.data.get(invoiceAutopaySchedules)).toEqual([
    expect.objectContaining({
      id: issued!.id,
      state: 'awaiting_notice',
      eligible: true,
      ineligibleReason: null,
      noticeSentAt: null,
      noticeOutboxId: null,
      termsSnapshot: expect.objectContaining({ noticeSeq: 2 }),
    }),
  ]);
  expect(h.notice).toHaveBeenCalledExactlyOnceWith(f.tx, issued!.id);
});

it.each([
  'no enrollment',
  'stale generation',
  'inactive enrollment',
  'foreign enrollment',
  'excluded contract',
  'other ineligibility',
  'no snapshot',
])('does not restore an issuance exclusion with %s', async (reason) => {
  const f = fixture({ state: 'not_needed', eligible: false, ineligibleReason: 'excluded_invoice' });
  f.inv.autopayExcluded = true;
  if (reason === 'no enrollment') f.sched.enrollmentId = null as any;
  if (reason === 'stale generation') f.sched.enrollmentGeneration = 2;
  if (reason === 'inactive enrollment') f.data.get(orgAutopayEnrollments)![0].status = 'cancelled';
  if (reason === 'foreign enrollment') f.data.get(orgAutopayEnrollments)![0].orgId = 'other';
  if (reason === 'excluded contract') f.data.set(invoiceLines, [{ id: 'excluded-contract' }]);
  if (reason === 'other ineligibility') f.sched.ineligibleReason = 'over_cap' as any;
  if (reason === 'no snapshot') f.data.set(invoiceAutopaySchedules, []);

  await setInvoiceAutopayExcluded(f.tx, invoice.id, false, actor);

  expect(f.sched.state).toBe('not_needed');
  expect(f.writes.some((write) => write.table === invoiceAutopaySchedules)).toBe(false);
  expect(h.notice).not.toHaveBeenCalled();
});


it('preserves already-excluded history while pending and permits replay and reinclusion after cancellation', async () => {
  const attempt = { id: 'attempt', state: 'requires_action' };
  const f = fixture({ state: 'excluded_by_msp', stateReason: 'exclude', mspExcludedAt: new Date() }, [attempt]);
  f.inv.autopayExcluded = true;
  const history = { ...f.sched };

  expect(await setInvoiceAutopayExcluded(f.tx, invoice.id, true, actor))
    .toEqual({ status: 'pending', control: 'exclude' });
  expect(f.sched).toEqual(history);
  expect(attempt.state).toBe('requires_action');
  expect(f.writes).toEqual([]);

  // Model the reconciler after verified cancellation, under the invoice lock.
  f.data.set(invoiceCollectionAttempts, []);
  expect(await finalizeInvoiceControl(f.tx, f.inv as any, f.sched as any, 'exclude'))
    .toEqual({ status: 'excluded' });
  expect(f.sched).toEqual(history);
  expect(f.writes).toEqual([]);
  expect(f.inv.autopayExcluded).toBe(true);
  const writes = f.writes.length;
  expect(await setInvoiceAutopayExcluded(f.tx, invoice.id, true, actor)).toEqual({ status: 'excluded' });
  expect(f.writes).toHaveLength(writes);

  expect(await setInvoiceAutopayExcluded(f.tx, invoice.id, false, actor)).toEqual({ status: 'included' });
  expect(f.inv.autopayExcluded).toBe(false);
  expect(f.sched).toMatchObject({ state: 'awaiting_notice', stateReason: null, mspExcludedAt: null });
  expect(h.notice).toHaveBeenCalledExactlyOnceWith(f.tx, f.sched.id);
  expect(h.confirmation).not.toHaveBeenCalled();
  expect(h.staff).not.toHaveBeenCalled();
});

it.each([
  ['skip', 'skipped_by_client'],
  ['exclude', 'excluded_by_msp'],
] as const)('preserves terminal history with legacy pending metadata on repeated %s finalization', async (kind, state) => {
  const f = fixture({ state, stateReason: `control_pending:${kind}`, nextAttemptAt: new Date() });
  const history = { ...f.sched };
  const result = await finalizeInvoiceControl(f.tx, f.inv as any, f.sched as any, kind);

  expect(result).toEqual({ status: kind === 'skip' ? 'skipped' : 'excluded' });
  expect(f.sched).toEqual(history);
  const writes = f.writes.length;
  expect(writes).toBe(0);
  expect(await finalizeInvoiceControl(f.tx, f.inv as any, f.sched as any, kind)).toEqual(result);
  expect(f.writes).toHaveLength(writes);
  expect(h.confirmation).not.toHaveBeenCalled();
  expect(h.staff).not.toHaveBeenCalled();
});

it('does not mark an already-excluded schedule pending without an outstanding attempt', async () => {
  const f = fixture({ state: 'excluded_by_msp', stateReason: 'exclude', mspExcludedAt: new Date() });
  f.inv.autopayExcluded = true;

  expect(await setInvoiceAutopayExcluded(f.tx, invoice.id, true, actor)).toEqual({ status: 'excluded' });
  expect(f.writes).toEqual([]);
  expect(f.sched.stateReason).toBe('exclude');
});

it('offers Charge now after the full notice lead even before collectOn',async()=>{
 const f=fixture({noticeSentAt:new Date('2020-01-01'),collectOn:'2099-01-01',termsSnapshot:schedule.termsSnapshot});
 expect((await getInvoiceAutopayView(f.tx,f.inv as any))?.canChargeNow).toBe(true);
});
it.each([{noticeSentAt:new Date()},{clientSkippedAt:new Date()},{mspExcludedAt:new Date()},{enrollmentGeneration:2},{state:'retry_scheduled',nextAttemptAt:new Date('2099-01-01')}])('withholds Charge now for an unsafe schedule %j',async over=>{
 const f=fixture({noticeSentAt:new Date('2020-01-01'),termsSnapshot:schedule.termsSnapshot,...over});expect((await getInvoiceAutopayView(f.tx,f.inv as any))?.canChargeNow).toBe(false);
});

it('allows MSP exclusion of an action-required reservation', async () => {
  const f = fixture({ state: 'action_required' }, [{ state: 'requires_action' }]);
  expect(await getInvoiceAutopayView(f.tx, invoice as never)).toMatchObject({ canExclude: true, canChargeNow: false });
});

it('provides a money-safe confirmation preview capped to the noticed principal plus fee',async()=>{
 const f=fixture({noticeSentAt:new Date('2020-01-01'),termsSnapshot:{...schedule.termsSnapshot,principal:'20.00',feeAmount:'1.00',methodLabel:'Visa ••4242'}});
 expect((await getInvoiceAutopayView(f.tx,f.inv as any))?.chargePreview).toEqual({amount:'11.00',currency:'USD',methodLabel:'Visa ••4242'});
});
