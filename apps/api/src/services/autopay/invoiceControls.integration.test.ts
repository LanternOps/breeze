import '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, invoices, stripeConnectAccounts, orgAutopayEnrollments,
  orgPaymentMethods, invoiceAutopaySchedules, invoiceCollectionAttempts, billingNoticeOutbox, orgAutopayConsents } from '../../db/schema';
import { mintBillingLinkToken } from './linkTokens';
import { skipInvoice, setInvoiceAutopayExcluded } from './invoiceControls';
import { RESERVING_COLLECTION_ATTEMPT_STATES } from '@breeze/shared';
import { requestInvoiceControl, finalizeInvoiceControl } from './collectionControl';

async function fixture() {
  return withSystemDbAccessContext(async () => {
    const suffix = randomUUID();
    const [partner] = await db.insert(partners).values({ autopayEnabled:true,name: 'Control fixture', slug: `control-${suffix}`, type: 'msp', plan: 'pro', status: 'active' }).returning();
    const [org] = await db.insert(organizations).values({ partnerId: partner!.id, name: 'Control customer', slug: `control-${suffix}`, currencyCode: 'USD', billingContact: {email:'billing@example.test'} }).returning();
    const [connection] = await db.insert(stripeConnectAccounts).values({ partnerId: partner!.id, stripeAccountId: `acct_${suffix}`, apiKey: 'enc:synthetic', keyLast4: 'test', status: 'connected', livemode: false,accountCountry:'US',autopayCapabilitiesCheckedAt:new Date(),autopayMissingPermissions:[] }).returning();
    const [enrollment] = await db.insert(orgAutopayEnrollments).values({ orgId: org!.id, partnerId: partner!.id, status: 'active', effectiveFrom: new Date('2026-09-01'), generation: 1, stripeConnectionId: connection!.id, stripeAccountId: connection!.stripeAccountId }).returning();
    const [method] = await db.insert(orgPaymentMethods).values({ orgId: org!.id, enrollmentId: enrollment!.id, stripePaymentMethodId: `pm_${suffix}`, type: 'card', status: 'active',isAutopayMethod:true }).returning();
    await db.insert(orgAutopayConsents).values({orgId:org!.id,enrollmentId:enrollment!.id,generation:1,paymentMethodId:method!.id,consentTextVersion:'2026-10-01.v1',consentTextHash:'a'.repeat(64),source:'setup_page',contactEmail:'billing@example.test',scheduleTerms:{offsetDays:0,rule:'later',cap:{enabled:false}},feeTerms:{methodType:'card',cardFeeBps:0,achFeeAmount:'0.00',feeAttested:false,currency:'USD'}});
    const [invoice] = await db.insert(invoices).values({ orgId: org!.id, partnerId: partner!.id, currencyCode: 'USD', status: 'sent', invoiceNumber: `INV-${suffix}`, issueDate: '2026-10-01', dueDate: '2026-10-31', total: '100.00', subtotal: '100.00', balance: '100.00' }).returning();
    const [schedule] = await db.insert(invoiceAutopaySchedules).values({ orgId: org!.id, invoiceId: invoice!.id, enrollmentId: enrollment!.id, enrollmentGeneration: 1, eligible: true, state: 'scheduled', collectOn: '2026-10-31', termsSnapshot: {} }).returning();
    const token = await mintBillingLinkToken(db, { orgId: org!.id, invoiceId: invoice!.id, enrollmentId: enrollment!.id, generation:1, purpose:'skip_invoice',ttlDays:1 });
    const actor = { userId: null, partnerId: partner!.id, accessibleOrgIds: [org!.id] };
    const attempt = { orgId: org!.id, invoiceId: invoice!.id, scheduleId: schedule!.id, paymentMethodId: method!.id, attemptNo:1, idempotencyKey:`control-${suffix}`, principalAmount:'100.00',currency:'USD',initiatedBy:'scheduler' as const,state:'requires_action' as const };
    return {invoice:invoice!,schedule:schedule!,actor,attempt,token:token.token};
  });
}
it('commits a durable pending fence without releasing action-required funds; replay preserves it',async()=>{
  const f=await fixture();
  await withSystemDbAccessContext(()=>db.insert(invoiceCollectionAttempts).values(f.attempt));
  const result=await withSystemDbAccessContext(()=>db.transaction(tx=>skipInvoice(tx,f.token)));
  expect(result).toEqual({status:'pending',control:'skip'});
  expect(await withSystemDbAccessContext(()=>db.transaction(tx=>skipInvoice(tx,f.token)))).toEqual(result);
  await withSystemDbAccessContext(async()=>{
    const [schedule]=await db.select().from(invoiceAutopaySchedules).where(eq(invoiceAutopaySchedules.id,f.schedule.id));
    expect(schedule).toMatchObject({state:'scheduled',stateReason:'control_pending:skip'});expect(schedule!.clientSkippedAt).toBeInstanceOf(Date);
    const [attempt]=await db.select().from(invoiceCollectionAttempts).where(eq(invoiceCollectionAttempts.invoiceId,f.invoice.id));expect(attempt!.state).toBe('requires_action');
    expect(await db.select().from(billingNoticeOutbox).where(eq(billingNoticeOutbox.invoiceId,f.invoice.id))).toHaveLength(0);
  });
});
it('serializes simultaneous skips and queues a single final confirmation',async()=>{
  const f=await fixture();
  const results=await Promise.all([1,2].map(()=>withSystemDbAccessContext(()=>db.transaction(tx=>skipInvoice(tx,f.token)))));
  expect(results.map(r=>r.status)).toEqual(['skipped','skipped']);
  expect(results.filter(r=>'staffNotice' in r)).toHaveLength(1);
  const notices=await withSystemDbAccessContext(()=>db.select().from(billingNoticeOutbox).where(eq(billingNoticeOutbox.invoiceId,f.invoice.id)));
  expect(notices).toHaveLength(1);expect(notices[0]).toMatchObject({kind:'payment_reminder',seq:0,dedupeKey:`invoice:${f.invoice.id}:skip:1`});
});
it('rolls the fence back with a failed transaction',async()=>{
  const f=await fixture();
  await expect(withSystemDbAccessContext(()=>db.transaction(async tx=>{await requestInvoiceControl(tx,{invoiceId:f.invoice.id,kind:'exclude',actor:f.actor});throw new Error('rollback fixture');}))).rejects.toThrow('rollback fixture');
  await withSystemDbAccessContext(async()=>{
    const [invoice]=await db.select().from(invoices).where(eq(invoices.id,f.invoice.id));expect(invoice!.autopayExcluded).toBe(false);
    const [schedule]=await db.select().from(invoiceAutopaySchedules).where(eq(invoiceAutopaySchedules.id,f.schedule.id));expect(schedule).toMatchObject({state:'scheduled',mspExcludedAt:null});
  });
});
it('denies foreign org before touching the invoice or schedule',async()=>{
  const f=await fixture();
  await expect(withSystemDbAccessContext(()=>db.transaction(tx=>setInvoiceAutopayExcluded(tx,f.invoice.id,true,{...f.actor,accessibleOrgIds:[randomUUID()]})))).rejects.toMatchObject({status:403});
  const [invoice]=await withSystemDbAccessContext(()=>db.select().from(invoices).where(eq(invoices.id,f.invoice.id)));expect(invoice!.autopayExcluded).toBe(false);
});


it.each(['confirming', 'processing'] as const)('refuses an exclusion for a schedule-less %s attempt and writes no fence', async state => {
  const f = await fixture();
  await withSystemDbAccessContext(async () => {
    await db.delete(invoiceAutopaySchedules).where(eq(invoiceAutopaySchedules.id, f.schedule.id));
    await db.insert(invoiceCollectionAttempts).values({ ...f.attempt, scheduleId: null, initiatedBy: 'client_on_session', state });
  });
  await expect(withSystemDbAccessContext(() => db.transaction(tx => setInvoiceAutopayExcluded(tx, f.invoice.id, true, f.actor))))
    .rejects.toMatchObject({ status: 409, code: 'COLLECTION_IN_PROGRESS', details: { reason: 'payment_processing' } });
  const [invoice] = await withSystemDbAccessContext(() => db.select().from(invoices).where(eq(invoices.id, f.invoice.id)));
  expect(invoice!.autopayExcluded).toBe(false);
});

it.each(['reserved', 'created', 'requires_action'] as const)(
  'persists a discoverable invoice fence for a schedule-less %s attempt',
  async state => {
    const f = await fixture();
    const [originalAttempt] = await withSystemDbAccessContext(async () => {
      await db.delete(invoiceAutopaySchedules).where(eq(invoiceAutopaySchedules.id, f.schedule.id));
      return db.insert(invoiceCollectionAttempts).values({
        ...f.attempt, scheduleId: null, initiatedBy: 'client_on_session', state,
      }).returning();
    });

    const result = await withSystemDbAccessContext(() => db.transaction(tx =>
      setInvoiceAutopayExcluded(tx, f.invoice.id, true, f.actor)));

    expect(result).toEqual({ status: 'pending', control: 'exclude' });
    expect(await withSystemDbAccessContext(() => db.transaction(tx =>
      setInvoiceAutopayExcluded(tx, f.invoice.id, true, f.actor)))).toEqual(result);
    await withSystemDbAccessContext(async () => {
      // The reconciler can discover this control through invoice_id without a schedule.
      const pending = await db.select({ attempt: invoiceCollectionAttempts, invoice: invoices })
        .from(invoiceCollectionAttempts)
        .innerJoin(invoices, eq(invoices.id, invoiceCollectionAttempts.invoiceId))
        .where(and(eq(invoices.id, f.invoice.id), eq(invoices.autopayExcluded, true),
          inArray(invoiceCollectionAttempts.state, [...RESERVING_COLLECTION_ATTEMPT_STATES])));
      expect(pending).toHaveLength(1);
      expect(pending[0]!.attempt).toEqual(originalAttempt);
      expect(await db.select().from(invoiceAutopaySchedules)
        .where(eq(invoiceAutopaySchedules.invoiceId, f.invoice.id))).toEqual([]);
      expect(await db.select().from(billingNoticeOutbox)
        .where(eq(billingNoticeOutbox.invoiceId, f.invoice.id))).toEqual([]);
    });
    await expect(withSystemDbAccessContext(() => db.transaction(tx =>
      setInvoiceAutopayExcluded(tx, f.invoice.id, false, f.actor))))
      .rejects.toMatchObject({ status: 409, code: 'COLLECTION_IN_PROGRESS' });
  },
);


it('clears an already-excluded pending control after verified cancellation and allows reinclusion', async () => {
  const f = await fixture();
  await withSystemDbAccessContext(async () => {
    await db.update(invoices).set({ autopayExcluded: true }).where(eq(invoices.id, f.invoice.id));
    await db.update(invoiceAutopaySchedules).set({
      state: 'scheduled', stateReason: null, mspExcludedAt: new Date(),
      termsSnapshot: { issuedAt: '2026-10-01T00:00:00Z', offsetDays: 0, rule: 'later',
        cap: { enabled: false }, methodType: 'card', methodId: f.attempt.paymentMethodId,
        last4: '4242', methodLabel: 'Card ending in 4242', accountHolderType: null,
        noticeLeadDays: 1, principal: '100.00', currency: 'USD', feeAmount: '0.00',
        feeKind: 'none', cardFeeBps: 0, achFeeAmount: '0.00', chargeDate: '2026-10-31', noticeSeq: 1 },
    }).where(eq(invoiceAutopaySchedules.id, f.schedule.id));
    await db.insert(invoiceCollectionAttempts).values(f.attempt);
  });

  const exclude = () => withSystemDbAccessContext(() => db.transaction(tx =>
    setInvoiceAutopayExcluded(tx, f.invoice.id, true, f.actor)));
  expect(await exclude()).toEqual({ status: 'pending', control: 'exclude' });
  expect(await exclude()).toEqual({ status: 'pending', control: 'exclude' });

  await withSystemDbAccessContext(() => db.transaction(async tx => {
    const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, f.invoice.id)).for('update');
    const [schedule] = await tx.select().from(invoiceAutopaySchedules)
      .where(eq(invoiceAutopaySchedules.id, f.schedule.id)).for('update');
    expect(schedule).toMatchObject({ state: 'scheduled', stateReason: 'control_pending:exclude' });
    const [attempt] = await tx.select().from(invoiceCollectionAttempts)
      .where(eq(invoiceCollectionAttempts.invoiceId, f.invoice.id));
    expect(attempt!.state).toBe('requires_action');
    // Simulate the reconciler's verified provider cancellation; D never calls Stripe.
    await tx.update(invoiceCollectionAttempts).set({ state: 'canceled' })
      .where(eq(invoiceCollectionAttempts.id, attempt!.id));
    expect(await finalizeInvoiceControl(tx, invoice!, schedule!, 'exclude')).toEqual({ status: 'excluded' });
    const [finalized] = await tx.select().from(invoiceAutopaySchedules)
      .where(eq(invoiceAutopaySchedules.id, f.schedule.id));
    expect(finalized).toMatchObject({ state: 'excluded_by_msp', stateReason: 'exclude', nextAttemptAt: null });
    expect(await finalizeInvoiceControl(tx, invoice!, finalized!, 'exclude')).toEqual({ status: 'excluded' });
  }));

  expect(await exclude()).toEqual({ status: 'excluded' });
  expect(await withSystemDbAccessContext(() => db.transaction(tx =>
    setInvoiceAutopayExcluded(tx, f.invoice.id, false, f.actor)))).toEqual({ status: 'included' });
  await withSystemDbAccessContext(async () => {
    const [invoice] = await db.select().from(invoices).where(eq(invoices.id, f.invoice.id));
    expect(invoice!.autopayExcluded).toBe(false);
    const [schedule] = await db.select().from(invoiceAutopaySchedules)
      .where(eq(invoiceAutopaySchedules.id, f.schedule.id));
    expect(schedule).toMatchObject({ state: 'awaiting_notice', stateReason: null, mspExcludedAt: null,
      noticeSentAt: null, termsSnapshot: { noticeSeq: 2 } });
    const notices = await db.select().from(billingNoticeOutbox).where(eq(billingNoticeOutbox.invoiceId, f.invoice.id));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: 'invoice_autopay', seq: 2 });
  });
});

import { getSkipInvoiceView } from './invoiceControls';
it.each([['processing',true],['confirming',true],['created',false]] as const)('skip against a real %s attempt: refused=%s',async(state,refused)=>{
  const f=await fixture();
  await withSystemDbAccessContext(async()=>{
    await db.update(invoiceAutopaySchedules).set({state:'collecting',attemptCount:1}).where(eq(invoiceAutopaySchedules.id,f.schedule.id));
    await db.insert(invoiceCollectionAttempts).values({...f.attempt,state});
  });
  expect(await withSystemDbAccessContext(()=>getSkipInvoiceView(db,f.token))).toMatchObject({state:'collecting',processing:refused});
  const skip=withSystemDbAccessContext(()=>db.transaction(tx=>skipInvoice(tx,f.token)));
  if(refused)await expect(skip).rejects.toMatchObject({status:409,code:'COLLECTION_IN_PROGRESS'});
  else expect(await skip).toEqual({status:'pending',control:'skip'});
  const [schedule]=await withSystemDbAccessContext(()=>db.select().from(invoiceAutopaySchedules).where(eq(invoiceAutopaySchedules.id,f.schedule.id)));
  if(refused)expect(schedule).toMatchObject({state:'collecting',stateReason:null,clientSkippedAt:null});
  else expect(schedule).toMatchObject({state:'collecting',stateReason:'control_pending:skip'});
});
