import type Stripe from 'stripe';
import {createHash} from 'node:crypto';
import {and,asc,eq,inArray,isNotNull,isNull,or,sql} from 'drizzle-orm';
import {db,withSystemDbAccessContext,runOutsideDbContext} from '../../db';
import {stripeConnectAccounts,stripeFinancialEvents,orgPaymentMethods,orgAutopayEnrollments} from '../../db/schema';
import {autopaySetupAttempts} from '../../db/schema/autopaySetupAttempts';
import {getPartnerStripeClient} from '../partnerStripe';
import {assertNoHeldDbContextForStripe,HeldDbContextForStripeError} from '../stripeSettle';
import {completeAutopaySetup} from './setupCompletion';
import {finishCardPayAndSave} from './payAndSave';
import {markPaymentMethodUnusable} from './paymentMethods';
import {notifyAutopayStaff} from './staffNotifications';
export const AUTOPAY_STRIPE_EVENT_TYPES=['setup_intent.succeeded','setup_intent.setup_failed','mandate.updated','payment_method.detached'] as const;
export function isAutopayStripeEvent(type:string):boolean{return (AUTOPAY_STRIPE_EVENT_TYPES as readonly string[]).includes(type);}
export async function ingestAutopayStripeEvent(partnerId:string,stripeAccountId:string,event:Stripe.Event):Promise<void>{
 if(!isAutopayStripeEvent(event.type))throw new Error('Unexpected autopay event');
 const [connection]=await withSystemDbAccessContext(()=>db.select().from(stripeConnectAccounts).where(and(eq(stripeConnectAccounts.partnerId,partnerId),eq(stripeConnectAccounts.stripeAccountId,stripeAccountId))).limit(1));
 if(!connection||event.account&&event.account!==stripeAccountId||event.livemode!==connection.livemode)throw new Error('Autopay event account mismatch');
 const digest=createHash('sha256').update(JSON.stringify({id:event.id,type:event.type,account:stripeAccountId,object:event.data.object})).digest('hex');
 await withSystemDbAccessContext(()=>db.insert(stripeFinancialEvents).values({partnerId,stripeConnectionId:connection.id,stripeAccountId,
  stripeEventId:event.id,eventType:event.type,livemode:event.livemode,providerCreated:event.created,paymentIntentId:null,currency:'XXX',payloadDigest:digest}).onConflictDoNothing());
 const [stored]=await withSystemDbAccessContext(()=>db.select().from(stripeFinancialEvents).where(eq(stripeFinancialEvents.stripeEventId,event.id)).limit(1));
 if(!stored||stored.partnerId!==partnerId||stored.stripeAccountId!==stripeAccountId||stored.payloadDigest!==digest)throw new Error('Autopay event identity conflict');
}
export async function replayAutopayStripeEvents():Promise<number>{
 assertNoHeldDbContextForStripe('replayAutopayStripeEvents');
 const rows=await withSystemDbAccessContext(()=>db.select().from(stripeFinancialEvents).where(and(eq(stripeFinancialEvents.status,'pending'),
  or(isNull(stripeFinancialEvents.nextAttemptAt),sql`${stripeFinancialEvents.nextAttemptAt} <= NOW()`),
  inArray(stripeFinancialEvents.eventType,[...AUTOPAY_STRIPE_EVENT_TYPES]))).orderBy(asc(stripeFinancialEvents.nextAttemptAt),asc(stripeFinancialEvents.providerCreated),asc(stripeFinancialEvents.createdAt)).limit(200));
 let applied=0;
 for(const row of rows){
  try{
   const {stripe,stripeAccountId}=await withSystemDbAccessContext(()=>getPartnerStripeClient(row.partnerId));
   if(stripeAccountId!==row.stripeAccountId)throw new Error('Stripe event account changed');
   const event=await runOutsideDbContext(()=>stripe.events.retrieve(row.stripeEventId));
   if(event.id!==row.stripeEventId||event.type!==row.eventType||event.livemode!==row.livemode||event.account&&event.account!==row.stripeAccountId)throw new Error('Stripe replay identity mismatch');
   const object=event.data.object as {id:string;payment_method?:string|{id:string};status?:string};
   if(event.type.startsWith('setup_intent.')){
    const [known]=await withSystemDbAccessContext(()=>db.select({id:autopaySetupAttempts.id}).from(autopaySetupAttempts)
     .where(and(eq(autopaySetupAttempts.partnerId,row.partnerId),eq(autopaySetupAttempts.id,(event.data.object as Stripe.SetupIntent).metadata?.setup_attempt_id??'00000000-0000-0000-0000-000000000000'))).limit(1));
    if(known)await completeAutopaySetup(row.partnerId,{setupIntentId:object.id});
   }else{
    let methodId:string|null=null;
    if(event.type==='payment_method.detached')methodId=object.id;
    else{
     const mandate=await runOutsideDbContext(()=>stripe.mandates.retrieve(object.id));
     if(mandate.status!=='active')methodId=typeof mandate.payment_method==='string'?mandate.payment_method:mandate.payment_method.id;
    }
    if(methodId){
     const methods=await withSystemDbAccessContext(()=>db.select({id:orgPaymentMethods.id,orgId:orgPaymentMethods.orgId}).from(orgPaymentMethods)
      .innerJoin(orgAutopayEnrollments,eq(orgAutopayEnrollments.id,orgPaymentMethods.enrollmentId)).where(and(eq(orgPaymentMethods.stripePaymentMethodId,methodId!),eq(orgPaymentMethods.isAutopayMethod,true),inArray(orgPaymentMethods.status,['active','pending_verification','unusable']),
       eq(orgAutopayEnrollments.partnerId,row.partnerId),eq(orgAutopayEnrollments.stripeAccountId,row.stripeAccountId))));
     for(const method of methods){
      await withSystemDbAccessContext(()=>markPaymentMethodUnusable(db,method.id,event.type));
      await notifyAutopayStaff({orgId:method.orgId,partnerId:row.partnerId,event:'autopay.needs_attention',dedupeKey:row.stripeEventId,
       message:'Automatic payments need a new payment method.'});
     }
    }
   }
   await withSystemDbAccessContext(()=>db.update(stripeFinancialEvents).set({status:'applied',processedAt:new Date(),lastAttemptAt:new Date(),nextAttemptAt:null,lastError:null,updatedAt:new Date()}).where(eq(stripeFinancialEvents.id,row.id)));
   applied++;
  }catch(error){
   if(error instanceof HeldDbContextForStripeError)throw error;
   // Match the monetary inbox's due-time, exponential backoff and terminal contract.
   const now=new Date(),attemptCount=row.attemptCount+1,exhausted=attemptCount>=50;
   const delayMinutes=Math.min(360,5*(2**Math.min(attemptCount-1,6)));
   const reason=error instanceof Error?error.message:String(error);
   await withSystemDbAccessContext(()=>db.update(stripeFinancialEvents).set({
    status:exhausted?'blocked':'pending',attemptCount,lastAttemptAt:now,updatedAt:now,
    nextAttemptAt:exhausted?null:new Date(now.getTime()+delayMinutes*60_000),
    processedAt:exhausted?now:null,lastError:exhausted?`${reason}_retry_exhausted`:reason,
   }).where(and(eq(stripeFinancialEvents.id,row.id),eq(stripeFinancialEvents.status,'pending'))));
  }
 }
 return applied;
}
export async function reconcileAutopaySetups():Promise<number>{
 assertNoHeldDbContextForStripe('reconcileAutopaySetups');
 const attempts=await withSystemDbAccessContext(()=>db.select().from(autopaySetupAttempts).where(and(isNull(autopaySetupAttempts.completedAt),
  sql`${autopaySetupAttempts.discoveryNextAttemptAt} <= NOW()`,
  sql`${autopaySetupAttempts.createdAt}>now()-interval '24 hours'`))
  .orderBy(asc(autopaySetupAttempts.discoveryNextAttemptAt),asc(autopaySetupAttempts.createdAt),asc(autopaySetupAttempts.id)).limit(200));
 let completed=0;
 for(const attempt of attempts){
  try{
   // Advance before provider work so unresolved sessions, verification waits,
   // failures and crashes all yield their place to unexamined attempts.
   const claimed=await withSystemDbAccessContext(()=>db.update(autopaySetupAttempts)
    .set({discoveryNextAttemptAt:new Date(Date.now()+10*60_000)})
    .where(and(eq(autopaySetupAttempts.id,attempt.id),isNull(autopaySetupAttempts.completedAt),
     sql`${autopaySetupAttempts.discoveryNextAttemptAt} <= NOW()`,
     sql`${autopaySetupAttempts.createdAt}>now()-interval '24 hours'`)).returning({id:autopaySetupAttempts.id}));
   if(!claimed.length)continue;
   let sessionId=attempt.checkoutSessionId;
   if(!sessionId&&attempt.stripeCustomerId){
    const {stripe,stripeAccountId}=await withSystemDbAccessContext(()=>getPartnerStripeClient(attempt.partnerId));
    if(stripeAccountId!==attempt.stripeAccountId)throw new Error('Stripe setup account changed');
    let after:string|undefined;
    do{
     const page=await runOutsideDbContext(()=>stripe.checkout.sessions.list({customer:attempt.stripeCustomerId!,created:{gte:Math.floor(attempt.createdAt.getTime()/1000)-60},limit:100,...(after?{starting_after:after}:{})}));
     sessionId=page.data.find(session=>session.metadata?.setup_attempt_id===attempt.id||session.metadata?.autopay_setup_attempt_id===attempt.id)?.id??null;
     after=page.has_more?page.data.at(-1)?.id:undefined;
    }while(!sessionId&&after);
    if(sessionId)await withSystemDbAccessContext(()=>db.update(autopaySetupAttempts).set({checkoutSessionId:sessionId}).where(eq(autopaySetupAttempts.id,attempt.id)));
   }
   if(!sessionId)continue;
   // Bound card captures use the separate durable, fairly scheduled pass below.
   if(attempt.source!=='pay_and_save'){
    const result=await completeAutopaySetup(attempt.partnerId,{checkoutSessionId:sessionId});
    if(result.outcome==='activated')completed++;
   }
  }catch(error){if(error instanceof HeldDbContextForStripeError)throw error;console.error('[autopay.setup-reconcile]',{attemptId:attempt.id,message:error instanceof Error?error.message:String(error)});}
 }
 // Later verification is event-driven. Card capture recovery is driven by bound
 // attempts, independent of the discovery window and without another BullMQ queue.
 const captures=await withSystemDbAccessContext(()=>db.select().from(autopaySetupAttempts).where(and(
  isNull(autopaySetupAttempts.completedAt),eq(autopaySetupAttempts.source,'pay_and_save'),
  isNotNull(autopaySetupAttempts.checkoutSessionId),sql`${autopaySetupAttempts.captureNextAttemptAt} <= NOW()`))
  .orderBy(asc(autopaySetupAttempts.captureNextAttemptAt),asc(autopaySetupAttempts.id)).limit(200));
 for(const attempt of captures){
  try{
   // Persist the next turn before external work: crashes and permanent no-ops
   // move behind untried rows instead of monopolizing the oldest batch.
   const claimed=await withSystemDbAccessContext(()=>db.update(autopaySetupAttempts)
    .set({captureNextAttemptAt:new Date(Date.now()+10*60_000)})
    .where(and(eq(autopaySetupAttempts.id,attempt.id),isNull(autopaySetupAttempts.completedAt),
     sql`${autopaySetupAttempts.captureNextAttemptAt} <= NOW()`)).returning({id:autopaySetupAttempts.id}));
   if(!claimed.length)continue;
   const result=await finishCardPayAndSave(attempt.partnerId,attempt.checkoutSessionId!);
   if(result.outcome==='activated')completed++;
  }catch(error){
   if(error instanceof HeldDbContextForStripeError)throw error;
   console.error('[autopay.capture-reconcile]',{attemptId:attempt.id,message:error instanceof Error?error.message:String(error)});
  }
 }
 return completed;
}
