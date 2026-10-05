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

import { invoices, invoiceCollectionAttempts, invoiceAutopaySchedules, orgAutopayEnrollments, orgPaymentMethods } from '../../db/schema';
function payment(variant:string) {
 h.row.kind='payment_failed';h.row.invoiceId='invoice';h.row.rendered.frozen={attemptId:'attempt',variant};
 h.rows.set(invoices,[{id:'invoice',orgId:'org',partnerId:'partner',status:'sent',balance:'100.00',currencyCode:'USD',autopayExcluded:false}]);
 h.rows.set(invoiceCollectionAttempts,[{id:'attempt',invoiceId:'invoice',orgId:'org',scheduleId:'schedule',paymentMethodId:'method',state:variant==='confirm'?'requires_action':'failed',failureClass:'hard',attemptNo:1}]);
 h.rows.set(invoiceAutopaySchedules,[{id:'schedule',invoiceId:'invoice',orgId:'org',enrollmentId:'enrollment',enrollmentGeneration:1,attemptCount:1,state:variant==='confirm'?'action_required':'failed'}]);
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
it.each(['confirm','update','pay'])('cancels %s after a stop or exclusion fence',async variant=>{
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

it.each(['skipped_by_client','excluded_by_msp','cancelled'])('cancels a failure notice for a %s schedule',async state=>{
 payment('pay');h.rows.get(invoiceAutopaySchedules)![0].state=state;
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

// Method-unusable notice for a due schedule with no attempt of its own.
function methodUnusable() {
 payment('update');
 h.row.rendered.frozen={attemptId:null,scheduleId:'schedule',variant:'update',tokenId:'token',returnIdentity:null};
 h.rows.set(invoiceCollectionAttempts,[]);
 h.rows.set(invoiceAutopaySchedules,[{id:'schedule',invoiceId:'invoice',orgId:'org',enrollmentId:'enrollment',enrollmentGeneration:1,attemptCount:0,state:'failed',stateReason:'method_not_usable'}]);
 h.rows.set(orgPaymentMethods,[]);
}
it('sends the method-unusable notice while the schedule is still failed for that reason',async()=>{
 methodUnusable();expect(await dispatchPendingBillingNotices()).toEqual({sent:1,failed:0});expect(h.send).toHaveBeenCalledOnce();
});
it.each([
 ['the invoice is paid',()=>{h.invoiceEligible=false;}],
 ['a replacement method is active',()=>{h.rows.set(orgPaymentMethods,[{id:'replacement',orgId:'org',enrollmentId:'enrollment',status:'active',isAutopayMethod:true}]);}],
 ['the schedule moved on',()=>{h.rows.get(invoiceAutopaySchedules)![0].state='scheduled';}],
 ['the enrollment was stopped',()=>{h.rows.get(orgAutopayEnrollments)![0].status='cancelled';}],
 ['the schedule belongs to another invoice',()=>{h.rows.get(invoiceAutopaySchedules)![0].id='other-schedule';}],
])('cancels the method-unusable notice when %s',async(_case,change)=>{
 methodUnusable();change();
 await dispatchPendingBillingNotices();expect(h.row.status).toBe('cancelled');expect(h.send).not.toHaveBeenCalled();
});
