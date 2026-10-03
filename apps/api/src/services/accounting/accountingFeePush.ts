import {randomUUID} from 'node:crypto';
import {and,asc,eq,gt} from 'drizzle-orm';
import {fromMinorUnits,toMinorUnits} from '@breeze/shared';
import {db,runOutsideDbContext,withSystemDbAccessContext} from '../../db';
import {accountingConnections,accountingEntityMappings,invoiceStripePayments,invoices} from '../../db/schema';
import {getConnectionById,resolveActiveConnection} from './accountingConnectionService';
import {assertAccountingInvoicePushCurrency} from './accountingCurrency';
import {getAccountingProvider,providerSupports} from './providerRegistry';
import {getValidAccessToken} from './accountingTokens';
import {feeEntrySettings} from './accountingFeeEntry';
import {AccountingProviderError} from './accountingProviderError';
import type {AccountingFeeEntryPayload,AccountingFeeJournalEntry} from './types';
const LEASE_MS=10*60*1000;
function journalOf(value:unknown):AccountingFeeJournalEntry[]{
  if(!Array.isArray(value))throw new Error('Invalid processing fee journal');
  for(const e of value){if(!e||!e.payload||!['pending','posted'].includes(e.state)||!e.connectionId||!e.payload.operationId)
    throw new Error('Invalid processing fee journal');}
  return structuredClone(value) as AccountingFeeJournalEntry[];
}
const signed=(e:AccountingFeeJournalEntry)=>toMinorUnits(e.payload.amount,e.payload.currencyCode)*(e.payload.direction==='receipt'?1:-1);
async function lockMapping(id:string){
  const [ref]=await db.select({invoiceId:invoiceStripePayments.invoiceId}).from(invoiceStripePayments).where(eq(invoiceStripePayments.id,id)).limit(1);
  if(!ref)return null;
  const [invoice]=await db.select().from(invoices).where(eq(invoices.id,ref.invoiceId)).limit(1).for('update');
  if(!invoice)return null;
  const [mapping]=await db.select().from(invoiceStripePayments).where(and(eq(invoiceStripePayments.id,id),
    eq(invoiceStripePayments.invoiceId,invoice.id),eq(invoiceStripePayments.orgId,invoice.orgId))).limit(1).for('update');
  return mapping?{invoice,mapping}:null;
}
async function save(id:string,journal:AccountingFeeJournalEntry[],error:string|null=null){
  await db.update(invoiceStripePayments).set({feeAccountingJournal:journal,feeAccountingError:error}).where(eq(invoiceStripePayments.id,id));
}
async function prepare(id:string){
  const locked=await lockMapping(id);if(!locked)return null;
  const {invoice,mapping}=locked,journal=journalOf(mapping.feeAccountingJournal),first=journal[0];
  if(mapping.currency!=='USD')throw new Error('Processing fee accounting requires USD');
  const target=toMinorUnits(mapping.feeAmount,'USD')-toMinorUnits(mapping.feeReversedAmount,'USD');
  if(target<0)throw new Error('Fee reversal exceeds original fee');
  const conn=first?await getConnectionById(db,first.connectionId,invoice.partnerId):await resolveActiveConnection(db,invoice.partnerId);
  if(first&&(!conn||conn.realmIdFingerprint!==first.realmFingerprint)){
    await save(id,journal,'Original accounting destination is unavailable. Reconnect the same connection; do not send this debt to another company.');return null;
  }
  if(!first){
    // Capture provenance survives deletion of the principal payment by the
    // reversal reducer, including a disputed principal with remaining fee cash.
    if(target===0||!mapping.paymentReceivedAt||!['succeeded','partially_refunded','partially_disputed','disputed'].includes(mapping.status))return null;
    if(!conn||conn.status!=='connected'||!conn.pushPayments||conn.pushMode!=='auto'||!providerSupports(conn.provider,'paymentPush')||invoice.status==='void')return null;
    const [raw]=await db.select({since:accountingConnections.pushPaymentsSince}).from(accountingConnections).where(eq(accountingConnections.id,conn.id)).limit(1);
    // Initiation can precede activation (ACH). Only successful capture decides
    // eligibility; reversals and replacement principal rows cannot re-age it.
    if(!raw)return null;
    if(raw.since){
      if(!mapping.paymentCapturedAt)throw new Error('Original successful capture time is unavailable; operator investigation is required');
      if(mapping.paymentCapturedAt<raw.since)return null;
    }
  }
  if(!conn||conn.status!=='connected'||!providerSupports(conn.provider,'paymentPush'))return null;
  assertAccountingInvoicePushCurrency(conn,{currencyCode:mapping.currency});
  const delta=target-journal.reduce((sum,e)=>sum+signed(e),0);
  if(delta!==0){
    let base:AccountingFeeEntryPayload;
    if(first)base=first.payload;
    else{
      const [inv]=await db.select().from(accountingEntityMappings).where(and(eq(accountingEntityMappings.integrationId,conn.id),
        eq(accountingEntityMappings.partnerId,invoice.partnerId),eq(accountingEntityMappings.breezeEntityType,'invoice'),eq(accountingEntityMappings.breezeEntityId,invoice.id))).limit(1);
      if(!inv?.remoteEntityId||!['synced','synced_with_tax_variance'].includes(inv.syncStatus))return null;
      const [customer]=await db.select().from(accountingEntityMappings).where(and(eq(accountingEntityMappings.integrationId,conn.id),
        eq(accountingEntityMappings.partnerId,invoice.partnerId),eq(accountingEntityMappings.breezeEntityType,'org'),eq(accountingEntityMappings.breezeEntityId,invoice.orgId))).limit(1);
      if(!customer?.remoteEntityId||['suggested','unlinked'].includes(customer.linkStatus))return null;
      const feeSettings=feeEntrySettings(conn);
      if(!conn.realmIdFingerprint)throw new Error('Original accounting destination has no fingerprint');
      const refusal=getAccountingProvider(conn.provider).paymentPushPreflight?.(conn);
      if(refusal)throw new Error(refusal);
      base={operationId:randomUUID(),remoteCustomerId:customer.remoteEntityId,amount:'0.00',currencyCode:mapping.currency,
        txnDate:mapping.paymentReceivedAt!,direction:'receipt',...feeSettings,firstSubmittedAt:''};
    }
    journal.push({connectionId:conn.id,realmFingerprint:first?.realmFingerprint??conn.realmIdFingerprint!,payload:{...base,
      operationId:randomUUID(),amount:fromMinorUnits(Math.abs(delta),'USD'),direction:delta>0?'receipt':'refund',
      txnDate:first?mapping.updatedAt.toISOString().slice(0,10):mapping.paymentReceivedAt!,firstSubmittedAt:''},
      state:'pending',leaseToken:null,leaseUntil:null,remoteId:null,error:null});
  }
  const next=journal.find(e=>e.state==='pending');
  if(!next){await save(id,journal);return null;}
  if(next.leaseUntil&&Date.parse(next.leaseUntil)>Date.now()){await save(id,journal,mapping.feeAccountingError);return null;}
  next.leaseToken=randomUUID();next.leaseUntil=new Date(Date.now()+LEASE_MS).toISOString();
  next.error=null;
  await save(id,journal);
  return {partnerId:invoice.partnerId,entry:structuredClone(next)};
}
// Only locally chosen categories may enter the tenant-exported error column.
// Provider messages, HTTP bodies, identifiers and transport URLs stay in logs.
function safeFeeError(error:unknown):string{
  if(error instanceof AccountingProviderError){
    switch(error.kind){
      case 'reauth':return 'Processing fee sync requires reconnecting the original accounting connection.';
      case 'rate_limited':return 'Processing fee sync is rate limited; retry will use the original operation.';
      case 'validation':return 'Processing fee sync needs attention; review the fee settings and original accounting entry.';
      case 'not_found':return 'Processing fee sync could not find the original accounting record; operator investigation is required.';
      case 'stale_version':
      case 'payment_linked':
      case 'duplicate_doc_number':return 'Processing fee sync has an accounting conflict; operator investigation is required.';
    }
  }
  return 'Processing fee sync failed; retry will use the original operation.';
}
export async function pushFeeForStripeMapping(id:string):Promise<boolean>{
  return runOutsideDbContext(async()=>{
    let claim:Awaited<ReturnType<typeof prepare>>=null;
    try{
      claim=await withSystemDbAccessContext(()=>prepare(id),'accountingFee.prepare');
      if(!claim)return false;
      const owned=claim;
      const conn=await withSystemDbAccessContext(()=>getConnectionById(db,owned.entry.connectionId,owned.partnerId),'accountingFee.connection');
      if(!conn||conn.status!=='connected'||conn.realmIdFingerprint!==owned.entry.realmFingerprint)throw new Error('Original fee accounting destination changed');
      const accessToken=await getValidAccessToken(db,conn);
      const payload=await withSystemDbAccessContext(async()=>{
        const row=await lockMapping(id);if(!row)return null;
        const journal=journalOf(row.mapping.feeAccountingJournal),entry=journal.find(e=>e.payload.operationId===owned.entry.payload.operationId);
        if(!entry||entry.leaseToken!==owned.entry.leaseToken)return null;
        entry.payload.firstSubmittedAt||=new Date().toISOString();await save(id,journal);
        return structuredClone(entry.payload);
      },'accountingFee.submit');
      if(!payload)return false;
      let ref:{id:string;remoteVersion?:string};
      for(let retry=0;;retry++){
        try{ref=await getAccountingProvider(conn.provider).postFeeEntry({...conn,accessToken},payload);break;}
        catch(error){
          if(retry>=2||!(error instanceof AccountingProviderError)||error.kind!=='transient'
            ||Date.now()-Date.parse(payload.firstSubmittedAt)>=4*60*1000)throw error;
          await new Promise(resolve=>setTimeout(resolve,(retry+1)*1000));
        }
      }
      await withSystemDbAccessContext(async()=>{
        const row=await lockMapping(id);if(!row)throw new Error('Processing fee journal disappeared');
        const journal=journalOf(row.mapping.feeAccountingJournal),entry=journal.find(e=>e.payload.operationId===owned.entry.payload.operationId);
        if(!entry||entry.leaseToken!==owned.entry.leaseToken)return;
        entry.state='posted';entry.remoteId=ref.id;entry.leaseToken=null;entry.leaseUntil=null;entry.error=null;
        await save(id,journal);
      },'accountingFee.ack');
      return true;
    }catch(error){
      console.error('[AccountingFeePush] processing fee sync failed',error);
      // Retain the uncertain lease. A late failure must neither steal a
      // successor's claim nor resurrect attention after its acknowledgement.
      const failedClaim=claim;
      await withSystemDbAccessContext(async()=>{
        const row=await lockMapping(id);if(!row)return;
        const journal=journalOf(row.mapping.feeAccountingJournal);
        const message=safeFeeError(error);
        if(failedClaim){
          const entry=journal.find(e=>e.payload.operationId===failedClaim.entry.payload.operationId);
          if(!entry||entry.state!=='pending'||entry.leaseToken!==failedClaim.entry.leaseToken)return;
          entry.error=message;
          await save(id,journal,message);
        }else if(journal.length===0){
          // A preflight failed before there was an operation. Do not overwrite
          // a concurrent worker that has since successfully frozen a journal.
          await save(id,journal,message);
        }
      },'accountingFee.error');
      throw error;
    }
  });
}
export async function drainAccountingFees():Promise<{posted:number;failed:number}>{
  return runOutsideDbContext(async()=>{
    let cursor:string|undefined,posted=0,failed=0;
    for(;;){
      const rows=await withSystemDbAccessContext(()=>db.select({id:invoiceStripePayments.id}).from(invoiceStripePayments).where(and(
        gt(invoiceStripePayments.feeAmount,'0.00'),cursor?gt(invoiceStripePayments.id,cursor):undefined)).orderBy(asc(invoiceStripePayments.id)).limit(100));
      if(!rows.length)break;
      for(const row of rows)try{for(let n=0;n<20;n++){if(!await pushFeeForStripeMapping(row.id))break;posted++;}}
        catch{failed++;}
      cursor=rows[rows.length-1]!.id;
    }
    return {posted,failed};
  });
}
