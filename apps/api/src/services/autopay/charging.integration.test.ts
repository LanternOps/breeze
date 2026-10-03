import '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext, withDbAccessContext, hasDbAccessContext } from '../../db';
import { createPartner, createOrganization, createUser } from '../../__tests__/integration/db-utils';
import { partners, invoices, orgAutopayEnrollments, orgPaymentMethods, invoiceAutopaySchedules,
  invoiceCollectionAttempts, invoiceStripePayments, stripeConnectAccounts, invoicePayments,
  organizations, billingNoticeOutbox, stripeFinancialEvents, orgMergeEvents } from '../../db/schema';
import { encryptSecret } from '../secretCrypto';
import { attemptCollection, resumeCollectionAttempt, applyAttemptOutcome } from './collectionEngine';
import {recordPayment,getInvoice} from '../invoiceService';
import {executeOrgMerge} from '../orgMerge';
import {ingestStripeFinancialEvent,processPendingStripeFinancialEvents,processPendingStripeFinancialEventsForPayment} from '../stripeReversalState';
import {enqueueAutopayNotice} from './chargingNotice';
import { createInvoicePayLink } from '../invoiceCheckout';
const provider = vi.hoisted(() => ({ create: vi.fn(), retrieve: vi.fn(), confirm: vi.fn(), cancel: vi.fn(),
  setupRetrieve: vi.fn(), mandateRetrieve: vi.fn(), eventList: vi.fn(), sessionCreate: vi.fn(), sessionExpire: vi.fn(), sessionRetrieve: vi.fn(), methodRetrieve:vi.fn(),methodDetach:vi.fn() }));
vi.mock('../partnerStripe', async importOriginal => ({
  ...(await importOriginal<typeof import('../partnerStripe')>()),
  getPartnerStripeClient: vi.fn(async () => ({ stripeAccountId: 'acct_autopay_test', defaultCurrency: 'USD',
    stripe: { setupIntents: {retrieve: provider.setupRetrieve}, mandates: {retrieve: provider.mandateRetrieve}, events: {list: provider.eventList}, paymentMethods:{retrieve:provider.methodRetrieve,detach:provider.methodDetach}, paymentIntents: { create: provider.create, retrieve: provider.retrieve, confirm: provider.confirm, cancel: provider.cancel },
      checkout: { sessions: { create: provider.sessionCreate, expire: provider.sessionExpire, retrieve: provider.sessionRetrieve } } } })),
}));
vi.mock('../invoiceEvents', () => ({ emitInvoiceEvent: vi.fn() }));
vi.mock('../../jobs/accountingSyncWorker', () => ({ enqueueAccountingInvoicePush: vi.fn(), enqueueAccountingInvoiceVoid: vi.fn(),
  enqueueAccountingPaymentPush: vi.fn(), enqueueAccountingPaymentDelete: vi.fn() }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn() }));
let currentPi: any;
const intentsByKey = new Map<string, any>();
beforeEach(() => {
  vi.stubEnv('ORG_MERGE_FENCE_DRAIN_MS', '0');
  vi.resetAllMocks();
  intentsByKey.clear();
  provider.create.mockImplementation(async (params, options) => {
    expect(hasDbAccessContext()).toBe(false);
    if (!intentsByKey.has(options.idempotencyKey)) {
      intentsByKey.set(options.idempotencyKey, { ...params,
        id: intentsByKey.size === 0 ? 'pi_autopay_test' : `pi_autopay_test_${intentsByKey.size + 1}`,
        status: 'requires_confirmation', amount_received: 0, last_payment_error: null,
        latest_charge: null, created: Math.floor(Date.now()/1000) });
    }
    currentPi = intentsByKey.get(options.idempotencyKey);
    expect(options.idempotencyKey).toMatch(/^(autopay_|autopay-bankpay:)/);
    return currentPi;
  });
  provider.retrieve.mockImplementation(async () => { expect(hasDbAccessContext()).toBe(false); return currentPi; });
  provider.confirm.mockImplementation(async () => {
    expect(hasDbAccessContext()).toBe(false);
    currentPi = { ...currentPi, status: 'processing' }; return currentPi;
  });
  provider.cancel.mockImplementation(async () => { expect(hasDbAccessContext()).toBe(false); currentPi = { ...currentPi, status: 'canceled' }; return currentPi; });
  provider.methodRetrieve.mockImplementation(async id => {
    expect(hasDbAccessContext()).toBe(false);
    return { id, customer: 'cus_autopay_test', type: 'card',
      card: { brand: 'visa', funding: 'credit', networks: { available: ['visa'], preferred: null } } };
  });
  provider.methodDetach.mockResolvedValue({customer:null});
  currentPi = null;
});
async function fixture() {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await db.update(organizations).set({ billingContact: {email: 'billing@example.test'} }).where(eq(organizations.id, org.id));
    await db.update(partners).set({ autopayEnabled: true }).where(eq(partners.id, partner.id));
    const [connection] = await db.insert(stripeConnectAccounts).values({ partnerId: partner.id,
      stripeAccountId: 'acct_autopay_test', status: 'connected', accountCountry: 'US', defaultCurrency: 'USD',
      keyLast4: 'only', apiKey: encryptSecret(['sk','test','fixture_only'].join('_')), autopayMissingPermissions: [],
      autopayCapabilitiesCheckedAt: new Date() }).returning();
    const [enrollment] = await db.insert(orgAutopayEnrollments).values({ orgId: org.id, partnerId: partner.id,
      status: 'active', generation: 1, stripeConnectionId: connection!.id, stripeAccountId: connection!.stripeAccountId,
      stripeCustomerId: 'cus_autopay_test', effectiveFrom: new Date('2020-01-01T00:00Z'), requestedAt: new Date() }).returning();
    const [method] = await db.insert(orgPaymentMethods).values({ orgId: org.id, enrollmentId: enrollment!.id,
      stripePaymentMethodId: 'pm_autopay_test', type: 'card', cardBrand: 'visa', cardLast4: '4242', cardFunding: 'credit',
      status: 'active', isAutopayMethod: true }).returning();
    const today = new Date().toISOString().slice(0,10);
    const [invoice] = await db.insert(invoices).values({ partnerId: partner.id, orgId: org.id,
      invoiceNumber: `T-${randomUUID()}`, currencyCode: 'USD', status: 'sent', issueDate: today, dueDate: today,
      total: '100.00', balance: '100.00', amountPaid: '0.00' }).returning();
    const [schedule] = await db.insert(invoiceAutopaySchedules).values({ orgId: org.id, invoiceId: invoice!.id,
      enrollmentId: enrollment!.id, enrollmentGeneration: 1, eligible: true, collectOn: today,
      state: 'scheduled', noticeSentAt: new Date(Date.now()-20*86_400_000), attemptCount: 0,
      termsSnapshot: { issuedAt: new Date().toISOString(), offsetDays: 0, rule: 'later', cap: {enabled:false},
        methodType:'card', methodId:method!.id, last4:'4242', methodLabel:'Visa ••4242', accountHolderType:null,
        noticeLeadDays:1, principal:'100.00', currency:'USD', feeAmount:'0.00', feeKind:'none',
        cardFeeBps:0, achFeeAmount:'0.00', chargeDate:today, noticeSeq:1 } }).returning();
    const [notice] = await db.insert(billingNoticeOutbox).values({
      orgId: org.id, invoiceId: invoice!.id, enrollmentId: enrollment!.id,
      kind: 'invoice_autopay', seq: 1, dedupeKey: `${invoice!.id}:invoice_autopay:1`,
      toEmail: 'billing@example.test', status: 'sent', sentAt: schedule!.noticeSentAt,
      rendered: { subject: 'Payment notice', html: '<p>Payment notice</p>', text: 'Payment notice',
        frozen: { amount: '100.00', fee: '0.00', chargeDate: today, methodType: 'card', enrollmentGeneration: 1 } },
    }).returning();
    await db.update(invoiceAutopaySchedules).set({ noticeOutboxId: notice!.id })
      .where(eq(invoiceAutopaySchedules.id, schedule!.id));
    return { partner, org, connection: connection!, notice: notice!, enrollment:enrollment!, method:method!, invoice:invoice!, schedule:schedule!,
      actor:{userId:null,partnerId:partner.id,accessibleOrgIds:[org.id]} };
  });
}
async function attempts(invoiceId:string) {
  return withSystemDbAccessContext(() => db.select().from(invoiceCollectionAttempts)
    .where(eq(invoiceCollectionAttempts.invoiceId,invoiceId)));
}
it('holds a real reservation against manual and pay-link producers', async () => {
  const f = await fixture();
  const result = await attemptCollection({invoiceId:f.invoice.id,scheduleId:f.schedule.id,initiatedBy:'scheduler'});
  expect(result.outcome).toBe('created');
  const ctx = {scope:'partner' as const,orgId:null,accessibleOrgIds:[f.org.id],accessiblePartnerIds:[f.partner.id]};
  await expect(withDbAccessContext(ctx, () => recordPayment(f.invoice.id, {
    amount:100, method:'cash', receivedAt:new Date().toISOString().slice(0,10),
  },f.actor))).rejects.toMatchObject({status:409});
  await expect(createInvoicePayLink(f.invoice.id,f.actor)).rejects.toMatchObject({status:409});
  expect(provider.create).toHaveBeenCalledTimes(1);
  expect(provider.sessionCreate).not.toHaveBeenCalled();
  expect((await attempts(f.invoice.id))[0]!.state).toBe('processing');
});
it('two collection workers reserve exactly one attempt', async () => {
  const f = await fixture();
  const input = {invoiceId:f.invoice.id,scheduleId:f.schedule.id,initiatedBy:'scheduler' as const};
  const results = await Promise.all([attemptCollection(input),attemptCollection(input)]);
  expect(results.filter(r=>r.outcome==='created')).toHaveLength(1);
  expect(await attempts(f.invoice.id)).toHaveLength(1);
  expect(provider.create).toHaveBeenCalledTimes(1);
});
it('recovers a lost create response with the same key and one provider PI', async () => {
  const f = await fixture();
  const normal = provider.create.getMockImplementation()!;
  provider.create.mockImplementationOnce(async (...args) => { await normal(...args); throw new Error('response lost'); });
  await expect(attemptCollection({invoiceId:f.invoice.id,scheduleId:f.schedule.id,initiatedBy:'scheduler'})).rejects.toThrow('response lost');
  const [attempt] = await attempts(f.invoice.id);
  expect(attempt!.state).toBe('reserved'); expect(provider.confirm).not.toHaveBeenCalled();
  await resumeCollectionAttempt(attempt!.id);
  expect(provider.create.mock.calls[0]![1].idempotencyKey).toBe(provider.create.mock.calls[1]![1].idempotencyKey);
  expect((await attempts(f.invoice.id))[0]!.stripePaymentIntentId).toBe('pi_autopay_test');
});
it('recovers a crash after mapping commit but before confirm without creating again', async () => {
  const f = await fixture();
  provider.confirm.mockRejectedValueOnce(new Error('process stopped'));
  await expect(attemptCollection({invoiceId:f.invoice.id,scheduleId:f.schedule.id,initiatedBy:'scheduler'})).rejects.toThrow();
  const [attempt] = await attempts(f.invoice.id);
  expect(attempt!.invoiceStripePaymentId).toBeTruthy();
  await resumeCollectionAttempt(attempt!.id);
  expect(provider.create).toHaveBeenCalledTimes(1);
});
it('preserves captured money as unapplied after an out-of-band void', async () => {
  const f = await fixture();
  const result = await attemptCollection({invoiceId:f.invoice.id,scheduleId:f.schedule.id,initiatedBy:'scheduler'});
  // Deliberately bypass the normal void guard to model an external/admin inconsistency.
  await withSystemDbAccessContext(()=>db.update(invoices).set({status:'void'}).where(eq(invoices.id,f.invoice.id)));
  currentPi = {...currentPi,status:'succeeded',amount_received:10000};
  await applyAttemptOutcome(f.partner.id,result.attemptId!);
  expect((await attempts(f.invoice.id))[0]!.state).toBe('unapplied');
  const [mapping] = await withSystemDbAccessContext(()=>db.select().from(invoiceStripePayments)
    .where(eq(invoiceStripePayments.invoiceId,f.invoice.id)));
  expect(mapping!.invoicePaymentId).toBeNull();
});
it('does not confirm when a late payment closes the invoice after reservation',async()=>{
  const f=await fixture();const normal=provider.create.getMockImplementation()!;
  provider.create.mockImplementationOnce(async(...args)=>{
    const pi=await normal(...args);
    // Model the ledger state committed by an older provider-success replay under its invoice lock.
    await withSystemDbAccessContext(()=>db.update(invoices).set({status:'paid',amountPaid:'100.00',balance:'0.00'})
      .where(eq(invoices.id,f.invoice.id)));
    return pi;
  });
  await attemptCollection({invoiceId:f.invoice.id,scheduleId:f.schedule.id,initiatedBy:'scheduler'});
  expect(provider.confirm).not.toHaveBeenCalled();expect(provider.cancel).toHaveBeenCalledTimes(1);
  expect((await attempts(f.invoice.id))[0]!.state).toBe('canceled');
});
it('does not confirm an old enrollment generation after create', async () => {
  const f = await fixture();
  const normal = provider.create.getMockImplementation()!;
  provider.create.mockImplementationOnce(async (...args) => {
    const pi = await normal(...args);
    await withSystemDbAccessContext(()=>db.update(orgAutopayEnrollments).set({generation:2})
      .where(eq(orgAutopayEnrollments.id,f.enrollment.id)));
    return pi;
  });
  await attemptCollection({invoiceId:f.invoice.id,scheduleId:f.schedule.id,initiatedBy:'scheduler'});
  expect(provider.confirm).not.toHaveBeenCalled();
  expect((await attempts(f.invoice.id))[0]!.state).toBe('canceled');
});
it.each([false,true])('reconciles original-org late success after real merge (unapplied=%s), then refunds once',async unapplied=>{
  const f=await fixture();
  const survivor=await withSystemDbAccessContext(()=>createOrganization({partnerId:f.partner.id}));
  const user=await withSystemDbAccessContext(()=>createUser({partnerId:f.partner.id,email:`merge-${randomUUID()}@example.test`}));
  provider.confirm.mockImplementationOnce(async()=>{
    currentPi={...currentPi,status:'requires_payment_method',last_payment_error:{code:'card_declined',decline_code:'do_not_honor'}};
    return currentPi;
  });
  const result=await attemptCollection({invoiceId:f.invoice.id,scheduleId:f.schedule.id,initiatedBy:'scheduler'});
  expect((await attempts(f.invoice.id))[0]!.state).toBe('failed');
  if(unapplied)await withSystemDbAccessContext(()=>db.update(invoices).set({status:'void'}).where(eq(invoices.id,f.invoice.id)));
  await executeOrgMerge({loserOrgId:f.org.id,survivorOrgId:survivor.id,partnerId:f.partner.id,performedBy:user.id});
  const merged=(await attempts(f.invoice.id))[0]!;
  expect(merged).toMatchObject({orgId:survivor.id,paymentMethodId:null,state:'failed'});
  const [schedule]=await withSystemDbAccessContext(()=>db.select().from(invoiceAutopaySchedules).where(eq(invoiceAutopaySchedules.id,f.schedule.id)));
  expect(schedule).toMatchObject({orgId:survivor.id,enrollmentId:null});
  const history=await withSystemDbAccessContext(()=>db.select().from(orgMergeEvents).where(eq(orgMergeEvents.loserOrgId,f.org.id)));
  expect(history[0]).toMatchObject({partnerId:f.partner.id,survivorOrgId:survivor.id});
  const [loserAuthority]=await withSystemDbAccessContext(()=>db.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.id,f.enrollment.id)));
  expect(loserAuthority).toMatchObject({orgId:f.org.id,status:'cancelled'});
  const beforeNotices=await withSystemDbAccessContext(()=>db.select().from(billingNoticeOutbox).where(eq(billingNoticeOutbox.invoiceId,f.invoice.id)));
  await withSystemDbAccessContext(()=>enqueueAutopayNotice(db,f.schedule.id));
  expect(await withSystemDbAccessContext(()=>db.select().from(billingNoticeOutbox).where(eq(billingNoticeOutbox.invoiceId,f.invoice.id))))
    .toHaveLength(beforeNotices.length);
  const unrelated=await withSystemDbAccessContext(()=>createOrganization({partnerId:f.partner.id}));
  currentPi={...currentPi,status:'succeeded',amount_received:10000,last_payment_error:null,
    metadata:{...currentPi.metadata,org_id:unrelated.id}};
  await expect(applyAttemptOutcome(f.partner.id,result.attemptId!)).rejects.toThrow('provenance mismatch');
  currentPi={...currentPi,metadata:{...currentPi.metadata,org_id:f.org.id}};
  await applyAttemptOutcome(f.partner.id,result.attemptId!);
  await applyAttemptOutcome(f.partner.id,result.attemptId!);
  expect((await attempts(f.invoice.id))[0]).toMatchObject({orgId:survivor.id,paymentMethodId:null,state:unapplied?'unapplied':'succeeded'});
  const paid=await withSystemDbAccessContext(()=>db.select().from(invoicePayments).where(eq(invoicePayments.invoiceId,f.invoice.id)));
  expect(paid).toHaveLength(unapplied?0:1);
  if(!unapplied)expect(paid[0]).toMatchObject({orgId:survivor.id,amount:'100.00'});
  const refund={partnerId:f.partner.id,stripeAccountId:'acct_autopay_test',stripeEventId:`evt_merge_refund_${f.invoice.id}`,
    eventType:'charge.refunded',livemode:false,providerCreated:Math.floor(Date.now()/1000),
    paymentIntentId:currentPi.id,currency:'USD',chargeAmountMinor:10000,refundedAmountMinor:10000};
  await ingestStripeFinancialEvent(refund);await ingestStripeFinancialEvent(refund);
  await applyAttemptOutcome(f.partner.id,result.attemptId!);
  expect(await withSystemDbAccessContext(()=>db.select().from(invoicePayments).where(eq(invoicePayments.invoiceId,f.invoice.id)))).toHaveLength(0);
  const final=(await attempts(f.invoice.id))[0]!;
  expect(final.paymentMethodId).toBeNull();
  if(unapplied)expect(final).toMatchObject({state:'canceled',failureCode:'unapplied_refunded'});
  const [finalSchedule]=await withSystemDbAccessContext(()=>db.select().from(invoiceAutopaySchedules).where(eq(invoiceAutopaySchedules.id,f.schedule.id)));
  expect(finalSchedule!.enrollmentId).toBeNull();expect(finalSchedule!.nextAttemptAt).toBeNull();
  expect(['scheduled','retry_scheduled','awaiting_notice','collecting']).not.toContain(finalSchedule!.state);
  expect(provider.create).toHaveBeenCalledTimes(1);expect(provider.confirm).toHaveBeenCalledTimes(1);
});
it('replays a PI event globally after its mapping arrives, even for a failed terminal attempt',async()=>{
  const f=await fixture();
  const eventId=`evt_early_${f.invoice.id}`;
  const early={partnerId:f.partner.id,stripeAccountId:'acct_autopay_test',stripeEventId:eventId,
    eventType:'payment_intent.succeeded',livemode:false,providerCreated:Math.floor(Date.now()/1000),
    paymentIntentId:'pi_autopay_test',currency:'USD',chargeAmountMinor:10000};
  expect(await ingestStripeFinancialEvent(early)).toMatchObject({state:'pending'});
  provider.confirm.mockImplementationOnce(async()=>{
    currentPi={...currentPi,status:'requires_payment_method',last_payment_error:{code:'card_declined',decline_code:'do_not_honor'}};
    return currentPi;
  });
  const result=await attemptCollection({invoiceId:f.invoice.id,scheduleId:f.schedule.id,initiatedBy:'scheduler'});
  expect((await attempts(f.invoice.id))[0]!.state).toBe('failed');
  currentPi={...currentPi,status:'succeeded',amount_received:10000,last_payment_error:null};
  await withSystemDbAccessContext(()=>db.update(stripeFinancialEvents).set({nextAttemptAt:new Date(0)})
    .where(eq(stripeFinancialEvents.stripeEventId,eventId)));
  await processPendingStripeFinancialEventsForPayment('acct_autopay_test',currentPi.id);
  let [event]=await withSystemDbAccessContext(()=>db.select().from(stripeFinancialEvents).where(eq(stripeFinancialEvents.stripeEventId,eventId)));
  expect(event!.status).toBe('pending'); // per-payment replay must stay charge-only
  await processPendingStripeFinancialEvents();await processPendingStripeFinancialEvents();
  [event]=await withSystemDbAccessContext(()=>db.select().from(stripeFinancialEvents).where(eq(stripeFinancialEvents.stripeEventId,eventId)));
  expect(event!.status).toBe('applied');
  expect((await attempts(f.invoice.id))[0]).toMatchObject({id:result.attemptId,state:'succeeded'});
  expect(await withSystemDbAccessContext(()=>db.select().from(invoicePayments).where(eq(invoicePayments.invoiceId,f.invoice.id)))).toHaveLength(1);
  expect(provider.create).toHaveBeenCalledTimes(1);
});
it('shows unresolved money through authorized invoice reads after rollout is disabled',async()=>{
  const f=await fixture();
  const result=await attemptCollection({invoiceId:f.invoice.id,scheduleId:f.schedule.id,initiatedBy:'scheduler'});
  await withSystemDbAccessContext(()=>db.update(invoices).set({status:'void'}).where(eq(invoices.id,f.invoice.id)));
  currentPi={...currentPi,status:'succeeded',amount_received:10000};
  await applyAttemptOutcome(f.partner.id,result.attemptId!);
  await withSystemDbAccessContext(()=>db.update(partners).set({autopayEnabled:false}).where(eq(partners.id,f.partner.id)));
  const actor={userId:randomUUID(),partnerId:f.partner.id,accessibleOrgIds:[f.org.id]};
  const detail=await withDbAccessContext({scope:'partner',orgId:null,accessibleOrgIds:[f.org.id],accessiblePartnerIds:[f.partner.id]},()=>getInvoice(f.invoice.id,actor));
  expect(detail.unappliedCount).toBe(1);
  const other=await withSystemDbAccessContext(()=>createOrganization({partnerId:f.partner.id}));
  await expect(withDbAccessContext({scope:'partner',orgId:null,accessibleOrgIds:[other.id],accessiblePartnerIds:[f.partner.id]},
    ()=>getInvoice(f.invoice.id,{...actor,accessibleOrgIds:[other.id]}))).rejects.toMatchObject({status:404});
  await ingestStripeFinancialEvent({partnerId:f.partner.id,stripeAccountId:'acct_autopay_test',stripeEventId:`evt_attention_${f.invoice.id}`,
    eventType:'charge.refunded',livemode:false,providerCreated:Math.floor(Date.now()/1000),paymentIntentId:currentPi.id,
    currency:'USD',chargeAmountMinor:10000,refundedAmountMinor:10000});
  expect((await withDbAccessContext({scope:'partner',orgId:null,accessibleOrgIds:[f.org.id],accessiblePartnerIds:[f.partner.id]},()=>getInvoice(f.invoice.id,actor))).unappliedCount).toBe(0);
});


// These barriers observe PostgreSQL's lock wait, rather than inferring contention
// from timing. Provider calls remain outside every app transaction.
import { getTestDb } from '../../__tests__/integration/setup';
import { sql } from 'drizzle-orm';
import { reserveCollection, runAutopayCollection } from './collectionEngine';
import { requestInvoiceControl, reconcilePendingControls } from './collectionControl';
import { invoiceAutopayNoticeSent } from './chargingNotice';
import { getPartnerStripeClient } from '../partnerStripe';
import { turnOffAutopay } from './enrollmentLifecycle';

const inputFor = (f: Awaited<ReturnType<typeof fixture>>) => ({
  invoiceId: f.invoice.id, scheduleId: f.schedule.id, initiatedBy: 'scheduler' as const,
});
const scheduleFor = (f: Awaited<ReturnType<typeof fixture>>) => withSystemDbAccessContext(async () =>
  (await db.select().from(invoiceAutopaySchedules).where(eq(invoiceAutopaySchedules.id, f.schedule.id)))[0]!);
function barrier() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}
async function blockedBy(pid: number) {
  await vi.waitFor(async () => {
    const rows = await getTestDb().execute(sql`select pid from pg_stat_activity
      where ${pid} = any(pg_blocking_pids(pid)) and wait_event_type = 'Lock'`);
    expect(rows.length).toBeGreaterThan(0);
  }, { timeout: 5000, interval: 20 });
}

it('manual-first holds the invoice lock; the losing collector never creates or confirms a PI', async () => {
  const f = await fixture();
  const locked = barrier(), release = barrier();
  let pid = 0;
  const holder = withSystemDbAccessContext(async () => {
    const [backend] = await db.execute<{pid: number}>(sql`select pg_backend_pid() as pid`);
    pid = backend!.pid;
    await db.select().from(invoices).where(eq(invoices.id, f.invoice.id)).for('update');
    locked.release();
    await release.wait;
  });
  await locked.wait;
  const manual = withSystemDbAccessContext(() => recordPayment(f.invoice.id,
    {amount: 100, method: 'cash', receivedAt: f.invoice.issueDate!}, f.actor));
  await blockedBy(pid);
  const collect = attemptCollection(inputFor(f));
  try {
    await blockedBy(pid);
    expect(provider.create).not.toHaveBeenCalled();
  } finally { release.release(); await holder; await manual; }
  expect(await collect).toMatchObject({outcome: 'refused', reason: 'not_payable'});
  expect(provider.create).not.toHaveBeenCalled();
  expect(provider.confirm).not.toHaveBeenCalled();
  expect(await attempts(f.invoice.id)).toHaveLength(0);
});

it('autopay-first reserves before paused provider HTTP and rejects manual and Checkout contenders', async () => {
  const f = await fixture();
  const entered = barrier(), release = barrier();
  const normal = provider.create.getMockImplementation()!;
  provider.create.mockImplementationOnce(async (...args) => {
    entered.release(); await release.wait; return normal(...args);
  });
  const collect = attemptCollection(inputFor(f));
  await Promise.race([entered.wait, collect.then(() => { throw new Error("Provider barrier not reached"); })]);
  try {
    await withSystemDbAccessContext(() => db.execute(sql`select id from invoices where id=${f.invoice.id} for update nowait`));
    await expect(withSystemDbAccessContext(() => recordPayment(f.invoice.id,
      {amount: 100, method: 'cash', receivedAt: f.invoice.issueDate!}, f.actor))).rejects.toMatchObject({status: 409});
    await expect(createInvoicePayLink(f.invoice.id, f.actor)).rejects.toMatchObject({status: 409});
    expect(provider.sessionCreate).not.toHaveBeenCalled();
  } finally { release.release(); await collect; }
  expect(intentsByKey.size).toBe(1);
});

it.each(['observe', 'enforce'])('rechecks Checkout inserted after revocation in %s mode', async mode => {
  vi.stubEnv('STRIPE_SESSION_REVOCATION_MODE', mode);
  try {
    const f = await fixture();
    const normal = provider.methodRetrieve.getMockImplementation()!;
    provider.methodRetrieve.mockImplementationOnce(async (...args) => {
      const method = await normal(...args);
      // Admission is after requestInvoiceSessionRevocation and before reserve's lock.
      await withSystemDbAccessContext(() => db.insert(invoiceStripePayments).values({
        orgId: f.org.id, invoiceId: f.invoice.id, stripeAccountId: 'acct_autopay_test',
        stripeObjectType: 'checkout_session', stripeObjectId: `cs_${f.invoice.id}`,
        amount: '100.00', currency: 'USD', status: 'pending', revocationState: 'active',
      }));
      return method;
    });
    expect(await attemptCollection(inputFor(f))).toMatchObject({outcome: 'deferred', reason: 'checkout_session_unrevoked'});
    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.confirm).not.toHaveBeenCalled();
    expect(await attempts(f.invoice.id)).toHaveLength(0);
  } finally { vi.unstubAllEnvs(); }
});

it.each(['invoice', 'org'])('refuses a schedule owned by a different %s', async ownership => {
  const f = await fixture();
  const otherOrg = ownership === 'org' ? await createOrganization({partnerId: f.partner.id}) : f.org;
  const [otherInvoice] = await withSystemDbAccessContext(() => db.insert(invoices).values({
    orgId: otherOrg.id, partnerId: f.partner.id, currencyCode: 'USD', status: 'sent', total: '100.00', balance: '100.00',
  }).returning());
  const [foreign] = await withSystemDbAccessContext(() => db.insert(invoiceAutopaySchedules).values({
    orgId: otherOrg.id, invoiceId: otherInvoice!.id, termsSnapshot: {}, enrollmentGeneration: 1, eligible: false, state: 'not_needed', ineligibleReason: 'not_enrolled',
  }).returning());
  expect(await reserveCollection({...inputFor(f), scheduleId: foreign!.id})).toMatchObject({outcome: 'refused', reason: 'schedule_inactive'});
  expect(await attempts(f.invoice.id)).toHaveLength(0);
  expect(provider.create).not.toHaveBeenCalled();
});

it.each(['skip', 'exclude', 'stop'] as const)('%s finalizes immediately and fences scheduler, charge-now, and client producers', async kind => {
  const f = await fixture();
  await withSystemDbAccessContext(async () => {
    if (kind === 'stop') await turnOffAutopay(db, f.actor, f.org.id);
    else expect(await requestInvoiceControl(db, {invoiceId: f.invoice.id, kind, actor: f.actor}))
      .toMatchObject({status: kind === 'skip' ? 'skipped' : 'excluded'});
  });
  const schedule = await scheduleFor(f);
  expect(schedule).toMatchObject({state: {skip: 'skipped_by_client', exclude: 'excluded_by_msp', stop: 'cancelled'}[kind], nextAttemptAt: null});
  for (const initiatedBy of ['scheduler', 'msp_charge_now', 'client_on_session'] as const) {
    const result = await attemptCollection({invoiceId: f.invoice.id, initiatedBy,
      ...(initiatedBy === 'client_on_session' ? {} : {scheduleId: f.schedule.id})});
    expect(result.outcome).not.toBe('created');
  }
  expect(await runAutopayCollection()).toMatchObject({attempted: 0});
  expect(provider.create).not.toHaveBeenCalled();
  expect(provider.confirm).not.toHaveBeenCalled();
});

it.each(['skip', 'exclude', 'stop'] as const)('%s stays pending until cancellation is verified, then finalizes once', async kind => {
  const f = await fixture();
  provider.confirm.mockRejectedValueOnce(new Error('crash before confirm'));
  await expect(attemptCollection(inputFor(f))).rejects.toThrow('crash before confirm');
  await withSystemDbAccessContext(async () => {
    if (kind === 'stop') await turnOffAutopay(db, f.actor, f.org.id);
    else expect(await requestInvoiceControl(db, {invoiceId: f.invoice.id, kind, actor: f.actor})).toMatchObject({status: 'pending'});
  });
  expect(await scheduleFor(f)).toMatchObject({state: 'collecting', stateReason: `control_pending:${kind}`});
  provider.cancel.mockRejectedValueOnce(new Error('cancel response lost'));
  await reconcilePendingControls(); // retrieve still says requires_confirmation
  expect((await attempts(f.invoice.id))[0]!.state).toBe('confirming');
  expect(await scheduleFor(f)).toMatchObject({stateReason: `control_pending:${kind}`});
  await reconcilePendingControls();
  expect((await attempts(f.invoice.id))[0]!.state).toBe('canceled');
  expect(await scheduleFor(f)).toMatchObject({state: {skip: 'skipped_by_client', exclude: 'excluded_by_msp', stop: 'cancelled'}[kind], nextAttemptAt: null});
  const count = (await withSystemDbAccessContext(() => db.select().from(billingNoticeOutbox))).length;
  await reconcilePendingControls();
  expect(await withSystemDbAccessContext(() => db.select().from(billingNoticeOutbox))).toHaveLength(count);
  expect(provider.confirm).toHaveBeenCalledTimes(1);
});

it('settles succeeded-during-pending instead of sending a skip confirmation', async () => {
  const f = await fixture();
  await attemptCollection(inputFor(f));
  await withSystemDbAccessContext(() => requestInvoiceControl(db, {invoiceId: f.invoice.id, kind: 'skip', actor: f.actor}));
  currentPi = {...currentPi, status: 'succeeded', amount_received: 10000};
  await reconcilePendingControls();
  expect((await attempts(f.invoice.id))[0]!.state).toBe('succeeded');
  expect(await scheduleFor(f)).toMatchObject({state: 'succeeded', nextAttemptAt: null});
  const notices = await withSystemDbAccessContext(() => db.select().from(billingNoticeOutbox));
  expect(notices.some(row => row.dedupeKey === `invoice:${f.invoice.id}:skip:1`)).toBe(false);
  expect(await withSystemDbAccessContext(() => db.select().from(invoicePayments))).toHaveLength(1);
});

it.each([22, 24])('unknown create at %s hours replays only inside the 23-hour safety window', async age => {
  const f = await fixture();
  const normal = provider.create.getMockImplementation()!;
  provider.create.mockImplementationOnce(async (...args) => {await normal(...args); throw new Error('lost create');});
  await expect(attemptCollection(inputFor(f))).rejects.toThrow('lost create');
  const [attempt] = await attempts(f.invoice.id);
  await withSystemDbAccessContext(async () => {
    await db.update(invoiceCollectionAttempts).set({createdAt: new Date(Date.now() - age * 3600000)})
      .where(eq(invoiceCollectionAttempts.id, attempt!.id));
    await requestInvoiceControl(db, {invoiceId: f.invoice.id, kind: 'skip', actor: f.actor});
  });
  await reconcilePendingControls(); await reconcilePendingControls();
  const [final] = await attempts(f.invoice.id);
  if (age < 23) {
    expect(final!.state).toBe('canceled');
    expect(provider.create).toHaveBeenCalledTimes(2);
    expect(provider.create.mock.calls[0]![1]).toEqual(provider.create.mock.calls[1]![1]);
    expect(await scheduleFor(f)).toMatchObject({state: 'skipped_by_client'});
  } else {
    expect(final).toMatchObject({state: 'reserved', failureCode: 'provider_create_unknown'});
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(await scheduleFor(f)).toMatchObject({stateReason: 'control_pending:skip'});
  }
  expect(intentsByKey.size).toBe(1);
  expect(provider.confirm).not.toHaveBeenCalled();
});

it('schedule-less pending exclusion is discovered and releases only a verified canceled attempt', async () => {
  const f = await fixture();
  provider.confirm.mockRejectedValueOnce(new Error('crash'));
  await expect(attemptCollection(inputFor(f))).rejects.toThrow('crash');
  await withSystemDbAccessContext(async () => {
    await db.update(invoiceCollectionAttempts).set({scheduleId: null, initiatedBy: 'client_on_session'})
      .where(eq(invoiceCollectionAttempts.invoiceId, f.invoice.id));
    await db.delete(invoiceAutopaySchedules).where(eq(invoiceAutopaySchedules.id, f.schedule.id));
    expect(await requestInvoiceControl(db, {invoiceId: f.invoice.id, kind: 'exclude', actor: f.actor})).toMatchObject({status: 'pending'});
  });
  await reconcilePendingControls();
  expect((await attempts(f.invoice.id))[0]!.state).toBe('canceled');
  expect(provider.cancel).toHaveBeenCalledTimes(1);
  expect(provider.confirm).toHaveBeenCalledTimes(1);
  expect(await withSystemDbAccessContext(() => requestInvoiceControl(db, {invoiceId: f.invoice.id, kind: 'exclude', actor: f.actor})))
    .toMatchObject({status: 'excluded'});
});

it('only the current notice acknowledgement advances identity and the elapsed lead clock', async () => {
  const f = await fixture();
  await withSystemDbAccessContext(async () => {
    await db.update(invoiceAutopaySchedules).set({state: 'awaiting_notice', noticeSentAt: null,
      termsSnapshot: {...f.schedule.termsSnapshot as object, noticeSeq: 2}}).where(eq(invoiceAutopaySchedules.id, f.schedule.id));
    await enqueueAutopayNotice(db, f.schedule.id);
  });
  const before = await scheduleFor(f);
  expect(before.noticeOutboxId).not.toBe(f.notice.id);
  await withSystemDbAccessContext(() => invoiceAutopayNoticeSent(db, {...f.notice, sentAt: new Date()}));
  expect(await scheduleFor(f)).toEqual(before);
  const [current] = await withSystemDbAccessContext(() => db.select().from(billingNoticeOutbox)
    .where(eq(billingNoticeOutbox.id, before.noticeOutboxId!)));
  const sentAt = new Date();
  await withSystemDbAccessContext(() => invoiceAutopayNoticeSent(db, {...current!, sentAt}));
  expect(await scheduleFor(f)).toMatchObject({noticeOutboxId: current!.id, noticeSentAt: sentAt, state: 'scheduled'});
  expect(await attemptCollection(inputFor(f))).toMatchObject({outcome: 'deferred', reason: 'notice_lead'});
  expect(provider.create).not.toHaveBeenCalled();
});

it('breeze_app cannot read or forge another org collection history', async () => {
  const f = await fixture();
  await attemptCollection(inputFor(f));
  const other = await createOrganization({partnerId: f.partner.id});
  const ctx = {scope: 'organization' as const, orgId: other.id, accessibleOrgIds: [other.id], accessiblePartnerIds: []};
  await withDbAccessContext(ctx, async () => {
    const [role] = await db.execute<{name: string}>(sql`select current_user as name`);
    expect(role!.name).toBe('breeze_app');
    expect(await db.select().from(invoiceCollectionAttempts).where(eq(invoiceCollectionAttempts.invoiceId, f.invoice.id))).toEqual([]);
    expect(await db.select().from(invoiceAutopaySchedules).where(eq(invoiceAutopaySchedules.invoiceId, f.invoice.id))).toEqual([]);
    expect(await db.update(invoiceAutopaySchedules).set({state: 'cancelled'}).where(eq(invoiceAutopaySchedules.id, f.schedule.id)).returning()).toEqual([]);
  });
  const [attempt] = await attempts(f.invoice.id);
  await expect(withDbAccessContext(ctx, () => db.insert(invoiceCollectionAttempts).values({
    ...attempt!, id: randomUUID(), attemptNo: 2, idempotencyKey: `forged_${randomUUID()}`,
  }))).rejects.toMatchObject({cause: {code: '42501'}});
});

it.each(['pending', 'network', 'wallet', 'unsupported-network'])('refuses isolated %s method admission without creating money', async invalid => {
  const f = await fixture();
  if (invalid === 'pending') await withSystemDbAccessContext(() => db.update(orgPaymentMethods)
    .set({status: 'pending_verification'}).where(eq(orgPaymentMethods.id, f.method.id)));
  else if (invalid === 'network') provider.methodRetrieve.mockRejectedValueOnce(new Error('network unavailable'));
  else provider.methodRetrieve.mockResolvedValueOnce({id: f.method.stripePaymentMethodId, customer: 'cus_autopay_test', type: 'card',
    card: {brand: 'visa', funding: 'credit', networks: {available: invalid === 'unsupported-network' ? ['unknown'] : ['visa']},
      ...(invalid === 'wallet' ? {wallet: {type: 'link'}} : {})}});
  expect((await attemptCollection(inputFor(f))).outcome).toBe('deferred');
  expect(provider.create).not.toHaveBeenCalled();
  expect(provider.confirm).not.toHaveBeenCalled();
  expect(await attempts(f.invoice.id)).toHaveLength(0);
});

import type Stripe from 'stripe';
import { autopaySetupAttempts } from '../../db/schema/autopaySetupAttempts';
import { persistCapturedAutopayMethod } from './setupCompletion';
import { mintBillingLinkToken } from './linkTokens';
import { collectAfterBankSetup } from './bankPayment';
import { disconnectPartnerStripe } from '../partnerStripe';
import { pollStripeFinancialEvents } from '../stripeFinancialEventPoller';

async function bankSetup(f: Awaited<ReturnType<typeof fixture>>, suffix: string) {
  const seeded = await withSystemDbAccessContext(async () => {
    const token = await mintBillingLinkToken(db, {orgId: f.org.id, invoiceId: f.invoice.id,
      enrollmentId: f.enrollment.id, generation: 1, purpose: 'enroll', ttlDays: 1});
    const [setup] = await db.insert(autopaySetupAttempts).values({
      orgId: f.org.id, partnerId: f.partner.id, enrollmentId: f.enrollment.id, generation: 1,
      stripeConnectionId: f.connection.id, stripeAccountId: 'acct_autopay_test', stripeCustomerId: 'cus_autopay_test',
      tokenId: token.id, source: 'setup_page', methodType: 'us_bank_account',
      checkoutSessionId: `cs_bank_${suffix}`, setupIntentId: `seti_bank_${suffix}`,
      consentSnapshot: {version: '2026-10-01.v1', text: 'Authorization', hash: 'a'.repeat(64), textHash: 'b'.repeat(64),
        partnerName: f.partner.name, scheduleText: 'Due date', feeText: 'No fee', achMode: 'ach_preferred',
        scheduleTerms: {offsetDays: 0, rule: 'later', cap: {enabled: false}},
        feeTerms: {methodType: 'us_bank_account', cardFeeBps: 0, achFeeAmount: '0.00', feeAttested: false, currency: 'USD'},
        source: 'setup_page', contactEmail: 'billing@example.test', ip: null, userAgent: null,
        invoiceId: null, checkoutKey: null,
        bankPayment: {invoiceId: f.invoice.id, orgId: f.org.id, principal: '100.00', fee: '0.00', currency: 'USD', disclosureHash: 'a'.repeat(64)}},
    }).returning();
    return {token, setup: setup!};
  });
  const method = {id: `pm_bank_${suffix}`, type: 'us_bank_account', customer: 'cus_autopay_test',
    us_bank_account: {account_holder_type: 'company', bank_name: 'Test bank', last4: '6789'}} as Stripe.PaymentMethod;
  await persistCapturedAutopayMethod(seeded.setup.id, method, 'activated', seeded.setup.setupIntentId, `mandate_${suffix}`);
  const [saved] = await withSystemDbAccessContext(() => db.select().from(orgPaymentMethods)
    .where(eq(orgPaymentMethods.stripePaymentMethodId, method.id)));
  const session = {id: seeded.setup.checkoutSessionId, mode: 'setup', status: 'complete', customer: 'cus_autopay_test',
    setup_intent: seeded.setup.setupIntentId, metadata: {invoice_id: f.invoice.id, org_id: f.org.id,
      token_id: seeded.token.id, generation: '1', principal_minor: '10000', fee_minor: '0', currency: 'USD'}};
  const intent = {id: seeded.setup.setupIntentId, status: 'succeeded', customer: 'cus_autopay_test', payment_method: method.id,
    mandate: `mandate_${suffix}`, metadata: {setup_attempt_id: seeded.setup.id, org_id: f.org.id,
      enrollment_id: f.enrollment.id, generation: '1', token_id: seeded.token.id}};
  return {...seeded, method: saved!, liveMethod: method, session, intent,
    authority: {tokenId: seeded.token.id, invoiceId: f.invoice.id, generation: 1, methodId: saved!.id,
      principal: '100.00', fee: '0.00', currency: 'USD', capture: {setupAttemptId: seeded.setup.id,
        stripePaymentMethodId: method.id, setupIntentId: seeded.setup.setupIntentId!,
        stripeAccountId: 'acct_autopay_test', stripeCustomerId: 'cus_autopay_test'}}};
}
function serveBank(setups: Awaited<ReturnType<typeof bankSetup>>[]) {
  provider.sessionRetrieve.mockImplementation(async id => {
    expect(hasDbAccessContext()).toBe(false);
    return setups.find(row => row.session.id === id)!.session;
  });
  provider.setupRetrieve.mockImplementation(async id => {
    expect(hasDbAccessContext()).toBe(false);
    return setups.find(row => row.intent.id === id)!.intent;
  });
  provider.methodRetrieve.mockImplementation(async id => {
    expect(hasDbAccessContext()).toBe(false);
    return setups.find(row => row.liveMethod.id === id)!.liveMethod;
  });
  provider.mandateRetrieve.mockImplementation(async id => ({id, status: 'active', payment_method: setups.find(row => row.intent.mandate === id)!.method.stripePaymentMethodId}));
}

it('old bank A cannot be collected after replacement B, including replay of completed setup A', async () => {
  const f = await fixture();
  const a = await bankSetup(f, 'A');
  const b = await bankSetup(f, 'B');
  serveBank([a, b]);
  await expect(collectAfterBankSetup({invoiceId: f.invoice.id, orgId: f.org.id, setupSessionId: a.session.id!}))
    .rejects.toMatchObject({code: 'INVALID_STATE'});
  expect(provider.create).not.toHaveBeenCalled();
  expect(provider.confirm).not.toHaveBeenCalled();
  expect(await attempts(f.invoice.id)).toHaveLength(0);
});

it('bank pay serializes simultaneous token collection into one distinct provider debit', async () => {
  const f = await fixture();
  const a = await bankSetup(f, 'A'); serveBank([a]);
  const input = {invoiceId: f.invoice.id, orgId: f.org.id, setupSessionId: a.session.id!};
  const results = await Promise.allSettled([collectAfterBankSetup(input), collectAfterBankSetup(input)]);
  expect(results.filter(result => result.status === 'fulfilled' && result.value.outcome === 'created')).toHaveLength(1);
  expect(await attempts(f.invoice.id)).toHaveLength(1);
  expect(intentsByKey.size).toBe(1);
  expect(provider.confirm).toHaveBeenCalledTimes(1);
});

it('bank reservation and consumed authority roll back together on a database fault', async () => {
  const f = await fixture();
  const a = await bankSetup(f, 'A'); serveBank([a]);
  await getTestDb().execute(sql`create function task_l_reject_attempt() returns trigger language plpgsql as $$
    begin raise exception 'task L bank reservation rollback'; end $$`);
  await getTestDb().execute(sql`create trigger task_l_reject_attempt after insert on invoice_collection_attempts
    for each row execute function task_l_reject_attempt()`);
  try {
    await expect(collectAfterBankSetup({invoiceId: f.invoice.id, orgId: f.org.id, setupSessionId: a.session.id!}))
      .rejects.toThrow();
  } finally {
    await getTestDb().execute(sql`drop trigger task_l_reject_attempt on invoice_collection_attempts`);
    await getTestDb().execute(sql`drop function task_l_reject_attempt()`);
  }
  expect(await attempts(f.invoice.id)).toHaveLength(0);
  expect(provider.create).not.toHaveBeenCalled();
  // Successful reuse proves the token/capture write also rolled back.
  expect(await collectAfterBankSetup({invoiceId: f.invoice.id, orgId: f.org.id, setupSessionId: a.session.id!}))
    .toMatchObject({outcome: 'created'});
});

it('replacement commits while bank A confirmation waits for the enrollment lock; A is canceled', async () => {
  const f = await fixture();
  const a = await bankSetup(f, 'A'); serveBank([a]);
  const created = barrier(), resume = barrier();
  const normalRetrieve = provider.retrieve.getMockImplementation()!;
  provider.retrieve.mockImplementationOnce(async (...args) => {created.release(); await resume.wait; return normalRetrieve(...args);});
  const collect = collectAfterBankSetup({invoiceId: f.invoice.id, orgId: f.org.id, setupSessionId: a.session.id!});
  await Promise.race([created.wait, collect.then(() => {throw new Error('PI barrier not reached');})]);
  const locked = barrier(), release = barrier(); let pid = 0;
  const replacement = withSystemDbAccessContext(async () => {
    const [backend] = await db.execute<{pid: number}>(sql`select pg_backend_pid() as pid`); pid = backend!.pid;
    await db.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.id, f.enrollment.id)).for('update');
    locked.release(); await release.wait;
    await db.update(orgPaymentMethods).set({isAutopayMethod: false}).where(eq(orgPaymentMethods.id, a.method.id));
    await db.insert(orgPaymentMethods).values({orgId: f.org.id, enrollmentId: f.enrollment.id,
      stripePaymentMethodId: 'pm_bank_B', stripeSetupIntentId: 'seti_bank_B', type: 'us_bank_account',
      accountHolderType: 'company', bankLast4: '4321', status: 'active', isAutopayMethod: true});
  });
  await locked.wait; resume.release();
  try { await blockedBy(pid); expect(provider.confirm).not.toHaveBeenCalled(); }
  finally {release.release(); await replacement; await collect;}
  expect(provider.confirm).not.toHaveBeenCalled();
  expect(provider.cancel).toHaveBeenCalledTimes(1);
  expect((await attempts(f.invoice.id))[0]!.state).toBe('canceled');
});

it('stale-generation setup completion after stop never restores collection authority', async () => {
  const f = await fixture();
  const a = await bankSetup(f, 'stale');
  await withSystemDbAccessContext(async () => {
    await db.update(autopaySetupAttempts).set({outcome: null, completedAt: null}).where(eq(autopaySetupAttempts.id, a.setup.id));
    await turnOffAutopay(db, f.actor, f.org.id);
  });
  expect(await persistCapturedAutopayMethod(a.setup.id, a.liveMethod, 'activated', a.setup.setupIntentId, 'mandate_stale'))
    .toMatchObject({outcome: 'stale_generation'});
  expect(await withSystemDbAccessContext(() => db.select().from(orgPaymentMethods).where(eq(orgPaymentMethods.isAutopayMethod, true)))).toHaveLength(0);
  expect(provider.confirm).not.toHaveBeenCalled();
});

it('concurrent reconcilers serialize under the invoice lock and book one ledger payment', async () => {
  const f = await fixture(); const result = await attemptCollection(inputFor(f));
  currentPi = {...currentPi, status: 'succeeded', amount_received: 10000};
  const locked = barrier(), release = barrier(); let pid = 0;
  const holder = withSystemDbAccessContext(async () => {
    const [backend] = await db.execute<{pid: number}>(sql`select pg_backend_pid() as pid`); pid = backend!.pid;
    await db.select().from(invoices).where(eq(invoices.id, f.invoice.id)).for('update');
    locked.release(); await release.wait;
  });
  await locked.wait;
  const workers = Promise.all([applyAttemptOutcome(f.partner.id, result.attemptId!), applyAttemptOutcome(f.partner.id, result.attemptId!)]);
  try {await blockedBy(pid);} finally {release.release(); await holder; await workers;}
  expect(await withSystemDbAccessContext(() => db.select().from(invoicePayments).where(eq(invoicePayments.invoiceId, f.invoice.id)))).toHaveLength(1);
  expect((await attempts(f.invoice.id))[0]!.state).toBe('succeeded');
  expect(intentsByKey.size).toBe(1);
});

it('disconnect retains historical credentials and the real poller settles using the original account', async () => {
  const f = await fixture();
  await attemptCollection(inputFor(f));
  await disconnectPartnerStripe(f.partner.id);
  const [mapping] = await withSystemDbAccessContext(() => db.select().from(invoiceStripePayments).where(eq(invoiceStripePayments.invoiceId, f.invoice.id)));
  expect(mapping!.revocationCredentialId).toBeTruthy();
  currentPi = {...currentPi, status: 'succeeded', amount_received: 10000};
  provider.eventList.mockResolvedValue({has_more: false, data: [{id: `evt_poll_${f.invoice.id}`, type: 'payment_intent.succeeded',
    account: 'acct_autopay_test', created: Math.floor(Date.now()/1000), livemode: false, data: {object: currentPi}}]});
  expect(await pollStripeFinancialEvents()).toMatchObject({accounts: 1, events: 1});
  expect((await attempts(f.invoice.id))[0]!.state).toBe('succeeded');
  expect(vi.mocked(getPartnerStripeClient)).toHaveBeenCalledWith(f.partner.id, expect.objectContaining({
    reconciliationAccountId: 'acct_autopay_test', archivedCredentialId: mapping!.revocationCredentialId,
  }));
  expect(await withSystemDbAccessContext(() => db.select().from(invoicePayments).where(eq(invoicePayments.invoiceId, f.invoice.id)))).toHaveLength(1);
});

import { drainAutopayMethodDetaches } from './merge';
import { billingLinkTokens } from '../../db/schema';

it('bank authority remains immutable and consumed after terminal cancellation', async () => {
  const f = await fixture(); const a = await bankSetup(f, 'terminal'); serveBank([a]);
  const before = a.setup.consentSnapshot;
  provider.confirm.mockImplementationOnce(async () => {
    currentPi = {...currentPi, status: 'canceled', last_payment_error: null};
    return currentPi;
  });
  const input = {invoiceId: f.invoice.id, orgId: f.org.id, setupSessionId: a.session.id!};
  await collectAfterBankSetup(input);
  expect((await attempts(f.invoice.id))[0]).toMatchObject({state: 'canceled',
    paymentMethodId: a.method.id, idempotencyKey: `autopay-bankpay:${a.setup.id}`});
  const [saved] = await withSystemDbAccessContext(() => db.select().from(autopaySetupAttempts).where(eq(autopaySetupAttempts.id, a.setup.id)));
  expect(saved!.consentSnapshot).toEqual(before);
  // Even if token consumption is reset, the durable attempt consumes this authority in every state.
  await withSystemDbAccessContext(() => db.update(billingLinkTokens).set({consumedAt: null}).where(eq(billingLinkTokens.id, a.token.id)));
  expect(await collectAfterBankSetup(input)).toMatchObject({outcome: 'refused', reason: 'client_authorization_used'});
  expect(await attempts(f.invoice.id)).toHaveLength(1);
  expect(provider.create).toHaveBeenCalledTimes(1);
});

it('Stop fences all invoices, sends one protected notice, and detaches only after every reservation settles', async () => {
  const f = await fixture();
  async function sibling() {
    return withSystemDbAccessContext(async () => {
      const [invoice] = await db.insert(invoices).values({...f.invoice, id: randomUUID(), invoiceNumber: `T-${randomUUID()}`}).returning();
      const [notice] = await db.insert(billingNoticeOutbox).values({...f.notice, id: randomUUID(), invoiceId: invoice!.id, dedupeKey: randomUUID()}).returning();
      const [schedule] = await db.insert(invoiceAutopaySchedules).values({...f.schedule, id: randomUUID(), invoiceId: invoice!.id, noticeOutboxId: notice!.id}).returning();
      return {...f, invoice: invoice!, schedule: schedule!};
    });
  }
  const second = await sibling(), idle = await sibling();
  await attemptCollection(inputFor(f)); const firstPi = {...currentPi};
  await attemptCollection(inputFor(second)); const secondPi = {...currentPi};
  const token = await withSystemDbAccessContext(() => mintBillingLinkToken(db, {orgId: f.org.id, enrollmentId: f.enrollment.id, generation: 1, purpose: 'enroll', ttlDays: 1}));
  // A custom body must not be able to suppress the in-flight money disclosure.
  await withSystemDbAccessContext(() => db.update(partners).set({settings: {emailTemplates: {autopay_stopped: {html: '<p>Custom stopped body</p>'}}}}).where(eq(partners.id, f.partner.id)));
  await withSystemDbAccessContext(() => turnOffAutopay(db, f.actor, f.org.id));
  expect(await scheduleFor(f)).toMatchObject({state: 'collecting', stateReason: 'control_pending:stop'});
  expect(await scheduleFor(second)).toMatchObject({state: 'collecting', stateReason: 'control_pending:stop'});
  expect(await scheduleFor(idle)).toMatchObject({state: 'cancelled', nextAttemptAt: null});
  const [enrollment] = await withSystemDbAccessContext(() => db.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.id, f.enrollment.id)));
  expect(enrollment!.status).toBe('cancelled');
  const [revoked] = await withSystemDbAccessContext(() => db.select().from(billingLinkTokens).where(eq(billingLinkTokens.id, token.id)));
  expect(revoked!.revokedAt).not.toBeNull();
  const [method] = await withSystemDbAccessContext(() => db.select().from(orgPaymentMethods).where(eq(orgPaymentMethods.id, f.method.id)));
  expect(method).toMatchObject({status: 'removed', isAutopayMethod: false});
  const stopped = await withSystemDbAccessContext(() => db.select().from(billingNoticeOutbox).where(eq(billingNoticeOutbox.kind, 'autopay_stopped')));
  expect(stopped).toHaveLength(1);
  const stoppedContent = stopped[0]!.rendered as {html: string; text: string};
  for (const body of [stoppedContent.html, stoppedContent.text]) {
    expect(body).toContain(f.invoice.invoiceNumber); expect(body).toContain(second.invoice.invoiceNumber);
    expect(body).toContain('is being cancelled'); expect(body).toContain('receipt');
  }
  await drainAutopayMethodDetaches(); expect(provider.methodDetach).not.toHaveBeenCalled();
  provider.retrieve.mockImplementation(async id => {
    expect(hasDbAccessContext()).toBe(false);
    return id === firstPi.id ? {...firstPi, status: 'canceled'} : secondPi;
  });
  await reconcilePendingControls();
  expect((await attempts(f.invoice.id))[0]!.state).toBe('canceled');
  expect((await attempts(second.invoice.id))[0]!.state).toBe('processing');
  await drainAutopayMethodDetaches(); expect(provider.methodDetach).not.toHaveBeenCalled();
  secondPi.status = 'succeeded'; secondPi.amount_received = 10000;
  await reconcilePendingControls();
  expect((await attempts(second.invoice.id))[0]!.state).toBe('succeeded');
  expect(await scheduleFor(f)).toMatchObject({state: 'cancelled'});
  expect(await scheduleFor(second)).toMatchObject({state: 'succeeded'});
  await drainAutopayMethodDetaches(); expect(provider.methodDetach).toHaveBeenCalledTimes(1);
  await withSystemDbAccessContext(() => turnOffAutopay(db, f.actor, f.org.id));
  await reconcilePendingControls(); await drainAutopayMethodDetaches();
  expect(provider.methodDetach).toHaveBeenCalledTimes(1);
  const notices = await withSystemDbAccessContext(() => db.select().from(billingNoticeOutbox));
  expect(notices.filter(n => n.kind === 'autopay_stopped')).toHaveLength(1);
  expect(notices.filter(n => n.kind === 'payment_receipt' && n.invoiceId === second.invoice.id)).toHaveLength(1);
});

it('Stop waits for a reservation transaction without blocking its org foreign key', async () => {
  const f = await fixture();
  const locked = barrier(), release = barrier(); let pid = 0;
  const reserving = withSystemDbAccessContext(async () => {
    const [backend] = await db.execute<{pid: number}>(sql`select pg_backend_pid() as pid`); pid = backend!.pid;
    await db.select().from(invoices).where(eq(invoices.id, f.invoice.id)).for('update');
    await db.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.id, f.enrollment.id)).for('update');
    locked.release(); await release.wait;
    await db.insert(invoiceCollectionAttempts).values({orgId: f.org.id, invoiceId: f.invoice.id, scheduleId: f.schedule.id,
      paymentMethodId: f.method.id, attemptNo: 1, idempotencyKey: `autopay_${f.schedule.id}_1`,
      principalAmount: '100.00', feeAmount: '0.00', currency: 'USD', state: 'reserved', initiatedBy: 'scheduler'});
    await db.update(invoiceAutopaySchedules).set({state: 'collecting', attemptCount: 1}).where(eq(invoiceAutopaySchedules.id, f.schedule.id));
  }).then(() => null, error => error);
  await locked.wait;
  const stopping = withSystemDbAccessContext(() => turnOffAutopay(db, f.actor, f.org.id)).then(() => null, error => error);
  try {await blockedBy(pid);} finally {release.release();}
  expect(await reserving).toBeNull(); expect(await stopping).toBeNull();
  expect(await scheduleFor(f)).toMatchObject({state: 'collecting', stateReason: 'control_pending:stop'});
  expect((await attempts(f.invoice.id))[0]!.state).toBe('reserved');
  expect(provider.methodDetach).not.toHaveBeenCalled();
});

it('Stop includes a schedule-less bank debit in the protected pending notice', async () => {
  const f = await fixture(); const a = await bankSetup(f, 'stop'); serveBank([a]);
  await withSystemDbAccessContext(() => db.delete(invoiceAutopaySchedules).where(eq(invoiceAutopaySchedules.id, f.schedule.id)));
  await collectAfterBankSetup({invoiceId: f.invoice.id, orgId: f.org.id, setupSessionId: a.session.id!});
  expect((await attempts(f.invoice.id))[0]).toMatchObject({scheduleId: null, state: 'processing'});
  provider.methodDetach.mockClear();
  await withSystemDbAccessContext(() => turnOffAutopay(db, f.actor, f.org.id));
  const [notice] = await withSystemDbAccessContext(() => db.select().from(billingNoticeOutbox).where(eq(billingNoticeOutbox.kind, 'autopay_stopped')));
  expect((notice!.rendered as {text: string}).text).toContain(`invoice ${f.invoice.invoiceNumber} is being cancelled`);
  await drainAutopayMethodDetaches(); expect(provider.methodDetach).not.toHaveBeenCalled();
  expect((await attempts(f.invoice.id))[0]!.state).toBe('processing');
});
