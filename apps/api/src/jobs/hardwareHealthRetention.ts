import { Queue,Worker } from 'bullmq';
import { and,eq,inArray,lt,sql } from 'drizzle-orm';
import { db,runOutsideDbContext,withSystemDbAccessContext } from '../db';
import { devices,deviceHardwareComponents,deviceHardwareEvents,deviceHardwareHealth } from '../db/schema';
import { getBullMQConnection } from '../services/redis';
import { resolveAlertsForRemovedComponents } from '../services/hardwareHealth/retire';
import { pruneInCtidBatches } from './retentionBatch';
import { jobSchedule } from './scheduleRegistry';
import { attachWorkerObservability } from './workerObservability';

const QUEUE_NAME='hardware-health-retention';
const scoped=<T>(label:string,fn:()=>Promise<T>)=>runOutsideDbContext(()=>withSystemDbAccessContext(fn,label));

export async function runHardwareHealthRetention(now=new Date()){
 const events=await pruneInCtidBatches({table:'device_hardware_events',where:sql`occurred_at < ${new Date(+now-180*86_400_000).toISOString()}::timestamptz`,batchSize:10000,maxBatches:100,label:'hardwareHealthRetention.events'});
 const cutoff=new Date(+now-7*86_400_000);let components=0;
 for(let batch=0;batch<100;batch++){
  const [candidate]=await scoped('hardwareHealthRetention.candidate',()=>db.select({deviceId:deviceHardwareComponents.deviceId}).from(deviceHardwareComponents).where(and(eq(deviceHardwareComponents.stale,true),lt(deviceHardwareComponents.staleSince,cutoff))).orderBy(deviceHardwareComponents.staleSince).limit(1));
  if(!candidate)break;
  components+=await scoped('hardwareHealthRetention.components',async()=>{
   const [device]=await db.select({id:devices.id}).from(devices).where(eq(devices.id,candidate.deviceId)).for('key share');if(!device)return 0;
   await db.select().from(deviceHardwareHealth).where(eq(deviceHardwareHealth.deviceId,device.id)).for('update');
   const rows=await db.select().from(deviceHardwareComponents).where(and(eq(deviceHardwareComponents.deviceId,device.id),eq(deviceHardwareComponents.stale,true),lt(deviceHardwareComponents.staleSince,cutoff))).orderBy(deviceHardwareComponents.staleSince,deviceHardwareComponents.id).limit(250).for('update');
   if(!rows.length)return 0;
   await resolveAlertsForRemovedComponents(device.id,rows.map(r=>r.componentKey));
   await db.insert(deviceHardwareEvents).values(rows.map(r=>({deviceId:r.deviceId,orgId:r.orgId,componentKey:r.componentKey,componentType:r.componentType,eventType:'removed' as const,fromHealth:r.health,fromState:r.state,toHealth:null,toState:null,detail:{},snapshotId:null,occurredAt:now,createdAt:now})));
   await db.delete(deviceHardwareComponents).where(inArray(deviceHardwareComponents.id,rows.map(r=>r.id)));
   return rows.length;
  });
 }
 return {events,components};
}

let queue:Queue|null=null,worker:Worker|null=null;

export async function initializeHardwareHealthRetention():Promise<void>{
 queue=new Queue(QUEUE_NAME,{connection:getBullMQConnection()});
 worker=new Worker(QUEUE_NAME,()=>runHardwareHealthRetention(),{connection:getBullMQConnection(),concurrency:1});
 attachWorkerObservability(worker,'hardwareHealthRetention');
 worker.on('error',error=>console.error('[hardware-health] retention worker failed',error));
 for(const job of await queue.getRepeatableJobs())await queue.removeRepeatableByKey(job.key);
 await queue.add('cleanup',{}, {repeat:{pattern:jobSchedule('hardware-health-retention')},removeOnComplete:{count:5},removeOnFail:{count:10}});
}

export async function shutdownHardwareHealthRetention():Promise<void>{
 if(worker){await worker.close();worker=null;}if(queue){await queue.close();queue=null;}
}
