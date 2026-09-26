import { beforeEach,expect,it,vi } from 'vitest';
const m=vi.hoisted(()=>({rows:[] as any[][],reevaluate:vi.fn()}));
vi.mock('../../db',()=>{
 const db={
  select:()=>{const rows=m.rows.shift()??[];const q:any={then:(a:any,b:any)=>Promise.resolve(rows).then(a,b)};for(const k of ['from','where','for'])q[k]=()=>q;return q;},
  insert:()=>({values:()=>({onConflictDoNothing:async()=>{},onConflictDoUpdate:async()=>{},then:(a:any,b:any)=>Promise.resolve().then(a,b)})}),
  delete:()=>({where:async()=>{}}),
  update:()=>({set:()=>({where:async()=>{}})}),
 };
 return {db,withDbTransaction:async(fn:any)=>fn()};
});
vi.mock('./retire',()=>({resolveAlertsForRemovedComponents:vi.fn(async()=>0)}));
vi.mock('../../jobs/deviceGroupJobs',()=>({requestDeviceGroupReevaluation:m.reevaluate}));
import { hardwareHealthSnapshotSchema,worstHardwareHealth } from '@breeze/shared';
import { ingestHardwareHealthSnapshot } from './ingest';
// Dynamic groups filtering on `hardware.health` only re-evaluate when a
// device-change event names that field; ingest is the only writer of the rollup.
const device={id:'11111111-1111-4111-8111-111111111111',orgId:'22222222-2222-4222-8222-222222222222'};
const now=new Date('2026-09-23T12:00:00Z');
const wire=hardwareHealthSnapshotSchema.parse({snapshotId:'33333333-3333-4333-8333-333333333333',sequence:2,collectedAt:now.toISOString(),agentVersion:'1',pollIntervalMinutes:10,diskHealthIntervalMinutes:60,tiersRun:['raid'],sources:[],components:[]});
const emptyRollup=worstHardwareHealth([]);
const otherHealth=emptyRollup==='critical'?'ok':'critical';
const ingest=(sequence=2)=>ingestHardwareHealthSnapshot({device,snapshot:{...wire,sequence},writer:'agent',receivedAt:now});
beforeEach(()=>{m.reevaluate.mockReset().mockResolvedValue('job');});
it('requests group re-evaluation on hardware.health when the rollup changes',async()=>{
 m.rows=[[device],[{lastAgentSequence:1,lastReceivedAt:now,health:otherHealth}],[]];
 await ingest();
 expect(m.reevaluate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({deviceId:device.id,orgId:device.orgId,changedFields:['hardware.health']}));
});
it('does not request re-evaluation when the rollup is unchanged',async()=>{
 m.rows=[[device],[{lastAgentSequence:1,lastReceivedAt:now,health:emptyRollup}],[]];
 await ingest();
 expect(m.reevaluate).not.toHaveBeenCalled();
});
it('does not request re-evaluation for a rejected snapshot',async()=>{
 m.rows=[[device],[{lastAgentSequence:5,lastReceivedAt:now,health:otherHealth}],[]];
 expect(await ingest(1)).toEqual({accepted:false,reason:'stale_snapshot'});
 expect(m.reevaluate).not.toHaveBeenCalled();
});
