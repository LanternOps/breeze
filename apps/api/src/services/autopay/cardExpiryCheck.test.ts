import { beforeEach,describe,expect,it,vi } from 'vitest';
const h=vi.hoisted(()=>({rows:[] as unknown[][],mint:vi.fn(),enqueue:vi.fn(),render:vi.fn(),disclosure:vi.fn()}));
vi.mock('../../db',()=>({runOutsideDbContext:(fn:()=>unknown)=>fn(),withSystemDbAccessContext:(fn:()=>unknown)=>fn(),db:{
  select:()=>{const q:any={};for(const key of ['from','innerJoin','where','limit','for'])q[key]=()=>q;
    q.then=(f:(x:unknown)=>unknown)=>Promise.resolve(h.rows.shift()??[]).then(f);return q;},
}}));
vi.mock('./linkTokens',()=>({mintBillingLinkToken:h.mint,buildBillingLinkUrl:(_purpose:string,token:string)=>`https://portal.example.test/autopay/${token}`}));
vi.mock('./noticeOutbox',()=>({enqueueBillingNotice:h.enqueue}));
vi.mock('./renderBillingNotice',()=>({renderBillingNotice:h.render}));
vi.mock('./consentText',()=>({buildAutopayDisclosure:h.disclosure}));
import {checkExpiringAutopayCards,isCardExpiring} from './cardExpiryCheck';
const methodId='11111111-1111-4111-8111-111111111111';
const row={method:{id:methodId,orgId:'22222222-2222-4222-8222-222222222222',enrollmentId:'33333333-3333-4333-8333-333333333333',type:'card',cardBrand:'visa',cardLast4:'1234',cardExpYear:2026,cardExpMonth:10},
  enrollment:{id:'33333333-3333-4333-8333-333333333333',generation:4,requestRecipientEmail:'billing@example.test'},
  org:{id:'22222222-2222-4222-8222-222222222222',partnerId:'44444444-4444-4444-8444-444444444444',name:'Example client',billingContact:{email:'billing@example.test'}}};
describe('autopay card expiry',()=>{
  beforeEach(()=>{vi.clearAllMocks();h.rows.length=0;h.mint.mockResolvedValue({token:'update-token',id:'55555555-5555-4555-8555-555555555555'});h.enqueue.mockResolvedValue({id:'66666666-6666-4666-8666-666666666666',created:true});h.render.mockResolvedValue({subject:'Update your card',html:'<p>Update</p>',text:'Update',frozen:{}});h.disclosure.mockResolvedValue({partnerName:'Example MSP',scheduleText:'After issue',feeText:'No fee applies.'});});
  it.each([
    ['2026-10-01T23:59:59Z',2026,10,false],['2026-10-02T00:00:00Z',2026,10,true],
    ['2026-10-31T23:59:59Z',2026,10,true],['2026-11-01T00:00:00Z',2026,10,false],
    ['2028-01-31T00:00:00Z',2028,2,true],['2026-10-02T00:00:00Z',null,10,false],
  ])('handles month boundary %s', (now,year,month,expected)=>expect(isCardExpiring(new Date(now),year,month)).toBe(expected));
  it('enqueues one notice per method with an update token at the same generation',async()=>{
    h.rows.push([row],[row.org],[row.enrollment],[row.method],[]);
    expect(await checkExpiringAutopayCards(new Date('2026-10-02T06:28:00Z'))).toEqual({enqueued:1});
    expect(h.mint).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({purpose:'enroll',generation:4,ttlDays:30}));
    expect(h.enqueue).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({kind:'card_expiring',dedupeKey:`card-expiring:${methodId}`,seq:1}));
    expect(h.render).toHaveBeenCalledWith('card_expiring',expect.objectContaining({autopay:expect.objectContaining({vars:expect.objectContaining({expires_on:'2026-10-31',payment_method:'Visa card ending in 1234'})})}));
  });
  it('does not mint another token or send another message on a repeated daily run',async()=>{
    h.rows.push([row],[row.org],[row.enrollment],[row.method],[{id:'66666666-6666-4666-8666-666666666666'}]);
    expect(await checkExpiringAutopayCards(new Date('2026-10-03T06:28:00Z'))).toEqual({enqueued:0});
    expect(h.mint).not.toHaveBeenCalled();expect(h.enqueue).not.toHaveBeenCalled();
  });
  it('skips a method removed after the candidate read',async()=>{
    h.rows.push([row],[row.org],[row.enrollment],[]);
    expect(await checkExpiringAutopayCards(new Date('2026-10-02T06:28:00Z'))).toEqual({enqueued:0});
    expect(h.mint).not.toHaveBeenCalled();
  });
  it('empty population returns zero',async()=>{h.rows.push([]);expect(await checkExpiringAutopayCards()).toEqual({enqueued:0});});
});
