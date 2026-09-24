import { expect,it,vi } from 'vitest';
vi.mock('../../db',()=>({db:{transaction:vi.fn()},withDbTransaction:vi.fn()}));
import { hardwareHealthSnapshotSchema,HARDWARE_SOURCE_STATUSES } from '@breeze/shared';
import { componentChange,reduceSnapshot,InvalidHardwareSnapshotError,acceptsAgentSequence,type ComponentInput } from './ingest';
const device={id:'11111111-1111-4111-8111-111111111111',orgId:'22222222-2222-4222-8222-222222222222'};
const now=new Date('2026-09-23T12:00:00Z');
const snapshot=hardwareHealthSnapshotSchema.parse({snapshotId:'33333333-3333-4333-8333-333333333333',sequence:1,collectedAt:'2020-01-01T00:00:00Z',agentVersion:'1',pollIntervalMinutes:10,diskHealthIntervalMinutes:60,tiersRun:['raid'],sources:[],components:[]});
const disk={componentKey:'storcli:c0:e1:s1',componentType:'physical_disk',source:'storcli',name:'Slot 1',state:'online',serial:'old',predictiveFailure:false,alertExempt:false,attributes:{}} satisfies ComponentInput;
it('first observation initializes streaks and timestamps',()=>{
 const {row,events}=componentChange(undefined,disk,device,snapshot,now);
 expect(row).toMatchObject({health:'ok',healthyStreak:1,belowCriticalStreak:1,criticalStreak:0,unhealthyStreak:0,predictiveStreak:0,lastSeenAt:now,firstSeenAt:now});
 expect(events.map(e=>e.eventType)).toEqual(['first_seen']);expect(events[0]!.occurredAt).toEqual(new Date(snapshot.collectedAt));
});
it('emits independent state, health, serial and predictive transitions once',()=>{
 const old=componentChange(undefined,disk,device,snapshot,now).row;
 const changed=componentChange(old,{...disk,state:'failed',serial:'new',model:'Replacement',predictiveFailure:true},device,snapshot,now);
 expect(changed.events.map(e=>e.eventType)).toEqual(['health_changed','state_changed','disk_replaced','predictive_failure_set']);
 expect(changed.events[2]!.detail).toMatchObject({oldSerial:'old',newSerial:'new',model:'Replacement'});
 expect(changed.row).toMatchObject({unhealthyStreak:1,criticalStreak:1,healthyStreak:0,belowCriticalStreak:0,predictiveStreak:1});
 expect(componentChange(changed.row,{...disk,state:'failed',serial:'new',predictiveFailure:true},device,snapshot,now).events).toEqual([]);
 expect(componentChange(changed.row,disk,device,snapshot,now).events.map(e=>e.eventType)).toContain('predictive_failure_cleared');
});
it('unknown freezes every counter; warning never builds a critical streak',()=>{
 let row=componentChange(undefined,{...disk,state:'degraded',predictiveFailure:true},device,snapshot,now).row;
 row=componentChange(row,{...disk,state:'degraded',predictiveFailure:true},device,snapshot,now).row;
 expect(row).toMatchObject({unhealthyStreak:2,criticalStreak:0,healthyStreak:0,belowCriticalStreak:2,predictiveStreak:2});
 const unknown=componentChange(row,{...disk,state:'unknown'},device,snapshot,now).row;
 for(const k of ['unhealthyStreak','criticalStreak','healthyStreak','belowCriticalStreak','predictiveStreak'] as const)expect(unknown[k]).toBe(row[k]);
 const healthy=componentChange(unknown,disk,device,snapshot,now).row;
 expect(healthy).toMatchObject({unhealthyStreak:0,criticalStreak:0,healthyStreak:1,belowCriticalStreak:3,predictiveStreak:0});
});
it('does not invent replacement from blank serial and clears staleness on observation',()=>{
 const old=componentChange(undefined,{...disk,serial:' '},device,snapshot,now).row;
 expect(componentChange({...old,stale:true,staleSince:now},disk,device,snapshot,now)).toMatchObject({row:{stale:false,staleSince:null},events:[]});
});
it.each(HARDWARE_SOURCE_STATUSES.flatMap(status=>[undefined,false,true].map(complete=>({status,complete}))))('source matrix $status / $complete',({status,complete})=>{
 const old=componentChange(undefined,disk,device,snapshot,now).row;
 const wire={...snapshot,sources:[{source:'storcli' as const,status,complete}],components:[]};
 const result=reduceSnapshot([old],device,wire,now);
 const row=result.rows.find(r=>r.componentKey===disk.componentKey)!;
 expect(row.stale).toBe(status==='ok'&&complete===true);
 expect(row.lastSeenAt).toEqual(old.lastSeenAt);
 expect(result.events.filter(e=>e.eventType==='stale')).toHaveLength(status==='ok'&&complete===true?1:0);
});
it('upserts partial ok results but leaves unreported rows byte-identical',()=>{
 const old=componentChange(undefined,disk,device,snapshot,now).row;
 const wire={...snapshot,sources:[{source:'storcli' as const,status:'ok' as const,complete:false}],components:[{...disk,componentKey:'storcli:c0:e1:s2',state:'failed'}]};
 const result=reduceSnapshot([old],device,wire,new Date(+now+1));
 expect(result.rows.find(r=>r.componentKey===old.componentKey)).toEqual(old);
 expect(result.rows.find(r=>r.componentKey.endsWith('s2'))!.criticalStreak).toBe(1);
 expect(result.health).toBe('critical');
});
it.each(HARDWARE_SOURCE_STATUSES)('only ok source %s may change reported component state',status=>{
 const old=componentChange(undefined,disk,device,snapshot,now).row;
 const result=reduceSnapshot([old],device,{...snapshot,sources:[{source:'storcli',status,complete:false}],components:[{...disk,state:'failed'}]},new Date(+now+1));
 const row=result.rows.find(r=>r.componentKey===old.componentKey)!;
 expect(row.state).toBe(status==='ok'?'failed':'online');expect(row.lastSeenAt).toEqual(status==='ok'?new Date(+now+1):now);
});
it.each(['unavailable','superseded','disabled'] as const)('%s removes only the collector row',status=>{
 const old=componentChange(undefined,disk,device,snapshot,now).row;
 const collector=componentChange(undefined,{...disk,componentKey:'collector:storcli',componentType:'collector',state:'failed'},device,snapshot,now).row;
 const r=reduceSnapshot([old,collector],device,{...snapshot,sources:[{source:'storcli',status}]},now);
 expect(r.rows).toEqual([old]);expect(r.deletedKeys).toEqual(['collector:storcli']);
});
it('stale event and stale_since happen once and only for the reporting source',()=>{
 const old=componentChange(undefined,disk,device,snapshot,now).row;
 const smart=componentChange(undefined,{...disk,componentKey:'smart:1',source:'smartctl'},device,snapshot,now).row;
 const wire={...snapshot,sources:[{source:'storcli' as const,status:'ok' as const,complete:true}]};
 const first=reduceSnapshot([old,smart],device,wire,now);
 const second=reduceSnapshot(first.rows,device,wire,new Date(+now+1));
 expect(second.events).toEqual([]);expect(second.rows.find(r=>r.componentKey===old.componentKey)!.staleSince).toEqual(now);
 expect(second.rows.find(r=>r.source==='smartctl')!.stale).toBe(false);
});
it('collector failure, recovery and disappearance follow source status',()=>{
 const run=(rows:ReturnType<typeof reduceSnapshot>['rows'],status:'failed'|'backing_off'|'ok'|'disabled')=>reduceSnapshot(rows,device,{...snapshot,sources:[{source:'storcli',status,complete:status==='ok',error:'timeout'}]},now);
 let r=run([],'failed');expect(r.collectorHealth).toBe('warning');expect(r.health).toBe('unknown');
 r=run(r.rows,'backing_off');expect(r.rows[0]).toMatchObject({componentKey:'collector:storcli',unhealthyStreak:2,stateDetail:'timeout'});
 r=run(r.rows,'ok');expect(r.rows[0]).toMatchObject({health:'ok',healthyStreak:1,unhealthyStreak:0,stale:false});
 r=run(r.rows,'disabled');expect(r.rows).toEqual([]);expect(r.deletedKeys).toEqual(['collector:storcli']);expect(r.collectorHealth).toBe('ok');
});
it('rollup excludes stale, collector and bmc, but keeps alert-exempt display rows',()=>{
 const rows=[componentChange(undefined,{...disk,alertExempt:true},device,snapshot,now).row,componentChange(undefined,{...disk,componentKey:'bmc:ipmi',componentType:'bmc',source:'ipmi',state:'unknown'},device,snapshot,now).row];
 const result=reduceSnapshot(rows,device,snapshot,now);expect(result.health).toBe('ok');expect(result.summary.counts['physical_disk:ok']).toBe(1);
});
it('rejects invalid state, oversized UTF-8 attributes and duplicate identities',()=>{
 for(const c of [{...disk,state:'optimal'},{...disk,attributes:{x:'é'.repeat(4096)}}])expect(()=>reduceSnapshot([],device,{...snapshot,components:[c]},now)).toThrow(InvalidHardwareSnapshotError);
 expect(()=>reduceSnapshot([],device,{...snapshot,components:[disk,disk]},now)).toThrow('components.1.componentKey');
 expect(()=>reduceSnapshot([],device,{...snapshot,sources:[{source:'storcli',status:'failed'},{source:'storcli',status:'ok',complete:true}]},now)).toThrow('sources.1.source');
});
it.each([
 [null,0,0,true],[now,10,11,true],[now,10,10,false],[now,10,0,false],
 [new Date(+now-3_600_000),10,0,false],[new Date(+now-3_600_001),10,0,true],
] as const)('sequence reset boundary %j %s %s', (lastReceivedAt,lastAgentSequence,sequence,accepted)=>{
 expect(acceptsAgentSequence({lastReceivedAt,lastAgentSequence},sequence,now)).toBe(accepted);
});
