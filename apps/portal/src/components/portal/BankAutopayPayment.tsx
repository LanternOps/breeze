import {useEffect,useState} from 'react';
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
const usd=(currency:string,value:number)=>`${currency} ${Math.trunc(value/100)}.${String(value%100).padStart(2,'0')}`;
function changeText({from,to}:Changed):string{
  const parts=[from.fee!==to.fee?`The processing fee changed from ${from.currency} ${from.fee} to ${to.currency} ${to.fee}.`:'',
    from.principal!==to.principal?`The amount due changed from ${from.currency} ${from.principal} to ${to.currency} ${to.principal}.`:''].filter(Boolean);
  return `${parts.length?parts.join(' '):'The payment terms changed.'} New total: ${usd(to.currency,cents(to.principal)+cents(to.fee))}.`;
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
  const [recovery,setRecovery]=useState<'in_progress'|'abandoned'|null>(null);
  const [changed,setChanged]=useState<Changed|null>(null);
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
  async function submit(){
    if(!view||!accepted||busy||finished)return;setBusy(true);
    const collecting=!!view.setupSessionId;
    if(!collecting){try{sessionStorage.setItem(key,JSON.stringify({...view.target,accepted:termsOf(view.offer)}));}
      catch{outcome('Enable session storage to return securely.',true);setBusy(false);return;}}
    let conflictReason: 'pending_verification'|'in_progress'|'abandoned'|undefined;
    let conflict=false,conflictOutcome:unknown=undefined;
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
    setBusy(false);
    if(!conflict)outcome('Payment has not started. Refresh the invoice to check its status.',true);
  }
  if(!view)return returning?<p role="status" data-testid="autopay-bank-return-status">{message||'Loading invoice…'}</p>:null;
  const pending=!!view.setupSessionId&&view.offer.methodStatus==='pending_verification';
  if(!view.offer.available&&!pending)return <p data-testid="autopay-bank-unavailable">Bank payment is unavailable for this invoice.</p>;
  return <section data-testid="autopay-bank-module" className="space-y-3">
    <h2>Pay by bank and set up autopay</h2>
    <p>Invoice payment: {view.offer.currency} {view.offer.principal}. Processing fee: {view.offer.currency} {view.offer.fee}.</p>
    {changed&&!finished&&<div role="alert" data-testid="autopay-bank-terms-changed">
      <p>{changeText(changed)}{changed.notCharged?' Your bank account was not charged.':''}</p>
      <p>Review the new terms below and authorize them to continue. You will confirm your bank account with Stripe again.</p>
    </div>}
    {message&&<p role={failed?'alert':'status'} data-testid="autopay-bank-result">{message}</p>}
    {recovery==='abandoned'?<button type="button" data-testid="autopay-bank-restart" disabled={busy} onClick={()=>{setRecovery(null);setAccepted(false);setView({...view,setupSessionId:undefined});setMessage('');}}>Restart bank setup</button>
      :recovery==='in_progress'?<button type="button" data-testid="autopay-bank-refresh" disabled={busy} onClick={()=>void refresh()}>Refresh verification</button>
      :pending&&!finished?<div data-testid="autopay-bank-pending"><p>Bank verification is pending. No payment has started.</p>
      <button type="button" data-testid="autopay-bank-refresh" disabled={busy} onClick={()=>void refresh()}>Refresh verification</button></div>
      :!finished&&<><label><input type="checkbox" data-testid="autopay-bank-consent" checked={accepted} disabled={busy}
        onChange={event=>setAccepted(event.target.checked)}/>{view.offer.consentText}</label>
        <button type="button" data-testid={view.setupSessionId?'autopay-bank-confirm-pay':'autopay-bank-pay'} disabled={busy||!accepted}
          onClick={()=>void submit()}>{view.setupSessionId?'Pay this invoice now':changed?'Authorize the new total':'Pay by bank and set up autopay'}</button></>}
  </section>;
}
