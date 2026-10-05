import type Stripe from 'stripe';
import {autopayScheduleSummary,formatPercentBps,paymentMethodInSentence,type CardFundingType} from '@breeze/shared';
import {clientNameFor,emailDate,emailMoney} from './billingEmail';
import {formatStripePaymentMethod} from './methodLabel';
import {and,desc,eq,inArray,ne,sql} from 'drizzle-orm';
import {db,withSystemDbAccessContext,runOutsideDbContext,runAfterDbContextExit} from '../../db';
import {organizations,stripeConnectAccounts,orgAutopayEnrollments,orgPaymentMethods,orgAutopayConsents,billingLinkTokens} from '../../db/schema';
import {autopaySetupAttempts} from '../../db/schema/autopaySetupAttempts';
import {getPartnerStripeClient} from '../partnerStripe';
import {assertNoHeldDbContextForStripe} from '../stripeSettle';
import {enqueueBillingNotice} from './noticeOutbox';
import {renderBillingNotice} from './renderBillingNotice';
import {verifiedFeeText,hasSupportedCardEvidence} from './feeDisclosure';
import {mintBillingLinkToken,buildBillingLinkUrl} from './linkTokens';
import {detachPaymentMethodPostCommit,enqueueRejectedAutopayMethod} from './paymentMethods';
import {resolveBillingEmail} from '../invoicePdf';
import {getOrMintInvoiceLink,buildPublicInvoiceUrl} from '../invoiceLinkToken';
import {invoices,invoiceAutopaySchedules} from '../../db/schema';
import {DEFERRAL_END_REASONS} from './notChargedNotice';
import {formatPaymentMethod} from '@breeze/shared';
import {notifyAutopayStaff} from './staffNotifications';
import {autopayConsentSnapshotSchema} from './types';
import type {AutopayEnrollmentStatus,AutopaySetupOutcome as Outcome} from '@breeze/shared';
export function setupAuthorityOutcome(enrollment:{status:AutopayEnrollmentStatus;generation:number},generation:number,newest:boolean):'stale_generation'|null{
 return enrollment.generation!==generation||(enrollment.status!=='requested'&&enrollment.status!=='active')||!newest?'stale_generation':null;
}
export function setupIntentOutcome(intent:{status:string;next_action:{type:string}|null;last_setup_error?:unknown}):Outcome{
 if(intent.status==='succeeded')return 'activated';
 if(intent.status==='requires_action'&&intent.next_action?.type==='verify_with_microdeposits')return 'pending_verification';
 if(intent.status==='canceled'||intent.status==='setup_failed'||intent.status==='requires_payment_method'&&intent.last_setup_error)return 'failed';
 return 'in_progress';
}
function id(value:string|{id:string}|null|undefined):string|null{return typeof value==='string'?value:value?.id??null;}
function cardFunding(value:string):CardFundingType{
 return value==='credit'||value==='debit'||value==='prepaid'?value:'unknown';
}

/** FP-10: billing email goes to the billing contact (spec: recipient = billing contact); the
 * person who accepted the authorization (a portal user, or a link's recipient) also gets it. */
function enrollmentRecipients(billingContact:unknown,authorizer:string):{email:string;suffix:string}[]{
 const contact=resolveBillingEmail(billingContact as never);
 const out=[{email:contact||authorizer,suffix:''}];
 if(contact&&authorizer&&contact.toLowerCase()!==authorizer.toLowerCase())out.push({email:authorizer,suffix:':authorizer'});
 return out.filter(r=>!!r.email);
}
// Internal shared persistence for setup and pay-and-save; not part of the public facade.
export async function persistCapturedAutopayMethod(attemptId:string,method:Stripe.PaymentMethod|null,outcome:Outcome,setupIntentId:string|null,mandateId:string|null):Promise<{outcome:Outcome;orgId:string}>{
 return withSystemDbAccessContext(async()=>{
  const [initial]=await db.select().from(autopaySetupAttempts).where(eq(autopaySetupAttempts.id,attemptId)).limit(1);
  if(!initial)throw new Error('Unknown autopay setup');
  const [org]=await db.select().from(organizations).where(eq(organizations.id,initial.orgId)).limit(1).for('update');
  const [enrollment]=await db.select().from(orgAutopayEnrollments).where(eq(orgAutopayEnrollments.id,initial.enrollmentId)).limit(1).for('update');
  // A competing completion can commit while we wait for the authority locks.
  // Re-read its outcome here so consent, stop tokens and callbacks are created once.
  const [attempt]=await db.select().from(autopaySetupAttempts).where(eq(autopaySetupAttempts.id,attemptId)).limit(1).for('update');
  if(!attempt)throw new Error('Unknown autopay setup');
  const [latest]=await db.select({id:autopaySetupAttempts.id}).from(autopaySetupAttempts)
   .where(and(eq(autopaySetupAttempts.enrollmentId,attempt.enrollmentId),eq(autopaySetupAttempts.generation,attempt.generation)))
   .orderBy(desc(autopaySetupAttempts.ordinal)).limit(1);
  const [connection]=await db.select().from(stripeConnectAccounts).where(and(eq(stripeConnectAccounts.id,attempt.stripeConnectionId),eq(stripeConnectAccounts.status,'connected'))).limit(1).for('share');
  if(attempt.completedAt&&attempt.outcome&&attempt.outcome!=='stale_generation'){
   if(attempt.outcome!=='activated')await enqueueRejectedAutopayMethod(db,attempt,method);
   return {outcome:attempt.outcome,orgId:attempt.orgId};
  }
  if(outcome==='in_progress')return {outcome:attempt.completedAt&&attempt.outcome?attempt.outcome:outcome,orgId:attempt.orgId};
  if(outcome==='abandoned'){
   await db.update(autopaySetupAttempts).set({outcome,completedAt:new Date()}).where(eq(autopaySetupAttempts.id,attempt.id));
   return {outcome,orgId:attempt.orgId};
  }
  const wasPending=attempt.outcome==='pending_verification';
  // A newly accepted update may finish while paused; a capture started before the pause cannot.
  const pausedUpdate=enrollment?.status==='paused'&&!!enrollment.pausedAt&&!!attempt.tokenId&&
   attempt.source==='setup_page'&&attempt.createdAt>enrollment.pausedAt;
  if(!org||org.deletedAt||!['active','trial'].includes(org.status)||!connection||connection.stripeAccountId!==attempt.stripeAccountId||!enrollment||
   ['stripe_account_changed','key_missing_permissions'].includes(enrollment.needsAttentionReason??'')||attempt.outcome==='stale_generation'||setupAuthorityOutcome((wasPending||pausedUpdate)&&enrollment.status==='paused'?{...enrollment,status:'active'}:enrollment,attempt.generation,wasPending||latest?.id===attempt.id)||
   enrollment.stripeAccountId!==attempt.stripeAccountId||enrollment.stripeCustomerId!==attempt.stripeCustomerId||method?.customer!=null&&attempt.stripeCustomerId!==id(method.customer)){
   await db.update(autopaySetupAttempts).set({outcome:'stale_generation',completedAt:new Date()}).where(eq(autopaySetupAttempts.id,attempt.id));
   await enqueueRejectedAutopayMethod(db,attempt,method);
   return {outcome:'stale_generation',orgId:attempt.orgId};
  }
  if((attempt.completedAt&&attempt.outcome==='activated')||(attempt.outcome==='pending_verification'&&outcome==='pending_verification'))return {outcome:attempt.outcome,orgId:attempt.orgId};
  if(outcome==='failed'){
   // Stripe can clear payment_method on failure. Retire and queue the stored
   // pending methods in this transaction, preserving their provider identities.
   const failedMethods=await db.update(orgPaymentMethods).set({status:'unusable',unusableReason:'verification_failed',
    isAutopayMethod:false,removedAt:new Date(),detachStripeAccountId:attempt.stripeAccountId,detachStripeCustomerId:attempt.stripeCustomerId})
    .where(and(eq(orgPaymentMethods.enrollmentId,enrollment.id),eq(orgPaymentMethods.stripeSetupIntentId,setupIntentId??''),eq(orgPaymentMethods.status,'pending_verification'))).returning();
   for(const failed of failedMethods)runAfterDbContextExit('autopay.detachFailedVerification',()=>detachPaymentMethodPostCommit(attempt.partnerId,failed.id));
   const [working]=await db.select().from(orgPaymentMethods).where(and(eq(orgPaymentMethods.enrollmentId,enrollment.id),eq(orgPaymentMethods.isAutopayMethod,true),eq(orgPaymentMethods.status,'active'))).limit(1);
   if(!working)await db.update(orgAutopayEnrollments).set({needsAttentionReason:'verification_failed'}).where(eq(orgAutopayEnrollments.id,enrollment.id));
   await db.update(autopaySetupAttempts).set({outcome:'failed',completedAt:new Date()}).where(eq(autopaySetupAttempts.id,attempt.id));
   // F-1: microdeposits fail days after the client left the page, so the client is told by
   // email, with what still works (the method kept beside it) or how to set up again.
   const failedBank=failedMethods[0];
   if(attempt.outcome==='pending_verification'&&failedBank&&org){
    const snapshot=autopayConsentSnapshotSchema.parse(attempt.consentSnapshot);
    const kept=working?formatPaymentMethod(working):null;
    const again=await mintBillingLinkToken(db,{orgId:attempt.orgId,purpose:'enroll',enrollmentId:enrollment.id,generation:enrollment.generation,ttlDays:30});
    const rendered=await renderBillingNotice('autopay_enrolled',{autopay:{partnerId:attempt.partnerId,orgId:attempt.orgId,variant:'verification_failed',locked:true,
     vars:{partner_name:snapshot.partnerName,org_name:org.name,client_name:clientNameFor(org.billingContact,org.name),
      payment_method:paymentMethodInSentence(formatPaymentMethod(failedBank))},
     processingText:kept?`Your automatic payments continue with your ${paymentMethodInSentence(kept)}.`
      :"Automatic payments aren't set up yet. Nothing will be charged automatically until you set them up again.",
     links:[{label:kept?'Change payment method':'Set up automatic payments',url:buildBillingLinkUrl('enroll',again.token)}]}});
    for(const recipient of enrollmentRecipients(org.billingContact,snapshot.contactEmail)){
     await enqueueBillingNotice(db,{orgId:attempt.orgId,partnerId:attempt.partnerId,enrollmentId:enrollment.id,kind:'autopay_enrolled',seq:attempt.generation,
      dedupeKey:`${attempt.id}:autopay_enrolled:verification_failed${recipient.suffix}`,toEmail:recipient.email,rendered});
    }
   }
   runAfterDbContextExit('autopay.verificationFailed',async()=>{
    const [committed]=await withSystemDbAccessContext(()=>db.select().from(autopaySetupAttempts).where(eq(autopaySetupAttempts.id,attempt.id)).limit(1));
    // A failed change leaves the working method paying: nothing needs attention (Final-V).
    if(committed?.outcome==='failed')await notifyAutopayStaff({orgId:attempt.orgId,partnerId:attempt.partnerId,event:working?'autopay.verification_failed':'autopay.needs_attention',
     dedupeKey:`${attempt.id}:verification_failed`,message:working?'Bank verification failed. Automatic payments continue with the previous payment method.'
      :'Automatic payments need a verified payment method.'});
   });
   if(!failedMethods.some(failed=>failed.stripePaymentMethodId===method?.id))await enqueueRejectedAutopayMethod(db,attempt,method);
   return {outcome,orgId:attempt.orgId};
  }
  if(!method)throw new Error('Completed setup has no payment method');
  if((method.type!=='card'&&method.type!=='us_bank_account')||method.type!==attempt.methodType)throw new Error('Stripe returned the wrong method type');
  // Fail closed before any replacement (#7894): collection admission never charges a card
  // without supported evidence (Link or an unknown wallet/network), so activating one would
  // leave the client believing autopay is on. The working method, consent and tokens stay.
  if(method.type==='card'&&!hasSupportedCardEvidence(method.card??undefined)){
   await db.update(autopaySetupAttempts).set({outcome:'unsupported_method',completedAt:new Date()}).where(eq(autopaySetupAttempts.id,attempt.id));
   await enqueueRejectedAutopayMethod(db,attempt,method);
   return {outcome:'unsupported_method',orgId:attempt.orgId};
  }
  const snapshot=autopayConsentSnapshotSchema.parse(attempt.consentSnapshot);
  const [existing]=await db.select().from(orgPaymentMethods).where(and(eq(orgPaymentMethods.orgId,attempt.orgId),
   eq(orgPaymentMethods.stripePaymentMethodId,method.id))).limit(1);
  // A pending bank may wait unflagged beside a working method (F-1); a retired one is stale.
  if(wasPending&&(!existing||existing.status!=='pending_verification')){
   await db.update(autopaySetupAttempts).set({outcome:'stale_generation',completedAt:new Date()}).where(eq(autopaySetupAttempts.id,attempt.id));
   await enqueueRejectedAutopayMethod(db,attempt,method);
   return {outcome:'stale_generation',orgId:attempt.orgId};
  }
  // F-1: an update to a bank that still needs microdeposit verification must not take away a
  // WORKING method. The working row keeps the one autopay-method flag (a database invariant);
  // the pending bank waits beside it unflagged and is swapped in only when it verifies.
  // Invoice-bound bank payment setups are excluded: their collection needs the new account
  // to be the autopay method (collectAfterBankSetup).
  const mayKeepWorking=outcome==='pending_verification'&&!wasPending&&!snapshot.bankPayment;
  const [working]=mayKeepWorking?await db.select().from(orgPaymentMethods).where(and(eq(orgPaymentMethods.orgId,attempt.orgId),
   eq(orgPaymentMethods.isAutopayMethod,true),eq(orgPaymentMethods.status,'active'))).limit(1):[];
  const keepWorking=mayKeepWorking&&!!working&&working.id!==existing?.id;
  // Retire whatever row is the current autopay method, including a hard-declined one that
  // kept the flag as 'unusable' (D-17); one flagged row per org is a database invariant.
  const replaced=keepWorking?[]:await db.update(orgPaymentMethods).set({isAutopayMethod:false,status:'removed',removedAt:new Date()})
   .where(and(eq(orgPaymentMethods.orgId,attempt.orgId),eq(orgPaymentMethods.isAutopayMethod,true),inArray(orgPaymentMethods.status,['active','pending_verification','unusable']))).returning();
  const holderType=method.us_bank_account?.account_holder_type;
  const values:typeof orgPaymentMethods.$inferInsert={orgId:attempt.orgId,enrollmentId:enrollment.id,stripePaymentMethodId:method.id,type:attempt.methodType,
   cardBrand:method.card?.brand??null,cardLast4:method.card?.last4??null,cardExpMonth:method.card?.exp_month??null,cardExpYear:method.card?.exp_year??null,
   cardFunding:method.card?(method.card.funding==='credit'&&!hasSupportedCardEvidence(method.card)?'unknown':cardFunding(method.card.funding)):null,cardCountry:method.card?.country??null,bankName:method.us_bank_account?.bank_name??null,
   bankLast4:method.us_bank_account?.last4??null,accountHolderType:holderType==='individual'?'individual':holderType==='company'?'company':null,
   stripeMandateId:mandateId,stripeSetupIntentId:setupIntentId,status:outcome==='activated'?'active' as const:'pending_verification' as const,
   isAutopayMethod:!keepWorking,removedAt:null,unusableReason:null};
  const [saved]=existing?await db.update(orgPaymentMethods).set(values).where(eq(orgPaymentMethods.id,existing.id)).returning():
   await db.insert(orgPaymentMethods).values(values).returning();
  // The locked setup attempt is the idempotency key, not the accepted text.
  // A distinct attempt always appends consent, including A → B → A acceptance.
  // Pending bank verification already recorded this attempt's consent;
  // its later activation must not append another authorization.
  if(!wasPending)await db.insert(orgAutopayConsents).values({orgId:attempt.orgId,enrollmentId:enrollment.id,generation:attempt.generation,paymentMethodId:saved!.id,
   consentTextVersion:snapshot.version,consentTextHash:snapshot.textHash,feeTerms:snapshot.feeTerms,scheduleTerms:snapshot.scheduleTerms,
   contactEmail:snapshot.contactEmail,ip:snapshot.ip,userAgent:snapshot.userAgent,source:snapshot.source});
  await db.update(orgAutopayEnrollments).set({status:enrollment.status==='paused'?'paused':'active',effectiveFrom:enrollment.effectiveFrom??new Date(),
   needsAttentionReason:null}).where(eq(orgAutopayEnrollments.id,enrollment.id));
  await db.update(autopaySetupAttempts).set({outcome,completedAt:outcome==='activated'?new Date():null,setupIntentId}).where(eq(autopaySetupAttempts.id,attempt.id));
  if(attempt.tokenId&&!snapshot.bankPayment)await db.update(billingLinkTokens).set({consumedAt:new Date()}).where(eq(billingLinkTokens.id,attempt.tokenId));
  // Re-authorizing a bank payment for the same invoice (a changed total, a spent authority)
  // re-runs setup under the same enrollment generation. When it saved the SAME bank account the
  // client already heard autopay is set up, so nothing new is sent to them or to staff; the new
  // consent is still recorded (B1-5). A different account is a method change and is announced
  // (F7). Same account: the same Stripe method, or the same bank and last four digits on the
  // method it replaced (Financial Connections mints a new PaymentMethod id per link and no
  // fingerprint is stored; a false match only suppresses a courtesy email).
  const sameAccount=method.type==='us_bank_account'&&replaced.some(old=>old.id===saved!.id||(old.type==='us_bank_account'
   &&!!old.bankLast4&&old.bankLast4===method.us_bank_account?.last4&&old.bankName===(method.us_bank_account?.bank_name??null)));
  const [earlierBankPay]=snapshot.bankPayment&&!wasPending&&sameAccount?await db.select({id:autopaySetupAttempts.id}).from(autopaySetupAttempts).where(and(
   eq(autopaySetupAttempts.enrollmentId,enrollment.id),eq(autopaySetupAttempts.generation,attempt.generation),
   eq(autopaySetupAttempts.outcome,'activated'),ne(autopaySetupAttempts.id,attempt.id),
   sql`${autopaySetupAttempts.consentSnapshot}->'bankPayment'->>'invoiceId' = ${snapshot.bankPayment.invoiceId}`)).limit(1):[];
  // The client's confirmation: set up (activated), saved but awaiting bank verification,
  // or verified after microdeposits (D-12: that moment used to pass silently). Nothing for a
  // same-account bank-pay re-authorization (B1-5).
  const baseVariant=wasPending?(outcome==='activated'?'verified':null):earlierBankPay?null
   :outcome==='pending_verification'?'pending_verification':'activated';
  // Replacing another method is an update for the client and staff, not a new enrollment (P-17).
  const updated=replaced.some(old=>old.id!==saved!.id);
  const previous=keepWorking?working:replaced.find(old=>old.id!==saved!.id)??null;
  const previousLabel=previous?formatPaymentMethod(previous):null;
  // V2-3: a re-authorization accepted by re-entering the SAME card or bank is not a method
  // change. When its accepted terms differ from that method's last authorization, the client
  // hears the updated terms are accepted (with the limit and fee), never "It replaces your …".
  const sameMethod=!!previous&&previous.type===saved!.type&&(saved!.type==='card'
   ?previous.cardBrand===saved!.cardBrand&&previous.cardLast4===saved!.cardLast4&&previous.cardExpMonth===saved!.cardExpMonth&&previous.cardExpYear===saved!.cardExpYear
   :!!saved!.bankLast4&&previous.bankName===saved!.bankName&&previous.bankLast4===saved!.bankLast4);
  const [previousConsent]=sameMethod&&baseVariant==='activated'?await db.select({textHash:orgAutopayConsents.consentTextHash}).from(orgAutopayConsents)
   .where(and(eq(orgAutopayConsents.orgId,attempt.orgId),eq(orgAutopayConsents.enrollmentId,enrollment.id),eq(orgAutopayConsents.paymentMethodId,previous!.id)))
   .orderBy(desc(orgAutopayConsents.createdAt)).limit(1):[];
  const termsAccepted=!!previousConsent&&previousConsent.textHash!==snapshot.textHash;
  // R1: the enrollment stays paused (above); a usable method saved while paused is "saved,
  // payments paused", never "automatic payments are on". Pending verification says nothing is charged yet anyway.
  const variant=baseVariant&&baseVariant!=='pending_verification'&&enrollment.status==='paused'?'paused'
   :baseVariant==='pending_verification'&&keepWorking?'pending_change'
   :baseVariant==='verified'&&updated?'verified_change'
   :baseVariant==='activated'&&updated&&termsAccepted?'terms_accepted'
   :baseVariant==='activated'&&updated?'method_changed':baseVariant;
  // The product's copy wherever a partner's generic "you're set up" wording would be untrue.
  const locked=variant==='paused'||variant==='pending_change'||variant==='verified_change'||variant==='method_changed'||variant==='terms_accepted';
  const lockedLine=variant==='pending_change'&&previousLabel?`Until it's verified, we'll keep using your ${paymentMethodInSentence(previousLabel)} for automatic payments.`
   :(variant==='verified_change'||variant==='method_changed')&&previousLabel&&!sameMethod?`It replaces your ${paymentMethodInSentence(previousLabel)}.`:undefined;
  // FP-7: a bank verified for a bank payment: the page promised an email to come back and pay
  // that invoice (it was issued before automatic payments, so it isn't collected by itself).
  const [bankPayInvoice]=baseVariant==='verified'&&snapshot.bankPayment?await db.select().from(invoices).where(and(
   eq(invoices.id,snapshot.bankPayment.invoiceId),eq(invoices.orgId,attempt.orgId))).limit(1):[];
  const stillToPay=bankPayInvoice&&bankPayInvoice.orgId===attempt.orgId&&['sent','partially_paid','overdue'].includes(bankPayInvoice.status)
   &&Number(bankPayInvoice.balance)>0?bankPayInvoice:null;
  // V2-2: what the verified bank now means for invoices the client already heard about. Only a
  // schedule still planned is charged; one the grace ended (the client was told it won't be
  // charged) stays manual and is linked. Never a blanket "charged as that email described".
  const announced=baseVariant==='verified'&&enrollment.status!=='paused'?await db.select({schedule:invoiceAutopaySchedules,invoice:invoices})
   .from(invoiceAutopaySchedules).innerJoin(invoices,and(eq(invoices.id,invoiceAutopaySchedules.invoiceId),eq(invoices.orgId,invoiceAutopaySchedules.orgId)))
   .where(and(eq(invoiceAutopaySchedules.orgId,attempt.orgId),eq(invoiceAutopaySchedules.enrollmentId,enrollment.id),
    inArray(invoices.status,['sent','partially_paid','overdue']),sql`${invoices.balance} > 0`,
    sql`((${invoiceAutopaySchedules.state} IN ('scheduled','retry_scheduled') AND ${invoiceAutopaySchedules.noticeSentAt} IS NOT NULL)
     OR (${invoiceAutopaySchedules.state} = 'cancelled' AND ${inArray(invoiceAutopaySchedules.stateReason,[...DEFERRAL_END_REASONS])}))`))
   .orderBy(invoices.invoiceNumber):[];
  const others=announced.filter(row=>row.invoice.orgId===attempt.orgId&&row.invoice.id!==stillToPay?.id);
  // A first bank was announced as "paid once it's verified"; a changed one replaced a card that kept paying.
  const stillPlanned=variant==='verified'?others.filter(row=>row.schedule.state!=='cancelled'):[];
  const ended=others.filter(row=>row.schedule.state==='cancelled');
  if(variant){
   const stop=await mintBillingLinkToken(db,{orgId:attempt.orgId,purpose:'stop_autopay',enrollmentId:enrollment.id,generation:enrollment.generation,ttlDays:365});
   const payLink=stillToPay?{label:'Pay it by bank',url:buildPublicInvoiceUrl((await getOrMintInvoiceLink(stillToPay,db)).token),
    note:`Invoice ${stillToPay.invoiceNumber} is still unpaid (${emailMoney(stillToPay.balance,stillToPay.currencyCode)}).`}:null;
   const endedLinks=await Promise.all(ended.map(async row=>({label:'Pay it here',url:buildPublicInvoiceUrl((await getOrMintInvoiceLink(row.invoice,db)).token),
    note:`Invoice ${row.invoice.invoiceNumber} (${emailMoney(row.invoice.balance,row.invoice.currencyCode)}) won't be paid automatically, as we emailed you.`})));
   const processingText=[lockedLine,...stillPlanned.map(row=>`Invoice ${row.invoice.invoiceNumber} will now be paid automatically from this account.`)]
    .filter(Boolean).join('\n')||undefined;
   const methodLabel=formatStripePaymentMethod(method);
   const displayFee=verifiedFeeText(method.type,method.card?.funding??null,snapshot.feeText,method.card);
   const verifiedCredit=method.type==='card'&&displayFee===snapshot.feeText&&snapshot.feeTerms.cardFeeBps>0;
   const fee=method.type==='us_bank_account'
    ?(Number(snapshot.feeTerms.achFeeAmount)>0?`${emailMoney(snapshot.feeTerms.achFeeAmount,snapshot.feeTerms.currency)} per payment`:'No fee')
    :verifiedCredit?`Up to ${formatPercentBps(snapshot.feeTerms.cardFeeBps)} per payment`:'No fee for this card';
   const acceptedOn=emailDate(attempt.createdAt??new Date());
   const cap=snapshot.scheduleTerms.cap;
   const rendered=await renderBillingNotice('autopay_enrolled',{autopay:{partnerId:attempt.partnerId,orgId:attempt.orgId,
     variant:variant==='activated'?undefined:variant,locked,processingText,...(payLink||endedLinks.length?{links:[...(payLink?[payLink]:[]),...endedLinks]}:{}),
     vars:{partner_name:snapshot.partnerName,org_name:org.name,client_name:clientNameFor(org.billingContact,org.name),
      payment_method:paymentMethodInSentence(methodLabel),schedule_text:snapshot.scheduleText,fee_text:displayFee},
     summary:[{label:variant==='pending_verification'?'Bank account':'Payment method',value:`${methodLabel}${variant==='pending_verification'?' (waiting for verification)':''}`},
      {label:"When you're charged",value:autopayScheduleSummary(snapshot.scheduleTerms)},{label:'Processing fee',value:fee},
      ...(variant==='terms_accepted'?[{label:'Limit',value:cap.enabled?`Up to ${emailMoney(cap.amount,cap.currency)} per invoice`:'No limit'}]
       :cap.enabled?[{label:'Which invoices',value:`Up to ${emailMoney(cap.amount,cap.currency)} each`}]:[]),
      ...(variant==='pending_verification'||variant==='pending_change'||variant==='paused'||variant==='method_changed'||variant==='verified_change'||variant==='terms_accepted'?[]
       :[{label:'Starts with',value:`Invoices issued from ${emailDate(enrollment.effectiveFrom??new Date())}`}])],
     terms:{title:'Your authorization',paragraphs:baseVariant==='verified'
      ?[`You accepted these terms on ${acceptedOn} (terms version ${snapshot.version}). We sent you a copy when you set up automatic payments.`]
      :[`You accepted these terms on ${acceptedOn} (terms version ${snapshot.version}):`,snapshot.text]},
     scheduleText:snapshot.scheduleText,feeText:displayFee,stopUrl:buildBillingLinkUrl('stop_autopay',stop.token),authorizationReference:snapshot.version}});
   for(const recipient of enrollmentRecipients(org.billingContact,snapshot.contactEmail)){
    await enqueueBillingNotice(db,{orgId:attempt.orgId,partnerId:attempt.partnerId,enrollmentId:enrollment.id,kind:'autopay_enrolled',seq:attempt.generation,
     dedupeKey:`${attempt.id}:autopay_enrolled:${baseVariant==='verified'?'verified':outcome}${recipient.suffix}`,toEmail:recipient.email,rendered});
   }
  }
  // Any other bank still waiting unflagged beside a working method is superseded by this
  // setup, so it can never be swapped in later over a newer choice (F-1).
  const superseded=await db.update(orgPaymentMethods).set({status:'removed',removedAt:new Date()}).where(and(
   eq(orgPaymentMethods.orgId,attempt.orgId),eq(orgPaymentMethods.isAutopayMethod,false),eq(orgPaymentMethods.status,'pending_verification'),
   ne(orgPaymentMethods.id,saved!.id))).returning();
  for(const old of [...replaced,...superseded])if(old.id!==saved!.id)runAfterDbContextExit('autopay.detachReplaced',()=>detachPaymentMethodPostCommit(attempt.partnerId,old.id));
  // FP-11: staff hear "enabled" when a method can be charged: not while a bank waits for verification.
  if(variant&&variant!=='pending_verification'&&variant!=='pending_change')runAfterDbContextExit('autopay.enrolled',async()=>{
   const [committed]=await withSystemDbAccessContext(()=>db.select().from(autopaySetupAttempts).where(eq(autopaySetupAttempts.id,attempt.id)).limit(1));
   // FP-13: never "Automatic payments enabled" for a method saved while payments are paused.
   if(committed?.outcome===outcome)await notifyAutopayStaff({orgId:attempt.orgId,partnerId:attempt.partnerId,
    event:variant==='terms_accepted'?'autopay.terms_accepted':updated||variant==='paused'?'autopay.method_updated':'autopay.enrolled',
    dedupeKey:`${attempt.id}:enrolled:${baseVariant==='verified'?'verified':outcome}`,
    message:variant==='terms_accepted'?'The client accepted the updated terms.'
     :variant==='paused'?`${updated?'Payment method updated':'Payment method saved'} while automatic payments are paused.`
     :baseVariant==='verified'?`${updated?'Payment method updated':'Automatic payments enabled'}: the bank account is verified.`
     :updated?'Payment method updated.':'Automatic payments enabled.'});
  });
  return {outcome,orgId:attempt.orgId};
 });
}
export async function completeAutopaySetup(partnerId:string,ref:{checkoutSessionId?:string;setupIntentId?:string},onVerifiedMethod?:(method:Stripe.PaymentMethod)=>void):Promise<{outcome:Outcome;orgId:string}>{
 assertNoHeldDbContextForStripe('completeAutopaySetup');
 if(Boolean(ref.checkoutSessionId)===Boolean(ref.setupIntentId))throw new Error('Supply exactly one setup reference');
 const {stripe,stripeAccountId}=await withSystemDbAccessContext(()=>getPartnerStripeClient(partnerId));
 let setupIntentId=ref.setupIntentId;
 if(ref.checkoutSessionId){
  const session=await runOutsideDbContext(()=>stripe.checkout.sessions.retrieve(ref.checkoutSessionId!));
  if(session.mode!=='setup')throw new Error('Expected setup Checkout');
  if(session.status==='open'||session.status==='expired'){
   const [attempt]=await withSystemDbAccessContext(()=>db.select().from(autopaySetupAttempts).where(and(
    eq(autopaySetupAttempts.checkoutSessionId,ref.checkoutSessionId!),eq(autopaySetupAttempts.partnerId,partnerId),eq(autopaySetupAttempts.stripeAccountId,stripeAccountId))).limit(1));
   if(!attempt||attempt.stripeCustomerId!==id(session.customer))throw new Error('Setup binding mismatch');
   if(attempt.completedAt&&attempt.outcome)return {outcome:attempt.outcome,orgId:attempt.orgId};
   if(session.status==='open')return {outcome:'in_progress',orgId:attempt.orgId};
   return persistCapturedAutopayMethod(attempt.id,null,'abandoned',null,null);
  }
  setupIntentId=id(session.setup_intent)??undefined;
 }
 if(!setupIntentId)throw new Error('Setup is not complete');
 const intent=await runOutsideDbContext(()=>stripe.setupIntents.retrieve(setupIntentId!));
 const metadata=intent.metadata;
 if(!metadata)throw new Error('Setup binding mismatch');
 const [attempt]=await withSystemDbAccessContext(()=>db.select().from(autopaySetupAttempts).where(and(
  eq(autopaySetupAttempts.id,metadata.setup_attempt_id??''),eq(autopaySetupAttempts.partnerId,partnerId),eq(autopaySetupAttempts.stripeAccountId,stripeAccountId))).limit(1));
 if(!attempt||attempt.orgId!==metadata.org_id||attempt.enrollmentId!==metadata.enrollment_id||String(attempt.generation)!==metadata.generation||
  (attempt.tokenId??'')!==(metadata.token_id??'')||attempt.stripeCustomerId!==id(intent.customer))throw new Error('Setup binding mismatch');
 const outcome=setupIntentOutcome(intent);
 if(outcome==='in_progress')return {outcome:attempt.completedAt&&attempt.outcome?attempt.outcome:outcome,orgId:attempt.orgId};
 const methodId=id(intent.payment_method);
 if(!methodId)return persistCapturedAutopayMethod(attempt.id,null,outcome,intent.id,null);
 const method=await runOutsideDbContext(()=>stripe.paymentMethods.retrieve(methodId));
 const mandateId=id(intent.mandate);
 if(method.type==='us_bank_account'&&intent.status==='succeeded'){
  if(!mandateId)throw new Error('Verified bank setup has no mandate');
  const mandate=await runOutsideDbContext(()=>stripe.mandates.retrieve(mandateId));
  if(mandate.status!=='active'||id(mandate.payment_method)!==method.id)throw new Error('Bank mandate is not active');
 }
 const result=await persistCapturedAutopayMethod(attempt.id,method,setupIntentOutcome(intent),intent.id,mandateId);
 // Reuse provider evidence for the return page without storing wallet/network data
 // or making another Stripe call. Never expose an unaccepted capture.
 if(result.outcome==='activated'||result.outcome==='pending_verification')onVerifiedMethod?.(method);
 return result;
}
