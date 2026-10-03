import '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext, withDbAccessContext, hasDbAccessContext } from '../../db';
import { createPartner, createOrganization, createUser } from '../../__tests__/integration/db-utils';
import { partners, invoices, orgAutopayEnrollments, orgPaymentMethods, invoiceAutopaySchedules,
  invoiceCollectionAttempts, invoiceStripePayments, stripeConnectAccounts, invoicePayments,
  organizations, billingNoticeOutbox, stripeFinancialEvents, orgMergeEvents, userNotifications } from '../../db/schema';
import { encryptSecret } from '../secretCrypto';
import { attemptCollection, resumeCollectionAttempt, applyAttemptOutcome } from './collectionEngine';
import {recordPayment,getInvoice} from '../invoiceService';
import {executeOrgMerge} from '../orgMerge';
import {ingestStripeFinancialEvent,processPendingStripeFinancialEvents,processPendingStripeFinancialEventsForPayment} from '../stripeReversalState';
import {enqueueAutopayNotice} from './chargingNotice';
import { createInvoicePayLink } from '../invoiceCheckout';
const provider = vi.hoisted(() => ({ search: vi.fn(), create: vi.fn(), retrieve: vi.fn(), confirm: vi.fn(), cancel: vi.fn(),
  accountRetrieve: vi.fn(), probeUpdate: vi.fn(), setupRetrieve: vi.fn(), mandateRetrieve: vi.fn(), eventList: vi.fn(), sessionCreate: vi.fn(), sessionExpire: vi.fn(), sessionRetrieve: vi.fn(), methodRetrieve:vi.fn(),methodDetach:vi.fn() }));
vi.mock('../partnerStripeClient', () => ({
  getPartnerStripeClient: vi.fn(async (partnerId: string, options?: {reconciliationAccountId?: string}) => ({ stripeAccountId: options?.reconciliationAccountId ?? accountsByPartner.get(partnerId) ?? 'acct_autopay_test', defaultCurrency: 'USD',
    stripe: { accounts: {retrieve: provider.accountRetrieve}, customers: {update: provider.probeUpdate}, setupIntents: {update: provider.probeUpdate, retrieve: provider.setupRetrieve}, mandates: {retrieve: provider.mandateRetrieve}, events: {list: provider.eventList}, paymentMethods:{update: provider.probeUpdate, retrieve:provider.methodRetrieve,detach:provider.methodDetach}, paymentIntents: { search: provider.search, update: provider.probeUpdate, create: provider.create, retrieve: provider.retrieve, confirm: provider.confirm, cancel: provider.cancel },
      checkout: { sessions: { create: provider.sessionCreate, expire: provider.sessionExpire, retrieve: provider.sessionRetrieve } } } })),
}));
vi.mock('../invoiceEvents', () => ({ emitInvoiceEvent: vi.fn() }));
vi.mock('../../jobs/accountingSyncWorker', () => ({ enqueueAccountingInvoicePush: vi.fn(), enqueueAccountingInvoiceVoid: vi.fn(),
  enqueueAccountingPaymentPush: vi.fn(), enqueueAccountingPaymentDelete: vi.fn() }));
vi.mock('../../jobs/invoiceWorker', () => ({ enqueueInvoicePdfRender: vi.fn() }));
let currentPi: any;
const intentsByKey = new Map<string, any>();
const accountsByPartner = new Map<string, string>();
afterEach(() => vi.useRealTimers());
beforeEach(() => {
  vi.stubEnv('ORG_MERGE_FENCE_DRAIN_MS', '0');
  vi.resetAllMocks();
  intentsByKey.clear();
  accountsByPartner.clear();
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
async function fixture(accountId = 'acct_autopay_test') {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    accountsByPartner.set(partner.id, accountId);
    const org = await createOrganization({ partnerId: partner.id });
    await db.update(organizations).set({ billingContact: {email: 'billing@example.test'} }).where(eq(organizations.id, org.id));
    await db.update(partners).set({ autopayEnabled: true }).where(eq(partners.id, partner.id));
    const [connection] = await db.insert(stripeConnectAccounts).values({ partnerId: partner.id,
      stripeAccountId: accountId, status: 'connected', accountCountry: 'US', defaultCurrency: 'USD',
      keyLast4: 'only', apiKey: encryptSecret(['sk','test','fixture_only'].join('_')), autopayMissingPermissions: [],
      autopayCapabilitiesCheckedAt: new Date() }).returning();
    const [enrollment] = await db.insert(orgAutopayEnrollments).values({ orgId: org.id, partnerId: partner.id,
      status: 'active', generation: 1, stripeConnectionId: connection!.id, stripeAccountId: connection!.stripeAccountId,
      stripeCustomerId: 'cus_autopay_test', effectiveFrom: new Date('2020-01-01T00:00Z'), requestedAt: new Date() }).returning();
    const [method] = await db.insert(orgPaymentMethods).values({ orgId: org.id, enrollmentId: enrollment!.id,
      stripePaymentMethodId: 'pm_autopay_test',stripeSetupIntentId:'seti_fixture', type: 'card', cardBrand: 'visa', cardLast4: '4242', cardFunding: 'credit',
      status: 'active', isAutopayMethod: true }).returning();
    await db.insert(autopaySetupAttempts).values({orgId:org.id,partnerId:partner.id,enrollmentId:enrollment!.id,
      generation:1,source:'setup_page',methodType:'card',stripeConnectionId:connection!.id,stripeAccountId:accountId,
      stripeCustomerId:'cus_autopay_test',setupIntentId:'seti_fixture',consentSnapshot:{},outcome:'activated'});
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
  expect(provider.confirm).toHaveBeenCalledOnce();
  expect((await attempts(f.invoice.id))[0]!.state).toBe('processing');
});
it('recovers a crash after mapping commit but before confirm without creating again', async () => {
  const f = await fixture();
  provider.confirm.mockRejectedValueOnce(new Error('process stopped'));
  await expect(attemptCollection({invoiceId:f.invoice.id,scheduleId:f.schedule.id,initiatedBy:'scheduler'})).rejects.toThrow();
  const [attempt] = await attempts(f.invoice.id);
  expect(attempt!.invoiceStripePaymentId).toBeTruthy();
  await resumeCollectionAttempt(attempt!.id);
  expect(provider.create).toHaveBeenCalledTimes(1);
  expect(provider.confirm).toHaveBeenCalledTimes(2);
  expect((await attempts(f.invoice.id))[0]!.state).toBe('processing');
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
async function blockedBy(pid: number, count = 1) {
  await vi.waitFor(async () => {
    const rows = await getTestDb().execute(sql`with recursive waiters(pid) as (
      select ${pid}::int union select a.pid from pg_stat_activity a join waiters w
      on w.pid = any(pg_blocking_pids(a.pid)) where a.wait_event_type = 'Lock'
    ) select pid from waiters where pid <> ${pid}`);
    expect(rows.length).toBeGreaterThanOrEqual(count);
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
    // Both manual and collector must be waiting before the holder releases.
    await blockedBy(pid, 2);
    expect(provider.create).not.toHaveBeenCalled();
  } finally { release.release(); await holder; await manual; await collect; }
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

it.each(['invoice', 'org'] as const)('refuses an otherwise collectible schedule owned by a different %s', async ownership => {
  const f = await fixture();
  const foreign = ownership === 'org' ? await fixture(`acct_foreign_${randomUUID()}`) : await siblingInvoice(f);
  expect(await reserveCollection({...inputFor(f), scheduleId: foreign.schedule.id}))
    .toMatchObject({outcome: 'refused', reason: 'schedule_inactive'});
  expect(await attempts(f.invoice.id)).toHaveLength(0);
  expect(provider.create).not.toHaveBeenCalled();
  // Each schedule independently collects when paired with its actual invoice.
  expect(await attemptCollection(inputFor(f))).toMatchObject({outcome: 'created'});
  expect(await attemptCollection(inputFor(foreign))).toMatchObject({outcome: 'created'});
  expect(intentsByKey.size).toBe(2);
});

it.each(['skip', 'exclude', 'stop'] as const)('%s finalizes immediately and fences scheduler and charge-now producers', async kind => {
  const f = await fixture();
  await withSystemDbAccessContext(async () => {
    if (kind === 'stop') await turnOffAutopay(db, f.actor, f.org.id);
    else expect(await requestInvoiceControl(db, {invoiceId: f.invoice.id, kind, actor: f.actor}))
      .toMatchObject({status: kind === 'skip' ? 'skipped' : 'excluded'});
  });
  const schedule = await scheduleFor(f);
  expect(schedule).toMatchObject({state: {skip: 'skipped_by_client', exclude: 'excluded_by_msp', stop: 'cancelled'}[kind], nextAttemptAt: null});
  for (const initiatedBy of ['scheduler', 'msp_charge_now'] as const) {
    const result = await attemptCollection({invoiceId: f.invoice.id, initiatedBy,
      scheduleId: f.schedule.id});
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

it.each([-1, 1])('unknown create at 23 hours %+i ms replays only inside the safety window', async epsilon => {
  const f = await fixture();
  const normal = provider.create.getMockImplementation()!;
  provider.create.mockImplementationOnce(async (...args) => {await normal(...args); throw new Error('lost create');});
  await expect(attemptCollection(inputFor(f))).rejects.toThrow('lost create');
  const [attempt] = await attempts(f.invoice.id);
  vi.useFakeTimers({toFake: ['Date']});
  vi.setSystemTime(new Date());
  await withSystemDbAccessContext(async () => {
    await db.update(invoiceCollectionAttempts).set({createdAt: new Date(Date.now() - 23 * 3600000 - epsilon)})
      .where(eq(invoiceCollectionAttempts.id, attempt!.id));
    await requestInvoiceControl(db, {invoiceId: f.invoice.id, kind: 'skip', actor: f.actor});
  });
  if(epsilon>0) await withSystemDbAccessContext(()=>db.update(orgPaymentMethods).set({stripeSetupIntentId:null}).where(eq(orgPaymentMethods.id,f.method.id)));
  await reconcilePendingControls(); await reconcilePendingControls();
  const [final] = await attempts(f.invoice.id);
  if (epsilon < 0) {
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
  const aged=new Date(Date.now()-2*86_400_000);
  await withSystemDbAccessContext(async()=>{
    await db.update(billingNoticeOutbox).set({status:'sent',sentAt:aged}).where(eq(billingNoticeOutbox.id,current!.id));
    await db.update(invoiceAutopaySchedules).set({noticeSentAt:aged}).where(eq(invoiceAutopaySchedules.id,f.schedule.id));
  });
  expect(await attemptCollection(inputFor(f))).toMatchObject({outcome:'created'});
  expect(provider.confirm).toHaveBeenCalledOnce();
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

async function bankSetup(f: Awaited<ReturnType<typeof fixture>>, suffix: string, stripeMethodId = `pm_bank_${suffix}`) {
  const seeded = await withSystemDbAccessContext(async () => {
    const token = await mintBillingLinkToken(db, {orgId: f.org.id, invoiceId: f.invoice.id,
      enrollmentId: f.enrollment.id, generation: 1, purpose: 'enroll', ttlDays: 1});
    const [setup] = await db.insert(autopaySetupAttempts).values({
      orgId: f.org.id, partnerId: f.partner.id, enrollmentId: f.enrollment.id, generation: 1,
      stripeConnectionId: f.connection.id, stripeAccountId: f.connection.stripeAccountId, stripeCustomerId: 'cus_autopay_test',
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
  const method = {id: stripeMethodId, type: 'us_bank_account', customer: 'cus_autopay_test',
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
        stripeAccountId: f.connection.stripeAccountId, stripeCustomerId: 'cus_autopay_test'}}};
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

it.each([false, true])('recovers a lost bank create after same-method replacement without confirming old authority (cancelOnly=%s)', async cancelOnly => {
  const f = await fixture();
  const original = await bankSetup(f, 'original'); serveBank([original]);
  const create = provider.create.getMockImplementation()!;
  provider.create.mockImplementationOnce(async (...args) => {
    await create(...args);
    throw new Error('bank create response lost');
  });
  await expect(collectAfterBankSetup({invoiceId: f.invoice.id, orgId: f.org.id, setupSessionId: original.session.id!}))
    .rejects.toThrow('bank create response lost');
  const [reserved] = await attempts(f.invoice.id);
  expect(reserved).toMatchObject({state: 'reserved', stripePaymentIntentId: null,
    paymentMethodId: original.method.id, idempotencyKey: `autopay-bankpay:${original.setup.id}`});
  expect(provider.confirm).not.toHaveBeenCalled();

  // Complete a real replacement setup that updates the existing method row in place.
  const replacement = await bankSetup(f, 'replacement', original.method.stripePaymentMethodId);
  serveBank([original, replacement]);
  expect(replacement.method).toMatchObject({id: original.method.id, status: 'active', isAutopayMethod: true,
    stripeSetupIntentId: replacement.setup.setupIntentId});
  expect(replacement.method.stripeSetupIntentId).not.toBe(original.setup.setupIntentId);
  // Recovery is permitted inside the 23-hour idempotency safety window.
  await withSystemDbAccessContext(() => db.update(invoiceCollectionAttempts)
    .set({createdAt: new Date(Date.now() - 22 * 3_600_000)}).where(eq(invoiceCollectionAttempts.id, reserved!.id)));
  await resumeCollectionAttempt(reserved!.id, cancelOnly);

  expect(provider.create).toHaveBeenCalledTimes(2);
  expect(provider.create.mock.calls[1]).toEqual(provider.create.mock.calls[0]);
  expect(intentsByKey.size).toBe(1);
  expect(provider.confirm).not.toHaveBeenCalled();
  expect(provider.cancel).toHaveBeenCalledTimes(1);
  expect(currentPi.status).toBe('canceled');
  const recovered = await attempts(f.invoice.id);
  expect(recovered).toHaveLength(1);
  expect(recovered[0]).toMatchObject({id: reserved!.id, state: 'canceled', stripePaymentIntentId: currentPi.id});
  if (!cancelOnly) {
    const [schedule] = await withSystemDbAccessContext(() => db.select().from(invoiceAutopaySchedules)
      .where(eq(invoiceAutopaySchedules.id, f.schedule.id)));
    expect(schedule).toMatchObject({state: 'cancelled', stateReason: 'authority_changed'});
  }
  expect(await withSystemDbAccessContext(() => db.select().from(invoicePayments)
    .where(eq(invoicePayments.invoiceId, f.invoice.id)))).toHaveLength(0);
  const [setup] = await withSystemDbAccessContext(() => db.select().from(autopaySetupAttempts)
    .where(eq(autopaySetupAttempts.id, original.setup.id)));
  expect(setup!.consentSnapshot).toEqual(original.setup.consentSnapshot);
  expect(setup!.setupIntentId).toBe(original.setup.setupIntentId);
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

async function siblingInvoice(f: Awaited<ReturnType<typeof fixture>>) {
  return withSystemDbAccessContext(async () => {
    const [invoice] = await db.insert(invoices).values({...f.invoice, id: randomUUID(), invoiceNumber: `T-${randomUUID()}`}).returning();
    const [notice] = await db.insert(billingNoticeOutbox).values({...f.notice, id: randomUUID(), invoiceId: invoice!.id, dedupeKey: randomUUID()}).returning();
    const [schedule] = await db.insert(invoiceAutopaySchedules).values({...f.schedule, id: randomUUID(), invoiceId: invoice!.id, noticeOutboxId: notice!.id}).returning();
    return {...f, invoice: invoice!, schedule: schedule!, notice: notice!};
  });
}

it('Stop preserves every terminal schedule while canceling pending and fencing in-flight invoices', async () => {
  const f = await fixture();
  provider.confirm.mockImplementationOnce(async () => {
    currentPi = {...currentPi, status: 'succeeded', amount_received: 10000}; return currentPi;
  });
  await attemptCollection(inputFor(f));
  const skipped = await siblingInvoice(f);
  await withSystemDbAccessContext(() => requestInvoiceControl(db, {invoiceId: skipped.invoice.id, kind: 'skip', actor: f.actor}));
  const history = [f, skipped];
  for (const state of ['failed', 'excluded_by_msp', 'cancelled', 'not_needed'] as const) {
    const sibling = await siblingInvoice(f);
    await withSystemDbAccessContext(() => db.update(invoiceAutopaySchedules)
      .set({state, stateReason: `historical_${state}`}).where(eq(invoiceAutopaySchedules.id, sibling.schedule.id)));
    history.push(sibling);
  }
  const before = await Promise.all(history.map(scheduleFor));
  const pending = await siblingInvoice(f), inFlight = await siblingInvoice(f);
  await attemptCollection(inputFor(inFlight));
  await withSystemDbAccessContext(() => turnOffAutopay(db, f.actor, f.org.id));
  expect(await Promise.all(history.map(scheduleFor))).toEqual(before);
  expect(await scheduleFor(pending)).toMatchObject({state: 'cancelled', stateReason: 'stop', nextAttemptAt: null});
  expect(await scheduleFor(inFlight)).toMatchObject({state: 'collecting', stateReason: 'control_pending:stop'});
  currentPi = {...currentPi, status: 'canceled'};
  await reconcilePendingControls();
  expect(await scheduleFor(inFlight)).toMatchObject({state: 'cancelled'});
  expect(await Promise.all(history.map(scheduleFor))).toEqual(before);
});

import { withClientPaymentAuthority } from './clientPaymentAuthority';
it.each(['skip', 'exclude', 'stop'] as const)('%s refuses valid bank authority that collects without the fence', async kind => {
  const f = await fixture(); const bank = await bankSetup(f, 'fenced'); serveBank([bank]);
  const input = {invoiceId: f.invoice.id, initiatedBy: 'client_on_session' as const};
  // A real setup row, captured method, invoice-bound consent and unconsumed token.
  await withSystemDbAccessContext(async () => {
    if (kind === 'stop') await turnOffAutopay(db, f.actor, f.org.id);
    else await requestInvoiceControl(db, {invoiceId: f.invoice.id, kind, actor: f.actor});
  });
  expect(await withClientPaymentAuthority(bank.authority, () => attemptCollection(input)))
    .toMatchObject({outcome: 'refused', reason: kind === 'stop' ? 'enrollment_inactive' : 'schedule_inactive'});
  expect(await attempts(f.invoice.id)).toHaveLength(0);
  expect(provider.create).not.toHaveBeenCalled(); expect(provider.confirm).not.toHaveBeenCalled();
  // Matched positive control: same setup procedure on an unfenced invoice.
  const control = await fixture(`acct_control_${randomUUID()}`);
  const valid = await bankSetup(control, 'control'); serveBank([valid]);
  expect(await collectAfterBankSetup({invoiceId: control.invoice.id, orgId: control.org.id, setupSessionId: valid.session.id!}))
    .toMatchObject({outcome: 'created'});
  expect(provider.create).toHaveBeenCalledTimes(1); expect(provider.confirm).toHaveBeenCalledTimes(1);
});

it.each(['recovery', 'outcome'] as const)('durable re-notice survives a crash after provider cancellation (%s)', async replay => {
  const f = await fixture();
  const create = provider.create.getMockImplementation()!;
  provider.create.mockImplementationOnce(async (...args) => {
    const pi = await create(...args);
    // Real setup completion replaces the rail after reservation but before confirmation.
    const replacement = await bankSetup(f, 'renotice'); serveBank([replacement]);
    return pi;
  });
  await getTestDb().execute(sql`create function task_l_cancel_crash() returns trigger language plpgsql as $$
    begin if NEW.state = 'canceled' then raise exception 'crash after provider cancellation'; end if; return NEW; end $$`);
  await getTestDb().execute(sql`create trigger task_l_cancel_crash before update on invoice_collection_attempts
    for each row execute function task_l_cancel_crash()`);
  try {
    await expect(attemptCollection(inputFor(f))).rejects.toThrow();
    expect(currentPi.status).toBe('canceled');
    expect((await attempts(f.invoice.id))[0]!.state).toBe('created');
    expect(await scheduleFor(f)).toMatchObject({state: 'collecting', stateReason: 'control_pending:renotice'});
    expect(provider.cancel).toHaveBeenCalledTimes(1);
  } finally {
    await getTestDb().execute(sql`drop trigger task_l_cancel_crash on invoice_collection_attempts`);
    await getTestDb().execute(sql`drop function task_l_cancel_crash()`);
  }
  const [attempt] = await attempts(f.invoice.id);
  if (replay === 'recovery') await resumeCollectionAttempt(attempt!.id);
  else await applyAttemptOutcome(f.partner.id, attempt!.id);
  const schedule = await scheduleFor(f);
  expect(schedule).toMatchObject({state: 'awaiting_notice', stateReason: null, noticeSentAt: null,
    termsSnapshot: expect.objectContaining({methodType: 'us_bank_account', noticeSeq: 2})});
  expect(schedule.noticeOutboxId).not.toBe(f.notice.id);
  await resumeCollectionAttempt(attempt!.id); await applyAttemptOutcome(f.partner.id, attempt!.id);
  expect(await scheduleFor(f)).toEqual(schedule);
  const notices = await withSystemDbAccessContext(() => db.select().from(billingNoticeOutbox)
    .where(eq(billingNoticeOutbox.invoiceId, f.invoice.id)));
  expect(notices.filter(n => n.kind === 'invoice_autopay' && n.seq === 2)).toHaveLength(1);
  expect(provider.confirm).not.toHaveBeenCalled(); expect(provider.cancel).toHaveBeenCalledTimes(1);
  expect(intentsByKey.size).toBe(1);
});

it.each([
  ['USD', '0.01', 1], ['USD', '100.01', 10001], ['USD', '9999999999.99', 999999999999],
  ['JPY', '1.00', 1], ['JPY', '9999999999.00', 9999999999],
] as const)('preserves %s %s through numeric(12,2), provider minor units and settlement', async (currency, amount, minor) => {
  const f = await fixture();
  await withSystemDbAccessContext(async () => {
    await db.update(invoices).set({currencyCode: currency, total: amount, balance: amount}).where(eq(invoices.id, f.invoice.id));
    await db.update(invoiceAutopaySchedules).set({termsSnapshot: {...f.schedule.termsSnapshot as object, currency, principal: amount}})
      .where(eq(invoiceAutopaySchedules.id, f.schedule.id));
    const rendered = f.notice.rendered as {frozen: object};
    await db.update(billingNoticeOutbox).set({rendered: {...rendered, frozen: {...rendered.frozen, amount}}})
      .where(eq(billingNoticeOutbox.id, f.notice.id));
  });
  provider.confirm.mockImplementationOnce(async () => {
    currentPi = {...currentPi, status: 'succeeded', amount_received: minor}; return currentPi;
  });
  expect(await attemptCollection(inputFor(f))).toMatchObject({outcome: 'created'});
  expect(provider.create).toHaveBeenCalledWith(expect.objectContaining({amount: minor, currency: currency.toLowerCase()}), expect.anything());
  expect((await attempts(f.invoice.id))[0]).toMatchObject({principalAmount: amount, currency, state: 'succeeded'});
  const [invoice] = await withSystemDbAccessContext(() => db.select().from(invoices).where(eq(invoices.id, f.invoice.id)));
  expect(invoice).toMatchObject({status: 'paid', amountPaid: amount, balance: '0.00'});
  const [payment] = await withSystemDbAccessContext(() => db.select().from(invoicePayments).where(eq(invoicePayments.invoiceId, f.invoice.id)));
  expect(payment!.amount).toBe(amount);
});

it('Postgres refuses a value above the numeric(12,2) maximum without changing the obligation', async () => {
  const f = await fixture();
  await expect(withSystemDbAccessContext(() => db.update(invoices).set({total: '10000000000.00', balance: '10000000000.00'})
    .where(eq(invoices.id, f.invoice.id)))).rejects.toThrow();
  const [invoice] = await withSystemDbAccessContext(() => db.select().from(invoices).where(eq(invoices.id, f.invoice.id)));
  expect(invoice!.balance).toBe('100.00'); expect(provider.create).not.toHaveBeenCalled();
});

import { savePartnerStripeKey } from '../partnerStripe';
import { decryptSecret } from '../secretCrypto';
it('key rotation retains original-account credentials; different-account rotation is refused with unsettled money', async () => {
  const f = await fixture(); const result = await attemptCollection(inputFor(f));
  provider.accountRetrieve.mockImplementation(async () => {
    expect(hasDbAccessContext()).toBe(false);
    return {id: 'acct_autopay_test', country: 'US', default_currency: 'usd'};
  });
  provider.probeUpdate.mockImplementation(async () => {expect(hasDbAccessContext()).toBe(false); return {};});
  provider.eventList.mockResolvedValue({has_more: false, data: []});
  const newKey = ['sk', 'test', 'rotation_fixture_only'].join('_');
  await savePartnerStripeKey({partnerId: f.partner.id, apiKey: newKey, userId: null});
  const [connection] = await withSystemDbAccessContext(() => db.select().from(stripeConnectAccounts).where(eq(stripeConnectAccounts.id, f.connection.id)));
  expect(connection!.stripeAccountId).toBe('acct_autopay_test');
  expect(decryptSecret(connection!.apiKey!)).toBe(newKey);
  const [mapping] = await withSystemDbAccessContext(() => db.select().from(invoiceStripePayments).where(eq(invoiceStripePayments.invoiceId, f.invoice.id)));
  expect(mapping!.revocationCredentialId).toBeTruthy();
  provider.accountRetrieve.mockResolvedValue({id: 'acct_rotated', country: 'US', default_currency: 'usd'});
  await expect(savePartnerStripeKey({partnerId: f.partner.id, apiKey: ['sk', 'test', 'other_account_fixture'].join('_'), userId: null}))
    .rejects.toMatchObject({code: 'STRIPE_ACCOUNT_CHANGE_BLOCKED'});
  expect((await withSystemDbAccessContext(() => db.select().from(stripeConnectAccounts).where(eq(stripeConnectAccounts.id, f.connection.id))))[0])
    .toEqual(connection);
  currentPi = {...currentPi, status: 'succeeded', amount_received: 10000};
  vi.mocked(getPartnerStripeClient).mockClear();
  await applyAttemptOutcome(f.partner.id, result.attemptId!);
  expect(vi.mocked(getPartnerStripeClient)).toHaveBeenCalledWith(f.partner.id, expect.objectContaining({
    reconciliationAccountId: 'acct_autopay_test', archivedCredentialId: mapping!.revocationCredentialId,
  }));
  expect((await attempts(f.invoice.id))[0]!.state).toBe('succeeded');
  expect(provider.create).toHaveBeenCalledTimes(1);
});

it.each(['before_confirm', 'after_confirm', 'after_settlement'] as const)(
  'reconciles real late success versus replacement %s with distinct provider debit accounting', async arrival => {
    const f = await fixture();
    const debits = new Map<string, number>();
    const intent = (id: string) => [...intentsByKey.values()].find(pi => pi.id === id)!;
    const succeed = (id: string) => {
      const pi = intent(id);
      Object.assign(pi, {status: 'succeeded', amount_received: pi.amount, last_payment_error: null});
      debits.set(id, pi.amount); return pi;
    };
    provider.retrieve.mockImplementation(async id => {expect(hasDbAccessContext()).toBe(false); return intent(id);});
    provider.cancel.mockImplementation(async id => {
      expect(hasDbAccessContext()).toBe(false);
      Object.assign(intent(id), {status: 'canceled'}); return intent(id);
    });
    provider.confirm.mockImplementationOnce(async id => {
      expect(hasDbAccessContext()).toBe(false);
      // Age only the attempt timestamp so the real day-3 retry is due; leave
      // all reservation, failure, schedule and ledger transitions to the services.
      await withSystemDbAccessContext(() => db.update(invoiceCollectionAttempts)
        .set({createdAt: new Date(Date.now() - 4 * 86400000)}).where(eq(invoiceCollectionAttempts.stripePaymentIntentId, id)));
      Object.assign(intent(id), {status: 'requires_payment_method', last_payment_error: {code: 'card_declined', decline_code: 'insufficient_funds'}});
      return intent(id);
    });
    const old = await attemptCollection(inputFor(f));
    const oldPi = currentPi.id;
    expect((await attempts(f.invoice.id))[0]).toMatchObject({state: 'failed', failureClass: 'soft'});
    expect(await scheduleFor(f)).toMatchObject({state: 'retry_scheduled'});
    expect(intent(oldPi).status).toBe('canceled'); expect(debits.size).toBe(0);
    expect((await scheduleFor(f)).nextAttemptAt!.getTime()).toBeLessThan(Date.now());
    const entered = barrier(), release = barrier();
    const retrieve = provider.retrieve.getMockImplementation()!;
    if (arrival === 'before_confirm') {
      provider.retrieve.mockImplementation(async (...args) => {
        if (args[0] !== oldPi) {entered.release(); await release.wait;}
        return retrieve(...args);
      });
    }
    provider.confirm.mockImplementation(async id => {
      expect(hasDbAccessContext()).toBe(false);
      if (arrival === 'after_settlement') return succeed(id);
      Object.assign(intent(id), {status: 'processing'}); return intent(id);
    });
    const replacementWork = attemptCollection(inputFor(f));
    if (arrival === 'before_confirm') {
      await Promise.race([entered.wait, replacementWork.then(() => {throw new Error('replacement did not reach confirmation barrier');})]);
      try {
        succeed(oldPi);
        await applyAttemptOutcome(f.partner.id, old.attemptId!);
      } finally {release.release();}
    }
    const replacement = await replacementWork;
    expect(replacement.outcome).toBe(arrival==='before_confirm'?'canceled':'created');
    const replacementAttempt = (await attempts(f.invoice.id)).find(a => a.id === replacement.attemptId)!;
    if (arrival !== 'before_confirm') {
      succeed(oldPi); await applyAttemptOutcome(f.partner.id, old.attemptId!);
      if (arrival === 'after_confirm') {
        // The replacement is still unsettled; verified provider cancellation ends it.
        intent(replacementAttempt.stripePaymentIntentId!).status = 'canceled';
        await resumeCollectionAttempt(replacement.attemptId!);
      }
    }
    await applyAttemptOutcome(f.partner.id, old.attemptId!);
    await applyAttemptOutcome(f.partner.id, replacement.attemptId!);
    expect(intentsByKey.size).toBe(2);
    expect(provider.create).toHaveBeenCalledTimes(2);
    expect(provider.confirm).toHaveBeenCalledTimes(arrival === 'before_confirm' ? 1 : 2);
    const payments = await withSystemDbAccessContext(() => db.select().from(invoicePayments).where(eq(invoicePayments.invoiceId, f.invoice.id)));
    expect(payments).toHaveLength(1); expect(payments[0]!.amount).toBe('100.00');
    const detail = await withDbAccessContext({scope: 'partner', orgId: null, accessibleOrgIds: [f.org.id], accessiblePartnerIds: [f.partner.id]},
      () => getInvoice(f.invoice.id, f.actor));
    if (arrival === 'after_settlement') {
      // An anomalous provider success for a previously verified canceled PI is real
      // extra money, not a second invoice payment; never hide it in a fake single PI.
      expect(debits.size).toBe(2);
      expect([...debits.values()].reduce((sum, amount) => sum + amount, 0)).toBe(20000);
      expect((await attempts(f.invoice.id)).find(a => a.id === old.attemptId)!.state).toBe('unapplied');
      expect(detail.unappliedCount).toBe(1);
      const [mapping] = await withSystemDbAccessContext(() => db.select().from(invoiceStripePayments)
        .where(eq(invoiceStripePayments.stripeObjectId, oldPi)));
      expect(mapping!.invoicePaymentId).toBeNull();
      // Attention survives retries and rollout disablement.
      await withSystemDbAccessContext(() => db.update(partners).set({autopayEnabled: false}).where(eq(partners.id, f.partner.id)));
      await resumeCollectionAttempt(old.attemptId!);
      expect((await attempts(f.invoice.id)).find(a => a.id === old.attemptId)!.state).toBe('unapplied');
    } else {
      expect(debits.size).toBe(1); expect([...debits.values()]).toEqual([10000]);
      expect(detail.unappliedCount).toBe(0);
      expect((await attempts(f.invoice.id)).find(a => a.id === replacement.attemptId)!.state).toBe('canceled');
    }
  });

it.each(['failed', 'skipped_by_client', 'excluded_by_msp', 'cancelled', 'not_needed'] as const)(
  'exclusion preserves terminal %s schedule history', async state => {
    const f = await fixture();
    await withSystemDbAccessContext(() => db.update(invoiceAutopaySchedules).set({state, stateReason: 'historical'})
      .where(eq(invoiceAutopaySchedules.id, f.schedule.id)));
    const before = await scheduleFor(f);
    expect(await withSystemDbAccessContext(() => requestInvoiceControl(db, {invoiceId: f.invoice.id, kind: 'exclude', actor: f.actor})))
      .toMatchObject({status: 'excluded'});
    expect(await scheduleFor(f)).toEqual(before);
  });

it.each(['exclude', 'stop'] as const)('%s preserves terminal schedule history even with a live bank reservation', async kind => {
  const f = await fixture(); const bank = await bankSetup(f, 'terminal_control'); serveBank([bank]);
  await withSystemDbAccessContext(() => db.update(invoiceAutopaySchedules).set({state: 'not_needed', stateReason: 'historical'})
    .where(eq(invoiceAutopaySchedules.id, f.schedule.id)));
  await collectAfterBankSetup({invoiceId: f.invoice.id, orgId: f.org.id, setupSessionId: bank.session.id!});
  const before = await scheduleFor(f);
  expect(before.state).toBe('not_needed');
  await withSystemDbAccessContext(async () => {
    if (kind === 'stop') await turnOffAutopay(db, f.actor, f.org.id);
    else expect(await requestInvoiceControl(db, {invoiceId: f.invoice.id, kind, actor: f.actor})).toMatchObject({status: 'pending'});
  });
  expect(await scheduleFor(f)).toEqual(before);
  expect((await attempts(f.invoice.id))[0]!.state).toBe('processing');
  currentPi = {...currentPi, status: 'canceled'};
  await reconcilePendingControls();
  expect((await attempts(f.invoice.id))[0]!.state).toBe('canceled');
  expect(await scheduleFor(f)).toEqual(before);
});

it.each(['empty', 'canceled', 'succeeded', 'changed_account', 'missing'] as const)(
  'quarantine recovery uses immutable setup provenance: %s', async mode => {
    const f = await fixture();
    if(mode==='missing')await withSystemDbAccessContext(()=>createUser({partnerId:f.partner.id,withMembership:true}));
    if (mode !== 'missing') await withSystemDbAccessContext(async () => {
      await db.update(orgPaymentMethods).set({ stripeSetupIntentId: 'seti_original' }).where(eq(orgPaymentMethods.id, f.method.id));
      await db.insert(autopaySetupAttempts).values({ orgId: f.org.id, partnerId: f.partner.id,
        enrollmentId: f.enrollment.id, generation: 1, source: 'setup_page', methodType: 'card',
        stripeConnectionId: f.connection.id, stripeAccountId: f.connection.stripeAccountId,
        stripeCustomerId: 'cus_autopay_test', setupIntentId: 'seti_original', consentSnapshot: {}, outcome: 'activated' });
    });
    const normal = provider.create.getMockImplementation()!;
    provider.create.mockImplementationOnce(async (...args) => { await normal(...args); throw new Error('lost'); });
    await expect(attemptCollection({ invoiceId: f.invoice.id, scheduleId: f.schedule.id, initiatedBy: 'scheduler' })).rejects.toThrow('lost');
    const [attempt] = await attempts(f.invoice.id);
    await withSystemDbAccessContext(async () => {
      await db.update(invoiceCollectionAttempts).set({ createdAt: new Date(Date.now() - 25 * 3600000) }).where(eq(invoiceCollectionAttempts.id, attempt!.id));
      if (mode === 'missing') await db.update(orgPaymentMethods).set({stripeSetupIntentId:null}).where(eq(orgPaymentMethods.id,f.method.id));
      if (mode === 'changed_account') await db.update(orgAutopayEnrollments).set({ stripeAccountId: 'acct_replacement' }).where(eq(orgAutopayEnrollments.id, f.enrollment.id));
    });
    currentPi = { ...currentPi, status: mode === 'succeeded' ? 'succeeded' : 'canceled', amount_received: mode === 'succeeded' ? 10000 : 0 };
    provider.search.mockImplementation(async params => {
      expect(hasDbAccessContext()).toBe(false);
      expect(params.query).toBe(`metadata['attempt_id']:'${attempt!.id}'`);
      return { data: ['canceled', 'succeeded'].includes(mode) ? [currentPi] : [], has_more: false };
    });
    vi.mocked(getPartnerStripeClient).mockClear();
    await resumeCollectionAttempt(attempt!.id);
    const [saved] = await attempts(f.invoice.id);
    expect(saved!.state).toBe(mode === 'missing' ? 'reserved' : mode === 'succeeded' ? 'succeeded' : 'canceled');
    expect(provider.create).toHaveBeenCalledTimes(1);
    if (mode === 'missing') {
      expect(provider.search).not.toHaveBeenCalled();
      await resumeCollectionAttempt(attempt!.id);
      const notices=await withSystemDbAccessContext(()=>db.select().from(userNotifications).where(eq(userNotifications.orgId,f.org.id)));
      expect(notices).toHaveLength(1);expect(notices[0]!.message).toContain(attempt!.id);expect(notices[0]!.message).toContain('Reservation retained');
    }
    else {
      expect(provider.search).toHaveBeenCalledOnce();
      expect(getPartnerStripeClient).toHaveBeenCalledWith(f.partner.id, expect.objectContaining({ reconciliationAccountId: f.connection.stripeAccountId }));
    }
  });

it('re-notices with the current saved method, not the issued method snapshot', async () => {
  const f = await fixture();
  await withSystemDbAccessContext(async () => {
    await db.update(orgPaymentMethods).set({cardLast4:'9999'}).where(eq(orgPaymentMethods.id,f.method.id));
    const {renoticeSchedule}=await import('./invoiceControls');
    await renoticeSchedule(db,f.invoice.id);
  });
  expect((await scheduleFor(f)).termsSnapshot).toMatchObject({last4:'9999',noticeSeq:2});
});
it('orphan notice sweep retries missing contacts and canceled notices', async () => {
  const f=await fixture();
  await withSystemDbAccessContext(async()=>{
    await db.update(invoiceAutopaySchedules).set({state:'awaiting_notice',noticeSentAt:null}).where(eq(invoiceAutopaySchedules.id,f.schedule.id));
    await db.update(billingNoticeOutbox).set({status:'cancelled'}).where(eq(billingNoticeOutbox.id,f.notice.id));
    await db.update(organizations).set({billingContact:null}).where(eq(organizations.id,f.org.id));
  });
  const {sweepOrphanAutopayNotices}=await import('./scheduler');
  await sweepOrphanAutopayNotices();
  expect(await scheduleFor(f)).toMatchObject({state:'awaiting_notice',stateReason:'no_billing_contact'});
  await withSystemDbAccessContext(()=>db.update(organizations).set({billingContact:{email:'billing@example.test'}}).where(eq(organizations.id,f.org.id)));
  await sweepOrphanAutopayNotices();
  const saved=await scheduleFor(f);
  expect(saved.state).toBe('awaiting_notice');expect(saved.noticeOutboxId).not.toBe(f.notice.id);
  const [notice]=await withSystemDbAccessContext(()=>db.select().from(billingNoticeOutbox).where(eq(billingNoticeOutbox.id,saved.noticeOutboxId!)));
  expect(notice?.status).toBe('pending');
});
it.each(['paid','void'] as const)('closes a live schedule for an externally %s invoice', async status=>{
  const f=await fixture();
  await withSystemDbAccessContext(()=>db.update(invoices).set({status}).where(eq(invoices.id,f.invoice.id)));
  await runAutopayCollection();
  expect(await scheduleFor(f)).toMatchObject({state:'not_needed',stateReason:status==='paid'?'invoice_settled':'invoice_voided'});
});

it.each(['expired','revoked','consumed','valid'] as const)('bank reservation token consume predicate: %s',async mode=>{
 const f=await fixture(), bank=await bankSetup(f,mode);serveBank([bank]);
 if(mode!=='valid')await withSystemDbAccessContext(()=>db.update(billingLinkTokens).set(mode==='expired'?{expiresAt:new Date(0)}:mode==='revoked'?{revokedAt:new Date()}:{consumedAt:new Date()}).where(eq(billingLinkTokens.id,bank.token.id)));
 const result=await withClientPaymentAuthority(bank.authority,()=>attemptCollection({invoiceId:f.invoice.id,initiatedBy:'client_on_session'}));
 if(mode==='valid'){expect(result.outcome).toBe('created');expect(provider.create).toHaveBeenCalledOnce();}
 else {expect(result).toMatchObject({outcome:'refused',reason:'client_authorization_used'});expect(await attempts(f.invoice.id)).toEqual([]);expect(provider.create).not.toHaveBeenCalled();}
});
it('bank consent amounts are immutable in the database (23514)',async()=>{
 const f=await fixture(), bank=await bankSetup(f,'immutable');
 const consent=bank.setup.consentSnapshot as Record<string,unknown>;
 try {
   await withSystemDbAccessContext(()=>db.update(autopaySetupAttempts).set({consentSnapshot:{...consent,bankPayment:{...consent.bankPayment as object,principal:'999.00'}}}).where(eq(autopaySetupAttempts.id,bank.setup.id)));
   throw new Error('Consent mutation unexpectedly succeeded');
 }catch(error){expect((error as {cause?:{code?:string};code?:string}).cause?.code ?? (error as {code?:string}).code).toBe('23514');}
});

import * as linkTokensModule from './linkTokens';
import { getConfirmPaymentView, confirmInvoicePayment } from './confirmPayment';
it.each(['newer','attemptCount','generation','expired','revoked','consumed','valid'] as const)(
 'real confirm-token binding and consume race: %s',async mode=>{
 const f=await fixture();
 provider.confirm.mockImplementationOnce(async()=>{currentPi={...currentPi,status:'requires_action',last_payment_error:{code:'authentication_required'}};return currentPi;});
 const result=await attemptCollection(inputFor(f));
 const [attempt]=await attempts(f.invoice.id);
 const token=await withSystemDbAccessContext(async()=>{
   const token=await mintBillingLinkToken(db,{orgId:f.org.id,invoiceId:f.invoice.id,enrollmentId:f.enrollment.id,generation:1,purpose:'confirm_payment',ttlDays:14});
   await db.insert(billingNoticeOutbox).values({orgId:f.org.id,invoiceId:f.invoice.id,kind:'payment_failed',seq:2,dedupeKey:`confirm-test:${token.id}`,toEmail:'billing@example.test',rendered:{subject:'Confirm',html:'Confirm',text:'Confirm',frozen:{attemptId:attempt!.id,tokenId:token.id,variant:'confirm'}}});
   if(mode==='newer')await db.insert(invoiceCollectionAttempts).values({orgId:f.org.id,invoiceId:f.invoice.id,scheduleId:f.schedule.id,paymentMethodId:f.method.id,attemptNo:2,principalAmount:'100.00',feeAmount:'0.00',currency:'USD',idempotencyKey:`newer:${token.id}`,state:'failed',initiatedBy:'scheduler'});
   if(mode==='attemptCount'||mode==='generation')await db.update(invoiceAutopaySchedules).set(mode==='attemptCount'?{attemptCount:2}:{enrollmentGeneration:2}).where(eq(invoiceAutopaySchedules.id,f.schedule.id));
   return token;
 });
 if(['newer','attemptCount','generation'].includes(mode)){
  await expect(getConfirmPaymentView(token.token)).rejects.toMatchObject({status:404});expect(provider.cancel).not.toHaveBeenCalled();return;
 }
 expect(await getConfirmPaymentView(token.token)).toMatchObject({state:'requires_action'});
 const original=linkTokensModule.resolveBillingLinkToken;let calls=0;
 const spy=vi.spyOn(linkTokensModule,'resolveBillingLinkToken').mockImplementation(async(...args)=>{
   const link=await original(...args);calls++;
   // Race after the locked resolution but before consume: the real UPDATE must reject.
   if(calls===2&&mode!=='valid')await db.update(billingLinkTokens).set(mode==='expired'?{expiresAt:new Date(0)}:mode==='revoked'?{revokedAt:new Date()}:{consumedAt:new Date()}).where(eq(billingLinkTokens.id,token.id));
   return link;
 });
 try{
   if(mode==='valid')expect(await confirmInvoicePayment(token.token)).toMatchObject({url:expect.any(String)});
   else await expect(confirmInvoicePayment(token.token)).rejects.toMatchObject({status:404});
 }finally{spy.mockRestore();}
 expect(result.attemptId).toBe(attempt!.id);expect(provider.cancel).toHaveBeenCalledOnce();
});

it.each(['bank','pay_and_save','ambiguous','credential_missing'] as const)(
  'recovers only proven account provenance: %s',async mode=>{
  const f=await fixture();
  const bank=mode==='bank'?await bankSetup(f,'quarantine'):null;
  if(bank)serveBank([bank]);
  if(mode==='pay_and_save') {
    const setup=await withSystemDbAccessContext(async()=>{
      await db.update(orgPaymentMethods).set({stripeSetupIntentId:null}).where(eq(orgPaymentMethods.id,f.method.id));
      const [setup]=await db.insert(autopaySetupAttempts).values({orgId:f.org.id,partnerId:f.partner.id,enrollmentId:f.enrollment.id,
        generation:1,source:'pay_and_save',methodType:'card',stripeConnectionId:f.connection.id,stripeAccountId:f.connection.stripeAccountId,
        stripeCustomerId:'cus_autopay_test',paymentIntentId:'pi_saved_card',checkoutSessionId:'cs_saved_card',consentSnapshot:{},outcome:'activated'}).returning();
      return setup!;
    });
    provider.retrieve.mockImplementation(async id=>{
      expect(hasDbAccessContext()).toBe(false);
      return id==='pi_saved_card'?{id,status:'succeeded',payment_method:f.method.stripePaymentMethodId,
        customer:'cus_autopay_test',metadata:{autopay_setup_attempt_id:setup.id}}:currentPi;
    });
  }
  const normal=provider.create.getMockImplementation()!;
  provider.create.mockImplementationOnce(async(...args)=>{await normal(...args);throw new Error('lost');});
  const start=()=>bank?withClientPaymentAuthority(bank.authority,()=>attemptCollection({invoiceId:f.invoice.id,initiatedBy:'client_on_session'})):attemptCollection(inputFor(f));
  await expect(start()).rejects.toThrow('lost');
  const [attempt]=await attempts(f.invoice.id);
  await withSystemDbAccessContext(async()=>{
    await db.update(invoiceCollectionAttempts).set({createdAt:new Date(Date.now()-25*3600000)}).where(eq(invoiceCollectionAttempts.id,attempt!.id));
    await db.update(orgAutopayEnrollments).set({stripeAccountId:'acct_new'}).where(eq(orgAutopayEnrollments.id,f.enrollment.id));
    if(mode==='ambiguous')await db.insert(autopaySetupAttempts).values({orgId:f.org.id,partnerId:f.partner.id,enrollmentId:f.enrollment.id,
      generation:1,source:'setup_page',methodType:'card',stripeConnectionId:f.connection.id,stripeAccountId:'acct_ambiguous',
      stripeCustomerId:'cus_other',setupIntentId:'seti_fixture',consentSnapshot:{},outcome:'activated'});
  });
  if(mode==='credential_missing')vi.mocked(getPartnerStripeClient).mockRejectedValueOnce(new Error('Original credential unavailable'));
  provider.search.mockImplementation(async()=>{expect(hasDbAccessContext()).toBe(false);return {data:[],has_more:false};});
  await resumeCollectionAttempt(attempt!.id);
  const [saved]=await attempts(f.invoice.id);
  expect(saved!.state).toBe(mode==='ambiguous'||mode==='credential_missing'?'reserved':'canceled');
  if(mode==='ambiguous'||mode==='credential_missing')expect(provider.search).not.toHaveBeenCalled();
  else expect(provider.search).toHaveBeenCalledOnce();
  expect(provider.create).toHaveBeenCalledOnce();
});

it.each(['cancelled','missing'] as const)('Send does not claim a %s notice was queued',async mode=>{
 const f=await fixture();
 await withSystemDbAccessContext(async()=>{
   await db.update(invoiceAutopaySchedules).set({state:'awaiting_notice',noticeOutboxId:mode==='missing'?null:f.notice.id}).where(eq(invoiceAutopaySchedules.id,f.schedule.id));
   await db.update(billingNoticeOutbox).set({status:'cancelled'}).where(eq(billingNoticeOutbox.id,f.notice.id));
 });
 const {sendInvoiceEmail}=await import('../invoicePdf');
 expect(await withSystemDbAccessContext(()=>sendInvoiceEmail(f.invoice.id,f.actor))).toMatchObject({emailed:false,reason:'send_failed'});
});
