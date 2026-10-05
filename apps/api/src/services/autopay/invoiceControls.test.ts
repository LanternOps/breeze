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
  peekInvoiceLink: vi.fn().mockReturnValue({ token: 'secret' }),
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
  getSkipInvoiceView,
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
  orgAutopayConsents,
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
    [orgAutopayConsents,[{feeTerms:{methodType:'card',currency:'USD',feeAttested:false,cardFeeBps:0,achFeeAmount:'0.00'},
      scheduleTerms:{offsetDays:0,rule:'later',cap:{enabled:false}}}]],
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
    for (const method of ['where', 'limit', 'for', 'innerJoin', 'orderBy']) c[method] = () => c;
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
// Only attempts that have not been sent for confirmation can still be cancelled.
it.each(['reserved', 'created', 'requires_action'])(
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
// Spec 6.6: an attempt sent to Stripe for confirmation (ACH processing in particular)
// cannot be recalled, so the skip is refused rather than promised.
it.each(['confirming', 'processing'])('refuses to skip while a %s payment cannot be stopped, with no fence written', async state => {
  const f = fixture({ state: 'collecting' }, [{ id: 'attempt', state }]);
  for (let i = 0; i < 2; i++) {
    await expect(skipInvoice(f.tx, 'token')).rejects.toMatchObject({ status: 409, code: 'COLLECTION_IN_PROGRESS',
      message: "A payment for this invoice is already processing and can't be stopped. You'll get a receipt when it completes." });
  }
  expect(f.writes).toEqual([]);
  expect(f.sched).toMatchObject({ clientSkippedAt: null, stateReason: null });
  expect(h.confirmation).not.toHaveBeenCalled(); expect(h.staff).not.toHaveBeenCalled();
});
// The MSP Exclude has the same limit: a payment already with Stripe cannot be recalled.
it.each(['confirming', 'processing'])('refuses an MSP exclusion while a %s payment cannot be stopped, with no fence written', async state => {
  const f = fixture({ state: 'collecting' }, [{ id: 'attempt', state }]);
  await expect(setInvoiceAutopayExcluded(f.tx, invoice.id, true, actor)).rejects.toMatchObject({ status: 409,
    code: 'COLLECTION_IN_PROGRESS', details: { reason: 'payment_processing' } });
  expect(f.writes).toEqual([]);
  expect(f.inv.autopayExcluded).toBe(false);
  expect(f.sched).toMatchObject({ mspExcludedAt: null, stateReason: null });
});
it.each(['reserved', 'created', 'requires_action'])('still fences an MSP exclusion for a %s attempt that can be cancelled', async state => {
  const f = fixture({ state: 'collecting' }, [{ id: 'attempt', state }]);
  expect(await setInvoiceAutopayExcluded(f.tx, invoice.id, true, actor)).toMatchObject({ status: 'pending', control: 'exclude' });
  expect(f.inv.autopayExcluded).toBe(true);
  expect(f.sched).toMatchObject({ stateReason: 'control_pending:exclude' });
});
it.each([['confirming', true], ['processing', true], ['created', false], ['requires_action', false]] as const)(
  'tells the skip page before the click whether a %s payment can still be stopped', async (state, processing) => {
    const f = fixture({ state: 'collecting' }, [{ id: 'attempt', state }]);
    expect(await getSkipInvoiceView(f.tx, 'token')).toMatchObject({ state: 'collecting', processing });
  });
it('names the provider on the skip page so a refused skip can say who to contact', async () => {
  expect(await getSkipInvoiceView(fixture().tx, 'token')).toMatchObject({ partnerName: 'Partner' });
});
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

// 2a-4: a not_needed schedule carries the issuance placeholder, never collection terms.
it.each(['not_needed', 'cancelled', 'excluded_by_msp'])('projects a %s schedule with a placeholder snapshot without throwing', async state => {
  const f = fixture({ state, eligible: false, ineligibleReason: 'method_not_usable', stateReason: 'method_not_usable',
    noticeOutboxId: null, noticeSentAt: null, termsSnapshot: { issuedAt: '2026-10-01T00:00:00Z', noticeSeq: 0 } });
  expect(await getInvoiceAutopayView(f.tx, f.inv as any)).toMatchObject({
    state, reason: 'method_not_usable', canChargeNow: false, chargePreview: null,
  });
});

// The skip page names the invoice, amount, charge date and method, and who is asking.
it('describes the invoice the skip link controls, without minting a link', async () => {
  const f = fixture();
  f.data.set(partners, [{ name: 'Partner', billingEmail: 'billing@partner.example' }]);
  const view = await getSkipInvoiceView(f.tx, 'token');
  expect(view).toMatchObject({ status: 'ready', state: 'scheduled', processing: false, control: null,
    invoiceNumber: 'INV-1', invoiceStatus: 'sent', dueDate: '2026-10-15', collectOn: '2026-10-15',
    amount: '10.00', fee: '0.00', currency: 'USD', methodType: 'card', methodLabel: 'Credit card ending in 4242',
    partnerName: 'Partner', supportEmail: 'billing@partner.example', invoiceUrl: 'https://portal.example.test/invoice/secret' });
  expect(f.writes).toEqual([]);
});
it('labels the noticed method from the terms when the saved method changed', async () => {
  const f = fixture({ termsSnapshot: { ...schedule.termsSnapshot, methodId: 'older', methodType: 'us_bank_account', last4: '6789' } });
  expect(await getSkipInvoiceView(f.tx, 'token')).toMatchObject({ methodType: 'us_bank_account', methodLabel: 'Bank account ending in 6789' });
});
it.each([
  ['the enrollment is paused', (f: ReturnType<typeof fixture>) => { f.data.get(orgAutopayEnrollments)![0].status = 'paused'; }],
  ['the schedule was cancelled by a stop', (f: ReturnType<typeof fixture>) => { f.sched.state = 'cancelled'; }],
  ['the schedule belongs to a newer enrollment generation', (f: ReturnType<typeof fixture>) => { f.sched.enrollmentGeneration = 2; }],
])('still describes the invoice but cannot skip when %s', async (_label, mutate) => {
  const f = fixture();
  mutate(f);
  expect(await getSkipInvoiceView(f.tx, 'token')).toMatchObject({ status: 'not_needed', invoiceNumber: 'INV-1' });
});
it('an unknown skip link reveals nothing', async () => {
  h.resolve.mockResolvedValueOnce(null);
  const f = fixture();
  await expect(getSkipInvoiceView(f.tx, 'token')).rejects.toMatchObject({ status: 404 });
});
// D-19: the pre-charge notice told the client the invoice would be charged. An MSP
// exclusion that lands after it went out tells them it will not be.
const sentNotice = { id: 'notice', invoiceId: invoice.id, kind: 'invoice_autopay', seq: 1, status: 'sent',
  sentAt: new Date('2026-10-02T12:00:00Z'), rendered: { frozen: { chargeDate: '2026-10-15' } } };
it('tells the client an announced invoice will not be charged after an MSP exclusion (D-19)', async () => {
  const f = fixture();
  f.data.set(billingNoticeOutbox, [{ ...sentNotice }]);
  const { renderBillingNotice } = await import('./renderBillingNotice');
  expect(await setInvoiceAutopayExcluded(f.tx, invoice.id, true, actor)).toMatchObject({ status: 'excluded' });
  // The locked 'not_charged' wording is rendered from these facts (renderBillingNotice.reminders.test).
  expect(renderBillingNotice).toHaveBeenCalledWith('payment_reminder', expect.objectContaining({
    data: expect.objectContaining({ variant: 'not_charged', notChargedReason: 'Partner will not charge this invoice automatically.',
      announcedFor: '2026-10-15', invoiceNumber: 'INV-1', partnerName: 'Partner' }) }), f.tx);
  expect(h.confirmation).toHaveBeenCalledExactlyOnceWith(f.tx, expect.objectContaining({
    kind: 'payment_reminder', seq: 0, invoiceId: invoice.id, dedupeKey: `invoice:${invoice.id}:not_charged:1`,
    rendered: expect.objectContaining({ subject: 'Reminder' }),
  }));
});
it('says nothing new when the exclusion lands before any charging notice was sent', async () => {
  const f = fixture({ state: 'awaiting_notice', noticeSentAt: null });
  f.data.set(billingNoticeOutbox, [{ ...sentNotice, status: 'pending', sentAt: null }]);
  expect(await setInvoiceAutopayExcluded(f.tx, invoice.id, true, actor)).toMatchObject({ status: 'excluded' });
  expect(h.confirmation).not.toHaveBeenCalled();
});
it('tells the client once the reconciler finalizes a pending exclusion of an announced invoice', async () => {
  const f = fixture({ state: 'collecting', stateReason: 'control_pending:exclude', mspExcludedAt: new Date() });
  f.inv.autopayExcluded = true;
  f.data.set(billingNoticeOutbox, [{ ...sentNotice }]);
  expect(await finalizeInvoiceControl(f.tx, f.inv as any, f.sched as any, 'exclude')).toEqual({ status: 'excluded' });
  expect(h.confirmation).toHaveBeenCalledExactlyOnceWith(f.tx, expect.objectContaining({ dedupeKey: `invoice:${invoice.id}:not_charged:1` }));
});

// D-22: a stale skip link on a paid, closed or unscheduled invoice must not offer "Skip".
it.each([
  ['a paid invoice', { status: 'paid', balance: '0.00' }, {}, [], 'paid'],
  ['an invoice paid by autopay', { status: 'paid', balance: '0.00' }, { state: 'succeeded' }, [], 'paid'],
  // V-1: a skipped invoice the client then paid is paid, not "skipped, please pay".
  ['a skipped invoice paid later', { status: 'paid', balance: '0.00' }, { state: 'skipped_by_client' }, [], 'paid'],
  // V-2: an automatic payment refunded or reversed after it succeeded leaves the invoice open.
  ['an invoice whose automatic payment was reversed', { status: 'sent' }, { state: 'succeeded' }, [], 'reversed'],
  ['a void invoice', { status: 'void' }, {}, [], 'not_needed'],
  ['an invoice with nothing left to pay', { balance: '0.00' }, {}, [], 'not_needed'],
  ['an MSP-excluded invoice', { autopayExcluded: true }, { state: 'excluded_by_msp' }, [], 'not_needed'],
  ['an invoice no longer scheduled', {}, { state: 'cancelled' }, [], 'not_needed'],
  ['an invoice autopay does not cover', {}, { state: 'not_needed', eligible: false }, [], 'not_needed'],
  ['a failed automatic payment', {}, { state: 'failed' }, [], 'not_needed'],
  ['an invoice the MSP is excluding', {}, { state: 'collecting', stateReason: 'control_pending:exclude' }, [{ id: 'attempt', state: 'created' }], 'not_needed'],
  ['an already skipped invoice', {}, { state: 'skipped_by_client' }, [], 'skipped'],
  ['a skip waiting on cancellation', {}, { state: 'collecting', stateReason: 'control_pending:skip' }, [{ id: 'attempt', state: 'created' }], 'pending'],
  ['a payment already processing', {}, { state: 'collecting' }, [{ id: 'attempt', state: 'processing' }], 'processing'],
  ['a payment waiting on bank confirmation', {}, { state: 'action_required' }, [{ id: 'attempt', state: 'requires_action' }], 'action_required'],
  ['a scheduled payment', {}, {}, [], 'ready'],
  ['a payment awaiting its notice', {}, { state: 'awaiting_notice' }, [], 'ready'],
  ['a scheduled retry', {}, { state: 'retry_scheduled' }, [], 'ready'],
] as const)('reports %s to the skip page with the matching status', async (_label, inv, sched, attempts, status) => {
  const f = fixture(sched as Record<string, unknown>, [...attempts]);
  Object.assign(f.inv, inv);
  expect(await getSkipInvoiceView(f.tx, 'token')).toMatchObject({ status });
});
// The skip page's GET status agrees with the skip POST's refusal: 'processing' exactly when a
// refused skip carries details.reason 'payment_processing' (#7983), even beside a pending control.
it.each(['exclude', 'stop'] as const)('reports a processing payment as processing even with a pending %s', async control => {
  const f = fixture({ state: 'collecting', stateReason: `control_pending:${control}` }, [{ id: 'attempt', state: 'processing' }]);
  expect(await getSkipInvoiceView(f.tx, 'token')).toMatchObject({ status: 'processing', processing: true, partnerName: 'Partner' });
});

// V-11: a link with nothing to skip says why, so the page never shows a schedule that won't happen.
it.each([
  ['void', (f: ReturnType<typeof fixture>) => { f.inv.status = 'void'; }],
  ['nothing_due', (f: ReturnType<typeof fixture>) => { f.inv.balance = '0.00'; }],
  ['excluded', (f: ReturnType<typeof fixture>) => { f.inv.autopayExcluded = true; f.sched.state = 'excluded_by_msp'; }],
  ['excluded', (f: ReturnType<typeof fixture>) => { f.sched.state = 'collecting'; (f.sched as { stateReason: string | null }).stateReason = 'control_pending:exclude'; f.data.set(invoiceCollectionAttempts, [{ id: 'a', state: 'created' }]); }],
  ['failed', (f: ReturnType<typeof fixture>) => { f.sched.state = 'failed'; }],
  ['stopped', (f: ReturnType<typeof fixture>) => { f.sched.state = 'cancelled'; }],
  ['stopped', (f: ReturnType<typeof fixture>) => { f.data.get(orgAutopayEnrollments)![0].status = 'cancelled'; }],
  ['paused', (f: ReturnType<typeof fixture>) => { f.data.get(orgAutopayEnrollments)![0].status = 'paused'; }],
  ['replaced', (f: ReturnType<typeof fixture>) => { f.sched.enrollmentGeneration = 2; }],
  ['not_included', (f: ReturnType<typeof fixture>) => { f.sched.state = 'not_needed'; f.sched.eligible = false; }],
] as const)('names why there is nothing to skip: %s', async (reason, mutate) => {
  const f = fixture();
  mutate(f);
  expect(await getSkipInvoiceView(f.tx, 'token')).toMatchObject({ status: 'not_needed', reason, balance: f.inv.balance });
});
it('a skippable invoice carries no reason, and reports whether the MSP put automatic payments on hold (V-37)', async () => {
  const on = fixture();
  expect(await getSkipInvoiceView(on.tx, 'token')).toMatchObject({ status: 'ready', reason: null, onHold: false, balance: '10.00' });
  const off = fixture();
  off.data.set(partners, [{ enabled: false, name: 'Partner' }]);
  expect(await getSkipInvoiceView(off.tx, 'token')).toMatchObject({ status: 'ready', onHold: true });
});
