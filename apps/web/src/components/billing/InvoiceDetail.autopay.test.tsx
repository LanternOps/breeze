import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const h=vi.hoisted(()=>({fetch:vi.fn(),toast:vi.fn(),can:vi.fn(()=>true)}));
vi.mock('../../stores/auth',()=>({fetchWithAuth:h.fetch,useAuthStore:Object.assign((s:any)=>s({user:{permissions:[{resource:'*',action:'*'}]}}),{getState:()=>({tokens:null})})}));
vi.mock('../../lib/permissions',()=>({usePermissions:()=>({can:h.can})}));
vi.mock('../shared/Toast',()=>({showToast:h.toast}));
vi.mock('@/lib/navigation',()=>({navigateTo:vi.fn()}));
import InvoiceDetail from './InvoiceDetail';
const autopay={state:'scheduled',reason:null,collectOn:'2026-10-15',noticeSentAt:null,excluded:false,canExclude:true,canChargeNow:false,processing:false,unapplied:false};
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
 await waitFor(()=>expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({type:'error'})));
 expect(h.fetch).toHaveBeenCalledWith('/invoices/inv/autopay/charge-now',{method:'POST'});expect(changed).not.toHaveBeenCalled();
});
it('Charge now disables duplicate clicks until the request finishes',async()=>{
 let finish!: (value:any)=>void;
 h.fetch.mockImplementation(async (_url:string,opts?:RequestInit)=>opts?.method==='POST'?new Promise(resolve=>{finish=resolve;}):{ok:true,json:async()=>({data:[]})});
 const changed=vi.fn();render(<InvoiceDetail detail={{...detail,autopay:{...autopay,canChargeNow:true}}} onChanged={changed}/>);
 fireEvent.click(screen.getByTestId('autopay-charge-now'));expect(screen.getByTestId('autopay-charge-now')).toBeDisabled();
 finish({ok:true,status:200,json:async()=>({data:{outcome:'created'}})});
 await waitFor(()=>expect(changed).toHaveBeenCalledOnce());
 expect(h.toast).toHaveBeenCalledWith(expect.objectContaining({type:'success',message:'Payment attempt started'}));
});
