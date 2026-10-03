import { beforeEach, expect, it, vi } from 'vitest';
const h=vi.hoisted(()=>({rows:[] as unknown[][],select:vi.fn(),disclosure:vi.fn(),method:vi.fn(),readiness:vi.fn()}));
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
