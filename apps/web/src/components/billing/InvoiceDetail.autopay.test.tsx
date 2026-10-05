import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const h=vi.hoisted(()=>({fetch:vi.fn(),toast:vi.fn(),can:vi.fn(()=>true)}));
vi.mock('../../stores/auth',()=>({fetchWithAuth:h.fetch,useAuthStore:Object.assign((s:any)=>s({user:{permissions:[{resource:'*',action:'*'}]}}),{getState:()=>({tokens:null})})}));
vi.mock('../../lib/permissions',()=>({usePermissions:()=>({can:h.can})}));
vi.mock('../shared/Toast',()=>({showToast:h.toast}));
vi.mock('@/lib/navigation',()=>({navigateTo:vi.fn()}));
import InvoiceDetail from './InvoiceDetail';
const autopay={state:'scheduled',reason:null,collectOn:'2026-10-15',noticeSentAt:null,excluded:false,canExclude:true,canChargeNow:false,chargePreview:{amount:'10.00',currency:'USD',methodLabel:'Visa ••4242'},processing:false,unapplied:false};
const detail:any={invoice:{id:'inv',status:'sent',invoiceNumber:'INV-1',currencyCode:'USD',balance:'10.00',total:'10.00',subtotal:'10.00',taxTotal:'0.00',amountPaid:'0.00',billToName:'Customer'},lines:[],stripeConnected:false,autopay};
afterEach(()=>{cleanup();vi.clearAllMocks();h.can.mockReturnValue(true);});
it('saves an exclusion through runAction and refreshes the invoice',async()=>{h.fetch.mockImplementation(async()=>({ok:true,status:200,json:async()=>({data:[]})}));const changed=vi.fn();render(<InvoiceDetail detail={detail} onChanged={changed}/>);fireEvent.click(screen.getByTestId('autopay-invoice-excluded'));await waitFor(()=>expect(changed).toHaveBeenCalledOnce());expect(h.fetch).toHaveBeenCalledWith('/invoices/inv/autopay',expect.objectContaining({method:'PATCH',body:'{"excluded":true}'}));expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({type:'success'}));});
it('hides the disabled idle panel',()=>{h.fetch.mockResolvedValue({ok:true,json:async()=>({data:[]})});render(<InvoiceDetail detail={{...detail,autopay:null}} onChanged={()=>{}}/>);expect(screen.queryByTestId('autopay-invoice-panel')).toBeNull();});
it('retains a read-only processing panel',()=>{h.fetch.mockResolvedValue({ok:true,json:async()=>({data:[]})});render(<InvoiceDetail detail={{...detail,autopay:{...autopay,processing:true,canExclude:false}}} onChanged={()=>{}}/>);expect(screen.getByTestId('autopay-invoice-excluded')).toBeDisabled();});
it('surfaces failed saves',async()=>{h.fetch.mockImplementation(async(_url:string,opts?:RequestInit)=>({ok:opts?.method!=='PATCH',status:opts?.method==='PATCH'?409:200,json:async()=>opts?.method==='PATCH'?{error:'Control pending'}:{data:[]}}));render(<InvoiceDetail detail={detail} onChanged={()=>{}}/>);fireEvent.click(screen.getByTestId('autopay-invoice-excluded'));await waitFor(()=>expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({type:'error'})));});
it('translates pending controls without treating their colon as an i18n namespace',()=>{
 h.fetch.mockResolvedValue({ok:true,json:async()=>({data:[]})});
 render(<InvoiceDetail detail={{...detail,autopay:{...autopay,reason:'control_pending:skip',canExclude:false}}} onChanged={()=>{}}/>);
 expect(screen.getByTestId('autopay-invoice-panel')).toHaveTextContent('Skip requested; stopping the pending payment');
});

it('Charge now reports a conflict without refreshing or claiming payment',async()=>{
 h.fetch.mockImplementation(async (_url:string,opts?:RequestInit)=>({ok:opts?.method!=='POST',status:opts?.method==='POST'?409:200,json:async()=>opts?.method==='POST'?{error:'notice_lead'}:{data:[]}}));
 const changed=vi.fn();render(<InvoiceDetail detail={{...detail,autopay:{...autopay,canChargeNow:true}}} onChanged={changed}/>);
 fireEvent.click(screen.getByTestId('autopay-charge-now'));
 expect(h.fetch.mock.calls.filter(([,opts])=>opts?.method==='POST')).toHaveLength(0);
 expect(screen.getByTestId('autopay-charge-dialog')).toHaveTextContent('INV-1');
 expect(screen.getByTestId('autopay-charge-dialog')).toHaveTextContent('Visa ••4242');
 expect(screen.getByTestId('autopay-charge-dialog')).toHaveTextContent('$10.00');
 fireEvent.click(screen.getByTestId('autopay-charge-confirm'));
 await waitFor(()=>expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({type:'error'})));
 expect(h.fetch).toHaveBeenCalledWith('/invoices/inv/autopay/charge-now',{method:'POST'});expect(changed).not.toHaveBeenCalled();
});
it('Charge now disables duplicate clicks until the request finishes',async()=>{
 let finish!: (value:any)=>void;
 h.fetch.mockImplementation(async (_url:string,opts?:RequestInit)=>opts?.method==='POST'?new Promise(resolve=>{finish=resolve;}):{ok:true,json:async()=>({data:[]})});
 const changed=vi.fn();render(<InvoiceDetail detail={{...detail,autopay:{...autopay,canChargeNow:true}}} onChanged={changed}/>);
 fireEvent.click(screen.getByTestId('autopay-charge-now'));
 expect(h.fetch.mock.calls.filter(([,opts])=>opts?.method==='POST')).toHaveLength(0);
 expect(screen.getByTestId('autopay-charge-dialog')).toHaveTextContent('INV-1');
 expect(screen.getByTestId('autopay-charge-dialog')).toHaveTextContent('Visa ••4242');
 expect(screen.getByTestId('autopay-charge-dialog')).toHaveTextContent('$10.00');
 fireEvent.click(screen.getByTestId('autopay-charge-confirm'));expect(screen.getByTestId('autopay-charge-now')).toBeDisabled();
 finish({ok:true,status:200,json:async()=>({data:{outcome:'created'}})});
 await waitFor(()=>expect(changed).toHaveBeenCalledOnce());
 expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({type:'success',message:'Payment attempt started'}));
});

it('reports a pending exclusion instead of saved',async()=>{
 h.fetch.mockImplementation(async(_url:string,opts?:RequestInit)=>({ok:true,status:opts?.method==='PATCH'?202:200,json:async()=>opts?.method==='PATCH'?{status:'pending',control:'exclude'}:{data:[]}}));
 render(<InvoiceDetail detail={detail} onChanged={()=>{}}/>);fireEvent.click(screen.getByTestId('autopay-invoice-excluded'));
 await waitFor(()=>expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({message:'Exclusion requested; stopping the pending payment'})));
});

const chargeable={...detail,autopay:{...autopay,canChargeNow:true}};
function chargeWith(post:{status:number;body:unknown}){
 h.fetch.mockImplementation(async (_url:string,opts?:RequestInit)=>opts?.method==='POST'
  ?{ok:post.status<300,status:post.status,json:async()=>post.body}:{ok:true,status:200,json:async()=>({data:[]})});
}
const paymentReads=()=>h.fetch.mock.calls.filter(([url,opts])=>url==='/invoices/inv/payments'&&!opts?.method).length;
it.each([
 ['succeeded','Payment received.'],
 ['processing','Payment submitted. It is processing'],
])('Charge now reports a %s charge as such and reloads the payments list',async(state,message)=>{
 chargeWith({status:200,body:{data:{outcome:'created',attemptId:'a',state}}});
 const changed=vi.fn();render(<InvoiceDetail detail={chargeable} onChanged={changed}/>);
 await waitFor(()=>expect(paymentReads()).toBe(1));
 fireEvent.click(screen.getByTestId('autopay-charge-now'));fireEvent.click(screen.getByTestId('autopay-charge-confirm'));
 await waitFor(()=>expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({type:'success',message:expect.stringContaining(message)})));
 await waitFor(()=>expect(paymentReads()).toBe(2));
 expect(changed).toHaveBeenCalledOnce();
 expect(h.toast).not.toHaveBeenCalledWith(expect.objectContaining({message:'Payment attempt started'}));
});
it('Charge now explains a 3DS confirmation request instead of printing the provider code, and refreshes',async()=>{
 chargeWith({status:409,body:{error:'authentication_required',code:'authentication_required',outcome:'requires_action'}});
 const changed=vi.fn();render(<InvoiceDetail detail={chargeable} onChanged={changed}/>);
 fireEvent.click(screen.getByTestId('autopay-charge-now'));fireEvent.click(screen.getByTestId('autopay-charge-confirm'));
 await waitFor(()=>expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({type:'error',message:expect.stringContaining('confirm this payment')})));
 expect(h.toast).not.toHaveBeenCalledWith(expect.objectContaining({message:expect.stringContaining('authentication_required')}));
 await waitFor(()=>expect(changed).toHaveBeenCalledOnce());
});
it('Charge now names a decline and a deferral in plain words',async()=>{
 chargeWith({status:409,body:{error:'card_declined',code:'card_declined',outcome:'failed'}});
 const {unmount}=render(<InvoiceDetail detail={chargeable} onChanged={()=>{}}/>);
 fireEvent.click(screen.getByTestId('autopay-charge-now'));fireEvent.click(screen.getByTestId('autopay-charge-confirm'));
 await waitFor(()=>expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({type:'error',message:'The card was declined.'})));
 unmount();h.toast.mockClear();
 chargeWith({status:409,body:{error:'collection_in_progress',code:'collection_in_progress',outcome:'deferred'}});
 const changed=vi.fn();render(<InvoiceDetail detail={chargeable} onChanged={changed}/>);
 fireEvent.click(screen.getByTestId('autopay-charge-now'));fireEvent.click(screen.getByTestId('autopay-charge-confirm'));
 await waitFor(()=>expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({type:'error',message:'A payment for this invoice is already in progress.'})));
 expect(changed).not.toHaveBeenCalled();
});
it('Charge now explains an unfinished notice period',async()=>{
 chargeWith({status:409,body:{error:'notice_lead',code:'INVALID_STATE'}});
 render(<InvoiceDetail detail={chargeable} onChanged={()=>{}}/>);
 fireEvent.click(screen.getByTestId('autopay-charge-now'));fireEvent.click(screen.getByTestId('autopay-charge-confirm'));
 await waitFor(()=>expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({type:'error',message:expect.stringContaining('notice period has not ended')})));
});
it.each([
 ['paid','0.00'],['void','10.00'],['draft','10.00'],['sent','0.00'],
])('hides Charge now on a %s invoice with balance %s',(status,balance)=>{
 h.fetch.mockResolvedValue({ok:true,status:200,json:async()=>({data:[]})});
 render(<InvoiceDetail detail={{...detail,invoice:{...detail.invoice,status,balance},autopay:{...autopay,state:'succeeded',canChargeNow:false}}} onChanged={()=>{}}/>);
 expect(screen.getByTestId('autopay-invoice-panel')).toBeInTheDocument();
 expect(screen.queryByTestId('autopay-charge-now')).toBeNull();
});
it('explains an exclusion refused because the payment is already processing',async()=>{
 h.fetch.mockImplementation(async(_url:string,opts?:RequestInit)=>({ok:opts?.method!=='PATCH',status:opts?.method==='PATCH'?409:200,
  json:async()=>opts?.method==='PATCH'?{error:'A payment for this invoice is already processing and can\'t be stopped.',code:'COLLECTION_IN_PROGRESS',details:{reason:'payment_processing'}}:{data:[]}}));
 const changed=vi.fn();render(<InvoiceDetail detail={detail} onChanged={changed}/>);fireEvent.click(screen.getByTestId('autopay-invoice-excluded'));
 await waitFor(()=>expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({type:'error',
  message:"This invoice's payment is already processing and can't be stopped. You can exclude the invoice once the payment completes or fails."})));
 expect(changed).not.toHaveBeenCalled();
});
it('keeps the server message for other exclusion conflicts',async()=>{
 h.fetch.mockImplementation(async(_url:string,opts?:RequestInit)=>({ok:opts?.method!=='PATCH',status:opts?.method==='PATCH'?409:200,
  json:async()=>opts?.method==='PATCH'?{error:'Another payment control is pending',code:'COLLECTION_IN_PROGRESS'}:{data:[]}}));
 render(<InvoiceDetail detail={detail} onChanged={()=>{}}/>);fireEvent.click(screen.getByTestId('autopay-invoice-excluded'));
 await waitFor(()=>expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({type:'error',message:'Another payment control is pending'})));
});

// R4: Charge now confirms with Stripe synchronously, so a lost response can follow money
// moving. Never say "please try again"; say the result is unknown and refresh the invoice.
it.each([
 ['a network failure',()=>h.fetch.mockImplementation(async(_url:string,opts?:RequestInit)=>{
  if(opts?.method==='POST')throw new TypeError('Failed to fetch');return {ok:true,status:200,json:async()=>({data:[]})};})],
 ['a 504 with no JSON body',()=>h.fetch.mockImplementation(async(_url:string,opts?:RequestInit)=>opts?.method==='POST'
  ?{ok:false,status:504,json:async()=>{throw new SyntaxError('Unexpected token <');}}:{ok:true,status:200,json:async()=>({data:[]})})],
 ['a 500 with an error body',()=>chargeWith({status:500,body:{error:'Internal server error'}})],
])('Charge now treats %s as an unknown result and refreshes the invoice',async(_case,arrange)=>{
 arrange();
 const changed=vi.fn();render(<InvoiceDetail detail={chargeable} onChanged={changed}/>);
 await waitFor(()=>expect(paymentReads()).toBe(1));
 fireEvent.click(screen.getByTestId('autopay-charge-now'));fireEvent.click(screen.getByTestId('autopay-charge-confirm'));
 await waitFor(()=>expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({message:expect.stringContaining('could not confirm')})));
 expect(h.toast).not.toHaveBeenCalledWith(expect.objectContaining({message:expect.stringContaining('try again')}));
 expect(h.toast).toHaveBeenCalledTimes(1);
 await waitFor(()=>expect(changed).toHaveBeenCalledOnce());
 await waitFor(()=>expect(paymentReads()).toBe(2));
});
