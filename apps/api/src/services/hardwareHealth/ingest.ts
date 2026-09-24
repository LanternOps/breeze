import { randomUUID } from 'node:crypto';
import { deriveHardwareHealth,HARDWARE_STATES,worstHardwareHealth,type HardwareComponentType,type HardwareComponentReport,type HardwareHealthSnapshot,type HardwareHealth } from '@breeze/shared';
import { deviceHardwareComponents,deviceHardwareEvents,deviceHardwareHealth } from '../../db/schema';
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
