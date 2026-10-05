import '../../__tests__/integration/setup';
import {randomUUID} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {db,hasDbAccessContext,withSystemDbAccessContext} from '../../db';
import * as dbAccess from '../../db';
import { discardPendingTenantSelection } from './accountingTenantSelection';
import { abandonAccountingFees } from './accountingFeeAbandonment';
import * as staffNotifications from '../autopay/staffNotifications';
import * as tokens from './accountingTokens';
import {accountingConnections,accountingEntityMappings,invoicePayments,invoiceStripePayments,invoices,stripeConnectAccounts,userNotifications} from '../../db/schema';
import {createPartner,createOrganization,createUser} from '../../__tests__/integration/db-utils';
import {upsertConnection,deleteConnection} from './accountingConnectionService';
import {getAccountingProvider} from './providerRegistry';
import {pushFeeForStripeMapping,drainAccountingFees} from './accountingFeePush';
import JSZip from 'jszip';
import {ingestStripeFinancialEvent} from '../stripeReversalState';
import {recordStripePayment} from '../stripeReconcile';
import {buildOrgExportZip} from '../tenantExport';
vi.mock('../autopay/paymentNotices',()=>({enqueueOnlineReceipt:vi.fn().mockResolvedValue(undefined),enqueueRefundNotice:vi.fn().mockResolvedValue(undefined)}));
vi.mock('../../jobs/accountingSyncWorker',()=>({enqueueAccountingPaymentPush:vi.fn().mockResolvedValue(undefined),enqueueAccountingPaymentDelete:vi.fn().mockResolvedValue(undefined)}));
vi.mock('../invoiceEvents',()=>({emitInvoiceEvent:vi.fn().mockResolvedValue(undefined)}));
vi.mock('../auditEvents',()=>({writeAuditEventAsync:vi.fn().mockResolvedValue(undefined),requestLikeFromSnapshot:()=>({req:{header:()=>undefined}})}));
vi.mock('../../jobs/invoiceWorker',()=>({enqueueInvoicePdfRender:vi.fn().mockResolvedValue(undefined)}));
import type {AccountingFeeJournalEntry} from './types';
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});
async function seedFee(provider:'quickbooks'|'xero'='quickbooks'){return withSystemDbAccessContext(async()=>{
  const partner=await createPartner(),org=await createOrganization({partnerId:partner.id});
  const conn=await upsertConnection(db,partner.id,provider,{realmId:`fee-${partner.id}`,accessToken:'access',refreshToken:'refresh',
    accessTokenExpiresAt:new Date('2099-01-01'),refreshTokenExpiresAt:new Date('2099-01-01'),environment:'sandbox',
    homeCurrency:'USD',pushMode:'auto',pushPayments:true,pullPayments:false,
    feeIncomeItemRef:provider==='xero'?null:'fee-item',feeIncomeAccountRef:provider==='xero'?'200':null,
    defaultPaymentAccountRef:'bank-1',defaultExemptTaxCodeRef:'NONE'});
  await db.update(accountingConnections).set({pushPaymentsSince:null}).where(eq(accountingConnections.id,conn.id));
  const [invoice]=await db.insert(invoices).values({partnerId:partner.id,orgId:org.id,status:'paid',currencyCode:'USD',
    invoiceNumber:`FEE-${randomUUID()}`,subtotal:'100.00',taxTotal:'0.00',total:'100.00',amountPaid:'100.00',balance:'0.00'}).returning();
  const [payment]=await db.insert(invoicePayments).values({invoiceId:invoice!.id,orgId:org.id,amount:'100.00',method:'card',receivedAt:'2026-10-01'}).returning();
  await db.insert(accountingEntityMappings).values([
    {integrationId:conn.id,partnerId:partner.id,breezeEntityType:'org',breezeEntityId:org.id,remoteEntityType:'Customer',remoteEntityId:'customer-1',linkStatus:'confirmed',syncStatus:'synced'},
    {integrationId:conn.id,partnerId:partner.id,breezeEntityType:'invoice',breezeEntityId:invoice!.id,remoteEntityType:'Invoice',remoteEntityId:'invoice-1',linkStatus:'confirmed',syncStatus:'synced'},
  ]);
  const [mapping]=await db.insert(invoiceStripePayments).values({orgId:org.id,invoiceId:invoice!.id,invoicePaymentId:payment!.id,
    stripeAccountId:`acct_${partner.id}`,stripeObjectType:'payment_intent',stripeObjectId:`pi_${partner.id}`,stripePaymentIntentId:`pi_${partner.id}`,
    amount:'100.00',feeAmount:'2.50',currency:'USD',status:'succeeded',source:'autopay',paymentMethodType:'card',paymentReceivedAt:'2026-10-01'}).returning();
  return {mapping:mapping!,conn,payment:payment!};
});}
async function read(id:string){return (await withSystemDbAccessContext(()=>db.select().from(invoiceStripePayments).where(eq(invoiceStripePayments.id,id))))[0]!;}
it('serializes concurrent claims outside DB context and ignores the payment-pull switch',async()=>{
  const f=await seedFee();let release!:()=>void,entered!:()=>void;
  const wait=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});
  const post=vi.spyOn(getAccountingProvider('quickbooks'),'postFeeEntry').mockImplementation(async()=>{
    expect(hasDbAccessContext()).toBe(false);entered();await wait;return {id:'fee-1'};
  });
  const first=pushFeeForStripeMapping(f.mapping.id);await started;
  expect(await pushFeeForStripeMapping(f.mapping.id)).toBe(false);release();await first;
  expect(post).toHaveBeenCalledTimes(1);
});
it('retries a lost response using the same operation and frozen item, then refunds and restores only fees',async()=>{
  const f=await seedFee();const posted=new Map<string,string>();
  const post=vi.spyOn(getAccountingProvider('quickbooks'),'postFeeEntry').mockImplementation(async(_c,p)=>{
    if(!posted.has(p.operationId)){posted.set(p.operationId,'fee-1');throw new Error('response lost');}
    return {id:posted.get(p.operationId)!};
  });
  await expect(pushFeeForStripeMapping(f.mapping.id)).rejects.toThrow('response lost');
  const before=(await read(f.mapping.id)).feeAccountingJournal as AccountingFeeJournalEntry[];
  await expect(withSystemDbAccessContext(()=>db.delete(invoiceStripePayments).where(eq(invoiceStripePayments.id,f.mapping.id)))).rejects.toThrow();
  await withSystemDbAccessContext(()=>db.update(accountingConnections).set({feeIncomeItemRef:'different',pushPayments:false}).where(eq(accountingConnections.id,f.conn.id)));
  await withSystemDbAccessContext(async()=>{
    const row=await read(f.mapping.id);
    const journal=row.feeAccountingJournal as AccountingFeeJournalEntry[];
    journal[0]!.leaseUntil=new Date(0).toISOString();
    await db.update(invoiceStripePayments).set({feeAccountingJournal:journal}).where(eq(invoiceStripePayments.id,f.mapping.id));
  });
  await pushFeeForStripeMapping(f.mapping.id);
  expect(post.mock.calls[1]![1]).toEqual(post.mock.calls[0]![1]);
  expect(before[0]!.payload.incomeRef).toBe('fee-item');
  post.mockResolvedValue({id:'fee-reversal'});
  await withSystemDbAccessContext(()=>db.update(invoiceStripePayments).set({feeReversedAmount:'1.00'}).where(eq(invoiceStripePayments.id,f.mapping.id)));
  await pushFeeForStripeMapping(f.mapping.id);
  await withSystemDbAccessContext(()=>db.update(invoiceStripePayments).set({feeReversedAmount:'0.00'}).where(eq(invoiceStripePayments.id,f.mapping.id)));
  await pushFeeForStripeMapping(f.mapping.id);
  expect(post.mock.calls.slice(2).map(([,p])=>[p.direction,p.amount])).toEqual([['refund','1.00'],['receipt','1.00']]);
  const [payment]=await withSystemDbAccessContext(()=>db.select().from(invoicePayments).where(eq(invoicePayments.id,f.payment.id)));
  expect(payment!.amount).toBe('100.00');
});
it('does not start the Xero replay clock when token preparation fails',async()=>{
  const f=await seedFee('xero');
  const token=vi.spyOn(tokens,'getValidAccessToken').mockRejectedValueOnce(new Error('token unavailable')).mockResolvedValue('access');
  const post=vi.spyOn(getAccountingProvider('xero'),'postFeeEntry').mockResolvedValue({id:'fee-1'});
  await expect(pushFeeForStripeMapping(f.mapping.id)).rejects.toThrow('token unavailable');
  const journal=(await read(f.mapping.id)).feeAccountingJournal as AccountingFeeJournalEntry[];
  expect(journal[0]!.payload.firstSubmittedAt).toBe('');expect(post).not.toHaveBeenCalled();
  journal[0]!.leaseUntil=new Date(0).toISOString();
  await withSystemDbAccessContext(()=>db.update(invoiceStripePayments).set({feeAccountingJournal:journal}).where(eq(invoiceStripePayments.id,f.mapping.id)));
  expect(await pushFeeForStripeMapping(f.mapping.id)).toBe(true);expect(token).toHaveBeenCalledTimes(2);
});
it('adopts remote success after a failed local acknowledgement',async()=>{
  const f=await seedFee(),original=dbAccess.withSystemDbAccessContext;
  const post=vi.spyOn(getAccountingProvider('quickbooks'),'postFeeEntry').mockResolvedValue({id:'fee-remote'});
  let fail=true;
  const context=vi.spyOn(dbAccess,'withSystemDbAccessContext').mockImplementation(((fn:any,label?:string)=>{
    if(label==='accountingFee.ack'&&fail){fail=false;return Promise.reject(new Error('ack unavailable'));}
    return original(fn,label);
  }) as typeof dbAccess.withSystemDbAccessContext);
  await expect(pushFeeForStripeMapping(f.mapping.id)).rejects.toThrow('ack unavailable');
  context.mockRestore();
  const journal=(await read(f.mapping.id)).feeAccountingJournal as AccountingFeeJournalEntry[];
  expect(journal[0]!.state).toBe('pending');journal[0]!.leaseUntil=new Date(0).toISOString();
  await withSystemDbAccessContext(()=>db.update(invoiceStripePayments).set({feeAccountingJournal:journal}).where(eq(invoiceStripePayments.id,f.mapping.id)));
  await pushFeeForStripeMapping(f.mapping.id);
  expect(post.mock.calls[1]![1]).toEqual(post.mock.calls[0]![1]);
  expect(((await read(f.mapping.id)).feeAccountingJournal as AccountingFeeJournalEntry[])[0]).toMatchObject({state:'posted',remoteId:'fee-remote'});
});
it('keeps a successor acknowledgement when an expired worker finishes last',async()=>{
  const f=await seedFee();let release!:(value:{id:string})=>void,entered!:()=>void;
  const wait=new Promise<{id:string}>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});
  vi.spyOn(getAccountingProvider('quickbooks'),'postFeeEntry').mockImplementationOnce(async()=>{entered();return wait;})
    .mockResolvedValueOnce({id:'adopted-id'});
  const old=pushFeeForStripeMapping(f.mapping.id);await started;
  const journal=(await read(f.mapping.id)).feeAccountingJournal as AccountingFeeJournalEntry[];
  journal[0]!.leaseUntil=new Date(0).toISOString();
  await withSystemDbAccessContext(()=>db.update(invoiceStripePayments).set({feeAccountingJournal:journal}).where(eq(invoiceStripePayments.id,f.mapping.id)));
  await pushFeeForStripeMapping(f.mapping.id);release({id:'stale-id'});await old;
  expect(((await read(f.mapping.id)).feeAccountingJournal as AccountingFeeJournalEntry[])[0]!.remoteId).toBe('adopted-id');
});
it('refuses to move exported fee debt to a different accounting realm',async()=>{
  const f=await seedFee();const post=vi.spyOn(getAccountingProvider('quickbooks'),'postFeeEntry').mockResolvedValue({id:'fee-1'});
  await pushFeeForStripeMapping(f.mapping.id);
  await withSystemDbAccessContext(async()=>{
    await db.update(accountingConnections).set({realmIdFingerprint:'f'.repeat(64)}).where(eq(accountingConnections.id,f.conn.id));
    await db.update(invoiceStripePayments).set({feeReversedAmount:'2.50'}).where(eq(invoiceStripePayments.id,f.mapping.id));
  });
  expect(await pushFeeForStripeMapping(f.mapping.id)).toBe(false);expect(post).toHaveBeenCalledTimes(1);
  expect((await read(f.mapping.id)).feeAccountingError).toContain('Original accounting destination');
});
it('blocks erasure of a reversal not yet queued, then allows settled journal erasure without refunding again',async()=>{
  const f=await seedFee();const post=vi.spyOn(getAccountingProvider('quickbooks'),'postFeeEntry').mockResolvedValue({id:'fee-1'});
  await pushFeeForStripeMapping(f.mapping.id);
  await withSystemDbAccessContext(()=>db.update(invoiceStripePayments).set({feeReversedAmount:'2.50'}).where(eq(invoiceStripePayments.id,f.mapping.id)));
  await expect(withSystemDbAccessContext(()=>db.delete(invoiceStripePayments).where(eq(invoiceStripePayments.id,f.mapping.id)))).rejects.toThrow();
  await pushFeeForStripeMapping(f.mapping.id);
  await withSystemDbAccessContext(()=>db.delete(invoiceStripePayments).where(eq(invoiceStripePayments.id,f.mapping.id)));
  expect(post.mock.calls.map(([,p])=>[p.direction,p.amount])).toEqual([['receipt','2.50'],['refund','2.50']]);
});
it('leaves no frozen operation for missing Xero settings and succeeds after repair',async()=>{
  const f=await seedFee('xero');
  await withSystemDbAccessContext(()=>db.update(accountingConnections).set({defaultExemptTaxCodeRef:null}).where(eq(accountingConnections.id,f.conn.id)));
  const post=vi.spyOn(getAccountingProvider('xero'),'postFeeEntry').mockResolvedValue({id:'bank-fee'});
  await expect(pushFeeForStripeMapping(f.mapping.id)).rejects.toThrow('exempt');
  expect((await read(f.mapping.id)).feeAccountingJournal).toEqual([]);expect(post).not.toHaveBeenCalled();
  await withSystemDbAccessContext(()=>db.update(accountingConnections).set({defaultExemptTaxCodeRef:'NONE'}).where(eq(accountingConnections.id,f.conn.id)));
  expect(await pushFeeForStripeMapping(f.mapping.id)).toBe(true);
  expect(post.mock.calls[0]![1]).toMatchObject({incomeRef:'200',exemptTaxCodeRef:'NONE'});
});
it.each([{pushMode:'manual' as const},{pushPayments:false},{status:'reauth_required' as const}])('does not originate fee entries with %j',async change=>{
  const f=await seedFee();await withSystemDbAccessContext(()=>db.update(accountingConnections).set(change).where(eq(accountingConnections.id,f.conn.id)));
  const post=vi.spyOn(getAccountingProvider('quickbooks'),'postFeeEntry');
  expect(await pushFeeForStripeMapping(f.mapping.id)).toBe(false);expect(post).not.toHaveBeenCalled();
});

// Exercise initiation, activation and real settlement on the same day. The
// original principal may subsequently disappear through the real reducer.
it.each([
  {eligible:true,feeOnly:false},
  {eligible:true,feeOnly:true},
  {eligible:false,feeOnly:false},
  {eligible:false,feeOnly:true},
])('uses durable successful capture time across activation %j',async({eligible,feeOnly})=>{
  const f=await seedFee();
  await withSystemDbAccessContext(async()=>{
    await db.insert(stripeConnectAccounts).values({partnerId:f.conn.partnerId,stripeAccountId:f.mapping.stripeAccountId,
      apiKey:'enc:synthetic',keyLast4:'test',livemode:false});
    await db.update(invoiceStripePayments).set({status:'pending'}).where(eq(invoiceStripePayments.id,f.mapping.id));
    await db.delete(invoicePayments).where(eq(invoicePayments.id,f.payment.id));
    await db.update(invoices).set({status:'sent',subtotal:'0.01',total:'0.01',amountPaid:'0.00',balance:'0.01'})
      .where(eq(invoices.id,f.mapping.invoiceId));
    await db.update(invoiceStripePayments).set({status:'pending',paymentReceivedAt:null,amount:'0.01',feeAmount:'25.00',
      paymentMethodType:'us_bank_account',createdAt:new Date('2026-10-01T10:00:00Z')})
      .where(eq(invoiceStripePayments.id,f.mapping.id));
    await db.update(accountingConnections).set({pushPaymentsSince:new Date('2026-10-01T12:00:00Z')})
      .where(eq(accountingConnections.id,f.conn.id));
  });
  const post=vi.spyOn(getAccountingProvider('quickbooks'),'postFeeEntry').mockResolvedValue({id:'remaining-fee'});
  expect(await pushFeeForStripeMapping(f.mapping.id)).toBe(false);
  const capturedAt=new Date(eligible?'2026-10-01T13:00:00Z':'2026-10-01T11:00:00Z');
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(capturedAt);
  const capture={stripeObjectId:f.mapping.stripeObjectId,stripePaymentIntentId:f.mapping.stripePaymentIntentId!,
    stripeAccountId:f.mapping.stripeAccountId,amount:'25.01',currency:'USD',receivedAt:'2026-10-01'};
  await recordStripePayment(capture);
  // A late delivery, refund or restoration cannot re-age the original capture.
  vi.setSystemTime(new Date('2026-10-02T14:00:00Z'));
  await recordStripePayment(capture);
  if(feeOnly){
    expect(await ingestStripeFinancialEvent({partnerId:f.conn.partnerId,stripeAccountId:f.mapping.stripeAccountId,
      stripeEventId:`evt_${randomUUID()}`,eventType:'charge.refunded',livemode:false,providerCreated:1790946000,
      paymentIntentId:f.mapping.stripePaymentIntentId!,chargeId:`ch_${randomUUID()}`,currency:'USD',
      chargeAmountMinor:2501,refundedAmountMinor:1251})).toMatchObject({state:'applied'});
    expect(await read(f.mapping.id)).toMatchObject({invoicePaymentId:null,feeReversedAmount:'12.50',paymentReceivedAt:'2026-10-01'});
    await recordStripePayment(capture);
  }
  expect(await pushFeeForStripeMapping(f.mapping.id)).toBe(eligible);
  expect(await read(f.mapping.id)).toMatchObject({paymentCapturedAt:capturedAt});
  if(eligible)expect(post.mock.calls[0]![1]).toMatchObject({direction:'receipt',amount:feeOnly?'12.50':'25.00'});
  else expect(post).not.toHaveBeenCalled();
});

it('persists safe errors in the row and actual tenant export and preserves attention on a busy claim',async()=>{
  const f=await seedFee(),sensitive='https://provider.example.test/customer/remote-secret?access_token=synthetic-secret';
  const error=new Error(sensitive);
  const log=vi.spyOn(console,'error').mockImplementation(()=>undefined);
  vi.spyOn(getAccountingProvider('quickbooks'),'postFeeEntry').mockRejectedValue(error);
  await expect(pushFeeForStripeMapping(f.mapping.id)).rejects.toThrow(sensitive);
  const failed=await read(f.mapping.id);
  expect(failed.feeAccountingError).toBe('Processing fee sync failed; retry will use the original operation.');
  expect(JSON.stringify(failed)).not.toContain(sensitive);
  expect(log.mock.calls.some(call=>call.includes(error))).toBe(true);
  expect(await pushFeeForStripeMapping(f.mapping.id)).toBe(false);
  expect((await read(f.mapping.id)).feeAccountingError).toBe(failed.feeAccountingError);
  const {zipBuffer}=await buildOrgExportZip(f.mapping.orgId,randomUUID());
  const archive=await JSZip.loadAsync(zipBuffer);
  const exported=await archive.file('invoice_stripe_payments.json')!.async('string');
  expect(JSON.parse(exported)[0].fee_accounting_error).toBe(failed.feeAccountingError);
  for(const entry of Object.values(archive.files))if(!entry.dir){
    const text=await entry.async('string');
    expect(text).not.toContain('synthetic-secret');expect(text).not.toContain('remote-secret');
  }
});

it('does not resurrect an error when an expired worker fails after its successor acknowledges',async()=>{
  const f=await seedFee();let reject!:(reason:Error)=>void,entered!:()=>void;
  const wait=new Promise<{id:string}>((_r,j)=>{reject=j;}),started=new Promise<void>(r=>{entered=r;});
  vi.spyOn(console,'error').mockImplementation(()=>undefined);
  vi.spyOn(getAccountingProvider('quickbooks'),'postFeeEntry').mockImplementationOnce(async()=>{entered();return wait;})
    .mockResolvedValueOnce({id:'successor'});
  const old=pushFeeForStripeMapping(f.mapping.id);
  const rejected=expect(old).rejects.toThrow('old failure');
  await started;
  const journal=(await read(f.mapping.id)).feeAccountingJournal as AccountingFeeJournalEntry[];
  journal[0]!.leaseUntil=new Date(0).toISOString();
  await withSystemDbAccessContext(()=>db.update(invoiceStripePayments).set({feeAccountingJournal:journal}).where(eq(invoiceStripePayments.id,f.mapping.id)));
  await pushFeeForStripeMapping(f.mapping.id);reject(new Error('old failure'));await rejected;
  const row=await read(f.mapping.id);
  expect(row.feeAccountingError).toBeNull();
  expect((row.feeAccountingJournal as AccountingFeeJournalEntry[])[0]).toMatchObject({state:'posted',remoteId:'successor',error:null});
});

it('does not clear an existing error while another worker owns the lease',async()=>{
  const f=await seedFee();
  vi.spyOn(console,'error').mockImplementation(()=>undefined);
  vi.spyOn(getAccountingProvider('quickbooks'),'postFeeEntry').mockRejectedValue(new Error('response lost'));
  await expect(pushFeeForStripeMapping(f.mapping.id)).rejects.toThrow('response lost');
  const before=await read(f.mapping.id);
  expect(before.feeAccountingError).toBeTruthy();
  expect(await pushFeeForStripeMapping(f.mapping.id)).toBe(false);
  const after=await read(f.mapping.id);
  expect(after.feeAccountingError).toBe(before.feeAccountingError);
  expect(after.feeAccountingJournal).toEqual(before.feeAccountingJournal);
});

async function expireLease(id:string){
  const journal=(await read(id)).feeAccountingJournal as AccountingFeeJournalEntry[];
  for(const entry of journal)entry.leaseUntil=new Date(0).toISOString();
  await withSystemDbAccessContext(()=>db.update(invoiceStripePayments).set({feeAccountingJournal:journal}).where(eq(invoiceStripePayments.id,id)));
}
it('retries lookup rate limits without starting the replay clock',async()=>{
  const f=await seedFee('xero');
  const post=vi.spyOn(getAccountingProvider('xero'),'postFeeEntry').mockRejectedValueOnce(new AccountingProviderError({
    provider:'xero',kind:'rate_limited',operation:'Xero fee lookup',message:'throttled'})).mockResolvedValue({id:'fee-1'});
  expect(await pushFeeForStripeMapping(f.mapping.id)).toBe(true);
  expect(post).toHaveBeenCalledTimes(2);
  expect(post.mock.calls[0]![1].firstSubmittedAt).toBe('');
});
it('refreezes a definitively rejected mapping after correction, with one staff attention',async()=>{
  const f=await seedFee();await createUser({partnerId:f.conn.partnerId,withMembership:true});
  const post=vi.spyOn(getAccountingProvider('quickbooks'),'postFeeEntry').mockRejectedValueOnce(new AccountingProviderError({
    provider:'quickbooks',kind:'validation',operation:'QuickBooks fee create',message:'sensitive invalid item'})).mockResolvedValue({id:'repaired'});
  await expect(pushFeeForStripeMapping(f.mapping.id)).rejects.toThrow('sensitive invalid item');
  expect(((await read(f.mapping.id)).feeAccountingJournal as AccountingFeeJournalEntry[])[0]!.state).toBe('needs_mapping');
  expect(await pushFeeForStripeMapping(f.mapping.id)).toBe(false);
  await withSystemDbAccessContext(()=>db.update(accountingConnections).set({feeIncomeItemRef:'correct-item'}).where(eq(accountingConnections.id,f.conn.id)));
  expect(await pushFeeForStripeMapping(f.mapping.id)).toBe(true);
  expect(post.mock.calls[1]![1].incomeRef).toBe('correct-item');
  const notices=await withSystemDbAccessContext(()=>db.select().from(userNotifications));
  expect(notices.filter(n=>n.message?.includes('fix fee income mapping'))).toHaveLength(1);
});
it('persists prepare errors with an existing journal and raises deduped attention',async()=>{
  const f=await seedFee();await createUser({partnerId:f.conn.partnerId,withMembership:true});
  vi.spyOn(getAccountingProvider('quickbooks'),'postFeeEntry').mockResolvedValue({id:'posted'});
  await pushFeeForStripeMapping(f.mapping.id);
  await withSystemDbAccessContext(async()=>{
    await db.update(accountingConnections).set({homeCurrency:'CAD'}).where(eq(accountingConnections.id,f.conn.id));
    await db.update(invoiceStripePayments).set({feeReversedAmount:'1.00'}).where(eq(invoiceStripePayments.id,f.mapping.id));
  });
  for(let n=0;n<2;n++)await expect(pushFeeForStripeMapping(f.mapping.id)).rejects.toThrow();
  expect((await read(f.mapping.id)).feeAccountingError).toBeTruthy();
  expect(await withSystemDbAccessContext(()=>db.select().from(userNotifications))).toHaveLength(1);
});
it('does not mask corrupt journals in the error handler',async()=>{
  const f=await seedFee();
  await withSystemDbAccessContext(()=>db.update(invoiceStripePayments).set({feeAccountingJournal:[{}]}).where(eq(invoiceStripePayments.id,f.mapping.id)));
  await expect(pushFeeForStripeMapping(f.mapping.id)).rejects.toThrow('Invalid processing fee journal');
  expect((await read(f.mapping.id)).feeAccountingError).toBeTruthy();
});
it('drains only outstanding work and does not lock or rewrite settled mappings',async()=>{
  const f=await seedFee();vi.spyOn(getAccountingProvider('quickbooks'),'postFeeEntry').mockResolvedValue({id:'posted'});
  await pushFeeForStripeMapping(f.mapping.id);
  const context=vi.spyOn(dbAccess,'withSystemDbAccessContext');
  expect(await drainAccountingFees()).toEqual({posted:0,failed:0});
  expect(context.mock.calls.some(([,label])=>label==='accountingFee.prepare')).toBe(false);
});
it('abandons disconnected bookkeeping, never replays it to a new connection, and permits deletion',async()=>{
  const f=await seedFee();await createUser({partnerId:f.conn.partnerId,withMembership:true});
  await createUser({partnerId:f.conn.partnerId,withMembership:true});
  const post=vi.spyOn(getAccountingProvider('quickbooks'),'postFeeEntry').mockRejectedValue(new Error('lost response'));
  await expect(pushFeeForStripeMapping(f.mapping.id)).rejects.toThrow('lost response');
  await withSystemDbAccessContext(()=>deleteConnection(db,f.conn.partnerId,'quickbooks'));
  expect((await read(f.mapping.id)).feeAccountingJournal).toEqual(expect.arrayContaining([expect.objectContaining({state:'abandoned'})]));
  await withSystemDbAccessContext(()=>upsertConnection(db,f.conn.partnerId,'quickbooks',{realmId:'new-company',accessToken:'access',refreshToken:'refresh',accessTokenExpiresAt:new Date('2099-01-01'),environment:'sandbox',homeCurrency:'USD',pushPayments:true,pushMode:'auto'}));
  await expireLease(f.mapping.id);expect(await pushFeeForStripeMapping(f.mapping.id)).toBe(false);expect(post).toHaveBeenCalledTimes(1);
  const notifications=await withSystemDbAccessContext(()=>db.select().from(userNotifications));
  expect(notifications).toHaveLength(4);
  expect(notifications.filter(n=>n.message?.includes('was abandoned'))).toHaveLength(2);
  await withSystemDbAccessContext(()=>db.delete(invoiceStripePayments).where(eq(invoiceStripePayments.id,f.mapping.id)));
});
it('allows tenantCascade erasure with unfinished fees and a live connection',async()=>{
  const f=await seedFee();vi.spyOn(getAccountingProvider('quickbooks'),'postFeeEntry').mockRejectedValue(new Error('lost response'));
  await expect(pushFeeForStripeMapping(f.mapping.id)).rejects.toThrow('lost response');
  await cascadeDeleteOrg(f.mapping.orgId,(await createUser({partnerId:f.conn.partnerId,withMembership:true})).id);
  expect(await read(f.mapping.id)).toBeUndefined();
});

import {AccountingProviderError} from './accountingProviderError';
import {cascadeDeleteOrg} from '../tenantCascade';

it('persists a categorized error for corrupt fee reversal with an existing journal',async()=>{
  const f=await seedFee();await createUser({partnerId:f.conn.partnerId,withMembership:true});
  vi.spyOn(getAccountingProvider('quickbooks'),'postFeeEntry').mockResolvedValue({id:'posted'});
  await pushFeeForStripeMapping(f.mapping.id);
  const admin=postgres(process.env.DATABASE_URL!,{max:1});
  try{
    // Simulate pre-existing corruption; production retains the CHECK constraint.
    await admin`ALTER TABLE invoice_stripe_payments DROP CONSTRAINT invoice_stripe_payments_fee_reversed_check`;
    await withSystemDbAccessContext(()=>db.update(invoiceStripePayments).set({feeReversedAmount:'3.00'}).where(eq(invoiceStripePayments.id,f.mapping.id)));
    await expect(pushFeeForStripeMapping(f.mapping.id)).rejects.toThrow('Fee reversal exceeds original fee');
    expect((await read(f.mapping.id)).feeAccountingError).toContain('reversal exceeds the original fee');
    expect(await withSystemDbAccessContext(()=>db.select().from(userNotifications))).toHaveLength(1);
  }finally{
    await withSystemDbAccessContext(()=>db.update(invoiceStripePayments).set({feeReversedAmount:'0.00'}).where(eq(invoiceStripePayments.id,f.mapping.id)));
    await admin`ALTER TABLE invoice_stripe_payments ADD CONSTRAINT invoice_stripe_payments_fee_reversed_check CHECK (fee_reversed_amount>=0 AND fee_reversed_amount<=fee_amount)`;
    await admin.end();
  }
});
it('allows deleting unfinished fee bookkeeping when no live accounting connection exists',async()=>{
  const f=await seedFee();vi.spyOn(getAccountingProvider('quickbooks'),'postFeeEntry').mockRejectedValue(new Error('lost response'));
  await expect(pushFeeForStripeMapping(f.mapping.id)).rejects.toThrow('lost response');
  await withSystemDbAccessContext(async()=>{
    await db.delete(accountingConnections).where(eq(accountingConnections.id,f.conn.id));
    await db.delete(invoiceStripePayments).where(eq(invoiceStripePayments.id,f.mapping.id));
  });
  expect(await read(f.mapping.id)).toBeUndefined();
});
import postgres from 'postgres';

it('recovers on the next sweep twenty minutes after exhausting lookup 429 retries',async()=>{
  const f=await seedFee('xero');
  const post=vi.spyOn(getAccountingProvider('xero'),'postFeeEntry').mockRejectedValue(new AccountingProviderError({
    provider:'xero',kind:'rate_limited',operation:'Xero fee lookup',httpStatus:429,message:'throttled'}));
  await expect(pushFeeForStripeMapping(f.mapping.id)).rejects.toMatchObject({kind:'rate_limited'});
  expect(post).toHaveBeenCalledTimes(3);
  expect(((await read(f.mapping.id)).feeAccountingJournal as AccountingFeeJournalEntry[])[0]!.payload.firstSubmittedAt).toBe('');
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(Date.now()+20*60*1000));
  post.mockImplementation(async(_conn,payload,hooks)=>{
    expect(hasDbAccessContext()).toBe(false);await hooks!.beforeCreate!();
    expect(hasDbAccessContext()).toBe(false);
    expect(((await read(f.mapping.id)).feeAccountingJournal as AccountingFeeJournalEntry[])[0]!.payload.firstSubmittedAt).toBe(payload.firstSubmittedAt);
    expect(payload.firstSubmittedAt).toBe(new Date().toISOString());
    return {id:'created-after-throttle'};
  });
  expect(await pushFeeForStripeMapping(f.mapping.id)).toBe(true);
});

it('keeps mapping frozen when a definitive rejection follows an ambiguous create in the same retry loop',async()=>{
  const f=await seedFee();let calls=0;
  vi.spyOn(getAccountingProvider('quickbooks'),'postFeeEntry').mockImplementation(async(_conn,_payload,hooks)=>{
    await hooks!.beforeCreate!();
    throw new AccountingProviderError({provider:'quickbooks',operation:'QuickBooks fee create',
      kind:calls++===0?'transient':'validation',message:'provider failure'});
  });
  await expect(pushFeeForStripeMapping(f.mapping.id)).rejects.toMatchObject({kind:'validation'});
  const [entry]=(await read(f.mapping.id)).feeAccountingJournal as AccountingFeeJournalEntry[];
  expect(entry).toMatchObject({state:'pending',payload:{incomeRef:'fee-item'}});
  expect(entry!.payload.firstSubmittedAt).not.toBe('');
});

// A re-parked connection can still carry fee bookkeeping from its previous realm.
it('pending disconnect rolls back deletion, abandonment and notifications when fanout fails', async () => {
  const f = await seedFee();
  await createUser({partnerId:f.conn.partnerId,withMembership:true});
  vi.spyOn(getAccountingProvider('quickbooks'),'postFeeEntry').mockResolvedValue({id:'fee-posted'});
  await pushFeeForStripeMapping(f.mapping.id);
  await withSystemDbAccessContext(async () => {
    await db.update(accountingConnections).set({status:'pending_tenant'}).where(eq(accountingConnections.id,f.conn.id));
    await db.update(invoiceStripePayments).set({feeReversedAmount:'1.00'}).where(eq(invoiceStripePayments.id,f.mapping.id));
  });
  const before = await read(f.mapping.id);
  const fanout = staffNotifications.enqueueAutopayStaffNotifications;
  const injected = vi.spyOn(staffNotifications,'enqueueAutopayStaffNotifications').mockImplementationOnce(async (executor, input) => {
    await fanout(executor,input);
    throw new Error('injected notification failure');
  });
  const input = {
    partnerId:f.conn.partnerId,provider:'quickbooks' as const,reason:'cancel' as const,
    runInDbContext:<T>(fn:()=>Promise<T>)=>withSystemDbAccessContext(fn,'accounting.disconnect'),
    onDeleted:(connectionId:string)=>abandonAccountingFees(db,f.conn.partnerId,connectionId),
  };
  await expect(discardPendingTenantSelection(input)).rejects.toThrow('injected notification failure');
  expect(await withSystemDbAccessContext(()=>db.select().from(accountingConnections).where(eq(accountingConnections.id,f.conn.id)))).toHaveLength(1);
  expect(await read(f.mapping.id)).toEqual(before);
  expect(await withSystemDbAccessContext(()=>db.select().from(userNotifications))).toHaveLength(0);
  expect(await withSystemDbAccessContext(()=>db.select().from(accountingEntityMappings).where(eq(accountingEntityMappings.integrationId,f.conn.id)))).toHaveLength(2);
  injected.mockRestore();
  await expect(discardPendingTenantSelection(input)).resolves.toMatchObject({discarded:true,connectionId:f.conn.id});
  expect(await withSystemDbAccessContext(()=>db.select().from(accountingConnections).where(eq(accountingConnections.id,f.conn.id)))).toHaveLength(0);
  expect((await read(f.mapping.id)).feeAccountingJournal).toEqual(expect.arrayContaining([expect.objectContaining({state:'abandoned'})]));
  expect(await withSystemDbAccessContext(()=>db.select().from(userNotifications))).toHaveLength(1);
});

it.each([false,true])('disconnect of settled history raises no attention (reversal settled: %s)', async (reversed) => {
  const f = await seedFee();
  await createUser({partnerId:f.conn.partnerId,withMembership:true});
  const post = vi.spyOn(getAccountingProvider('quickbooks'),'postFeeEntry').mockResolvedValue({id:'fee-posted'});
  await pushFeeForStripeMapping(f.mapping.id);
  if(reversed){
    await withSystemDbAccessContext(()=>db.update(invoiceStripePayments).set({feeReversedAmount:'1.00'}).where(eq(invoiceStripePayments.id,f.mapping.id)));
    await pushFeeForStripeMapping(f.mapping.id);
  }
  const posted = (await read(f.mapping.id)).feeAccountingJournal as AccountingFeeJournalEntry[];
  await withSystemDbAccessContext(()=>deleteConnection(db,f.conn.partnerId,'quickbooks'));
  expect(await withSystemDbAccessContext(()=>db.select().from(userNotifications))).toHaveLength(0);
  const abandoned = await read(f.mapping.id);
  expect(abandoned.feeAccountingJournal).toEqual([...posted,expect.objectContaining({state:'abandoned'})]);
  expect(abandoned.feeAccountingError).toBeNull();
  await withSystemDbAccessContext(()=>upsertConnection(db,f.conn.partnerId,'quickbooks',{realmId:'new-company',accessToken:'access',refreshToken:'refresh',accessTokenExpiresAt:new Date('2099-01-01'),environment:'sandbox',homeCurrency:'USD',pushPayments:true,pushMode:'auto'}));
  expect(await pushFeeForStripeMapping(f.mapping.id)).toBe(false);
  expect(post).toHaveBeenCalledTimes(reversed?2:1);
});
