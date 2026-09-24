import { desc,eq } from 'drizzle-orm';
import type { HardwareHealth,HardwareSourceReport } from '@breeze/shared';
import { db } from '../../db';
import { deviceHardwareComponents,deviceHardwareEvents,deviceHardwareHealth } from '../../db/schema';
import { resolveDeviceHardwareMonitoringPolicy } from '../../routes/agents/helpers';
import { isComponentFresh } from './freshness';
type JsonDates<T>={[K in keyof T]:T[K] extends Date?string:T[K] extends Date|null?string|null:T[K]};
export type HardwareComponentView=JsonDates<typeof deviceHardwareComponents.$inferSelect>&{fresh:boolean};
export type HardwareEventView=JsonDates<typeof deviceHardwareEvents.$inferSelect>;
export interface HardwareHealthView{
 health:HardwareHealth;collectorHealth:HardwareHealth;lastReceivedAt:string|null;lastCollectedAt:string|null;
 pollIntervalMinutes:number|null;diskHealthIntervalMinutes:number|null;tiersRun:string[];agentVersion:string|null;
 sources:HardwareSourceReport[];components:HardwareComponentView[];events:HardwareEventView[];
 policy:{enabled:boolean;source:'default'|'policy';policyName?:string}|null;
}
export async function getDeviceHardwareHealthView(deviceId:string,opts?:{eventLimit?:number}):Promise<HardwareHealthView|null>{
 const [health]=await db.select().from(deviceHardwareHealth).where(eq(deviceHardwareHealth.deviceId,deviceId)).limit(1);
 if(!health)return null;
 const rows=await db.select().from(deviceHardwareComponents).where(eq(deviceHardwareComponents.deviceId,deviceId)).orderBy(deviceHardwareComponents.componentKey);
 const limit=Math.max(0,Math.min(50,Math.floor(opts?.eventLimit??50)));
 const events=limit?await db.select().from(deviceHardwareEvents).where(eq(deviceHardwareEvents.deviceId,deviceId)).orderBy(desc(deviceHardwareEvents.occurredAt),desc(deviceHardwareEvents.createdAt),desc(deviceHardwareEvents.id)).limit(limit):[];
 let policy:HardwareHealthView['policy']=null;
 try{policy=await resolveDeviceHardwareMonitoringPolicy(deviceId);}catch(error){console.warn('[hardware-health] policy view unavailable',error);}
 const now=new Date();
 return {health:health.health,collectorHealth:health.collectorHealth,lastReceivedAt:health.lastReceivedAt?.toISOString()??null,lastCollectedAt:health.lastCollectedAt?.toISOString()??null,pollIntervalMinutes:health.pollIntervalMinutes,diskHealthIntervalMinutes:health.diskHealthIntervalMinutes,tiersRun:health.tiersRun,agentVersion:health.agentVersion,sources:health.sources,
  components:rows.map(row=>({...row,firstSeenAt:row.firstSeenAt.toISOString(),lastSeenAt:row.lastSeenAt.toISOString(),createdAt:row.createdAt.toISOString(),updatedAt:row.updatedAt.toISOString(),staleSince:row.staleSince?.toISOString()??null,fresh:isComponentFresh(row,health,now)})),
  events:events.map(row=>({...row,occurredAt:row.occurredAt.toISOString(),createdAt:row.createdAt.toISOString()})),policy,
 };
}
