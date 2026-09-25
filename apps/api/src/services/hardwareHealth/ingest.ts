import { randomUUID } from 'node:crypto';
import { and,eq,inArray } from 'drizzle-orm';
import { deriveHardwareHealth,HARDWARE_STATES,worstHardwareHealth,type HardwareComponentType,type HardwareComponentReport,type HardwareHealthSnapshot,type HardwareHealth } from '@breeze/shared';
import { db,withDbTransaction } from '../../db';
import { deviceHardwareComponents,deviceHardwareEvents,deviceHardwareHealth,devices } from '../../db/schema';
import { resolveAlertsForRemovedComponents } from './retire';
import { linkBmcAssetFromAgentReport, type BmcLinkTx } from '../discovery/agentReportedBmcLink';
import { captureException } from '../sentry';
export type ComponentRow=typeof deviceHardwareComponents.$inferSelect;
type EventRow=typeof deviceHardwareEvents.$inferInsert;
export type ComponentInput=Omit<HardwareComponentReport,'componentType'> & {componentType:HardwareComponentType};
export function componentChange(previous:ComponentRow|undefined,report:ComponentInput,device:{id:string;orgId:string},snapshot:HardwareHealthSnapshot,receivedAt:Date):{row:ComponentRow;events:EventRow[]}{
 const health=deriveHardwareHealth(report);
 const count=(key:'unhealthyStreak'|'criticalStreak'|'healthyStreak'|'belowCriticalStreak'|'predictiveStreak',matches:boolean)=>health==='unknown'?(previous?.[key]??0):matches?(previous?.[key]??0)+1:0;
 const row:ComponentRow={
  id:previous?.id??randomUUID(),deviceId:device.id,orgId:device.orgId,componentKey:report.componentKey,componentType:report.componentType,parentKey:report.parentKey??null,source:report.source,name:report.name,model:report.model??null,serial:report.serial??null,firmware:report.firmware??null,sizeBytes:report.sizeBytes??null,
  health,state:report.state,stateDetail:report.stateDetail??null,progressPercent:report.progressPercent??null,temperatureC:report.temperatureC??null,predictiveFailure:report.predictiveFailure,alertExempt:report.alertExempt,attributes:report.attributes,
  unhealthyStreak:count('unhealthyStreak',health==='warning'||health==='critical'),criticalStreak:count('criticalStreak',health==='critical'),healthyStreak:count('healthyStreak',health==='ok'),belowCriticalStreak:count('belowCriticalStreak',health==='ok'||health==='warning'),predictiveStreak:count('predictiveStreak',report.predictiveFailure),
  stale:false,staleSince:null,firstSeenAt:previous?.firstSeenAt??receivedAt,lastSeenAt:receivedAt,createdAt:previous?.createdAt??receivedAt,updatedAt:receivedAt,
 };
 const events:EventRow[]=[];
 const emit=(eventType:EventRow['eventType'],detail:Record<string,unknown>={})=>events.push({deviceId:device.id,orgId:device.orgId,componentKey:row.componentKey,componentType:row.componentType,eventType,fromHealth:previous?.health??null,toHealth:row.health,fromState:previous?.state??null,toState:row.state,detail,snapshotId:snapshot.snapshotId,occurredAt:new Date(snapshot.collectedAt),createdAt:receivedAt});
 if(!previous)emit('first_seen');
 else{
  if(previous.health!==health)emit('health_changed');
  if(previous.state!==row.state)emit('state_changed');
  if(row.componentType==='physical_disk'&&previous.serial?.trim()&&row.serial?.trim()&&previous.serial!==row.serial)emit('disk_replaced',{oldSerial:previous.serial,newSerial:row.serial,model:row.model});
  if(previous.predictiveFailure!==row.predictiveFailure)emit(row.predictiveFailure?'predictive_failure_set':'predictive_failure_cleared');
 }
 return {row,events};
}
export class InvalidHardwareSnapshotError extends Error{
 constructor(public readonly path:string){super(`invalid_snapshot: ${path}`);this.name='InvalidHardwareSnapshotError';}
}
/**
 * #6895 — stale rows are excluded from alert evaluation (spec §7.3), so an
 * unhealthy row that stops being reported keeps its open alert until the
 * 7-day reaper retires it. When the snapshot itself proves the fault is over,
 * retire it now through the same path the reaper uses: the row's parent was
 * reported by a complete answer from the same source, and that parent plus
 * every live same-source row beneath it has been healthy (health ok, which
 * also rules out predictive failure) for
 * STALE_RECOVERY_SNAPSHOTS consecutive snapshots (the built-in rules' default
 * `consecutiveSnapshots`, so the retirement lands with the array's own
 * recovery). A stale row with no parent is never retired early: a standalone
 * disk that vanished is itself a fault.
 */
export const STALE_RECOVERY_SNAPSHOTS=2;
function staleKeysUnderRecoveredParent(rows:Map<string,ComponentRow>,live:ComponentRow[],completeSources:Set<string>):string[]{
 const liveByKey=new Map(live.map(r=>[r.componentKey,r]));
 const children=new Map<string,ComponentRow[]>();
 for(const r of live)if(r.parentKey)children.set(r.parentKey,[...(children.get(r.parentKey)??[]),r]);
 const verdicts=new Map<string,boolean>();
 const subtreeHealthy=(root:ComponentRow):boolean=>{
  const cached=verdicts.get(root.componentKey);if(cached!==undefined)return cached;
  const seen=new Set<string>(),stack=[root];let healthy=true;
  while(stack.length&&healthy){
   const r=stack.pop()!;if(seen.has(r.componentKey))continue;seen.add(r.componentKey);
   if(r.health!=='ok'||r.healthyStreak<STALE_RECOVERY_SNAPSHOTS){healthy=false;break;}
   for(const child of children.get(r.componentKey)??[])if(child.source===root.source)stack.push(child);
  }
  verdicts.set(root.componentKey,healthy);return healthy;
 };
 const keys:string[]=[];
 for(const r of rows.values()){
  if(!r.stale||r.componentType==='collector'||!r.parentKey||!completeSources.has(r.source))continue;
  if(r.health!=='warning'&&r.health!=='critical')continue; // predictive failure derives to warning
  const parent=liveByKey.get(r.parentKey);
  if(parent&&parent.source===r.source&&subtreeHealthy(parent))keys.push(r.componentKey);
 }
 return keys;
}
export function reduceSnapshot(previous:ComponentRow[],device:{id:string;orgId:string},snapshot:HardwareHealthSnapshot,receivedAt:Date){
 const sourceNames=new Set<string>();
 snapshot.sources.forEach((s,i)=>{if(sourceNames.has(s.source))throw new InvalidHardwareSnapshotError(`sources.${i}.source`);sourceNames.add(s.source);});
 const keys=new Set<string>();
 snapshot.components.forEach((c,i)=>{
  if(keys.has(c.componentKey)||c.componentKey.startsWith('collector:'))throw new InvalidHardwareSnapshotError(`components.${i}.componentKey`);
  keys.add(c.componentKey);
  if(!HARDWARE_STATES[c.componentType].includes(c.state))throw new InvalidHardwareSnapshotError(`components.${i}.state`);
  if(Buffer.byteLength(JSON.stringify(c.attributes),'utf8')>8192)throw new InvalidHardwareSnapshotError(`components.${i}.attributes`);
 });
 const rows=new Map(previous.map(r=>[r.componentKey,r]));
 const upserts=new Map<string,ComponentRow>(),events:EventRow[]=[],deletedKeys:string[]=[];
 const apply=(report:ComponentInput)=>{
  const change=componentChange(rows.get(report.componentKey),report,device,snapshot,receivedAt);
  rows.set(report.componentKey,change.row);upserts.set(report.componentKey,change.row);events.push(...change.events);
 };
 for(const source of snapshot.sources){
  if(source.status==='ok'){
   const reports=snapshot.components.filter(c=>c.source===source.source);
   for(const report of reports)apply(report);
   if(source.complete===true){
    const seen=new Set(reports.map(r=>r.componentKey));
    for(const old of rows.values()){
     if(old.source!==source.source||old.componentType==='collector'||old.stale||seen.has(old.componentKey))continue;
     const row={...old,stale:true,staleSince:receivedAt,updatedAt:receivedAt};
     rows.set(row.componentKey,row);upserts.set(row.componentKey,row);
     events.push({deviceId:device.id,orgId:device.orgId,componentKey:row.componentKey,componentType:row.componentType,eventType:'stale',fromHealth:row.health,toHealth:row.health,fromState:row.state,toState:row.state,detail:{},snapshotId:snapshot.snapshotId,occurredAt:new Date(snapshot.collectedAt),createdAt:receivedAt});
    }
   }
  }
  const collectorKey=`collector:${source.source}`;
  if(source.status==='ok'||source.status==='failed'||source.status==='backing_off'){
   apply({componentKey:collectorKey,componentType:'collector',source:source.source,name:source.source,state:source.status,stateDetail:source.error??null,predictiveFailure:false,alertExempt:false,attributes:{}});
  }else if(rows.delete(collectorKey)){
   // Pure reduction only: Task 11 must await retirement for these keys before SQL deletion.
   deletedKeys.push(collectorKey);upserts.delete(collectorKey);
  }
 }
 const live=[...rows.values()].filter(r=>!r.stale);
 const hardware=live.filter(r=>r.componentType!=='collector'&&r.componentType!=='bmc');
 const collectors=live.filter(r=>r.componentType==='collector');
 const counts:Record<string,number>={};for(const c of hardware){const k=`${c.componentType}:${c.health}`;counts[k]=(counts[k]??0)+1;}
 const completeSources=new Set(snapshot.sources.filter(s=>s.status==='ok'&&s.complete===true).map(s=>s.source));
 return {rows:[...rows.values()],upserts:[...upserts.values()],deletedKeys,events,retiredStaleKeys:staleKeysUnderRecoveredParent(rows,live,completeSources),
  health:worstHardwareHealth(hardware.map(r=>r.health)),collectorHealth:collectors.length?worstHardwareHealth(collectors.map(r=>r.health)):'ok' as HardwareHealth,
  summary:{counts,controllerNames:hardware.filter(r=>r.componentType==='controller').map(r=>r.name)},
 };
}
export type IngestResult={accepted:true;events:number;health:HardwareHealth}|{accepted:false;reason:'stale_snapshot'};
export function acceptsAgentSequence(health:{lastReceivedAt:Date|null;lastAgentSequence:number},sequence:number,receivedAt:Date):boolean{
 return health.lastReceivedAt===null||sequence>health.lastAgentSequence||receivedAt.getTime()-health.lastReceivedAt.getTime()>3_600_000;
}
export async function ingestHardwareHealthSnapshot(input:{device:{id:string;orgId:string};snapshot:HardwareHealthSnapshot;writer:'agent'|'server';receivedAt:Date}):Promise<IngestResult>{
 const {device,snapshot,receivedAt,writer}=input;
 return withDbTransaction(async()=>{
  const tx = db satisfies BmcLinkTx;
  const [owner]=await tx.select({id:devices.id,siteId:devices.siteId}).from(devices).where(and(eq(devices.id,device.id),eq(devices.orgId,device.orgId))).for('key share');
  if(!owner)throw new Error('Hardware device missing or ownership changed');
  await tx.insert(deviceHardwareHealth).values({deviceId:device.id,orgId:device.orgId}).onConflictDoNothing({target:deviceHardwareHealth.deviceId});
  const [health]=await tx.select().from(deviceHardwareHealth).where(and(eq(deviceHardwareHealth.deviceId,device.id),eq(deviceHardwareHealth.orgId,device.orgId))).for('update');
  if(!health)throw new Error('Hardware health ownership mismatch');
  if(writer==='agent'&&!acceptsAgentSequence(health,snapshot.sequence,receivedAt))return {accepted:false,reason:'stale_snapshot'};
  const previous=await tx.select().from(deviceHardwareComponents).where(eq(deviceHardwareComponents.deviceId,device.id));
  const change=reduceSnapshot(previous,device,snapshot,receivedAt);
  for(const row of change.upserts){
   if(row.componentType==='bmc'){
    const {bmcLink:_untrusted,...facts}=row.attributes;
    row.attributes=facts;
   }
   const {id,createdAt,firstSeenAt,...update}=row;
   await tx.insert(deviceHardwareComponents).values(row).onConflictDoUpdate({target:[deviceHardwareComponents.deviceId,deviceHardwareComponents.componentKey],set:update});
  }
  if(writer==='agent'){
   const successfulSources=new Set(snapshot.sources.filter(source=>source.status==='ok').map(source=>source.source));
   for(const component of change.upserts){
    if(component.componentType!=='bmc'||component.stale||!successfulSources.has(component.source)||typeof component.attributes.mac!=='string')continue;
    try{
     // Run in its own savepoint (db.transaction nests as a SAVEPOINT inside the
     // ambient withDbTransaction here) so a BMC-link failure can be caught and
     // rolled back on its own without poisoning the outer transaction that
     // must still commit the hardware snapshot itself.
     await db.transaction(sp=>linkBmcAssetFromAgentReport(sp,{
      deviceId:device.id,orgId:device.orgId,siteId:owner.siteId,mac:component.attributes.mac as string,
      ip:typeof component.attributes.ip==='string'?component.attributes.ip:null,
     }));
    }catch(error){
     console.warn('[hardware-health] BMC link failed',error);captureException(error);
    }
   }
  }
  if(change.deletedKeys.length){
   await resolveAlertsForRemovedComponents(device.id,change.deletedKeys);
   await tx.delete(deviceHardwareComponents).where(and(eq(deviceHardwareComponents.deviceId,device.id),inArray(deviceHardwareComponents.componentKey,change.deletedKeys)));
  }
  if(change.retiredStaleKeys.length){
   await resolveAlertsForRemovedComponents(device.id,change.retiredStaleKeys,'component no longer reported; the array it belonged to reports healthy');
  }
  for(let i=0;i<change.events.length;i+=500)await tx.insert(deviceHardwareEvents).values(change.events.slice(i,i+500));
  await tx.update(deviceHardwareHealth).set({health:change.health,collectorHealth:change.collectorHealth,summary:change.summary,updatedAt:receivedAt,
   ...(writer==='agent'?{sources:snapshot.sources,lastAgentSequence:snapshot.sequence,lastSnapshotId:snapshot.snapshotId,lastCollectedAt:new Date(snapshot.collectedAt),lastReceivedAt:receivedAt,lastRaidReceivedAt:snapshot.tiersRun.includes('raid')?receivedAt:health.lastRaidReceivedAt,lastDiskReceivedAt:snapshot.tiersRun.includes('disk')?receivedAt:health.lastDiskReceivedAt,pollIntervalMinutes:snapshot.pollIntervalMinutes,diskHealthIntervalMinutes:snapshot.diskHealthIntervalMinutes,tiersRun:snapshot.tiersRun,agentVersion:snapshot.agentVersion}:{}),
  }).where(eq(deviceHardwareHealth.deviceId,device.id));
  return {accepted:true,events:change.events.length,health:change.health};
 });
}
