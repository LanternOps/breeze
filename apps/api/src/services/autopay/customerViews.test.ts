import { beforeEach, expect, it, vi } from 'vitest';
const h=vi.hoisted(()=>({rows:[] as unknown[][],select:vi.fn(),disclosure:vi.fn(),method:vi.fn(),readiness:vi.fn(),settings:vi.fn()}));
vi.mock('./billingPaymentSettings',()=>({resolveBillingPaymentSettings:h.settings}));
vi.mock('../../db',()=>({db:{select:h.select},runOutsideDbContext:(fn:()=>unknown)=>fn(),withSystemDbAccessContext:(fn:()=>unknown)=>fn()}));
vi.mock('./consentText',()=>({buildAutopayDisclosure:h.disclosure}));
vi.mock('./paymentMethods',()=>({getAutopayMethod:h.method}));
vi.mock('./stripeCapabilities',()=>({getAutopayStripeReadiness:h.readiness}));
vi.mock('./enrollmentService',()=>({completeAutopaySetup:vi.fn()}));
import { getAutopayCustomerPage } from './customerViews';
const orgId='11111111-1111-4111-8111-111111111111';
beforeEach(()=>{
 vi.clearAllMocks();h.rows=[];
 h.select.mockImplementation(()=>({from:()=>({where:()=>({limit:async()=>h.rows.shift()??[]})})}));
 h.method.mockResolvedValue({type:'card',cardLast4:'1234',status:'active'});
 h.settings.mockResolvedValue({cardFeeBps:{value:0,source:'default'},achFeeAmount:{value:'0.00',source:'default'},feeAttested:false});
});
function seed(status:string|null,enabled=false){
 h.rows.push([{id:orgId,name:'Example client',partnerId:'22222222-2222-4222-8222-222222222222'}],
  [{name:'Example MSP',autopayEnabled:enabled}],[],status?[{status,generation:1,effectiveFrom:null,needsAttentionReason:null}]:[]);
}
it.each(['active','requested','paused','verification_failed'])('returns only a read-only summary for disabled %s enrollment',async status=>{
 seed(status);
 const page=await getAutopayCustomerPage(orgId,{allowStopOnly:true});
 expect(page).toMatchObject({stopOnly:true,partnerName:'Example MSP',enrollment:{status},method:{cardLast4:'1234'}});
 expect(page).not.toHaveProperty('disclosures');expect(page).not.toHaveProperty('fees');
 expect(h.disclosure).not.toHaveBeenCalled();expect(h.readiness).not.toHaveBeenCalled();
 expect(h.method).toHaveBeenCalledWith(expect.anything(),orgId);
});
it.each([null,'cancelled'])('keeps disabled enrollment %s unavailable',async status=>{
 seed(status);
 await expect(getAutopayCustomerPage(orgId,{allowStopOnly:true})).rejects.toMatchObject({status:404});
 expect(h.disclosure).not.toHaveBeenCalled();expect(h.method).not.toHaveBeenCalled();
});
it('retains the full setup view for enabled partners',async()=>{
 seed('active',true);
 const disclosure={partnerName:'Example MSP',scheduleText:'Due date',achMode:'card_only',version:'1',text:'Terms',feeText:'No fee',feeTerms:{cardFeeBps:0,achFeeAmount:'0.00',feeAttested:false}};
 h.disclosure.mockResolvedValue(disclosure);h.readiness.mockResolvedValue({accountCountry:'US'});
 expect(await getAutopayCustomerPage(orgId,{allowStopOnly:true})).toMatchObject({disclosures:{card:disclosure,us_bank_account:disclosure}});
});

// #7895: the reason explains the configured fee policy; amounts stay the disclosed terms.
type Case={region:string;country?:string;account?:string;bps:number;attested:boolean;ach?:string;disclosedBps:number;disclosedAch?:string};
const cases:Array<[string,Case,{card:[string,string,number|null];debit:string;bank:[string,string]}]>=[
 ['fee not configured',{region:'NY',bps:0,attested:true,disclosedBps:0},{card:['disabled','0.00',null],debit:'disabled',bank:['disabled','0.00']}],
 ['not attested',{region:'NY',bps:300,attested:false,disclosedBps:0},{card:['not_attested','0.00',null],debit:'not_attested',bank:['disabled','0.00']}],
 ['banned state',{region:'CA',bps:300,attested:true,disclosedBps:0},{card:['state_banned','0.00',null],debit:'debit_or_prepaid',bank:['disabled','0.00']}],
 ['non-US client',{region:'ON',country:'CA',bps:300,attested:true,disclosedBps:0},{card:['non_us','0.00',null],debit:'debit_or_prepaid',bank:['disabled','0.00']}],
 ['non-US account',{region:'NY',account:'CA',bps:300,attested:true,ach:'2.50',disclosedBps:0,disclosedAch:'0.00'},{card:['non_us','0.00',null],debit:'debit_or_prepaid',bank:['non_us','0.00']}],
 ['capped state',{region:'CO',bps:300,attested:true,ach:'2.50',disclosedBps:200,disclosedAch:'2.50'},{card:['state_capped','2.00',200],debit:'debit_or_prepaid',bank:['applied','2.50']}],
 ['applied',{region:'NY',bps:300,attested:true,disclosedBps:300},{card:['applied','3.00',300],debit:'debit_or_prepaid',bank:['disabled','0.00']}],
];
it.each(cases)('reports the configured card fee reason: %s',async(_label,c,expected)=>{
 h.rows.push([{id:orgId,name:'Example client',partnerId:'22222222-2222-4222-8222-222222222222',currencyCode:'USD',
  billingAddressCountry:c.country??'US',billingAddressRegion:c.region,billingContact:{email:'billing@example.test'}}],
  [{name:'Example MSP',autopayEnabled:true}],[],[{status:'requested',generation:1,effectiveFrom:null,needsAttentionReason:null}]);
 h.settings.mockResolvedValue({cardFeeBps:{value:c.bps,source:'partner'},achFeeAmount:{value:c.ach??'0.00',source:'partner'},feeAttested:c.attested});
 h.readiness.mockResolvedValue({accountCountry:c.account??'US'});
 h.disclosure.mockImplementation(async(_db:unknown,_org:string,type:'card'|'us_bank_account')=>({partnerName:'Example MSP',scheduleText:'Due date',
  achMode:'ach_preferred',version:'1',text:'Terms',feeText:'Fee text',
  feeTerms:{methodType:type,cardFeeBps:type==='card'?c.disclosedBps:0,achFeeAmount:type==='us_bank_account'?c.disclosedAch??'0.00':'0.00',feeAttested:c.attested,currency:'USD'}}));
 const page=await getAutopayCustomerPage(orgId);
 expect(h.settings).toHaveBeenCalledWith(expect.anything(),{partnerId:'22222222-2222-4222-8222-222222222222',orgId});
 expect(page.fees.card).toMatchObject({reason:expected.card[0],feeAmount:expected.card[1],appliedBps:expected.card[2]});
 expect(page.fees.debit).toMatchObject({reason:expected.debit,feeAmount:'0.00',kind:'none'});
 expect(page.fees.us_bank_account).toMatchObject({reason:expected.bank[0],feeAmount:expected.bank[1]});
});
it('keeps disclosed amounts from the accepted terms when configuration differs',async()=>{
 h.rows.push([{id:orgId,name:'Example client',partnerId:'22222222-2222-4222-8222-222222222222',currencyCode:'USD',
  billingAddressCountry:'US',billingAddressRegion:'NY',billingContact:null}],[{name:'Example MSP',autopayEnabled:true}],[],[]);
 h.settings.mockResolvedValue({cardFeeBps:{value:300,source:'partner'},achFeeAmount:{value:'5.00',source:'partner'},feeAttested:true});
 h.readiness.mockResolvedValue({accountCountry:'US'});
 h.disclosure.mockImplementation(async(_db:unknown,_org:string,type:'card'|'us_bank_account')=>({partnerName:'Example MSP',scheduleText:'Due date',
  achMode:'ach_preferred',version:'1',text:'Terms',feeText:'Fee text',
  feeTerms:{methodType:type,cardFeeBps:type==='card'?100:0,achFeeAmount:type==='us_bank_account'?'2.00':'0.00',feeAttested:true,currency:'USD'}}));
 const page=await getAutopayCustomerPage(orgId);
 expect(page.fees.card).toMatchObject({feeAmount:'1.00',appliedBps:100,kind:'card_percent',reason:'applied'});
 expect(page.fees.us_bank_account).toMatchObject({feeAmount:'2.00',kind:'ach_flat',reason:'applied'});
});
