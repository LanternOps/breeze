import {useEffect,useState} from 'react';
import {apiGet,apiPost,type ApiResponse,type BankAutopayOffer} from '@/lib/api';
import {runAction} from '@/lib/runAction';
import {navigateTo} from '@/lib/navigation';
type Target={invoiceId:string;publicToken?:string};
type View={target:Target;offer:BankAutopayOffer;setupSessionId?:string};
type Result={url?:string;attemptId?:string|null;outcome?:'created'|'deferred'|'refused';reason?:string};
const key='autopay-bank-return';
const path=(target:Target)=>target.publicToken?`/invoices/public/${encodeURIComponent(target.publicToken)}`:`/portal/invoices/${encodeURIComponent(target.invoiceId)}`;
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
  const outcome=(text:string,error:boolean)=>{setMessage(text);setFailed(error);};
  useEffect(()=>{if(!returning){setView(target&&offer?{target,offer}:null);setAccepted(false);}},
    [target?.invoiceId,target?.publicToken,offer,returning]);
  useEffect(()=>{
    if(!returning)return;let canceled=false;
    try{
      const stored=JSON.parse(sessionStorage.getItem(key)??'null') as (Target&{setupSessionId?:string})|null;
      const session=new URLSearchParams(window.location.search).get('session_id')??stored?.setupSessionId;
      if(!stored||typeof stored.invoiceId!=='string'||(stored.publicToken!==undefined&&typeof stored.publicToken!=='string')||!session||!/^cs_[A-Za-z0-9_]+$/.test(session))throw new Error();
      sessionStorage.setItem(key,JSON.stringify({...stored,setupSessionId:session}));
      void read(stored).then(response=>{
        if(canceled)return;
        if(response.data?.invoice.id!==stored.invoiceId||!response.data.bankAutopay)throw new Error();
        setView({target:stored,offer:response.data.bankAutopay,setupSessionId:session});
      }).catch(()=>{if(!canceled)outcome('Could not reload the invoice. Refresh to try again.',true);});
    }catch{outcome('This return is incomplete. Open the invoice and try again.',true);}
    return()=>{canceled=true;};
  },[returning]);
  async function refresh(){
    if(!view||busy)return;setBusy(true);
    try{const result=await read(view.target);if(result.data?.invoice.id!==view.target.invoiceId||!result.data.bankAutopay)throw new Error();
      setView({...view,offer:result.data.bankAutopay});setAccepted(false);setRecovery(null);
    }catch{outcome('Could not check verification.',true);}finally{setBusy(false);}
  }
  async function submit(){
    if(!view||!accepted||busy||finished)return;setBusy(true);
    const collecting=!!view.setupSessionId;
    if(!collecting){try{sessionStorage.setItem(key,JSON.stringify(view.target));}
      catch{outcome('Enable session storage to return securely.',true);setBusy(false);return;}}
    const result=await runAction<Result>({request:async()=>unwrap(await apiPost<Result|{data:Result}>(`${path(view.target)}/pay`,{
      methodType:'us_bank_account',phase:collecting?'collect':'setup',consentAccepted:true,disclosureHash:view.offer.disclosureHash,
      principal:view.offer.principal,fee:view.offer.fee,currency:view.offer.currency,...(collecting?{setupSessionId:view.setupSessionId}:{}),
    },{redirectOnUnauthorized:!view.target.publicToken}),!!view.target.publicToken),onOutcome:outcome,
      successMessage:collecting?'Payment request checked.':'Opening secure bank setup…',errorFallback:'Could not start bank payment.',
      validate:value=>collecting?['created','deferred','refused'].includes(value.outcome??''):
        typeof value.url==='string'&&value.url.startsWith('https://checkout.stripe.com/')});
    setBusy(false);if(!result)return;
    if(!collecting&&result.url){void navigateTo(result.url);return;}
    if(result.outcome==='created'){try{sessionStorage.removeItem(key);}catch{}setFinished(true);
      outcome('Bank payment started. Processing may take several days.',false);return;}
    if(result.reason==='pending_verification'){setView({...view,offer:{...view.offer,methodStatus:'pending_verification'}});
      setAccepted(false);outcome('Bank verification is pending. No payment has started.',false);return;}
    if(result.reason==='in_progress'||result.reason==='abandoned'){setRecovery(result.reason);setAccepted(false);
      outcome(result.reason==='in_progress'?'Your bank setup is still being confirmed. Refresh verification before trying again.':'Bank setup was not completed. Restart bank setup to continue.',false);return;}
    outcome('Payment has not started. Refresh the invoice to check its status.',true);
  }
  if(!view)return returning?<p role="status" data-testid="autopay-bank-return-status">{message||'Loading invoice…'}</p>:null;
  const pending=!!view.setupSessionId&&view.offer.methodStatus==='pending_verification';
  if(!view.offer.available&&!pending)return <p data-testid="autopay-bank-unavailable">Bank payment is unavailable for this invoice.</p>;
  return <section data-testid="autopay-bank-module" className="space-y-3">
    <h2>Pay by bank and set up autopay</h2>
    <p>Invoice payment: {view.offer.currency} {view.offer.principal}. Processing fee: {view.offer.currency} {view.offer.fee}.</p>
    {message&&<p role={failed?'alert':'status'} data-testid="autopay-bank-result">{message}</p>}
    {recovery==='abandoned'?<button type="button" data-testid="autopay-bank-restart" disabled={busy} onClick={()=>{setRecovery(null);setAccepted(false);setView({...view,setupSessionId:undefined});setMessage('');}}>Restart bank setup</button>
      :recovery==='in_progress'?<button type="button" data-testid="autopay-bank-refresh" disabled={busy} onClick={()=>void refresh()}>Refresh verification</button>
      :pending&&!finished?<div data-testid="autopay-bank-pending"><p>Bank verification is pending. No payment has started.</p>
      <button type="button" data-testid="autopay-bank-refresh" disabled={busy} onClick={()=>void refresh()}>Refresh verification</button></div>
      :!finished&&<><label><input type="checkbox" data-testid="autopay-bank-consent" checked={accepted} disabled={busy}
        onChange={event=>setAccepted(event.target.checked)}/>{view.offer.consentText}</label>
        <button type="button" data-testid={view.setupSessionId?'autopay-bank-confirm-pay':'autopay-bank-pay'} disabled={busy||!accepted}
          onClick={()=>void submit()}>{view.setupSessionId?'Pay this invoice now':'Pay by bank and set up autopay'}</button></>}
  </section>;
}
