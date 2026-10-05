import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {and,eq,gt,inArray,isNull,sql} from 'drizzle-orm';
import {db as database,runAfterDbContextExit,withSystemDbAccessContext} from '../../db';
import {organizations,partners,orgAutopayEnrollments,orgPaymentMethods,invoiceAutopaySchedules,invoiceCollectionAttempts,invoices,stripeConnectAccounts,billingNoticeOutbox,billingLinkTokens} from '../../db/schema';
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
import {lifecycleTransitionAt} from './lifecycleNoticeValidation';
import type {AutopayNoticeContext} from './enrollmentNotices';
import type { Tx } from './types';
import { RESERVING_COLLECTION_ATTEMPT_STATES, autopayScheduleSummary, formatPaymentMethod, formatPercentBps, paymentMethodInSentence, type AutopayPaymentMethodType } from '@breeze/shared';
import { clientNameFor, emailMoney } from './billingEmail';
import {announcedCharges,announcedOn,type AnnouncedCharge} from './announcedCharges';
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
  links.push({number:invoice.invoiceNumber??invoice.id,amount:emailMoney(invoice.balance,invoice.currencyCode),currency:invoice.currencyCode,url:buildPublicInvoiceUrl(link.token)});
 }
 return links;
}
/** {{open_invoices_text}} for partner templates that still use it; the locked list carries the links. */
function openInvoicesText(links:{number:string}[]):string{
 return links.length===0?'You have no open invoices right now.':`You have ${links.length} open ${links.length===1?'invoice':'invoices'}; the links are below.`;
}
type Disclosure=Awaited<ReturnType<typeof buildAutopayDisclosure>>;
/** One short fee line per method for a facts table ("$1.00 per payment", "up to 3% per payment"). */
function feeRows(disclosures:{type:AutopayPaymentMethodType;disclosure:Disclosure}[]):{label:string;value:string}[]{
 return disclosures.flatMap(({type,disclosure})=>{
  const terms=disclosure.feeTerms;
  if(!terms)return [{label:disclosures.length>1?(type==='card'?'Card fee':'Bank account fee'):'Processing fee',value:disclosure.feeText}];
  if(type==='us_bank_account'){
   const fee=Number(terms.achFeeAmount)>0?`${emailMoney(terms.achFeeAmount,terms.currency)} per payment`:'No fee';
   return [{label:disclosures.length>1?'Bank account fee':'Processing fee',value:fee}];
  }
  if(terms.cardFeeBps>0)return [{label:disclosures.length>1?'Credit card fee':'Processing fee',value:`Up to ${formatPercentBps(terms.cardFeeBps)} per payment`},
   {label:'Debit or prepaid card',value:'No fee'}];
  return [{label:disclosures.length>1?'Card fee':'Processing fee',value:'No fee'}];
 });
}
/** The "How it works" facts of a request or resume. */
function termsSummary(disclosures:{type:AutopayPaymentMethodType;disclosure:Disclosure}[]):{label:string;value:string}[]{
 const first=disclosures[0]?.disclosure;
 if(!first)return [];
 const cap=first.scheduleTerms?.cap;
 return [{label:"When you're charged",value:first.scheduleTerms?autopayScheduleSummary(first.scheduleTerms):first.scheduleText},...feeRows(disclosures),
  {label:'Which invoices',value:`Invoices issued after you set this up${cap?.enabled?`, up to ${emailMoney(cap.amount,cap.currency)} each`:''}`},
  {label:'Before each payment',value:'We email you the amount and date'}];
}
/** terms: which schedule and fee terms the email restates. A request offers every
 * available method; a resume restates the client's own method; pause and stop restate
 * none (P-19: they repeated bank fee terms to card clients). */
async function notice(db:Tx,enrollment:typeof orgAutopayEnrollments.$inferSelect,kind:'autopay_request'|'autopay_stopped'|'autopay_paused'|'autopay_resumed',recipient:string,vars:Record<string,string>,url?:string,openInvoices?:AutopayNoticeContext['openInvoices'],processingText?:string,dedupeKey?:string,
 terms:'all'|'none'|AutopayPaymentMethodType='all',extra:Pick<AutopayNoticeContext,'variant'|'notes'>&{methodLabel?:string}={}){
 const [org]=await db.select().from(organizations).where(eq(organizations.id,enrollment.orgId)).limit(1);
 const [partner]=await db.select().from(partners).where(eq(partners.id,enrollment.partnerId)).limit(1);
 if(!org||!partner)throw new Error('Autopay notice tenant disappeared');
 const disclosures:{type:AutopayPaymentMethodType;disclosure:Disclosure}[]=[];
 if(terms==='all'){
  const card=await buildAutopayDisclosure(db,org.id,'card');
  if(card.achMode!=='card_only')disclosures.push({type:'us_bank_account',disclosure:await buildAutopayDisclosure(db,org.id,'us_bank_account')});
  if(card.achMode!=='ach_only')disclosures.push({type:'card',disclosure:card});
 }else if(terms!=='none')disclosures.push({type:terms,disclosure:await buildAutopayDisclosure(db,org.id,terms)});
 const scheduleText=disclosures[0]?.disclosure.scheduleText??'';
 const feeText=disclosures.map(({disclosure})=>disclosure.feeText).join(' ');
 // Q5: a request has nothing to stop yet, so it carries no stop link.
 let stopUrl:string|undefined;
 if(enrollment.status!=='cancelled'&&kind!=='autopay_request'){
  const stopToken=await mintBillingLinkToken(db,{orgId:org.id,purpose:'stop_autopay',enrollmentId:enrollment.id,generation:enrollment.generation,ttlDays:30});
  stopUrl=buildBillingLinkUrl('stop_autopay',stopToken.token);
 }
 const notes=[...(extra.notes??[]),...(kind==='autopay_request'?['This link works for 30 days.']:[]),
  ...(kind==='autopay_stopped'&&extra.variant!=='request_withdrawn'?[`To turn automatic payments back on, ask ${partner.name} to send you a new setup link.`]:[])];
 const rendered=await renderBillingNotice(kind,{autopay:{partnerId:partner.id,orgId:org.id,variant:extra.variant,
  vars:{partner_name:partner.name,org_name:org.name,client_name:clientNameFor(org.billingContact,org.name),...vars},ctaUrl:url,scheduleText,feeText,stopUrl,
  openInvoices:kind==='autopay_request'||kind==='autopay_resumed'?undefined:openInvoices??[],processingText,
  summary:kind==='autopay_resumed'&&extra.methodLabel?[{label:'Payment method',value:extra.methodLabel},...termsSummary(disclosures).slice(0,-2)]
   :kind==='autopay_request'?termsSummary(disclosures):undefined,
  notes:notes.length?notes:undefined}},db);
 // Pause/resume/stop emails are revalidated at dispatch against this transition.
 if(kind!=='autopay_request')rendered.frozen={...rendered.frozen,transitionAt:lifecycleTransitionAt(kind,enrollment)};
 await enqueueBillingNotice(db,{orgId:org.id,partnerId:partner.id,enrollmentId:enrollment.id,kind,
  seq:enrollment.generation,dedupeKey:dedupeKey??`${enrollment.id}:${kind}:${enrollment.generation}:${enrollment.cancelledAt?.toISOString()??enrollment.pausedAt?.toISOString()??(kind==='autopay_resumed'?enrollment.effectiveFrom?.toISOString():'request')}`,
  toEmail:recipient,rendered});
}
/** D-19: one line per invoice whose charge was announced and is now cancelled. Payments
 * already in flight are excluded: the pending-payment lines speak for those. */
function announcedChargeLines(announced:AnnouncedCharge[],inFlight:string[],paused:boolean):string{
 return announced.filter(charge=>!inFlight.includes(charge.invoiceNumber)&&!inFlight.includes(charge.invoiceId))
  .map(charge=>`Invoice ${charge.invoiceNumber}: the automatic payment announced${announcedOn(charge)} will not happen${paused?', even if automatic payments resume':''}. Please pay it using its invoice link.`)
  .join('\n');
}
/** What the client will be asked to save. */
function achModeText(achMode:'ach_preferred'|'ach_only'|'card_only'):string{
 return achMode==='ach_only'?"You'll connect a US bank account.":achMode==='card_only'?"You'll save a card.":'You can use a US bank account or a card.';
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
   // Bind each notice to its own token. Historical notices must not prevent
   // recovery after expiry, consumption, revocation or terminal delivery failure.
   // The org/enrollment locks serialize this check with concurrent requests.
   const [queued]=await db.select({id:billingNoticeOutbox.id}).from(billingNoticeOutbox)
    .innerJoin(billingLinkTokens,eq(billingNoticeOutbox.dedupeKey,sql`${dedupeKey + ':'} || ${billingLinkTokens.id}::text`))
    .where(and(eq(billingNoticeOutbox.orgId,orgId),eq(billingNoticeOutbox.enrollmentId,existing!.id),
     eq(billingNoticeOutbox.kind,'autopay_request'),inArray(billingNoticeOutbox.status,['pending','sending','sent']),
     eq(billingLinkTokens.orgId,orgId),eq(billingLinkTokens.enrollmentId,existing!.id),
     eq(billingLinkTokens.generation,existing!.generation),eq(billingLinkTokens.purpose,'enroll'),
     gt(billingLinkTokens.expiresAt,new Date()),isNull(billingLinkTokens.consumedAt),isNull(billingLinkTokens.revokedAt))).limit(1);
   if(!queued){
    const token=await mintBillingLinkToken(db,{orgId,purpose:'enroll',enrollmentId:existing!.id,generation:existing!.generation,ttlDays:30});
    const url=buildBillingLinkUrl('enroll',token.token);
    await notice(db,existing!,'autopay_request',recipient,{setup_link:url,ach_mode_text:achModeText(card.achMode)},url,undefined,
     'Your automatic payments continue at the processing fee you already accepted until you review and accept the updated terms.',`${dedupeKey}:${token.id}`);
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
  const url=buildBillingLinkUrl('enroll',token.token);
  // The disclosure's achMode knows card-only (non-USD or non-US account); the setting alone does not (D-10).
  const achMode=(await buildAutopayDisclosure(db,orgId,'card')).achMode;
  await notice(db,enrollment!,'autopay_request',recipient,{setup_link:url,ach_mode_text:achModeText(achMode)},url);
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
 // Read before cancelling: these schedules' charges were already announced to the client.
 const announced=await announcedCharges(db,{orgId,states:NON_TERMINAL_SCHEDULE_STATES});
 // An invoice a payment still holds may yet be charged: it is never told "will not happen".
 const inFlight=(await db.select({invoiceId:invoiceCollectionAttempts.invoiceId}).from(invoiceCollectionAttempts)
  .where(and(eq(invoiceCollectionAttempts.orgId,orgId),inArray(invoiceCollectionAttempts.state,[...RESERVING_COLLECTION_ATTEMPT_STATES]))))
  .map(row=>row.invoiceId);
 await db.update(invoiceAutopaySchedules).set({state:'cancelled',stateReason:'paused_by_msp'})
  .where(and(eq(invoiceAutopaySchedules.orgId,orgId),inArray(invoiceAutopaySchedules.state,[...NON_TERMINAL_SCHEDULE_STATES])));
 await db.update(autopaySetupAttempts).set({outcome:'stale_generation',completedAt:new Date()}).where(and(eq(autopaySetupAttempts.enrollmentId,enrollment.id),eq(autopaySetupAttempts.generation,enrollment.generation),isNull(autopaySetupAttempts.completedAt),sql`${autopaySetupAttempts.outcome} IS DISTINCT FROM 'pending_verification'`));
 const links=await openInvoiceLinks(db,orgId);
 const recipient=enrollment.requestRecipientEmail??contact(org.billingContact);
 if(recipient)await notice(db,updated!,'autopay_paused',recipient,{stopped_by:'Your service provider',open_invoices_text:openInvoicesText(links)},undefined,links,
  [announcedChargeLines(announced,inFlight,true),inFlight.length?'A payment that had already started may still complete.':''].filter(Boolean).join('\n'),undefined,'none');
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
 if(recipient){
  const label=formatPaymentMethod(method);
  await notice(db,updated!,'autopay_resumed',recipient,{payment_method:paymentMethodInSentence(label)},undefined,undefined,undefined,undefined,method.type,{methodLabel:label});
 }
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
 // Read before cancelling: these schedules' charges were already announced to the client.
 const announced=await announcedCharges(db,{enrollmentId:enrollment.id,states:NON_TERMINAL_SCHEDULE_STATES});
 const pendingInvoices=await stopEnrollmentSchedules(db,enrollment.id);
 const removed=await db.update(orgPaymentMethods).set({status:'removed',isAutopayMethod:false,removedAt:new Date()})
  .where(and(eq(orgPaymentMethods.orgId,orgId),eq(orgPaymentMethods.isAutopayMethod,true),inArray(orgPaymentMethods.status,['active','pending_verification','unusable']))).returning();
 await revokeBillingLinkTokens(db,{orgId,enrollmentId:enrollment.id});
 const links=await openInvoiceLinks(db,orgId);
 const recipient=enrollment.requestRecipientEmail??contact(org.billingContact);
 // Who stopped it, and whether there was ever anything set up to stop.
 const variant=enrollment.status==='requested'&&!removed.length?'request_withdrawn':source==='msp'?'msp':undefined;
 if(recipient)await notice(db,updated!,'autopay_stopped',recipient,{stopped_by:source==='client'?'You':'Your service provider',open_invoices_text:openInvoicesText(links)},undefined,links,
  [...pendingInvoices.processing.map(number=>`A payment for invoice ${number} is already processing and will complete; you'll get a receipt.`),
   ...pendingInvoices.cancelling.map(number=>`A payment already in progress for invoice ${number} is being cancelled. A receipt will follow if it had already completed.`),
   // D-19 lines never name an invoice a payment still holds: those lines above speak for it.
   announcedChargeLines(announced,[...pendingInvoices.processing,...pendingInvoices.cancelling],false)].filter(Boolean).join('\n'),undefined,'none',{variant});
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
