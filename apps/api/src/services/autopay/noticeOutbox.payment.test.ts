import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ row: {} as any, ackFailures: 0, invoiceEligible: true, rows: new Map<unknown,any[]>(), send: vi.fn(), capture: vi.fn() }));
vi.mock('../email', () => ({ getEmailService: () => ({ sendEmail: h.send }) }));
vi.mock('../sentry', () => ({ captureException: h.capture }));
vi.mock('../../db', async () => {
  const { billingNoticeOutbox, invoices } = await import('../../db/schema');
  const db: any = {
    transaction: (fn: any) => fn(db),
    select: () => {
      let table: any;
      const chain: any = {};
      for (const key of ['where', 'orderBy', 'limit', 'for', 'innerJoin']) chain[key] = () => chain;
      chain.from = (t: any) => { table = t; return chain; };
      chain.then = (resolve: any, reject: any) => Promise.resolve(table === billingNoticeOutbox ? [structuredClone(h.row)] : table === invoices ? (h.invoiceEligible ? h.rows.get(table) ?? [] : []) : h.rows.get(table) ?? [{ id: 'partner', name: 'Partner' }]).then(resolve, reject);
      return chain;
    },
    update: () => ({ set: (values: any) => {
      const chain: any = { where: () => chain, returning: () => chain };
      chain.then = (resolve: any, reject: any) => Promise.resolve().then(() => {
        if (values.sentAt && h.ackFailures-- > 0) throw new Error('ack failed');
        Object.assign(h.row, values); return [structuredClone(h.row)];
      }).then(resolve, reject);
      return chain;
    } }),
  };
  return { db, assertOutsideHeldDbContext: () => {}, runOutsideDbContext: (fn: any) => fn(), withSystemDbAccessContext: (fn: any) => fn() };
});
import { dispatchPendingBillingNotices, registerNoticeSentHandler } from './noticeOutbox';
beforeEach(() => {
  vi.clearAllMocks(); h.ackFailures = 0; h.invoiceEligible = true; h.rows.clear();
  h.send.mockReset().mockResolvedValue(undefined);
  h.row = { id: 'outbox', orgId: 'org', kind: 'autopay_request', status: 'pending', attempts: 0, sentAt: null,
    rendered: { subject: 'Notice', html: '<p>Notice</p>', text: 'Notice' }, toEmail: 'client@example.test' };
});

import { invoices, invoiceCollectionAttempts, invoiceAutopaySchedules, invoiceStripePayments, orgAutopayEnrollments, orgPaymentMethods } from '../../db/schema';
const attemptState=(variant:string)=>variant==='confirm'?'requires_action':variant==='returned'?'succeeded':variant==='expired'?'canceled':'failed';
function payment(variant:string) {
 h.row.kind='payment_failed';h.row.invoiceId='invoice';
 h.row.rendered.frozen={attemptId:'attempt',variant,...(variant==='returned'?{returnIdentity:'mapping:dp_1'}:{})};
 h.rows.set(invoices,[{id:'invoice',orgId:'org',partnerId:'partner',status:'sent',balance:'100.00',currencyCode:'USD',autopayExcluded:false}]);
 h.rows.set(invoiceCollectionAttempts,[{id:'attempt',invoiceId:'invoice',orgId:'org',scheduleId:'schedule',paymentMethodId:'method',invoiceStripePaymentId:'mapping',state:attemptState(variant),failureClass:'hard',attemptNo:1}]);
 h.rows.set(invoiceAutopaySchedules,[{id:'schedule',invoiceId:'invoice',orgId:'org',enrollmentId:'enrollment',enrollmentGeneration:1,attemptCount:1,state:variant==='confirm'?'action_required':variant==='returned'?'succeeded':'failed'}]);
 h.rows.set(invoiceStripePayments,[{id:'mapping',invoiceId:'invoice',orgId:'org',status:'disputed',paymentMethodType:'us_bank_account',disputeFundsWithdrawn:variant==='returned',paymentReceivedAt:'2026-10-01'}]);
 h.rows.set(orgAutopayEnrollments,[{id:'enrollment',orgId:'org',status:'active',generation:1}]);
 h.rows.set(orgPaymentMethods,[{id:'method',orgId:'org',enrollmentId:'enrollment',status:variant==='update'?'unusable':'active',isAutopayMethod:true}]);
}
it.each(['confirm','update','pay'])('sends a still-needed %s action',async variant=>{
 payment(variant);expect(await dispatchPendingBillingNotices()).toEqual({sent:1,failed:0});expect(h.send).toHaveBeenCalledOnce();
});
it.each(['confirm','update','pay'])('cancels %s after the invoice is paid',async variant=>{
 payment(variant);h.invoiceEligible=false;
 expect(await dispatchPendingBillingNotices()).toEqual({sent:0,failed:0});expect(h.row.status).toBe('cancelled');expect(h.send).not.toHaveBeenCalled();
});
it.each(['confirm','update'])('cancels %s after a stop or exclusion fence',async variant=>{
 payment(variant);h.rows.get(invoiceAutopaySchedules)![0].stateReason='control_pending:exclude';
 expect(await dispatchPendingBillingNotices()).toEqual({sent:0,failed:0});expect(h.row.status).toBe('cancelled');expect(h.send).not.toHaveBeenCalled();
});
it.each(['canceled','succeeded','processing'])('cancels confirmation for a %s attempt',async state=>{
 payment('confirm');h.rows.get(invoiceCollectionAttempts)![0].state=state;
 await dispatchPendingBillingNotices();expect(h.row.status).toBe('cancelled');expect(h.send).not.toHaveBeenCalled();
});
it('cancels update-method after a replacement becomes active',async()=>{
 payment('update');h.rows.get(orgPaymentMethods)![0].status='active';
 await dispatchPendingBillingNotices();expect(h.row.status).toBe('cancelled');expect(h.send).not.toHaveBeenCalled();
});
it('cancels a cross-org attempt binding',async()=>{
 payment('confirm');h.rows.get(invoiceCollectionAttempts)![0].orgId='other';
 await dispatchPendingBillingNotices();expect(h.row.status).toBe('cancelled');expect(h.send).not.toHaveBeenCalled();
});
it('does not revalidate receipts after money moved',async()=>{
 payment('pay');h.row.kind='payment_receipt';h.invoiceEligible=false;
 expect(await dispatchPendingBillingNotices()).toEqual({sent:1,failed:0});expect(h.send).toHaveBeenCalledOnce();
});

it.each(['skipped_by_client','excluded_by_msp','cancelled'])('cancels an update-method notice for a %s schedule',async state=>{
 payment('update');h.rows.get(invoiceAutopaySchedules)![0].state=state;
 await dispatchPendingBillingNotices();expect(h.row.status).toBe('cancelled');expect(h.send).not.toHaveBeenCalled();
});
it('cancels a failure notice after the balance reaches zero',async()=>{
 payment('pay');h.rows.get(invoices)![0].balance='0.00';
 await dispatchPendingBillingNotices();expect(h.row.status).toBe('cancelled');expect(h.send).not.toHaveBeenCalled();
});
it('cancels update-method when enrollment was stopped',async()=>{
 payment('update');h.rows.get(orgAutopayEnrollments)![0].status='stopped';
 await dispatchPendingBillingNotices();expect(h.row.status).toBe('cancelled');expect(h.send).not.toHaveBeenCalled();
});

// Money facts (returned / pay / expired) stay true after autopay itself changes:
// only the invoice, the attempt and the reversed payment decide them.
const autopayChanges:[string,()=>void][]=[
 ['autopay was stopped',()=>{h.rows.get(orgAutopayEnrollments)![0].status='cancelled';h.rows.get(invoiceAutopaySchedules)![0].state='cancelled';}],
 ['autopay was paused',()=>{h.rows.get(orgAutopayEnrollments)![0].status='paused';Object.assign(h.rows.get(invoiceAutopaySchedules)![0],{state:'cancelled',stateReason:'paused_by_msp'});}],
 ['the enrollment generation advanced',()=>{Object.assign(h.rows.get(orgAutopayEnrollments)![0],{status:'requested',generation:2});}],
 ['the enrollment row is gone',()=>{h.rows.set(orgAutopayEnrollments,[]);}],
 ['the client skipped the invoice',()=>{Object.assign(h.rows.get(invoiceAutopaySchedules)![0],{state:'skipped_by_client',clientSkippedAt:new Date()});}],
 ['the MSP excluded the invoice',()=>{h.rows.get(invoices)![0].autopayExcluded=true;Object.assign(h.rows.get(invoiceAutopaySchedules)![0],{stateReason:'control_pending:exclude'});}],
];
for(const variant of ['returned','pay','expired'])it.each(autopayChanges)(`still sends the ${variant} notice after %s`,async(_label,change)=>{
 payment(variant);change();
 expect(await dispatchPendingBillingNotices()).toEqual({sent:1,failed:0});expect(h.send).toHaveBeenCalledOnce();
});
it.each(['returned','pay','expired'])('still cancels a %s notice once the invoice is no longer open',async variant=>{
 payment(variant);h.rows.get(invoices)![0].status='paid';
 await dispatchPendingBillingNotices();expect(h.row.status).toBe('cancelled');expect(h.send).not.toHaveBeenCalled();
});
it.each([
 ['the withdrawal was reinstated',()=>{h.rows.get(invoiceStripePayments)![0].disputeFundsWithdrawn=false;}],
 ['the return identity names another payment',()=>{h.row.rendered.frozen.returnIdentity='other:dp_1';}],
 ['the attempt no longer owns the payment',()=>{h.rows.get(invoiceCollectionAttempts)![0].invoiceStripePaymentId='other';}],
] as [string,()=>void][])('cancels a returned notice when %s',async(_label,change)=>{
 payment('returned');change();
 await dispatchPendingBillingNotices();expect(h.row.status).toBe('cancelled');expect(h.send).not.toHaveBeenCalled();
});

// K: a receipt is a true record unless the payment it reports never really
// completed (ACH return or failure) before the receipt went out.
function receipt(mapping:Record<string,unknown>={}){
 h.row.kind='payment_receipt';h.row.invoiceId='invoice';h.row.rendered.frozen={mappingId:'mapping',amount:'100.00',fee:'0.00',total:'100.00'};
 h.rows.set(invoiceStripePayments,[{id:'mapping',invoiceId:'invoice',orgId:'org',status:'succeeded',paymentMethodType:'us_bank_account',disputeFundsWithdrawn:false,...mapping}]);
}
it.each([
 ['an ACH return withdrew the funds',{status:'disputed',disputeFundsWithdrawn:true}],
 ['a partial ACH return withdrew funds',{status:'partially_disputed',disputeFundsWithdrawn:true}],
 ['the payment failed',{status:'failed'}],
 ['the payment belongs to another org',{orgId:'other'}],
] as [string,Record<string,unknown>][])('cancels a receipt when %s before dispatch',async(_label,mapping)=>{
 receipt(mapping);
 expect(await dispatchPendingBillingNotices()).toEqual({sent:0,failed:0});expect(h.row.status).toBe('cancelled');expect(h.send).not.toHaveBeenCalled();
});
it.each([
 ['the payment is unchanged',{}],
 ['the payment was refunded',{status:'refunded'}],
 ['the payment was partially refunded',{status:'partially_refunded'}],
 ['a card chargeback withdrew the funds',{status:'disputed',paymentMethodType:'card',disputeFundsWithdrawn:true}],
] as [string,Record<string,unknown>][])('still sends a receipt when %s',async(_label,mapping)=>{
 receipt(mapping);
 expect(await dispatchPendingBillingNotices()).toEqual({sent:1,failed:0});expect(h.send).toHaveBeenCalledOnce();
});

// G + H: reminders are revalidated against payments in flight and the frozen amount/due date.
import { STALE_REMINDER_REASON } from './reminderValidation';
function reminder(frozen:Record<string,unknown>={amount:'100.00',currency:'USD',dueDate:'2026-10-08',daysOverdue:0}){
 h.row.kind='payment_overdue';h.row.invoiceId='invoice';h.row.rendered.frozen=frozen;
 h.rows.set(invoices,[{id:'invoice',orgId:'org',status:'overdue',balance:'100.00',currencyCode:'USD',dueDate:'2026-10-08'}]);
 h.rows.set(invoiceCollectionAttempts,[{reservedAmount:'0.00'}]);
}
it('sends a reminder whose frozen amount and due date are still current',async()=>{
 reminder({amount:'100',currency:'USD',dueDate:'2026-10-08',daysOverdue:0});
 expect(await dispatchPendingBillingNotices()).toEqual({sent:1,failed:0});expect(h.send).toHaveBeenCalledOnce();
});
it('cancels a reminder while a collection attempt is reserving the invoice',async()=>{
 reminder();h.rows.set(invoiceCollectionAttempts,[{reservedAmount:'100.00'}]);
 await dispatchPendingBillingNotices();
 expect(h.row).toMatchObject({status:'cancelled',lastError:'Payment in progress'});expect(h.send).not.toHaveBeenCalled();
});
it.each([
 ['a partial payment lowered the balance',()=>{h.rows.get(invoices)![0].balance='60.00';}],
 ['the due date moved',()=>{h.rows.get(invoices)![0].dueDate='2026-10-15';}],
 ['the frozen amount is missing',()=>{h.row.rendered.frozen={currency:'USD',dueDate:'2026-10-08'};}],
] as [string,()=>void][])('cancels a stale reminder when %s',async(_label,change)=>{
 reminder();change();
 await dispatchPendingBillingNotices();
 expect(h.row).toMatchObject({status:'cancelled',lastError:STALE_REMINDER_REASON});expect(h.send).not.toHaveBeenCalled();
});
