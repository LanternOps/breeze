import {expect,it} from 'vitest';
import {allocateReversal} from './refundAllocation';
const money=(n:bigint)=>`${n/100n}.${String(n%100n).padStart(2,'0')}`;
const cents=(s:string)=>BigInt(s.replace('.',''));
it.each([
  ['9999999999.99','0.01','10000000000.00','9999999999.99','0.01'],
  ['100.00','3.00','51.50','50.00','1.50'],['100.00','3.00','103.00','100.00','3.00'],
  ['0.01','0.01','0.01','0.01','0.00'],['0.01','0.01','0.02','0.01','0.01'],
  ['100.00','0.00','33.33','33.33','0.00'],['0.00','0.00','0.00','0.00','0.00'],
])('allocates %s + %s reversed %s',(principal,fee,cumulativeReversedGross,principalReversed,feeReversed)=>{
  expect(allocateReversal({principal,fee,cumulativeReversedGross})).toEqual({principalReversed,feeReversed});
});
it('conserves deltas, remains monotone, and puts residue on the last event in 2000 random sequences',()=>{
  let seed=0x5fee1234;
  const next=(max:number)=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%max;};
  for(let sample=0;sample<2000;sample++){
    const p=BigInt(1+next(1000000)),f=BigInt(next(2501)),g=p+f;
    const cuts=[...new Set([0,Number(g),...Array.from({length:30},()=>next(Number(g)+1))])].sort((a,b)=>a-b);
    let pp=0n,pf=0n,pr=0n,totalP=0n,totalF=0n;
    for(const cut of cuts){
      const r=BigInt(cut),input={principal:money(p),fee:money(f),cumulativeReversedGross:money(r)};
      const result=allocateReversal(input),ap=cents(result.principalReversed),af=cents(result.feeReversed);
      expect(ap+af).toBe(r);expect(ap>=pp&&af>=pf).toBe(true);
      expect(ap<=p&&af<=f).toBe(true);expect((ap-pp)+(af-pf)).toBe(r-pr);
      const error=ap*g-p*r;expect((error<0n?-error:error)*2n<=g).toBe(true);
      expect(allocateReversal(input)).toEqual(result);
      totalP+=ap-pp;totalF+=af-pf;pp=ap;pf=af;pr=r;
    }
    expect(totalP).toBe(p);expect(totalF).toBe(f);
  }
});
it('rejects invalid and out-of-range amounts on every argument',()=>{
  for(const key of ['principal','fee','cumulativeReversedGross'] as const)
    for(const value of ['-1.00','1.001','NaN','1e2','',' 1.00','10000000000.00'])
      expect(()=>allocateReversal({principal:'1.00',fee:'0.00',cumulativeReversedGross:'0.00',[key]:value})).toThrow();
  expect(()=>allocateReversal({principal:'1.00',fee:'0.01',cumulativeReversedGross:'1.02'})).toThrow('exceeds');
});
