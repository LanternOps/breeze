import { describe, expect, it } from 'vitest';
import { advanceTopologyAbsence, prunableTopologyKnownKeys, TOPOLOGY_PRUNE_STALE_MS, assessTopologyRetainedCapacity, effectiveTopologyCapture, jsonbTextBytes, retainTopologyKnownKeys, TOPOLOGY_BASELINE_MAX_BYTES, TOPOLOGY_KNOWN_KEY_LIMIT, TOPOLOGY_PENDING_MISSES_MAX_BYTES, type TopologyAbsenceState } from './collectionState';
const empty=():TopologyAbsenceState=>({active:[],transitions:[]});
const input=(sequence:string,minutes:number,extra={})=>({sequence,digest:'digest',effectiveAt:new Date(1_000_000+minutes*60000),outcome:'complete',positiveKeys:[] as string[],previousKeys:['route'],generation:sequence,...extra});
describe('source-scoped absence transitions',()=>{
  it('counts one qualifying unchanged complete miss but not cached timestamps or retries',()=>{
    const first=advanceTopologyAbsence(empty(),input('1',0));
    expect(first.state.active).toHaveLength(1);
    expect(advanceTopologyAbsence(first.state,input('2',0)).newTransitions).toEqual([]);
    expect(advanceTopologyAbsence(first.state,input('2',4)).newTransitions).toEqual([]);
    const second=advanceTopologyAbsence(first.state,input('2',5));
    expect(second.newTransitions).toHaveLength(1);
    expect(advanceTopologyAbsence(second.state,input('3',10)).state.transitions).toHaveLength(1);
  });
  it('preserves misses through partial/failed absence and resets only matching positives',()=>{
    const first=advanceTopologyAbsence(empty(),input('1',0)).state;
    for(const outcome of ['partial','failed','unsupported']) expect(advanceTopologyAbsence(first,input('2',10,{outcome})).newTransitions).toEqual([]);
    expect(advanceTopologyAbsence(first,input('2',10,{outcome:'partial',positiveKeys:['route']})).state.active).toEqual([]);
  });
  it('retains an accepted withdrawal transition after a later positive',()=>{
    const first=advanceTopologyAbsence(empty(),input('1',0)).state;
    const second=advanceTopologyAbsence(first,input('2',5)).state;
    const positive=advanceTopologyAbsence(second,input('3',6,{positiveKeys:['route']})).state;
    expect(positive.active).toEqual([]);
    expect(positive.transitions).toHaveLength(1);
  });
  it('does not withdraw newly missing facts using another facts older clock',()=>{
    const first=advanceTopologyAbsence(empty(),input('1',0)).state;
    const second=advanceTopologyAbsence(first,input('2',5,{previousKeys:['route','new-route']}));
    expect(second.newTransitions[0]!.rowKeys).toEqual(['route']);
    expect(second.state.active.find(g=>g.rowKeys.includes('new-route'))!.qualifyingSequence).toBeUndefined();
  });
});
describe('bounded absence memory',()=>{
  it('forgets a miss streak once its withdrawal is queued',()=>{
    const first=advanceTopologyAbsence(empty(),input('1',0)).state;
    const second=advanceTopologyAbsence(first,input('2',5));
    expect(second.newTransitions).toHaveLength(1);
    expect(second.state.active).toEqual([]);
  });
  it('stops tracking withdrawn keys so a churning section cannot grow without limit',()=>{
    const withdrawn=advanceTopologyAbsence(advanceTopologyAbsence(empty(),input('1',0)).state,input('2',5)).newTransitions;
    expect(retainTopologyKnownKeys(['route','kept'],['fresh'],withdrawn)).toEqual({keys:['fresh','kept'],capacity:'ok',required:2});
  });
  it('reports an explicit capacity outcome instead of silently dropping keys',()=>{
    const old=Array.from({length:TOPOLOGY_KNOWN_KEY_LIMIT},(_,i)=>`old-${i}`);
    const kept=retainTopologyKnownKeys(old,['now-1','now-2'],[]);
    expect(kept.capacity).toBe('exceeded');
    expect(kept.required).toBe(TOPOLOGY_KNOWN_KEY_LIMIT+2);
    // OS network context still uses the bounded list (current positives first);
    // physical admission rejects on `exceeded` instead (collectionIngest).
    expect(kept.keys).toHaveLength(TOPOLOGY_KNOWN_KEY_LIMIT);
    expect(kept.keys.slice(0,2)).toEqual(['now-1','now-2']);
  });
  it('is ok exactly at the limit',()=>{
    const old=Array.from({length:TOPOLOGY_KNOWN_KEY_LIMIT-1},(_,i)=>`old-${i}`);
    expect(retainTopologyKnownKeys(old,['now'],[]).capacity).toBe('ok');
  });
});
describe('whole retained source state capacity (D13)',()=>{
  const snapshot=(rows:number,width=10)=>({key:{protocol:'lldp',contextKey:'t/default',addressFamily:'any'},section:{kind:'lldp',rows:Array.from({length:rows},(_,i)=>({rowKey:`${i}.1`,name:'x'.repeat(width)}))}});
  it('measures the jsonb text form Postgres enforces (separator spaces included)',()=>{
    expect(jsonbTextBytes({a:1,b:[1,2]})).toBe('{"a": 1, "b": [1, 2]}'.length);
    expect(jsonbTextBytes({})).toBe(2);
    expect(jsonbTextBytes([])).toBe(2);
    expect(jsonbTextBytes('é')).toBe(4);
    expect(jsonbTextBytes({k:null,t:true})).toBe('{"k": null, "t": true}'.length);
  });
  it('admits a small source',()=>{
    const s=snapshot(10);
    expect(assessTopologyRetainedCapacity({snapshot:s,knownKeys:s.section.rows.map(r=>r.rowKey),pendingMisses:{active:[],transitions:[]}})).toEqual({ok:true});
  });
  it('rejects when the retained baseline plus known keys would exceed 1 MiB',()=>{
    const s=snapshot(4000,250);
    const result=assessTopologyRetainedCapacity({snapshot:s,knownKeys:s.section.rows.map(r=>r.rowKey),pendingMisses:{}});
    expect(result).toMatchObject({ok:false,reason:'snapshot_budget_exceeded'});
    expect(result.ok===false&&result.bytes).toBeGreaterThan(TOPOLOGY_BASELINE_MAX_BYTES);
  });
  it('counts the published row->relationship map, not just the snapshot',()=>{
    // Snapshot fits alone; the per-key relationship map pushes publication over 1 MiB.
    const s=snapshot(1);
    const keys=Array.from({length:16000},(_,i)=>`${'k'.repeat(20)}-${i}`);
    const result=assessTopologyRetainedCapacity({snapshot:s,knownKeys:keys,pendingMisses:{}});
    expect(result).toMatchObject({ok:false,exceeded:'published_baseline'});
  });
  it('rejects pending misses above 512 KiB',()=>{
    const s=snapshot(1);
    const rowKeys=Array.from({length:30000},(_,i)=>`missing-key-${i}`);
    const result=assessTopologyRetainedCapacity({snapshot:s,knownKeys:[],pendingMisses:{active:[{rowKeys}],transitions:[]}});
    expect(result).toMatchObject({ok:false,exceeded:'pending_misses'});
    expect(result.ok===false&&result.bytes).toBeGreaterThan(TOPOLOGY_PENDING_MISSES_MAX_BYTES);
  });
});
describe('conservative capture freshness',()=>{
  const receipt=new Date('2026-09-16T12:00:00Z');
  it('uses the older producer/monotonic capture clock',()=>{
    expect(effectiveTopologyCapture('2026-09-16T11:59:00Z',300000,300,receipt).effectiveAt?.toISOString()).toBe('2026-09-16T11:55:00.000Z');
  });
  it('refuses unknown-age spool and future producer clocks',()=>{
    expect(effectiveTopologyCapture('2026-09-16T11:59:00Z',null,300,receipt).freshUntil).toBeNull();
    expect(effectiveTopologyCapture('2026-09-16T12:06:00Z',0,300,receipt).freshUntil).toBeNull();
  });
});
describe('known-key pruning for physical sources (partial-only growth)',()=>{
  const now=new Date('2026-10-01T00:00:00Z');
  const old=new Date(now.getTime()-TOPOLOGY_PRUNE_STALE_MS-1000),recent=new Date(now.getTime()-60_000);
  const rows={a:['r-a'],b:['r-b'],c:['r-c'],d:['r-d'],e:['r-e','r-e2']};
  const support=new Map([['r-a',{lifecycle:'archived',freshUntil:old}],['r-b',{lifecycle:'archived',freshUntil:recent}],['r-c',{lifecycle:'active',freshUntil:old}],
    ['r-d',{lifecycle:'archived',freshUntil:old}],['r-e',{lifecycle:'archived',freshUntil:old}],['r-e2',{lifecycle:'active',freshUntil:old}]]);
  it('prunes only absent keys whose every support is archived and older than the stale window',()=>{
    const state={active:[],transitions:[]};
    expect(prunableTopologyKnownKeys({knownKeys:['a','b','c','d','e','f'],positives:['d'],rowRelationships:rows,support,absence:state,now}).sort()).toEqual(['a']);
  });
  it('never prunes a key inside a pending miss streak or transition (second-miss semantics intact)',()=>{
    const state={active:[{generation:'g',firstSequence:'1',firstEffectiveAt:now.toISOString(),digest:'x',rowKeys:['a']}],transitions:[]};
    expect(prunableTopologyKnownKeys({knownKeys:['a'],positives:[],rowRelationships:rows,support,absence:state,now})).toEqual([]);
  });
  it('never prunes a key whose relationship has a queued lifecycle change (an unpublished revival)',()=>{
    const revival={generation:'r',relationshipId:'r-a',producerEpoch:'e',sequence:'2',contentDigest:'d',inputRevision:'5',lifecycle:'active' as const,effectiveAt:now.toISOString(),freshUntil:now.toISOString()};
    expect(prunableTopologyKnownKeys({knownKeys:['a'],positives:[],rowRelationships:rows,support,absence:{active:[],transitions:[],lifecycle:[revival]},now})).toEqual([]);
  });
  it('keeps unmapped keys (their publication may still be pending)',()=>{
    expect(prunableTopologyKnownKeys({knownKeys:['f'],positives:[],rowRelationships:rows,support,absence:{active:[],transitions:[]},now})).toEqual([]);
  });
});
