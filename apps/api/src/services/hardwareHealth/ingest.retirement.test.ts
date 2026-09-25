import { beforeEach,expect,it,vi } from 'vitest';
const m=vi.hoisted(()=>({rows:[] as any[][],order:[] as string[],retire:vi.fn()}));
vi.mock('../../db',()=>{
 const db={
  select:()=>{const rows=m.rows.shift()??[];const q:any={then:(a:any,b:any)=>Promise.resolve(rows).then(a,b)};for(const k of ['from','where','for'])q[k]=()=>q;return q;},
  insert:()=>({values:()=>({onConflictDoNothing:async()=>{},onConflictDoUpdate:async()=>{m.order.push('upsert');},then:(a:any,b:any)=>Promise.resolve().then(a,b)})}),
  delete:()=>({where:async()=>{m.order.push('delete');}}),
  update:()=>({set:()=>({where:async()=>{m.order.push('rollup');}})}),
 };
 return {db,withDbTransaction:async(fn:any)=>fn()};
});
vi.mock('./retire',()=>({resolveAlertsForRemovedComponents:m.retire}));
import { hardwareHealthSnapshotSchema } from '@breeze/shared';
import { componentChange,ingestHardwareHealthSnapshot } from './ingest';
const device={id:'11111111-1111-4111-8111-111111111111',orgId:'22222222-2222-4222-8222-222222222222'};
const now=new Date('2026-09-23T12:00:00Z');
const wire=hardwareHealthSnapshotSchema.parse({snapshotId:'33333333-3333-4333-8333-333333333333',sequence:2,collectedAt:now.toISOString(),agentVersion:'1',pollIntervalMinutes:10,diskHealthIntervalMinutes:60,tiersRun:['raid'],sources:[],components:[]});
const collector=componentChange(undefined,{componentKey:'collector:storcli',componentType:'collector',source:'storcli',name:'storcli',state:'failed',predictiveFailure:false,alertExempt:false,attributes:{}},device,wire,now).row;
const health={lastAgentSequence:1,lastReceivedAt:now};
beforeEach(()=>{m.rows=[[device],[health],[collector]];m.order=[];m.retire.mockReset().mockImplementation(async()=>{m.order.push('retire');return 0;});});
it.each(['unavailable','superseded','disabled'] as const)('retires %s collector subjects before deletion and rollup',async status=>{
 await ingestHardwareHealthSnapshot({device,snapshot:{...wire,sources:[{source:'storcli',status}]},writer:'agent',receivedAt:now});
 expect(m.retire).toHaveBeenCalledExactlyOnceWith(device.id,['collector:storcli']);
 expect(m.order).toEqual(['retire','delete','rollup']);
});
it('does not delete or publish a new rollup if retirement fails',async()=>{
 m.retire.mockRejectedValue(new Error('retirement unavailable'));
 await expect(ingestHardwareHealthSnapshot({device,snapshot:{...wire,sources:[{source:'storcli',status:'disabled'}]},writer:'agent',receivedAt:now})).rejects.toThrow('retirement unavailable');
 expect(m.order).toEqual([]);
});
it('does not retire on a rejected snapshot or a silent source',async()=>{
 await ingestHardwareHealthSnapshot({device,snapshot:{...wire,sequence:1,sources:[{source:'storcli',status:'disabled'}]},writer:'agent',receivedAt:now});
 expect(m.retire).not.toHaveBeenCalled();expect(m.order).toEqual([]);
 m.rows=[[device],[health],[collector]];
 await ingestHardwareHealthSnapshot({device,snapshot:wire,writer:'agent',receivedAt:now});
 expect(m.retire).not.toHaveBeenCalled();expect(m.order).toEqual(['rollup']);
});
