import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {and,eq,inArray,isNull,sql} from 'drizzle-orm';
import {db as database,runAfterDbContextExit,withSystemDbAccessContext} from '../../db';
import {organizations,partners,orgAutopayEnrollments,orgPaymentMethods,invoiceAutopaySchedules,invoices,stripeConnectAccounts,billingNoticeOutbox} from '../../db/schema';
import {InvoiceServiceError,type InvoiceActor} from '../invoiceTypes';
import {requireOrgAccess} from '../invoiceService';
import {isHiddenOrgType} from '../unassignedPool/visibility';
import {autopaySetupAttempts} from '../../db/schema/autopaySetupAttempts';
import {getOrMintInvoiceLink,buildPublicInvoiceUrl} from '../invoiceLinkToken';
import {isAutopayEnabledForPartner} from './autopayGate';
import {getAutopayStripeReadiness} from './stripeCapabilities';
import {resolveBillingPaymentSettings} from './billingPaymentSettings';
import {mintBillingLinkToken,revokeBillingLinkTokens,buildBillingLinkUrl,resolveBillingLinkToken} from './linkTokens';
import {enqueueBillingNotice} from './noticeOutbox';
import {renderBillingNotice} from './renderBillingNotice';
import {lockInvoicesForEnrollmentStop,stopEnrollmentSchedules} from './collectionControl';
import {getAutopayMethod,detachPaymentMethodPostCommit} from './paymentMethods';
import {enqueueAutopayStaffNotifications,sendAutopayStaffEmail,type AutopayStaffNotice} from './staffNotifications';
import {buildAutopayDisclosure} from './consentText';
import type {AutopayNoticeContext} from './enrollmentNotices';
import type { Tx } from './types';
export const NON_TERMINAL_SCHEDULE_STATES=['awaiting_notice','scheduled','collecting','retry_scheduled','action_required'] as const;
export function nextEnrollmentRequest(row:{status:string;generation:number}|null):number|null{
 return row&&['active','paused'].includes(row.status)?null:(row?.generation??0)+1;
}
async function lockOrg(db:Tx,orgId:string,actor?:InvoiceActor,lock:'update'|'no key update'='update'){
 if(actor){
  if(!actor.partnerId)throw new InvoiceServiceError('Organization not found',404,'ORG_NOT_FOUND');
  requireOrgAccess(actor,orgId);
 }
 const [org]=await db.select().from(organizations).where(and(eq(organizations.id,orgId),
  actor?eq(organizations.partnerId,actor.partnerId!):undefined)).limit(1).for(lock);
 if(!org)throw new InvoiceServiceError('Organization not found',404,'ORG_NOT_FOUND');
 if(org.deletedAt||!['active','trial'].includes(org.status)||isHiddenOrgType(org.type))
  throw new InvoiceServiceError('Organization is not available for automatic payments',409,'INVALID_STATE');
 return org;
}
async function lockEnrollment(db:Tx,orgId:string){
 const [row]=await db.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.orgId,orgId)).limit(1).for('update');
 if(!row)throw new InvoiceServiceError('Automatic payments have not been requested',409,'INVALID_STATE');
 return row;
}
function contact(value:unknown):string|null{
 if(!value||typeof value!=='object')return null;
 const email=(value as {email?:unknown}).email;
 return typeof email==='string'&&email.trim()?email.trim():null;
}
// These helpers use the caller's executor, including raw transactions.
async function openInvoiceLinks(db:Tx,orgId:string):Promise<NonNullable<AutopayNoticeContext['openInvoices']>>{
 const open=await db.select().from(invoices).where(and(eq(invoices.orgId,orgId),inArray(invoices.status,['sent','partially_paid','overdue']),sql`${invoices.balance}>0`));
 const links:NonNullable<AutopayNoticeContext['openInvoices']>=[];
 for(const invoice of open){
  const link=await getOrMintInvoiceLink(invoice,db);
  links.push({number:invoice.invoiceNumber??invoice.id,amount:invoice.balance,currency:invoice.currencyCode,url:buildPublicInvoiceUrl(link.token)});
 }
 return links;
}
async function notice(db:Tx,enrollment:typeof orgAutopayEnrollments.$inferSelect,kind:'autopay_request'|'autopay_stopped'|'autopay_paused'|'autopay_resumed',recipient:string,vars:Record<string,string>,url?:string,openInvoices?:AutopayNoticeContext['openInvoices'],processingText?:string,dedupeKey?:string){
 const [org]=await db.select().from(organizations).where(eq(organizations.id,enrollment.orgId)).limit(1);
 const [partner]=await db.select().from(partners).where(eq(partners.id,enrollment.partnerId)).limit(1);
 if(!org||!partner)throw new Error('Autopay notice tenant disappeared');
 const card=await buildAutopayDisclosure(db,org.id,'card');
 const disclosures=card.achMode==='ach_only'?[]:[{label:'Card',disclosure:card}];
 if(card.achMode!=='card_only')disclosures.push({label:'Bank account (ACH)',disclosure:await buildAutopayDisclosure(db,org.id,'us_bank_account')});
 const scheduleText=disclosures[0]!.disclosure.scheduleText;
 const feeText=disclosures.map(({label,disclosure})=>`${label}: ${disclosure.feeText}`).join(' ');
 let stopUrl:string|undefined;
 if(enrollment.status!=='cancelled'){
  const stopToken=await mintBillingLinkToken(db,{orgId:org.id,purpose:'stop_autopay',enrollmentId:enrollment.id,generation:enrollment.generation,ttlDays:30});
  stopUrl=buildBillingLinkUrl('stop_autopay',stopToken.token);
 }
 const rendered=await renderBillingNotice(kind,{autopay:{partnerId:partner.id,orgId:org.id,
  vars:{partner_name:partner.name,org_name:org.name,client_name:org.name,...vars},ctaUrl:url,scheduleText,feeText,stopUrl,openInvoices,processingText}},db);
 await enqueueBillingNotice(db,{orgId:org.id,partnerId:partner.id,enrollmentId:enrollment.id,kind,
  seq:enrollment.generation,dedupeKey:dedupeKey??`${enrollment.id}:${kind}:${enrollment.generation}:${enrollment.cancelledAt?.toISOString()??enrollment.pausedAt?.toISOString()??(kind==='autopay_resumed'?enrollment.effectiveFrom?.toISOString():'request')}`,
  toEmail:recipient,rendered});
}
export async function requestAutopay(db:Tx,actor:InvoiceActor,input:{orgIds:string[];recipientOverride?:string;mode?:'request'|'reauthorize'}):Promise<{requested:string[];skipped:{orgId:string;reason:'no_billing_contact'|'already_active'|'stripe_not_ready'}[]}>{
 const result:{requested:string[];skipped:{orgId:string;reason:'no_billing_contact'|'already_active'|'stripe_not_ready'}[]}={requested:[],skipped:[]};
 for(const orgId of [...new Set(input.orgIds)].sort()){
  const org=await lockOrg(db,orgId,actor);
  if(!await isAutopayEnabledForPartner(db,org.partnerId))throw new InvoiceServiceError('Automatic payments unavailable',404,'INVALID_STATE');
  const [existing]=await db.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.orgId,orgId)).limit(1).for('update');
  const generation=nextEnrollmentRequest(existing??null);
  if(generation===null&&input.mode!=='reauthorize'){result.skipped.push({orgId,reason:'already_active'});continue;}
  const recipient=input.recipientOverride??contact(org.billingContact);
  if(!recipient){result.skipped.push({orgId,reason:'no_billing_contact'});continue;}
  const readiness=await getAutopayStripeReadiness(db,org.partnerId);
  const [connection]=await db.select().from(stripeConnectAccounts).where(and(eq(stripeConnectAccounts.partnerId,org.partnerId),eq(stripeConnectAccounts.status,'connected'))).limit(1).for('share');
  if(!readiness.ready||!connection){result.skipped.push({orgId,reason:'stripe_not_ready'});continue;}
  if(generation===null){
   if(existing!.stripeConnectionId!==connection.id||existing!.stripeAccountId!==connection.stripeAccountId){
    result.skipped.push({orgId,reason:'stripe_not_ready'});continue;
   }
   const card=await buildAutopayDisclosure(db,orgId,'card');
   const bank=card.achMode==='card_only'?null:await buildAutopayDisclosure(db,orgId,'us_bank_account');
   const termsHash=createHash('sha256').update(JSON.stringify([card.feeTerms,bank?.feeTerms])).digest('hex');
   const dedupeKey=`${existing!.id}:reauthorize:${existing!.generation}:${existing!.pausedAt?.toISOString()??'active'}:${termsHash}`;
   const [queued]=await db.select({id:billingNoticeOutbox.id}).from(billingNoticeOutbox)
    .where(and(eq(billingNoticeOutbox.orgId,orgId),eq(billingNoticeOutbox.dedupeKey,dedupeKey))).limit(1);
   if(!queued){
    const token=await mintBillingLinkToken(db,{orgId,purpose:'enroll',enrollmentId:existing!.id,generation:existing!.generation,ttlDays:30});
    const url=buildBillingLinkUrl('enroll',token.token);
    await notice(db,existing!,'autopay_request',recipient,{setup_link:url,
     ach_mode_text:card.achMode==='ach_only'?'Use a US bank account.':'Choose a bank account or card.'},url,undefined,
     'Your service provider has updated its processing fee terms; your current authorization stays in place at the previously accepted fee until you review and accept the new terms',dedupeKey);
   }
   result.requested.push(orgId);continue;
  }
  const values={status:'requested' as const,generation,stripeConnectionId:connection.id,stripeAccountId:connection.stripeAccountId,
   stripeCustomerId:existing?.stripeAccountId===connection.stripeAccountId?existing.stripeCustomerId:null,
   effectiveFrom:null,requestedBy:actor.userId,requestedAt:new Date(),requestRecipientEmail:recipient,
   pausedBy:null,pausedAt:null,cancelledAt:null,cancelSource:null,cancelReason:null,needsAttentionReason:null};
  const [enrollment]=existing?await db.update(orgAutopayEnrollments).set(values).where(eq(orgAutopayEnrollments.id,existing.id)).returning():
   await db.insert(orgAutopayEnrollments).values({orgId,partnerId:org.partnerId,...values}).returning();
  await revokeBillingLinkTokens(db,{orgId,enrollmentId:enrollment!.id});
  const token=await mintBillingLinkToken(db,{orgId,purpose:'enroll',enrollmentId:enrollment!.id,generation,ttlDays:30});
  const settings=await resolveBillingPaymentSettings(db,{partnerId:org.partnerId,orgId});
  const url=buildBillingLinkUrl('enroll',token.token);
  await notice(db,enrollment!,'autopay_request',recipient,{setup_link:url,ach_mode_text:settings.achMode.value==='ach_only'?'Use a US bank account.':'Choose a bank account or card.'},url);
  result.requested.push(orgId);
 }
 return result;
}
export async function pauseAutopay(db:Tx,actor:InvoiceActor,orgId:string):Promise<void>{
 const org=await lockOrg(db,orgId,actor);const enrollment=await lockEnrollment(db,orgId);
 if(enrollment.status==='paused')return;
 if(enrollment.status!=='active')throw new InvoiceServiceError('Only active automatic payments can be paused',409,'INVALID_STATE');
 const [updated]=await db.update(orgAutopayEnrollments).set({status:'paused',pausedBy:actor.userId,pausedAt:new Date()})
  .where(eq(orgAutopayEnrollments.id,enrollment.id)).returning();
 await db.update(invoiceAutopaySchedules).set({state:'cancelled',stateReason:'paused_by_msp'})
  .where(and(eq(invoiceAutopaySchedules.orgId,orgId),inArray(invoiceAutopaySchedules.state,[...NON_TERMINAL_SCHEDULE_STATES])));
 await db.update(autopaySetupAttempts).set({outcome:'stale_generation',completedAt:new Date()}).where(and(eq(autopaySetupAttempts.enrollmentId,enrollment.id),eq(autopaySetupAttempts.generation,enrollment.generation),isNull(autopaySetupAttempts.completedAt),sql`${autopaySetupAttempts.outcome} IS DISTINCT FROM 'pending_verification'`));
 const links=await openInvoiceLinks(db,orgId);
 const recipient=enrollment.requestRecipientEmail??contact(org.billingContact);
 if(recipient)await notice(db,updated!,'autopay_paused',recipient,{stopped_by:'Your service provider',open_invoices_text:'Existing invoices remain payable using their payment links.'},undefined,links);
}
export async function resumeAutopay(db:Tx,actor:InvoiceActor,orgId:string):Promise<void>{
 const org=await lockOrg(db,orgId,actor);const enrollment=await lockEnrollment(db,orgId);
 if(enrollment.status==='active')return;
 const method=await getAutopayMethod(db,orgId);
 if(enrollment.status!=='paused'||method?.status!=='active'||enrollment.needsAttentionReason)
  throw new InvoiceServiceError('Update the payment method before resuming',409,'INVALID_STATE');
 if(!await isAutopayEnabledForPartner(db,enrollment.partnerId)||!(await getAutopayStripeReadiness(db,enrollment.partnerId)).ready)
  throw new InvoiceServiceError('Stripe is not ready for automatic payments',409,'INVALID_STATE');
 const [updated]=await db.update(orgAutopayEnrollments).set({status:'active',effectiveFrom:new Date(),pausedBy:null,pausedAt:null})
  .where(eq(orgAutopayEnrollments.id,enrollment.id)).returning();
 const recipient=enrollment.requestRecipientEmail??contact(org.billingContact);
 if(recipient)await notice(db,updated!,'autopay_resumed',recipient,{});
}
const clientStopToken=new AsyncLocalStorage<string>();
/** Internal route orchestration only; deliberately not exported by the C4 facade. */
export function withAutopayStopToken<T>(token:string,fn:()=>Promise<T>):Promise<T>{
 return clientStopToken.run(token,fn);
}
async function validateClientStop(db:Tx,enrollment:typeof orgAutopayEnrollments.$inferSelect):Promise<void>{
 const token=clientStopToken.getStore();
 const link=token?await resolveBillingLinkToken(db,token,'stop_autopay'):null;
 if(!link||link.orgId!==enrollment.orgId||link.enrollmentId!==enrollment.id||link.generation!==enrollment.generation)
  throw new InvoiceServiceError('Invalid or expired automatic payment link',409,'INVALID_STATE');
}
async function stop(db:Tx,orgId:string,source:'client'|'msp',actor?:InvoiceActor,verifyLink=false):Promise<void>{
 // Serialize lifecycle changes without blocking a reserving transaction's org FK check.
 const org=await lockOrg(db,orgId,actor,'no key update');
 await lockInvoicesForEnrollmentStop(db,orgId);
 const enrollment=await lockEnrollment(db,orgId);
 if(verifyLink)await validateClientStop(db,enrollment);
 if(enrollment.status==='cancelled')return;
 const [updated]=await db.update(orgAutopayEnrollments).set({status:'cancelled',cancelledAt:new Date(),cancelSource:source,cancelReason:'autopay_stopped'})
  .where(eq(orgAutopayEnrollments.id,enrollment.id)).returning();
 const pendingInvoices=await stopEnrollmentSchedules(db,enrollment.id);
 const removed=await db.update(orgPaymentMethods).set({status:'removed',isAutopayMethod:false,removedAt:new Date()})
  .where(and(eq(orgPaymentMethods.orgId,orgId),eq(orgPaymentMethods.isAutopayMethod,true),inArray(orgPaymentMethods.status,['active','pending_verification','unusable']))).returning();
 await revokeBillingLinkTokens(db,{orgId,enrollmentId:enrollment.id});
 const links=await openInvoiceLinks(db,orgId);
 const lines=links.map(link=>`${link.number}: ${link.currency} ${link.amount} — ${link.url}`);
 const recipient=enrollment.requestRecipientEmail??contact(org.billingContact);
 if(recipient)await notice(db,updated!,'autopay_stopped',recipient,{stopped_by:source==='client'?'You':'Your service provider',open_invoices_text:lines.join('\n')||'There are no open invoices.'},undefined,links,
  pendingInvoices.map(number=>`A payment already in progress for invoice ${number} is being cancelled. A receipt will follow if it had already completed.`).join('\n'));
 const staffNotice:AutopayStaffNotice={orgId,partnerId:enrollment.partnerId,event:'autopay.stopped',
  dedupeKey:`${enrollment.id}:stopped:${enrollment.generation}`,message:`Automatic payments stopped for ${org.name}.`};
 await enqueueAutopayStaffNotifications(db,staffNotice);
 for(const method of removed)runAfterDbContextExit('autopay.detach',()=>detachPaymentMethodPostCommit(enrollment.partnerId,method.id));
 runAfterDbContextExit('autopay.stopped',async()=>{
  const [committed]=await withSystemDbAccessContext(()=>database.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.id,enrollment.id)).limit(1));
  if(committed?.status==='cancelled'&&committed.generation===enrollment.generation)await sendAutopayStaffEmail(staffNotice);
 });
}
export async function turnOffAutopay(db:Tx,actor:InvoiceActor,orgId:string):Promise<void>{await stop(db,orgId,'msp',actor);}
export async function stopAutopayByClient(db:Tx,input:{orgId:string;source:'link'|'portal';portalUserId?:string}):Promise<void>{await stop(db,input.orgId,'client',undefined,input.source==='link');}
