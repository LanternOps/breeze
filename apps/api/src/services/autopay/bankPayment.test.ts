import { expect, it, vi } from 'vitest';
import { getClientPaymentAuthority, withClientPaymentAuthority } from './clientPaymentAuthority';
it('isolates each client authorization and restores the empty context', async () => {
  const base = { tokenId: '10000000-0000-4000-8000-000000000001', generation: 1,
    principal: '100.00', fee: '0.00', currency: 'USD', methodId: 'pm_local' };
  const result = await Promise.all(['invoice-a','invoice-b'].map(invoiceId =>
    withClientPaymentAuthority({ ...base, invoiceId }, async () => {
      await Promise.resolve();
      return getClientPaymentAuthority()?.invoiceId;
    })));
  expect(result).toEqual(['invoice-a','invoice-b']);
  expect(getClientPaymentAuthority()).toBeUndefined();
});

import {bankPaySchema} from './bankPayment';
it('requires consent, an unchanged disclosure, decimal amounts, and a session for collect',()=>{
  const base={methodType:'us_bank_account',phase:'setup',consentAccepted:true,disclosureHash:'a'.repeat(64),principal:'100.00',fee:'0.00',currency:'USD'};
  expect(bankPaySchema.safeParse(base).success).toBe(true);
  for(const patch of [{consentAccepted:false},{disclosureHash:''},{principal:100},{currency:'EUR'},{phase:'collect'}]){
    expect(bankPaySchema.safeParse({...base,...patch}).success).toBe(false);
  }
  expect(bankPaySchema.safeParse({...base,phase:'collect',setupSessionId:'cs_test_1'}).success).toBe(true);
});

const bank=vi.hoisted(()=>({rows:[] as unknown[][],disclosure:vi.fn(),quote:vi.fn(),session:vi.fn(),intent:vi.fn()}));
vi.mock('../../db',()=>({db:{select:()=>({from:()=>({where:()=>({limit:async()=>bank.rows.shift()})})})},
  withSystemDbAccessContext:async(fn:()=>Promise<unknown>)=>fn(),runOutsideDbContext:async(fn:()=>Promise<unknown>)=>fn()}));
vi.mock('./autopayGate',()=>({isAutopayEnabledForPartner:vi.fn(async()=>true)}));
vi.mock('./stripeCapabilities',()=>({getAutopayStripeReadiness:vi.fn(async()=>({ready:true,accountCountry:'US',stripeAccountId:'acct_test'}))}));
vi.mock('./billingPaymentSettings',()=>({resolveBillingPaymentSettings:vi.fn(async()=>({achMode:{value:'ach_preferred'},
  cardFeeBps:{value:0},achFeeAmount:{value:'0.00'},feeAttested:false}))}));
vi.mock('./consentText',()=>({buildAutopayDisclosure:bank.disclosure,withAcceptedAutopayDisclosure:vi.fn()}));
vi.mock('./processingFee',()=>({quoteProcessingFee:bank.quote}));
vi.mock('./paymentMethods',()=>({getAutopayMethod:vi.fn(async()=>null)}));
vi.mock('./enrollmentService',()=>({createAutopaySetupSession:vi.fn(),completeAutopaySetup:vi.fn()}));
import {getBankAutopayOffer} from './bankPayment';
it.each(['card_only','ach_preferred','ach_only'] as const)('admits bank pay using derived %s availability',async achMode=>{
  vi.clearAllMocks();
  bank.rows=[[{id:'invoice',orgId:'org',partnerId:'partner',currencyCode:'USD',status:'sent',balance:'100.00'}],
    [{status:'active',stripeAccountId:'acct_test'}],[{id:'org',status:'active',deletedAt:null,currencyCode:achMode==='card_only'?'EUR':'USD'}],[]];
  bank.disclosure.mockResolvedValue({achMode,hash:'a'.repeat(64),text:'Accepted bank terms'});
  bank.quote.mockReturnValue({feeAmount:'0.00'});
  const offer=await getBankAutopayOffer('invoice','org');
  expect(bank.disclosure).toHaveBeenCalledOnce();
  if(achMode==='card_only') {expect(offer).toBeNull();expect(bank.quote).not.toHaveBeenCalled();}
  else {expect(offer).toMatchObject({available:true,fee:'0.00',disclosureHash:'a'.repeat(64)});}
});

vi.mock('../invoicePdf',()=>({resolveBillingEmail:vi.fn()}));
vi.mock('../partnerStripe',()=>({getPartnerStripeClient:vi.fn()}));
vi.mock('../stripeSettle',()=>({assertNoHeldDbContextForStripe:vi.fn()}));
vi.mock('./linkTokens',()=>({mintBillingLinkToken:vi.fn()}));
vi.mock('./collectionEngine',()=>({attemptCollection:vi.fn()}));
vi.mock('./reservation',()=>({readInFlightCollection:vi.fn(async()=>({inProgress:false}))}));

import {collectAfterBankSetup,invoicePaySchema,startInvoiceBankSetup} from './bankPayment';
import {getPartnerStripeClient} from '../partnerStripe';
import {completeAutopaySetup,createAutopaySetupSession} from './enrollmentService';
import {getAutopayMethod} from './paymentMethods';
import {attemptCollection} from './collectionEngine';
import {readInFlightCollection} from './reservation';
const invoice={id:'10000000-0000-4000-8000-000000000001',orgId:'20000000-0000-4000-8000-000000000001',partnerId:'partner',currencyCode:'USD',status:'sent',balance:'100.00'};
const accepted={invoiceId:invoice.id,orgId:invoice.orgId,principal:'100.00',fee:'0.00',currency:'USD',disclosureHash:'a'.repeat(64)};
const token={id:'token',invoiceId:invoice.id,orgId:invoice.orgId,enrollmentId:'enrollment',generation:1,purpose:'enroll',consumedAt:null,revokedAt:null,expiresAt:new Date('2099-01-01')};
const enrollment={id:'enrollment',orgId:invoice.orgId,generation:1,status:'active',stripeAccountId:'acct_test',stripeCustomerId:'cus_test'};
const method={id:'method',orgId:invoice.orgId,enrollmentId:'enrollment',type:'us_bank_account',status:'active',isAutopayMethod:true,stripePaymentMethodId:'pm_A',stripeSetupIntentId:'seti_A'};
const snapshot={version:'v1',text:'Consent',textHash:'hash',hash:'a'.repeat(64),partnerName:'MSP',scheduleText:'Schedule',feeText:'No fee',achMode:'ach_preferred',
 scheduleTerms:{offsetDays:0,rule:'later',cap:{enabled:false}},feeTerms:{methodType:'us_bank_account',cardFeeBps:0,achFeeAmount:'0.00',feeAttested:false,currency:'USD'},
 source:'setup_page',contactEmail:'billing@example.test',ip:null,userAgent:null,invoiceId:null,checkoutKey:null,bankPayment:accepted};
const setup={id:'setup',orgId:invoice.orgId,enrollmentId:enrollment.id,generation:1,tokenId:token.id,checkoutSessionId:'cs_A',stripeAccountId:'acct_test',stripeCustomerId:'cus_test',setupIntentId:'seti_A',outcome:'activated',consentSnapshot:snapshot};
const session={id:'cs_A',mode:'setup',customer:'cus_test',setup_intent:'seti_A',metadata:{invoice_id:invoice.id,org_id:invoice.orgId,token_id:token.id,generation:'1',principal_minor:'10000',fee_minor:'0',currency:'USD'}};
const collect=()=>collectAfterBankSetup({invoiceId:invoice.id,orgId:invoice.orgId,setupSessionId:'cs_A'});
function completionFixture(){
 vi.clearAllMocks();bank.rows=[[invoice],[token],[enrollment],[setup],[{id:invoice.orgId,status:'active',deletedAt:null}]];
 vi.mocked(getPartnerStripeClient).mockResolvedValue({stripeAccountId:'acct_test',stripe:{checkout:{sessions:{retrieve:bank.session}},setupIntents:{retrieve:bank.intent}}} as never);
 bank.session.mockResolvedValue(structuredClone(session));
 bank.intent.mockResolvedValue({id:'seti_A',status:'succeeded',customer:'cus_test',payment_method:'pm_A'});
 vi.mocked(completeAutopaySetup).mockResolvedValue({outcome:'activated',orgId:invoice.orgId});
 vi.mocked(getAutopayMethod).mockResolvedValue({...method} as never);
 vi.mocked(attemptCollection).mockImplementation(async()=>{
  expect(getClientPaymentAuthority()).toMatchObject({invoiceId:invoice.id,tokenId:token.id,methodId:method.id,
   capture:{setupAttemptId:setup.id,stripePaymentMethodId:'pm_A',setupIntentId:'seti_A'}});
  return {attemptId:'attempt',outcome:'created'};
 });
}
it('collect carries only the server-verified exact method authority and clears it afterward',async()=>{
 completionFixture();expect(await collect()).toEqual({attemptId:'attempt',outcome:'created'});
 expect(attemptCollection).toHaveBeenCalledWith({invoiceId:invoice.id,initiatedBy:'client_on_session'});expect(getClientPaymentAuthority()).toBeUndefined();
});
it.each(['pending_verification','in_progress','abandoned'] as const)('never collects a %s setup',async outcome=>{
 completionFixture();vi.mocked(completeAutopaySetup).mockResolvedValue({outcome,orgId:invoice.orgId});
 expect(await collect()).toMatchObject({outcome:'deferred',reason:outcome});expect(attemptCollection).not.toHaveBeenCalled();
});
it.each(['invoice','org','account','generation','method','setupIntent','principal','fee','currency','consumed','revoked','purpose','expired'])(
 'refuses mismatched %s before reserving',async mismatch=>{
 completionFixture();
 if(mismatch==='invoice'||mismatch==='org')bank.session.mockResolvedValue({...session,metadata:{...session.metadata,[mismatch+'_id']:'other'}});
 if(mismatch==='account')bank.rows[2]=[{...enrollment,stripeAccountId:'acct_other'}];
 if(mismatch==='generation')bank.rows[2]=[{...enrollment,generation:2}];
 if(mismatch==='method')vi.mocked(getAutopayMethod).mockResolvedValue({...method,id:'replacement',stripePaymentMethodId:'pm_B',stripeSetupIntentId:'seti_B'} as never);
 if(mismatch==='setupIntent')bank.session.mockResolvedValue({...session,setup_intent:'seti_B'});
 if(mismatch==='principal'||mismatch==='fee')bank.session.mockResolvedValue({...session,metadata:{...session.metadata,[mismatch+'_minor']:'99999'}});
 if(mismatch==='currency')bank.session.mockResolvedValue({...session,metadata:{...session.metadata,currency:'EUR'}});
 if(mismatch==='consumed'||mismatch==='revoked')bank.rows[1]=[{...token,[mismatch+'At']:new Date()}];
 if(mismatch==='purpose')bank.rows[1]=[{...token,purpose:'confirm_payment'}];
 if(mismatch==='expired')bank.rows[1]=[{...token,expiresAt:new Date(0)}];
 await expect(collect()).rejects.toThrow();expect(attemptCollection).not.toHaveBeenCalled();
});
it('never lets invalid bank consent fall through the ordinary card branch',()=>{
 expect(invoicePaySchema.safeParse({}).success).toBe(true);
 expect(invoicePaySchema.safeParse({methodType:'us_bank_account'}).success).toBe(false);
 expect(invoicePaySchema.safeParse({saveForAutopay:true}).success).toBe(false);
});
it('does not offer bank payment while money is reserved',async()=>{
 completionFixture();bank.rows=[[invoice],[enrollment],[{id:invoice.orgId,status:'active'}]];
 bank.disclosure.mockResolvedValue({achMode:'ach_preferred',hash:'a'.repeat(64)});
 vi.mocked(readInFlightCollection).mockResolvedValueOnce({inProgress:true,amount:'100.00'});
 expect(await getBankAutopayOffer(invoice.id,invoice.orgId)).toBeNull();expect(attemptCollection).not.toHaveBeenCalled();
});
it('requires fresh displayed terms when the balance changed before setup',async()=>{
 completionFixture();bank.rows=[[{...invoice,balance:'90.00'}],[enrollment],[{id:invoice.orgId,status:'active'}],[]];
 bank.disclosure.mockResolvedValue({achMode:'ach_preferred',hash:'a'.repeat(64)});bank.quote.mockReturnValue({feeAmount:'0.00'});
 await expect(startInvoiceBankSetup({invoiceId:invoice.id,orgId:invoice.orgId,terms:{...accepted,methodType:'us_bank_account',phase:'setup',consentAccepted:true,currency:'USD'},returnTo:'public',ip:null,userAgent:null})).rejects.toMatchObject({status:409});
 expect(createAutopaySetupSession).not.toHaveBeenCalled();
});

it('refuses a current method whose PM differs from the exact provider SetupIntent capture',async()=>{
 completionFixture();bank.intent.mockResolvedValue({id:'seti_A',status:'succeeded',customer:'cus_test',payment_method:'pm_different'});
 await expect(collect()).rejects.toThrow();expect(attemptCollection).not.toHaveBeenCalled();
});

it('revalidates the organization after setup return',async()=>{
 completionFixture();bank.rows[4]=[{id:invoice.orgId,status:'archived',deletedAt:null}];
 await expect(collect()).rejects.toThrow('Organization unavailable');expect(attemptCollection).not.toHaveBeenCalled();
});
