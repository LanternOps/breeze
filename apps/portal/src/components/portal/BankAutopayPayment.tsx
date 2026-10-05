import {useEffect,useState,type ReactElement} from 'react';
import {cn} from '@/lib/utils';
import {money} from '@/lib/format';
import {withBase} from '@/lib/basePath';
import {BTN_PRIMARY,BTN_SECONDARY,Notice} from './ui';
import {AutopayShell} from './autopay/AutopayShell';
import {AuthorizationBox} from './autopay/AuthorizationBox';
import {StatePanel} from './autopay/StatePanel';
import {SummaryList} from './autopay/SummaryList';
import {apiGet,apiPost,type ApiResponse,type BankAutopayOffer} from '@/lib/api';
import {runAction} from '@/lib/runAction';
import {navigateTo} from '@/lib/navigation';
type Target={invoiceId:string;publicToken?:string};
/** The exact one-time terms the client authorized before Stripe bank setup. */
type Terms=Pick<BankAutopayOffer,'principal'|'fee'|'currency'|'disclosureHash'>;
type View={target:Target;offer:BankAutopayOffer;setupSessionId?:string;accepted?:Terms};
/** notCharged: the server answered this collection with an outcome that never debits. */
type Changed={from:Terms;to:BankAutopayOffer;notCharged:boolean};
import type { InvoicePayResult as Result } from '@breeze/shared';
const key='autopay-bank-return';
// The bank authority stopped being usable (e.g. after microdeposit verification).
// Each offers a restart against the invoice's current terms; the server re-checks.
const REAUTHORIZE:Record<string,string>={
  bank_authorization_expired:'Your bank authorization for this payment expired before it was used. Restart bank setup to pay this invoice.',
  bank_authorization_changed:"Your bank authorization no longer matches this invoice's payment details. Restart bank setup to review and pay.",
  client_authorization_required:"Your bank authorization no longer matches this invoice's payment details. Restart bank setup to review and pay.",
  bank_authorization_used:"This bank authorization was already used. Refresh the invoice to check whether the payment started; if it didn't, restart bank setup.",
};
const path=(target:Target)=>target.publicToken?`/invoices/public/${encodeURIComponent(target.publicToken)}`:`/portal/invoices/${encodeURIComponent(target.invoiceId)}`;
const termsOf=(offer:Terms):Terms=>({principal:offer.principal,fee:offer.fee,currency:offer.currency,disclosureHash:offer.disclosureHash});
const sameTerms=(a:Terms,b:Terms)=>a.principal===b.principal&&a.fee===b.fee&&a.currency===b.currency&&a.disclosureHash===b.disclosureHash;
function storedTerms(value:unknown):Terms|undefined{
  const v=value as Partial<Record<keyof Terms,unknown>>|null;
  const money=(x:unknown)=>typeof x==='string'&&/^\d+\.\d{2}$/.test(x);
  return v&&typeof v==='object'&&money(v.principal)&&money(v.fee)&&v.currency==='USD'&&typeof v.disclosureHash==='string'&&/^[a-f0-9]{64}$/.test(v.disclosureHash)
    ?termsOf(v as Terms):undefined;
}
const cents=(value:string)=>{const [whole,fraction]=value.split('.');return Number(whole)*100+Number(fraction);};
const total=(t:Terms)=>money((cents(t.principal)+cents(t.fee))/100,t.currency);
function changeText({from,to}:Changed):string{
  const parts=[from.fee!==to.fee?`The processing fee changed from ${money(from.fee,from.currency)} to ${money(to.fee,to.currency)}.`:'',
    from.principal!==to.principal?`The amount due changed from ${money(from.principal,from.currency)} to ${money(to.principal,to.currency)}.`:''].filter(Boolean);
  return `${parts.length?parts.join(' '):'The payment terms changed.'} New total: ${total(to)}.`;
}
function unwrap<T>(response:ApiResponse<T|{data:T}>,publicRequest:boolean):ApiResponse<T>{
  return {...response,data:publicRequest?(response.data as {data?:T}|undefined)?.data:response.data as T|undefined};
}
async function read(target:Target){
  type Data={invoice:{id:string};bankAutopay?:BankAutopayOffer|null};
  return unwrap(await apiGet<Data|{data:Data}>(path(target),{redirectOnUnauthorized:!target.publicToken}),!!target.publicToken);
}
export default function BankAutopayPayment({target,offer,returning=false}:{target?:Target;offer?:BankAutopayOffer|null;returning?:boolean}){
  const [view,setView]=useState<View|null>(target&&offer?{target,offer}:null);
  const [accepted,setAccepted]=useState(false),[busy,setBusy]=useState(false),[finished,setFinished]=useState(false);
  const [message,setMessage]=useState(''),[failed,setFailed]=useState(false);
  const [recovery,setRecovery]=useState<'in_progress'|'abandoned'|'reauthorize'|null>(null);
  const [changed,setChanged]=useState<Changed|null>(null);
  const [cancelled,setCancelled]=useState(false),[invoiceHref,setInvoiceHref]=useState<string|null>(null);
  const outcome=(text:string,error:boolean)=>{setMessage(text);setFailed(error);};
  /** Shows a freshly read offer against the terms this setup authorized. The same terms
   * stay accepted (#7897); different terms need a new authorization and bank setup,
   * because the server only collects exactly what the client accepted (#7896). */
  function show(next:View,notCharged=false):boolean{
    const pending=!!next.setupSessionId&&next.offer.methodStatus==='pending_verification';
    if(!pending&&next.setupSessionId&&next.accepted&&!sameTerms(next.accepted,next.offer)){
      setChanged({from:next.accepted,to:next.offer,notCharged});setView({target:next.target,offer:next.offer});setAccepted(false);return true;
    }
    setChanged(null);setView(next);setAccepted(!pending&&!!next.accepted&&sameTerms(next.accepted,next.offer));return false;
  }
  useEffect(()=>{if(!returning){setView(target&&offer?{target,offer}:null);setAccepted(false);setChanged(null);}},
    [target?.invoiceId,target?.publicToken,offer,returning]);
  useEffect(()=>{
    if(!returning)return;let canceled=false;
    try{
      const stored=JSON.parse(sessionStorage.getItem(key)??'null') as (Target&{setupSessionId?:string;accepted?:unknown})|null;
      // The way back to the invoice the client was paying, for every return state.
      if(stored&&typeof stored.invoiceId==='string')setInvoiceHref(typeof stored.publicToken==='string'
        ?withBase(`/invoice/${encodeURIComponent(stored.publicToken)}`):withBase(`/invoices/${encodeURIComponent(stored.invoiceId)}`));
      // Stripe "Back" before connecting the bank: nothing was saved or charged.
      if(new URLSearchParams(window.location.search).get('cancelled')==='1'){setCancelled(true);return;}
      const session=new URLSearchParams(window.location.search).get('session_id')??stored?.setupSessionId;
      if(!stored||typeof stored.invoiceId!=='string'||(stored.publicToken!==undefined&&typeof stored.publicToken!=='string')||!session||!/^cs_[A-Za-z0-9_]+$/.test(session))throw new Error();
      sessionStorage.setItem(key,JSON.stringify({...stored,setupSessionId:session}));
      const next:Target={invoiceId:stored.invoiceId,...(stored.publicToken!==undefined?{publicToken:stored.publicToken}:{})};
      void read(next).then(response=>{
        if(canceled)return;
        if(response.data?.invoice.id!==stored.invoiceId||!response.data.bankAutopay)throw new Error();
        show({target:next,offer:response.data.bankAutopay,setupSessionId:session,accepted:storedTerms(stored.accepted)});
      }).catch(()=>{if(!canceled)outcome('Could not reload the invoice. Refresh to try again.',true);});
    }catch{outcome('This return is incomplete. Open the invoice and try again.',true);}
    return()=>{canceled=true;};
  },[returning]);
  async function refresh(){
    if(!view||busy)return;setBusy(true);
    try{const result=await read(view.target);if(result.data?.invoice.id!==view.target.invoiceId||!result.data.bankAutopay)throw new Error();
      show({...view,offer:result.data.bankAutopay});setRecovery(null);
    }catch{outcome('Could not check verification.',true);}finally{setBusy(false);}
  }
  /** After a collection the server refused or cancelled before any debit, re-read the offer:
   * if the terms changed since authorization, offer the new total instead of a dead end. */
  async function recheckTerms(authorized:Terms):Promise<boolean>{
    try{
      const result=await read(view!.target);const latest=result.data?.bankAutopay;
      if(result.data?.invoice.id!==view!.target.invoiceId||!latest?.available)return false;
      return show({target:view!.target,offer:latest,setupSessionId:view!.setupSessionId,accepted:authorized},true);
    }catch{return false;}
  }
  /** Restart bank setup against the invoice's CURRENT offer. Reusing the offer read at
   * return time would loop on stale terms into "The terms changed". Consent starts
   * unticked: a restart is a new authorization. No current offer means bank payment is
   * not available now (for example, a payment already started). */
  async function restart(){
    if(!view||busy)return;setBusy(true);
    try{const result=await read(view.target);if(result.data?.invoice.id!==view.target.invoiceId)throw new Error();
      try{sessionStorage.removeItem(key);}catch{}
      setView({target:view.target,offer:result.data.bankAutopay??{...view.offer,available:false,methodStatus:null}});
      setChanged(null);setAccepted(false);setRecovery(null);setMessage('');setFailed(false);
    }catch{outcome('Could not reload the invoice. Refresh to try again.',true);}finally{setBusy(false);}
  }
  async function submit(){
    if(!view||!accepted||busy||finished)return;setBusy(true);
    const collecting=!!view.setupSessionId;
    if(!collecting){try{sessionStorage.setItem(key,JSON.stringify({...view.target,accepted:termsOf(view.offer)}));}
      catch{outcome('Enable session storage to return securely.',true);setBusy(false);return;}}
    let conflictReason: 'pending_verification'|'in_progress'|'abandoned'|undefined;
    let conflict=false,conflictOutcome:unknown=undefined,conflictDetailReason:string|undefined;
    const result=await runAction<Result>({request:async()=>{
      const response=await apiPost<Result|{data:Result}>(`${path(view.target)}/pay`,{
      methodType:'us_bank_account',phase:collecting?'collect':'setup',consentAccepted:true,disclosureHash:view.offer.disclosureHash,
      principal:view.offer.principal,fee:view.offer.fee,currency:view.offer.currency,...(collecting?{setupSessionId:view.setupSessionId}:{}),
    },{redirectOnUnauthorized:!view.target.publicToken});
      // Conflicts remain failures in runAction; consume only recognized setup recovery details.
      const detail=response.errorData;
      if(collecting&&response.statusCode===409){
        conflict=true;
        if(detail&&typeof detail==='object'&&'outcome' in detail)conflictOutcome=detail.outcome;
        if(detail&&typeof detail==='object'&&'reason' in detail&&typeof detail.reason==='string')conflictDetailReason=detail.reason;
        if(detail&&typeof detail==='object'&&'outcome' in detail&&(detail.outcome==='deferred'||detail.outcome==='refused')&&'reason' in detail&&
          (detail.reason==='pending_verification'||detail.reason==='in_progress'||detail.reason==='abandoned')){
          conflictReason=detail.reason;
        }
      }
      return unwrap(response,!!view.target.publicToken);
    },onOutcome:outcome,
      successMessage:collecting?'Payment request checked.':'Opening secure bank setup…',errorFallback:'Could not start bank payment.',
      validate:value=>collecting?['created','deferred','refused','failed','canceled','requires_action','unapplied'].includes(value.outcome??''):
        typeof value.url==='string'&&value.url.startsWith('https://checkout.stripe.com/')});
    if(!result&&!conflictReason&&!conflict){setBusy(false);return;}
    const reason=conflictReason??result?.reason;
    if(!collecting&&result?.url){setBusy(false);void navigateTo(result.url);return;}
    if(result?.outcome==='created'){setBusy(false);try{sessionStorage.removeItem(key);}catch{}setFinished(true);
      outcome('Bank payment started. Processing may take several days.',false);return;}
    if(reason==='pending_verification'){setBusy(false);setView({...view,offer:{...view.offer,methodStatus:'pending_verification'}});
      setAccepted(false);outcome('Bank verification is pending. No payment has started.',!!conflictReason);return;}
    if(reason==='in_progress'||reason==='abandoned'){setBusy(false);setRecovery(reason);setAccepted(false);
      outcome(reason==='in_progress'?'Your bank setup is still being confirmed. Refresh verification before trying again.':'Bank setup was not completed. Restart bank setup to continue.',!!conflictReason);return;}
    // Only an explicit refusal (nothing reserved) or a verified provider cancellation proves this
    // collection debited nothing. A bare 409 or a deferral can follow money already moving.
    const notCharged=['canceled','refused'].includes(String(conflict?conflictOutcome:result?.outcome));
    if(notCharged&&await recheckTerms(view.accepted??termsOf(view.offer))){setBusy(false);setMessage('');return;}
    // Terms unchanged but this authority can no longer collect: restart setup, never a dead end.
    const unusable=conflictDetailReason??reason;
    if(unusable&&unusable in REAUTHORIZE){setBusy(false);setRecovery('reauthorize');setAccepted(false);
      outcome(REAUTHORIZE[unusable]!,true);return;}
    setBusy(false);
    if(!conflict)outcome('Payment has not started. Refresh the invoice to check its status.',true);
  }
  const summary=(offer:BankAutopayOffer)=>[{label:'Invoice payment',value:money(offer.principal,offer.currency)},
    {label:'Processing fee',value:Number(offer.fee)>0?money(offer.fee,offer.currency):'None'},
    {label:'Total',value:total(offer),figure:true}];
  const frame=(children:ReactElement)=>returning?<AutopayShell testId="autopay-bank-return">{children}</AutopayShell>:children;
  if(!view){
    if(!returning)return null;
    if(cancelled)return frame(<StatePanel title="Your bank connection wasn't finished" mark={{tone:'neutral',label:'Not paid'}}
      primary={invoiceHref?{label:'Back to the invoice',href:invoiceHref}:null}>
      <p>You left Stripe's page before connecting your bank account. Nothing was saved or charged.</p>
      {!invoiceHref&&<p>Open the invoice from your email to pay it.</p>}
    </StatePanel>);
    return frame(message?<StatePanel title="Open the invoice to continue" primary={invoiceHref?{label:'Open the invoice',href:invoiceHref}:null} testId="autopay-bank-return-status">
      <p>{failed?"We couldn't pick up where you left off on this page. Open the invoice again to finish paying.":message}</p>
    </StatePanel>:<StatePanel title="Finishing your bank connection…" testId="autopay-bank-return-status"><p>This takes a few seconds.</p></StatePanel>);
  }
  const pending=!!view.setupSessionId&&view.offer.methodStatus==='pending_verification';
  if(!view.offer.available&&!pending)return frame(<p className="text-sm text-muted-foreground" data-testid="autopay-bank-unavailable">Bank payment isn't available for this invoice right now. You can pay it by card.</p>);
  const tone:'destructive'|'primary'=failed?'destructive':'primary';
  const body=<section data-testid="autopay-bank-module" className="space-y-4">
    {returning&&<h1 className="font-display text-[1.75rem] font-semibold leading-tight tracking-tight text-foreground">Pay by bank</h1>}
    <SummaryList rows={summary(view.offer)}/>
    {changed&&!finished&&<Notice tone="warning" title="The total changed, so no payment was made." data-testid="autopay-bank-terms-changed">
      <p>{changeText(changed)}{changed.notCharged?' Your bank account was not charged.':''}</p>
      <p>Please read the new authorization and agree to it. You'll connect your bank account with Stripe again.</p>
    </Notice>}
    {message&&<Notice tone={finished?'primary':tone} data-testid="autopay-bank-result">{finished?<><p className="font-semibold">Bank payment started</p>
      <p>{`Your bank payment of ${total(view.offer)} has started. Bank payments usually take a few business days to clear, and we'll email you a receipt when it does. Automatic payments are now on for future invoices.`}</p></>
      :<p>{message}</p>}</Notice>}
    {recovery==='abandoned'||recovery==='reauthorize'?<button type="button" className={cn(BTN_PRIMARY,'w-full')} data-testid="autopay-bank-restart" disabled={busy} onClick={()=>void restart()}>Connect your bank again</button>
      :recovery==='in_progress'?<button type="button" className={cn(BTN_SECONDARY,'w-full')} data-testid="autopay-bank-refresh" disabled={busy} onClick={()=>void refresh()}>Check again</button>
      :pending&&!finished?<Notice tone="warning" title="Your bank account needs verifying first." data-testid="autopay-bank-pending"
        action={<button type="button" className={BTN_SECONDARY} data-testid="autopay-bank-refresh" disabled={busy} onClick={()=>void refresh()}>Check again</button>}>
        <p>Stripe will email you instructions, usually within 1–2 business days. No payment has started.</p></Notice>
      :!finished&&<div className="space-y-4">
        <AuthorizationBox id="autopay-bank-authorization" text={view.offer.consentText} checked={accepted} disabled={busy}
          onChange={setAccepted} testIds={{text:'autopay-bank-consent-text',checkbox:'autopay-bank-consent'}}/>
        <button type="button" className={cn(BTN_PRIMARY,'w-full')} data-testid={view.setupSessionId?'autopay-bank-confirm-pay':'autopay-bank-pay'} disabled={busy||!accepted}
          onClick={()=>void submit()}>{busy?(view.setupSessionId?'Starting your payment…':'Opening Stripe…'):view.setupSessionId?`Pay ${total(view.offer)} now`:changed?`Agree and pay ${total(view.offer)}`:`Pay ${total(view.offer)} by bank`}</button>
        {!accepted&&<p className="text-sm text-muted-foreground">Tick the box above to continue.</p>}
      </div>}
  </section>;
  return frame(body);
}
