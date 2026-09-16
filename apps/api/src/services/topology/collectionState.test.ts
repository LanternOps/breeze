import { describe, expect, it } from 'vitest';
import { advanceTopologyAbsence, effectiveTopologyCapture, type TopologyAbsenceState } from './collectionState';
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
