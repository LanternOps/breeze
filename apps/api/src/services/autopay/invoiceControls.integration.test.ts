import '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { partners, organizations, invoices, stripeConnectAccounts, orgAutopayEnrollments,
  orgPaymentMethods, invoiceAutopaySchedules, invoiceCollectionAttempts, billingNoticeOutbox } from '../../db/schema';
import { mintBillingLinkToken } from './linkTokens';
import { skipInvoice, setInvoiceAutopayExcluded } from './invoiceControls';
import { requestInvoiceControl } from './collectionControl';

async function fixture() {
  return withSystemDbAccessContext(async () => {
    const suffix = randomUUID();
    const [partner] = await db.insert(partners).values({ name: 'Control fixture', slug: `control-${suffix}`, type: 'msp', plan: 'pro', status: 'active' }).returning();
    const [org] = await db.insert(organizations).values({ partnerId: partner!.id, name: 'Control customer', slug: `control-${suffix}`, currencyCode: 'USD', billingContact: {email:'billing@example.test'} }).returning();
    const [connection] = await db.insert(stripeConnectAccounts).values({ partnerId: partner!.id, stripeAccountId: `acct_${suffix}`, apiKey: 'enc:synthetic', keyLast4: 'test', status: 'connected', livemode: false }).returning();
    const [enrollment] = await db.insert(orgAutopayEnrollments).values({ orgId: org!.id, partnerId: partner!.id, status: 'active', effectiveFrom: new Date('2026-09-01'), generation: 1, stripeConnectionId: connection!.id, stripeAccountId: connection!.stripeAccountId }).returning();
    const [method] = await db.insert(orgPaymentMethods).values({ orgId: org!.id, enrollmentId: enrollment!.id, stripePaymentMethodId: `pm_${suffix}`, type: 'card', status: 'active' }).returning();
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
