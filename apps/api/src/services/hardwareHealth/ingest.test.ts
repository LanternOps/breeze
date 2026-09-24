import { expect,it,vi } from 'vitest';
vi.mock('../../db',()=>({db:{transaction:vi.fn()}}));
import { hardwareHealthSnapshotSchema,HARDWARE_SOURCE_STATUSES } from '@breeze/shared';
import { componentChange,type ComponentInput } from './ingest';
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
