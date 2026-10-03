import { and, eq, sql } from 'drizzle-orm';
import { invoiceStripePayments, invoices } from '../../db/schema';
import type { db } from '../../db';
import { enqueueAutopayStaffNotifications } from '../autopay/staffNotifications';
import type { AccountingFeeJournalEntry } from './types';

/** A disconnect is terminal for this destination, including future reversals.
 * Keep posted identities for audit and never replay them into a reconnected realm. */
export async function abandonAccountingFees(executor: Pick<typeof db, 'select'|'update'|'insert'>,
  partnerId:string, connectionId:string):Promise<void>{
  const rows=await executor.select({id:invoiceStripePayments.id,invoiceId:invoices.id,orgId:invoices.orgId})
    .from(invoiceStripePayments).innerJoin(invoices,eq(invoices.id,invoiceStripePayments.invoiceId))
    .where(and(eq(invoices.partnerId,partnerId),sql`${invoiceStripePayments.feeAccountingJournal} @> ${JSON.stringify([{connectionId}])}::jsonb`));
  for(const ref of rows){
    await executor.select({id:invoices.id}).from(invoices).where(eq(invoices.id,ref.invoiceId)).for('update');
    const [row]=await executor.select().from(invoiceStripePayments).where(eq(invoiceStripePayments.id,ref.id)).for('update');
    if(!row)continue;
    const journal=structuredClone(row.feeAccountingJournal) as AccountingFeeJournalEntry[];
    if(journal.some(e=>e.state==='abandoned'))continue;
    const message='Processing fee bookkeeping was abandoned when the original accounting connection was disconnected. Review the original accounting company.';
    // The terminal marker also prevents a later reversal from moving old cash
    // into a newly connected company. Existing posted entries remain intact.
    const first=journal[0];if(!first)continue;
    const unfinished=journal.some(e=>e.state!=='posted');
    for(const entry of journal)if(entry.state!=='posted'){
      entry.state='abandoned';entry.leaseToken=null;entry.leaseUntil=null;entry.error=message;
    }
    if(!unfinished)journal.push({...first,payload:{...first.payload,amount:'0.00'},state:'abandoned',
      remoteId:null,leaseToken:null,leaseUntil:null,error:message});
    await executor.update(invoiceStripePayments).set({feeAccountingJournal:journal,feeAccountingError:message}).where(eq(invoiceStripePayments.id,row.id));
    await enqueueAutopayStaffNotifications(executor as typeof db,{orgId:ref.orgId,partnerId,partnerOnly:true,
      event:'autopay.needs_attention',dedupeKey:`accounting_fee:${row.id}:abandoned`,message});
  }
}
