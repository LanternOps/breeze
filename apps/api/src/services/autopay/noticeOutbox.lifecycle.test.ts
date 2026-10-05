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

// I: a lifecycle email whose transport failed is retried with backoff, so it can
// land after a later transition's email. It is sent only while still true.
import { orgAutopayEnrollments } from '../../db/schema';
const at={paused:'2026-10-04T10:00:00.000Z',resumed:'2026-10-04T11:00:00.000Z',stopped:'2026-10-04T12:00:00.000Z'};
function lifecycle(kind:'autopay_paused'|'autopay_resumed'|'autopay_stopped',enrollment:Record<string,unknown>){
 const transition=kind==='autopay_paused'?at.paused:kind==='autopay_resumed'?at.resumed:at.stopped;
 Object.assign(h.row,{kind,enrollmentId:'enrollment',seq:3,rendered:{...h.row.rendered,frozen:{scheduleText:'s',feeText:'f',authorizationReference:null,transitionAt:transition}}});
 h.rows.set(orgAutopayEnrollments,[{id:'enrollment',orgId:'org',generation:3,pausedAt:null,cancelledAt:null,effectiveFrom:new Date('2026-01-01'),...enrollment}]);
}
const paused={status:'paused',pausedAt:new Date(at.paused)};
const resumed={status:'active',effectiveFrom:new Date(at.resumed)};
const stopped={status:'cancelled',cancelledAt:new Date(at.stopped)};
it.each([
 ['autopay_paused',paused],['autopay_resumed',resumed],['autopay_stopped',stopped],
] as const)('sends %s while the enrollment is still in that transition',async(kind,enrollment)=>{
 lifecycle(kind,enrollment);
 expect(await dispatchPendingBillingNotices()).toEqual({sent:1,failed:0});expect(h.send).toHaveBeenCalledOnce();
});
it.each([
 ['autopay_paused','resumed since',resumed],
 ['autopay_paused','paused again since',{...paused,pausedAt:new Date('2026-10-04T13:00:00.000Z')}],
 ['autopay_paused','stopped since',stopped],
 ['autopay_resumed','paused since',paused],
 ['autopay_resumed','resumed again since',{...resumed,effectiveFrom:new Date('2026-10-04T14:00:00.000Z')}],
 ['autopay_resumed','stopped since',stopped],
 ['autopay_stopped','re-requested since',{status:'requested',generation:4}],
 ['autopay_stopped','stopped again at a later generation',{...stopped,generation:4}],
 ['autopay_paused','missing',null],
] as const)('cancels %s when the enrollment was %s',async(kind,_label,enrollment)=>{
 lifecycle(kind,enrollment??{});
 if(!enrollment)h.rows.set(orgAutopayEnrollments,[]);
 expect(await dispatchPendingBillingNotices()).toEqual({sent:0,failed:0});
 expect(h.row.status).toBe('cancelled');expect(h.row.lastError).toBeTruthy();expect(h.send).not.toHaveBeenCalled();
});
