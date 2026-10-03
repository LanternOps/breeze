import { beforeEach, expect, it, vi } from 'vitest';
const h=vi.hoisted(()=>({rows:new Map<unknown,any[]>(),writes:[] as unknown[],depth:0,
 resolve:vi.fn(),resume:vi.fn(),history:vi.fn(),mint:vi.fn()}));
vi.mock('../../db',()=>{
 const query=(table?:unknown,values?:unknown)=>{const c:any={};
 c.from=(t:unknown)=>{table=t;return c;};
 for(const op of ['where','limit','for','orderBy','returning'])c[op]=()=>c;
 c.then=(resolve:any)=>{if(values){h.writes.push({table,values});return Promise.resolve([{id:'token'}]).then(resolve);}
 return Promise.resolve(h.rows.get(table)??[]).then(resolve);};return c;};
 return {db:{select:()=>query(),update:(t:unknown)=>({set:(v:unknown)=>query(t,v)})},
 withSystemDbAccessContext:async(fn:()=>unknown)=>{h.depth++;try{return await fn();}finally{h.depth--;}}};
});
vi.mock('./linkTokens',()=>({resolveBillingLinkToken:h.resolve}));
vi.mock('./collectionEngine',()=>({resumeCollectionAttempt:h.resume,loadAttemptForReconciliation:h.history}));
vi.mock('../stripeSettle',()=>({assertNoHeldDbContextForStripe:()=>{expect(h.depth).toBe(0);}}));
vi.mock('../invoiceLinkToken',()=>({getOrMintInvoiceLink:h.mint,buildPublicInvoiceUrl:()=> 'https://portal.example.test/invoice/token'}));
import { getConfirmPaymentView,confirmInvoicePayment } from './confirmPayment';
import { billingNoticeOutbox,invoices,orgAutopayEnrollments,invoiceAutopaySchedules,invoiceCollectionAttempts } from '../../db/schema';
const invoice={id:'invoice',orgId:'org',partnerId:'partner'};
const attempt={id:'attempt',invoiceId:invoice.id,orgId:invoice.orgId,scheduleId:'schedule',attemptNo:1,stripePaymentIntentId:'pi_original',state:'requires_action',principalAmount:'100.00',currency:'USD'};
const link={id:'token',invoiceId:invoice.id,orgId:invoice.orgId,enrollmentId:'enrollment',generation:1};
beforeEach(()=>{vi.clearAllMocks();h.rows.clear();h.writes.length=0;h.depth=0;
 h.resolve.mockResolvedValue(link);h.mint.mockResolvedValue({token:'token'});
 h.resume.mockImplementation(async()=>{expect(h.depth).toBe(0);h.rows.set(invoiceCollectionAttempts,[{...attempt,state:'canceled'}]);});
 h.history.mockResolvedValue({attempt:{...attempt,state:'canceled'},invoice,mapping:{invoicePaymentId:null}});
 h.rows.set(invoices,[invoice]);h.rows.set(orgAutopayEnrollments,[{id:link.enrollmentId,orgId:'org',generation:1}]);
 h.rows.set(billingNoticeOutbox,[{rendered:{frozen:{attemptId:'attempt',tokenId:'token',variant:'confirm'}}}]);
 h.rows.set(invoiceCollectionAttempts,[attempt]);
 h.rows.set(invoiceAutopaySchedules,[{id:'schedule',invoiceId:'invoice',orgId:'org',enrollmentId:'enrollment',enrollmentGeneration:1,attemptCount:1}]);
});
it('GET resolves the frozen attempt without provider or mutation work',async()=>{
 expect(await getConfirmPaymentView('token')).toEqual({state:'requires_action',amount:'100.00',currency:'USD'});
 expect(h.resume).not.toHaveBeenCalled();expect(h.writes).toEqual([]);
});
it('cancels the exact original before consuming once and returning the invoice URL',async()=>{
 expect(await confirmInvoicePayment('token')).toEqual({url:'https://portal.example.test/invoice/token'});
 expect(h.resume).toHaveBeenCalledWith('attempt',true);expect(h.writes).toHaveLength(1);
 h.resolve.mockResolvedValue(null);await expect(confirmInvoicePayment('token')).rejects.toThrow();expect(h.writes).toHaveLength(1);
});
it.each(['processing','succeeded'])('reconciles a raced %s without replacement or token consumption',async state=>{
 h.history.mockResolvedValue({attempt:{...attempt,state},mapping:{invoicePaymentId:state==='succeeded'?'payment':null}});
 expect(await confirmInvoicePayment('token')).toEqual(state==='processing'?{processing:true}:{paid:true});expect(h.mint).not.toHaveBeenCalled();expect(h.writes).toEqual([]);
});
it('cancellation timeout leaves original authority untouched',async()=>{
 h.resume.mockRejectedValue(new Error('timeout'));await expect(confirmInvoicePayment('token')).rejects.toThrow('timeout');expect(h.writes).toEqual([]);expect(h.mint).not.toHaveBeenCalled();
});
it.each(['generation','schedule','attempt','org'])('rejects stale %s bindings before provider work',async kind=>{
 if(kind==='generation')h.resolve.mockResolvedValue({...link,generation:2});
 if(kind==='schedule')h.rows.set(invoiceAutopaySchedules,[{id:'replacement'}]);
 if(kind==='attempt')h.rows.set(invoiceCollectionAttempts,[{...attempt,id:'newer'}]);
 if(kind==='org')h.rows.set(invoices,[{...invoice,orgId:'other'}]);
 await expect(confirmInvoicePayment('token')).rejects.toThrow();expect(h.resume).not.toHaveBeenCalled();
});
