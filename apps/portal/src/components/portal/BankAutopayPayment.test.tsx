// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
vi.mock('@/lib/api',()=>({apiGet:vi.fn(),apiPost:vi.fn()}));
vi.mock('@/lib/navigation',()=>({navigateTo:vi.fn()}));
import {apiGet,apiPost} from '@/lib/api';
import {navigateTo} from '@/lib/navigation';
import BankAutopayPayment from './BankAutopayPayment';
const offer={available:true,principal:'100.00',fee:'0.00',currency:'USD',consentText:'Authorize payment and future automatic payments.',
  disclosureHash:'a'.repeat(64),methodStatus:null,methodLabel:null} as const;
beforeEach(()=>{vi.clearAllMocks();sessionStorage.clear();window.history.replaceState({},'','/');});
afterEach(cleanup);
it('requires consent and stores continuation before Stripe redirect',async()=>{
  vi.mocked(apiPost).mockResolvedValue({data:{data:{url:'https://checkout.stripe.com/c/setup/example'}}});
  render(<BankAutopayPayment target={{invoiceId:'invoice-1',publicToken:'token-1'}} offer={offer}/>);
  expect(screen.getByTestId('autopay-bank-pay')).toBeDisabled();
  fireEvent.click(screen.getByTestId('autopay-bank-consent'));fireEvent.click(screen.getByTestId('autopay-bank-pay'));
  await waitFor(()=>expect(navigateTo).toHaveBeenCalled());
  expect(apiPost).toHaveBeenCalledWith('/invoices/public/token-1/pay',expect.objectContaining({phase:'setup',disclosureHash:offer.disclosureHash}),{redirectOnUnauthorized:false});
  expect(JSON.parse(sessionStorage.getItem('autopay-bank-return')!)).toEqual({invoiceId:'invoice-1',publicToken:'token-1',
    accepted:{principal:offer.principal,fee:offer.fee,currency:offer.currency,disclosureHash:offer.disclosureHash}});
});
it('return reads only until the explicit payment confirmation',async()=>{
  sessionStorage.setItem('autopay-bank-return',JSON.stringify({invoiceId:'invoice-1'}));
  window.history.replaceState({},'','/autopay/return?bank=1&session_id=cs_bank_one');
  vi.mocked(apiGet).mockResolvedValue({data:{invoice:{id:'invoice-1'},bankAutopay:{...offer,methodStatus:'active'}}});
  vi.mocked(apiPost).mockResolvedValue({data:{outcome:'created',attemptId:'attempt-1'}});
  render(<BankAutopayPayment returning/>);await screen.findByTestId('autopay-bank-confirm-pay');
  expect(apiPost).not.toHaveBeenCalled();fireEvent.click(screen.getByTestId('autopay-bank-consent'));
  fireEvent.click(screen.getByTestId('autopay-bank-confirm-pay'));
  await waitFor(()=>expect(apiPost).toHaveBeenCalledWith('/portal/invoices/invoice-1/pay',expect.objectContaining({phase:'collect',setupSessionId:'cs_bank_one'}),{redirectOnUnauthorized:true}));
});
it('pending verification has no charge button or mutation on refresh',async()=>{
  sessionStorage.setItem('autopay-bank-return',JSON.stringify({invoiceId:'invoice-1',setupSessionId:'cs_pending'}));
  vi.mocked(apiGet).mockResolvedValue({data:{invoice:{id:'invoice-1'},bankAutopay:{...offer,methodStatus:'pending_verification'}}});
  render(<BankAutopayPayment returning/>);await screen.findByTestId('autopay-bank-pending');
  expect(screen.queryByTestId('autopay-bank-confirm-pay')).toBeNull();fireEvent.click(screen.getByTestId('autopay-bank-refresh'));
  await waitFor(()=>expect(apiGet).toHaveBeenCalledTimes(2));expect(apiPost).not.toHaveBeenCalled();
});
it.each(['in_progress','abandoned'])('shows explicit %s recovery without automatic collection',async reason=>{
 sessionStorage.setItem('autopay-bank-return',JSON.stringify({invoiceId:'invoice-1',setupSessionId:'cs_bank_one'}));
 vi.mocked(apiGet).mockResolvedValue({data:{invoice:{id:'invoice-1'},bankAutopay:{...offer,methodStatus:'active'}}});
 vi.mocked(apiPost).mockResolvedValue({data:{outcome:'deferred',reason}});
 render(<BankAutopayPayment returning/>);await screen.findByTestId('autopay-bank-confirm-pay');
 fireEvent.click(screen.getByTestId('autopay-bank-consent'));fireEvent.click(screen.getByTestId('autopay-bank-confirm-pay'));
 await waitFor(()=>expect(screen.getByTestId('autopay-bank-result')).toHaveTextContent(reason==='in_progress'?'still being confirmed':'Restart bank setup'));
 expect(screen.queryByTestId('autopay-bank-confirm-pay')).toBeNull();
 if(reason==='abandoned'){fireEvent.click(screen.getByTestId('autopay-bank-restart'));expect(await screen.findByTestId('autopay-bank-pay')).toBeDisabled();}
 else {fireEvent.click(screen.getByTestId('autopay-bank-refresh'));await waitFor(()=>expect(apiGet).toHaveBeenCalledTimes(2));}
 expect(apiPost).toHaveBeenCalledTimes(1);
});
it('retains verification status without a charge button when collection is unavailable',async()=>{
 sessionStorage.setItem('autopay-bank-return',JSON.stringify({invoiceId:'invoice-1',setupSessionId:'cs_pending'}));
 vi.mocked(apiGet).mockResolvedValue({data:{invoice:{id:'invoice-1'},bankAutopay:{...offer,available:false,methodStatus:'pending_verification'}}});
 render(<BankAutopayPayment returning/>);await screen.findByTestId('autopay-bank-pending');
 expect(screen.queryByTestId('autopay-bank-confirm-pay')).toBeNull();expect(apiPost).not.toHaveBeenCalled();
});

it.each(['portal','public'].flatMap(route=>['pending_verification','in_progress','abandoned'].map(reason=>({route,reason}))))(
 'keeps failure feedback and exposes $reason recovery for a $route conflict',async({route,reason})=>{
 const target={invoiceId:'invoice-1',setupSessionId:'cs_bank_one',...(route==='public'?{publicToken:'token-1'}:{})};
 sessionStorage.setItem('autopay-bank-return',JSON.stringify(target));
 const data={invoice:{id:'invoice-1'},bankAutopay:{...offer,methodStatus:'active'}};
 vi.mocked(apiGet).mockResolvedValue({data:route==='public'?{data}:data});
 vi.mocked(apiPost).mockResolvedValue({statusCode:409,error:'Payment has not started. Review the invoice payment status.',errorData:{outcome:'deferred',reason}});
 render(<BankAutopayPayment returning/>);await screen.findByTestId('autopay-bank-confirm-pay');
 fireEvent.click(screen.getByTestId('autopay-bank-consent'));fireEvent.click(screen.getByTestId('autopay-bank-confirm-pay'));
 const control=await screen.findByTestId(reason==='abandoned'?'autopay-bank-restart':'autopay-bank-refresh');
 expect(screen.getByTestId('autopay-bank-result')).toHaveAttribute('role','alert');
 expect(screen.queryByTestId('autopay-bank-confirm-pay')).toBeNull();
 expect(navigateTo).not.toHaveBeenCalled();
 if(reason==='abandoned'){
   fireEvent.click(control);expect(await screen.findByTestId('autopay-bank-pay')).toBeDisabled();
 }else{
   fireEvent.click(control);await waitFor(()=>expect(apiGet).toHaveBeenCalledTimes(2));
 }
 expect(apiPost).toHaveBeenCalledTimes(1);
});
it('keeps an unrecognized conflict as a failure without setup recovery',async()=>{
 vi.mocked(apiPost).mockResolvedValue({statusCode:409,error:'Invoice is not payable',errorData:{outcome:'refused',reason:'invoice_not_payable'}});
 render(<BankAutopayPayment target={{invoiceId:'invoice-1'}} offer={offer}/>);
 fireEvent.click(screen.getByTestId('autopay-bank-consent'));fireEvent.click(screen.getByTestId('autopay-bank-pay'));
 await waitFor(()=>expect(screen.getByTestId('autopay-bank-result')).toHaveTextContent('Invoice is not payable'));
 expect(screen.getByTestId('autopay-bank-result')).toHaveAttribute('role','alert');
 expect(screen.queryByTestId('autopay-bank-restart')).toBeNull();
 expect(screen.queryByTestId('autopay-bank-refresh')).toBeNull();
 expect(navigateTo).not.toHaveBeenCalled();
});

// The authority can be unavailable after microdeposit verification (expired, changed
// terms, replaced method, already used). The page must offer a working restart that
// uses the invoice's CURRENT terms, never a dead end or a stale-terms 409 loop.
it.each([
 ['bank_authorization_expired','expired'],
 ['bank_authorization_changed','no longer matches'],
 ['client_authorization_required','no longer matches'],
 ['bank_authorization_used','already used'],
] as const)('offers a working restart when collection reports %s',async(reason,text)=>{
 sessionStorage.setItem('autopay-bank-return',JSON.stringify({invoiceId:'invoice-1',setupSessionId:'cs_bank_one'}));
 vi.mocked(apiGet).mockResolvedValueOnce({data:{invoice:{id:'invoice-1'},bankAutopay:{...offer,methodStatus:'active'}}});
 vi.mocked(apiPost).mockResolvedValueOnce({statusCode:409,error:'Payment has not started. Review the invoice payment status.',errorData:{outcome:'refused',reason}});
 render(<BankAutopayPayment returning/>);await screen.findByTestId('autopay-bank-confirm-pay');
 fireEvent.click(screen.getByTestId('autopay-bank-consent'));fireEvent.click(screen.getByTestId('autopay-bank-confirm-pay'));
 await waitFor(()=>expect(screen.getByTestId('autopay-bank-result')).toHaveTextContent(text));
 expect(screen.queryByTestId('autopay-bank-confirm-pay')).toBeNull();
 const fresh={...offer,principal:'90.00',disclosureHash:'b'.repeat(64),methodStatus:'active' as const};
 vi.mocked(apiGet).mockResolvedValueOnce({data:{invoice:{id:'invoice-1'},bankAutopay:fresh}});
 fireEvent.click(screen.getByTestId('autopay-bank-restart'));
 const pay=await screen.findByTestId('autopay-bank-pay');expect(pay).toBeDisabled();
 expect(screen.getByTestId('autopay-bank-module')).toHaveTextContent('Invoice payment$90.00');
 vi.mocked(apiPost).mockResolvedValueOnce({data:{url:'https://checkout.stripe.com/c/setup/restart'}});
 fireEvent.click(screen.getByTestId('autopay-bank-consent'));fireEvent.click(pay);
 await waitFor(()=>expect(apiPost).toHaveBeenLastCalledWith('/portal/invoices/invoice-1/pay',
  expect.objectContaining({phase:'setup',principal:'90.00',disclosureHash:'b'.repeat(64)}),{redirectOnUnauthorized:true}));
 expect(vi.mocked(apiPost).mock.lastCall![1]).not.toHaveProperty('setupSessionId');
});

// #7897: the client accepted these exact terms before Stripe; the return does not ask twice.
const accepted={principal:offer.principal,fee:offer.fee,currency:offer.currency,disclosureHash:offer.disclosureHash};
it('stores the accepted terms with the continuation before the Stripe redirect',async()=>{
  vi.mocked(apiPost).mockResolvedValue({data:{url:'https://checkout.stripe.com/c/setup/example'}});
  render(<BankAutopayPayment target={{invoiceId:'invoice-1'}} offer={offer}/>);
  fireEvent.click(screen.getByTestId('autopay-bank-consent'));fireEvent.click(screen.getByTestId('autopay-bank-pay'));
  await waitFor(()=>expect(navigateTo).toHaveBeenCalled());
  expect(JSON.parse(sessionStorage.getItem('autopay-bank-return')!)).toEqual({invoiceId:'invoice-1',accepted});
});
it('returns with the same terms already accepted and pays on one click',async()=>{
  sessionStorage.setItem('autopay-bank-return',JSON.stringify({invoiceId:'invoice-1',accepted}));
  window.history.replaceState({},'','/autopay/return?bank=1&session_id=cs_bank_one');
  vi.mocked(apiGet).mockResolvedValue({data:{invoice:{id:'invoice-1'},bankAutopay:{...offer,methodStatus:'active'}}});
  vi.mocked(apiPost).mockResolvedValue({data:{outcome:'created',attemptId:'attempt-1'}});
  render(<BankAutopayPayment returning/>);
  const pay=await screen.findByTestId('autopay-bank-confirm-pay');
  expect(screen.getByTestId('autopay-bank-consent')).toBeChecked();expect(pay).toBeEnabled();
  expect(screen.queryByTestId('autopay-bank-terms-changed')).toBeNull();expect(apiPost).not.toHaveBeenCalled();
  fireEvent.click(pay);
  await waitFor(()=>expect(apiPost).toHaveBeenCalledWith('/portal/invoices/invoice-1/pay',expect.objectContaining({phase:'collect',
    setupSessionId:'cs_bank_one',fee:offer.fee,disclosureHash:offer.disclosureHash}),{redirectOnUnauthorized:true}));
  expect(await screen.findByTestId('autopay-bank-result')).toHaveTextContent('Bank payment started');
});
it.each([[{accepted:{...accepted,disclosureHash:'b'.repeat(64)}},'changed terms'],[{},'no recorded acceptance'],
  [{accepted:{principal:100}},'a malformed record']] as const)('asks for a fresh tick on return with %#: %s',async(extra,_label)=>{
  sessionStorage.setItem('autopay-bank-return',JSON.stringify({invoiceId:'invoice-1',...extra}));
  window.history.replaceState({},'','/autopay/return?bank=1&session_id=cs_bank_one');
  vi.mocked(apiGet).mockResolvedValue({data:{invoice:{id:'invoice-1'},bankAutopay:{...offer,methodStatus:'active'}}});
  render(<BankAutopayPayment returning/>);
  await waitFor(()=>expect(screen.getByTestId('autopay-bank-consent')).not.toBeChecked());
  expect(screen.queryByTestId('autopay-bank-confirm-pay')??screen.getByTestId('autopay-bank-pay')).toBeDisabled();
});

// #7896: a fee change after authorization is shown, and the new total is authorized afresh.
const lowered={...offer,fee:'2.00',disclosureHash:'c'.repeat(64),methodStatus:'active' as const,
  consentText:'I authorize a bank payment of USD 100.00, plus a processing fee of USD 2.00, for this invoice.'};
async function restartsAtNewTotal(notCharged:boolean){
  const change=await screen.findByTestId('autopay-bank-terms-changed');
  expect(change).toHaveTextContent('The processing fee changed from $2.50 to $2.00.');
  expect(change).toHaveTextContent('New total: $102.00.');
  // Only a server answer that never debits may say so; a return alone proves nothing.
  if(notCharged)expect(change).toHaveTextContent('Your bank account was not charged.');
  else expect(change).not.toHaveTextContent('not charged');
  expect(screen.queryByTestId('autopay-bank-confirm-pay')).toBeNull();
  const restart=screen.getByTestId('autopay-bank-pay');expect(restart).toBeDisabled();
  expect(screen.getByTestId('autopay-bank-consent')).not.toBeChecked();
  expect(screen.getByTestId('autopay-bank-module')).toHaveTextContent(lowered.consentText);
  vi.mocked(apiPost).mockResolvedValue({data:{url:'https://checkout.stripe.com/c/setup/reauth'}});
  fireEvent.click(screen.getByTestId('autopay-bank-consent'));fireEvent.click(restart);
  await waitFor(()=>expect(navigateTo).toHaveBeenCalledWith('https://checkout.stripe.com/c/setup/reauth'));
  const sent=vi.mocked(apiPost).mock.calls.at(-1)![1] as Record<string,unknown>;
  expect(sent).toMatchObject({phase:'setup',principal:'100.00',fee:'2.00',disclosureHash:lowered.disclosureHash});
  expect(sent).not.toHaveProperty('setupSessionId');
  expect(JSON.parse(sessionStorage.getItem('autopay-bank-return')!)).toEqual({invoiceId:'invoice-1',
    accepted:{principal:'100.00',fee:'2.00',currency:'USD',disclosureHash:lowered.disclosureHash}});
}
it('shows a fee change found on return and re-authorizes the new total',async()=>{
  sessionStorage.setItem('autopay-bank-return',JSON.stringify({invoiceId:'invoice-1',accepted:{...accepted,fee:'2.50'}}));
  window.history.replaceState({},'','/autopay/return?bank=1&session_id=cs_bank_one');
  vi.mocked(apiGet).mockResolvedValue({data:{invoice:{id:'invoice-1'},bankAutopay:lowered}});
  render(<BankAutopayPayment returning/>);
  await restartsAtNewTotal(false);
});
it.each([
  ['a cancelled attempt',{statusCode:409,error:'Payment has not started. Review the invoice payment status.',errorData:{outcome:'canceled',reason:'canceled'}}],
  ['a refused authorization',{statusCode:409,error:'Payment has not started. Review the invoice payment status.',errorData:{outcome:'refused',reason:'client_authorization_required'}}],
])('turns %s after a fee change into a re-authorization, not a dead end',async(_label,response)=>{
  const before={...offer,fee:'2.50',methodStatus:'active' as const};
  sessionStorage.setItem('autopay-bank-return',JSON.stringify({invoiceId:'invoice-1',accepted:{...accepted,fee:'2.50'}}));
  window.history.replaceState({},'','/autopay/return?bank=1&session_id=cs_bank_one');
  vi.mocked(apiGet).mockResolvedValueOnce({data:{invoice:{id:'invoice-1'},bankAutopay:before}})
    .mockResolvedValue({data:{invoice:{id:'invoice-1'},bankAutopay:lowered}});
  vi.mocked(apiPost).mockResolvedValueOnce(response);
  render(<BankAutopayPayment returning/>);
  fireEvent.click(await screen.findByTestId('autopay-bank-confirm-pay'));
  await restartsAtNewTotal(true);
  expect(apiGet).toHaveBeenCalledTimes(2);
});
it.each([
  ['a spent authorization',{statusCode:409,error:'Bank authorization unavailable',code:'INVALID_STATE'}],
  ['a collection already in progress',{statusCode:409,error:'Payment has not started. Review the invoice payment status.',errorData:{outcome:'deferred',reason:'collection_in_progress'}}],
  ['a card checkout that may have charged',{statusCode:409,error:'Payment has not started. Review the invoice payment status.',errorData:{outcome:'deferred',reason:'checkout_session_unrevoked'}}],
])('never offers a new authorization after %s, which cannot prove nothing was debited',async(_label,response)=>{
  sessionStorage.setItem('autopay-bank-return',JSON.stringify({invoiceId:'invoice-1',accepted:{...accepted,fee:'2.50'}}));
  window.history.replaceState({},'','/autopay/return?bank=1&session_id=cs_bank_one');
  vi.mocked(apiGet).mockResolvedValueOnce({data:{invoice:{id:'invoice-1'},bankAutopay:{...offer,fee:'2.50',methodStatus:'active'}}})
    .mockResolvedValue({data:{invoice:{id:'invoice-1'},bankAutopay:lowered}});
  vi.mocked(apiPost).mockResolvedValueOnce(response);
  render(<BankAutopayPayment returning/>);
  fireEvent.click(await screen.findByTestId('autopay-bank-confirm-pay'));
  await waitFor(()=>expect(screen.getByTestId('autopay-bank-result')).toHaveTextContent(response.error));
  expect(screen.getByTestId('autopay-bank-result')).toHaveAttribute('role','alert');
  expect(screen.queryByTestId('autopay-bank-terms-changed')).toBeNull();expect(apiGet).toHaveBeenCalledTimes(1);
});
it('keeps the honest failure when the terms did not change',async()=>{
  sessionStorage.setItem('autopay-bank-return',JSON.stringify({invoiceId:'invoice-1',accepted}));
  window.history.replaceState({},'','/autopay/return?bank=1&session_id=cs_bank_one');
  vi.mocked(apiGet).mockResolvedValue({data:{invoice:{id:'invoice-1'},bankAutopay:{...offer,methodStatus:'active'}}});
  vi.mocked(apiPost).mockResolvedValue({statusCode:409,error:'Payment has not started. Review the invoice payment status.',errorData:{outcome:'canceled',reason:'canceled'}});
  render(<BankAutopayPayment returning/>);
  fireEvent.click(await screen.findByTestId('autopay-bank-confirm-pay'));
  await waitFor(()=>expect(screen.getByTestId('autopay-bank-result')).toHaveTextContent('Payment has not started'));
  expect(screen.queryByTestId('autopay-bank-terms-changed')).toBeNull();
});

// The abandoned-setup restart used the offer read at return time; changed terms then
// failed setup with "The terms changed" on every click. It now reloads the current offer.
it('restarts an abandoned setup against the current offer, not the stale one',async()=>{
 sessionStorage.setItem('autopay-bank-return',JSON.stringify({invoiceId:'invoice-1',setupSessionId:'cs_bank_one'}));
 vi.mocked(apiGet).mockResolvedValueOnce({data:{invoice:{id:'invoice-1'},bankAutopay:{...offer,methodStatus:'active'}}});
 vi.mocked(apiPost).mockResolvedValueOnce({data:{outcome:'deferred',reason:'abandoned'}});
 render(<BankAutopayPayment returning/>);await screen.findByTestId('autopay-bank-confirm-pay');
 fireEvent.click(screen.getByTestId('autopay-bank-consent'));fireEvent.click(screen.getByTestId('autopay-bank-confirm-pay'));
 const fresh={...offer,fee:'2.00',disclosureHash:'d'.repeat(64),methodStatus:'active' as const};
 vi.mocked(apiGet).mockResolvedValueOnce({data:{invoice:{id:'invoice-1'},bankAutopay:fresh}});
 fireEvent.click(await screen.findByTestId('autopay-bank-restart'));
 const pay=await screen.findByTestId('autopay-bank-pay');expect(pay).toBeDisabled();
 vi.mocked(apiPost).mockResolvedValueOnce({data:{url:'https://checkout.stripe.com/c/setup/again'}});
 fireEvent.click(screen.getByTestId('autopay-bank-consent'));fireEvent.click(pay);
 await waitFor(()=>expect(apiPost).toHaveBeenLastCalledWith('/portal/invoices/invoice-1/pay',
  expect.objectContaining({phase:'setup',fee:'2.00',disclosureHash:'d'.repeat(64)}),{redirectOnUnauthorized:true}));
});
