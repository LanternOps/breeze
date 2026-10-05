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
vi.mock('../invoiceLinkToken',()=>({getOrMintInvoiceLink:h.mint,peekInvoiceLink:()=>({token:'token'}),buildPublicInvoiceUrl:()=> 'https://portal.example.test/invoice/token'}));
import { getConfirmPaymentView,confirmInvoicePayment } from './confirmPayment';
import { billingNoticeOutbox,invoices,orgAutopayEnrollments,invoiceAutopaySchedules,invoiceCollectionAttempts,orgPaymentMethods,partners } from '../../db/schema';
const invoice={id:'invoice',orgId:'org',partnerId:'partner',status:'sent',balance:'100.00',currencyCode:'USD',autopayExcluded:false};
const attempt={id:'attempt',invoiceId:invoice.id,orgId:invoice.orgId,scheduleId:'schedule',attemptNo:1,stripePaymentIntentId:'pi_original',state:'requires_action',principalAmount:'100.00',currency:'USD'};
const link={id:'token',invoiceId:invoice.id,orgId:invoice.orgId,enrollmentId:'enrollment',generation:1};
beforeEach(()=>{vi.clearAllMocks();h.rows.clear();h.writes.length=0;h.depth=0;
 h.resolve.mockResolvedValue(link);h.mint.mockResolvedValue({token:'token'});
 h.resume.mockImplementation(async()=>{expect(h.depth).toBe(0);h.rows.set(invoiceCollectionAttempts,[{...attempt,state:'canceled'}]);
  Object.assign(h.rows.get(invoiceAutopaySchedules)![0],{state:'cancelled',stateReason:'provider_canceled'});});
 h.history.mockResolvedValue({attempt:{...attempt,state:'canceled'},invoice,mapping:{invoicePaymentId:null}});
 h.rows.set(invoices,[invoice]);h.rows.set(orgAutopayEnrollments,[{id:link.enrollmentId,orgId:'org',generation:1,status:'active'}]);
 h.rows.set(billingNoticeOutbox,[{rendered:{frozen:{attemptId:'attempt',tokenId:'token',variant:'confirm'}}}]);
 h.rows.set(invoiceCollectionAttempts,[attempt]);
 h.rows.set(invoiceAutopaySchedules,[{id:'schedule',invoiceId:'invoice',orgId:'org',enrollmentId:'enrollment',enrollmentGeneration:1,attemptCount:1}]);
});
it('GET resolves the frozen attempt without provider or mutation work',async()=>{
 expect(await getConfirmPaymentView('token')).toEqual({state:'requires_action',amount:'100.00',fee:'0.00',currency:'USD',invoiceNumber:null,invoiceStatus:'sent',balance:'100.00',
  methodLabel:null,partnerName:'',logoUrl:null,supportEmail:null,invoiceUrl:'https://portal.example.test/invoice/token'});
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

it('lands an already cancelled confirmation without provider calls or minting a pay link',async()=>{
 h.rows.set(invoiceCollectionAttempts,[{...attempt,state:'canceled'}]);
 expect(await getConfirmPaymentView('token')).toMatchObject({state:'not_needed'});
 expect(await confirmInvoicePayment('token')).toEqual({notNeeded:true});
 expect(h.resume).not.toHaveBeenCalled();expect(h.mint).not.toHaveBeenCalled();expect(h.writes).toEqual([]);
});

it.each(['skip','exclude','stop','renotice'])('lands a fenced %s confirmation without minting a link',async control=>{
 h.rows.get(invoiceAutopaySchedules)![0].stateReason=`control_pending:${control}`;
 expect(await getConfirmPaymentView('token')).toMatchObject({state:'not_needed'});
 expect(await confirmInvoicePayment('token')).toEqual({notNeeded:true});
 expect(h.resume).not.toHaveBeenCalled();expect(h.mint).not.toHaveBeenCalled();
});
it('does not mint a pay link when a control wins during cancellation',async()=>{
 h.resume.mockImplementation(async()=>{
  h.rows.set(invoiceCollectionAttempts,[{...attempt,state:'canceled'}]);
  h.rows.get(invoiceAutopaySchedules)![0].stateReason='control_pending:exclude';
 });
 expect(await confirmInvoicePayment('token')).toEqual({notNeeded:true});
 expect(h.mint).not.toHaveBeenCalled();expect(h.writes).toEqual([]);
});

// Invoice pages (public link + portal) offer the same way out as the emailed confirm link.
import { releaseInvoiceConfirmation } from './confirmPayment';
it('invoice pages cancel the off-session PI outside a DB context and release the reservation',async()=>{
 expect(await releaseInvoiceConfirmation({invoiceId:invoice.id,orgId:invoice.orgId})).toEqual({outcome:'released'});
 expect(h.resume).toHaveBeenCalledWith('attempt',true);
 // The page's own authority is the invoice link or portal session: no confirm token is consumed or minted.
 expect(h.writes).toEqual([]);expect(h.mint).not.toHaveBeenCalled();
});
it.each([['processing','processing'],['succeeded','paid']] as const)('invoice pages report a raced %s instead of releasing',async(state,outcome)=>{
 h.history.mockResolvedValue({attempt:{...attempt,state},mapping:{invoicePaymentId:state==='succeeded'?'payment':null}});
 expect(await releaseInvoiceConfirmation({invoiceId:invoice.id,orgId:invoice.orgId})).toEqual({outcome});
});
it.each(['processing','failed','canceled','succeeded'])('invoice pages never cancel when the latest attempt is %s',async state=>{
 h.rows.set(invoiceCollectionAttempts,[{...attempt,state}]);
 expect(await releaseInvoiceConfirmation({invoiceId:invoice.id,orgId:invoice.orgId})).toEqual({outcome:'not_needed'});
 expect(h.resume).not.toHaveBeenCalled();
});
it('invoice pages refuse another organization\'s invoice before provider work',async()=>{
 await expect(releaseInvoiceConfirmation({invoiceId:invoice.id,orgId:'other'})).rejects.toMatchObject({status:404});
 expect(h.resume).not.toHaveBeenCalled();
});
it('invoice pages surface a cancellation that did not land',async()=>{
 h.resume.mockResolvedValue(undefined);
 h.history.mockResolvedValue({attempt:{...attempt,state:'requires_action'},mapping:{invoicePaymentId:null}});
 await expect(releaseInvoiceConfirmation({invoiceId:invoice.id,orgId:invoice.orgId})).rejects.toMatchObject({status:409});
});

it('GET names the invoice, the charged method and the MSP for the confirm page',async()=>{
 h.rows.set(invoices,[{...invoice,invoiceNumber:'INV-7'}]);
 h.rows.set(invoiceCollectionAttempts,[{...attempt,paymentMethodId:'pm-row'}]);
 h.rows.set(orgPaymentMethods,[{id:'pm-row',orgId:'org',type:'card',cardBrand:'visa',cardFunding:'credit',cardLast4:'3184'}]);
 h.rows.set(partners,[{name:'Example MSP',billingEmail:'billing@msp.example'}]);
 expect(await getConfirmPaymentView('token')).toMatchObject({invoiceNumber:'INV-7',methodLabel:'Visa credit card ending in 3184',
  partnerName:'Example MSP',supportEmail:'billing@msp.example'});
 expect(h.writes).toEqual([]);expect(h.mint).not.toHaveBeenCalled();
});

// V-3: after the client cancels the bank-confirmation payment on the invoice, the confirm
// link must say what is still owed, not imply the invoice was settled.
it('a canceled confirmation still reports what the open invoice owes',async()=>{
 h.rows.set(invoices,[{...invoice,balance:'90.00'}]);
 h.rows.set(invoiceCollectionAttempts,[{...attempt,state:'canceled'}]);
 expect(await getConfirmPaymentView('token')).toMatchObject({state:'not_needed',invoiceStatus:'sent',balance:'90.00'});
});

// R5: a 409 says WHY by reason, not by English text: the confirm page must tell "money
// arrived, under review" (never pay again) from "still processing".
it.each([['unapplied','needs_review'],['processing_late','processing']] as const)('a %s outcome refuses with reason %s',async(kind,reason)=>{
 h.resume.mockResolvedValue(undefined);
 h.history.mockResolvedValue(kind==='unapplied'?{attempt:{...attempt,state:'unapplied'},mapping:{invoicePaymentId:null}}
  :{attempt:{...attempt,state:'requires_action'},mapping:{invoicePaymentId:null}});
 await expect(confirmInvoicePayment('token')).rejects.toMatchObject({status:409,details:{reason}});
});

// FP-4: the attempt's fee is part of what the bank asked to confirm.
it('the confirm view carries the attempt fee',async()=>{
 h.rows.set(invoiceCollectionAttempts,[{...attempt,principalAmount:'90.00',feeAmount:'2.70'}]);
 expect(await getConfirmPaymentView('token')).toMatchObject({amount:'90.00',fee:'2.70'});
});
