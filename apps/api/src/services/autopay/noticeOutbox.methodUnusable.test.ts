import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ row: {} as any, ackFailures: 0, invoiceEligible: true, rows: new Map<unknown,any[]>(), send: vi.fn(), capture: vi.fn() }));
vi.mock('../email', () => ({ getEmailService: () => ({ sendEmail: h.send }) }));
vi.mock('../sentry', () => ({ captureException: h.capture }));
const f = vi.hoisted(() => ({ attemptNotice: vi.fn(), schedulePay: vi.fn() }));
vi.mock('./paymentNotices', () => ({ enqueueAttemptNotice: f.attemptNotice, enqueueMethodUnusablePayNotice: f.schedulePay }));
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
 ['the schedule moved on',()=>{h.rows.get(invoiceAutopaySchedules)![0].state='scheduled';}],
 ['the schedule belongs to another invoice',()=>{h.rows.get(invoiceAutopaySchedules)![0].id='other-schedule';}],
])('cancels the method-unusable notice when %s',async(_case,change)=>{
 methodUnusable();change();
 await dispatchPendingBillingNotices();expect(h.row.status).toBe('cancelled');expect(h.send).not.toHaveBeenCalled();
 expect(f.schedulePay).not.toHaveBeenCalled();
});
// 2b-1: the invoice still was not charged; only the update link stopped being true.
it.each([
 ['a replacement method is active',()=>{h.rows.set(orgPaymentMethods,[{id:'replacement',orgId:'org',enrollmentId:'enrollment',status:'active',isAutopayMethod:true}]);}],
 ['the enrollment was stopped',()=>{h.rows.get(orgAutopayEnrollments)![0].status='cancelled';}],
 ['the enrollment was paused',()=>{h.rows.get(orgAutopayEnrollments)![0].status='paused';}],
 ['the MSP excluded the invoice',()=>{h.rows.get(invoices)![0].autopayExcluded=true;}],
])('re-issues the method-unusable notice as the pay variant when %s',async(_case,change)=>{
 methodUnusable();change();
 await dispatchPendingBillingNotices();expect(h.row.status).toBe('cancelled');expect(h.send).not.toHaveBeenCalled();
 expect(f.schedulePay).toHaveBeenCalledWith(expect.anything(),'schedule');
});
it('sends the schedule-bound pay variant whatever happened to autopay since',async()=>{
 methodUnusable();h.row.rendered.frozen={attemptId:null,scheduleId:'schedule',variant:'pay',tokenId:null,returnIdentity:null};
 h.rows.get(orgAutopayEnrollments)![0].status='cancelled';
 expect(await dispatchPendingBillingNotices()).toEqual({sent:1,failed:0});expect(h.send).toHaveBeenCalledOnce();
});
it('cancels the schedule-bound pay variant once the invoice is paid',async()=>{
 methodUnusable();h.row.rendered.frozen={attemptId:null,scheduleId:'schedule',variant:'pay',tokenId:null,returnIdentity:null};
 h.invoiceEligible=false;
 await dispatchPendingBillingNotices();expect(h.row.status).toBe('cancelled');expect(h.send).not.toHaveBeenCalled();
});
