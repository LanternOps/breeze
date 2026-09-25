import { beforeEach,expect,it,vi } from 'vitest';
const m=vi.hoisted(()=>({rows:[] as any[][],order:[] as string[],prune:vi.fn(),retire:vi.fn(),add:vi.fn(),close:vi.fn()}));
vi.mock('../db',()=>{
 const select=()=>{const rows=m.rows.shift()??[];const q:any={then:(a:any,b:any)=>Promise.resolve(rows).then(a,b)};for(const k of ['from','where','orderBy','limit','for'])q[k]=()=>q;return q;};
 return {db:{select,insert:()=>({values:async()=>{m.order.push('events');}}),delete:()=>({where:async()=>{m.order.push('delete');}})},runOutsideDbContext:(fn:any)=>fn(),withSystemDbAccessContext:(fn:any)=>fn()};
});
vi.mock('./retentionBatch',()=>({pruneInCtidBatches:m.prune}));
vi.mock('../services/hardwareHealth/retire',()=>({resolveAlertsForRemovedComponents:m.retire}));
vi.mock('../services/redis',()=>({getBullMQConnection:()=>({})}));
vi.mock('./workerObservability',()=>({attachWorkerObservability:vi.fn()}));
vi.mock('bullmq',()=>({Queue:class{add=m.add;close=m.close;getRepeatableJobs=async()=>[];removeRepeatableByKey=vi.fn();},Worker:class{close=m.close;on=vi.fn();}}));
import { runHardwareHealthRetention,initializeHardwareHealthRetention,shutdownHardwareHealthRetention } from './hardwareHealthRetention';
beforeEach(()=>{m.rows=[];m.order=[];m.prune.mockReset().mockResolvedValue({deleted:3,batches:1});m.retire.mockReset().mockImplementation(async()=>{m.order.push('resolve');return 0;});m.add.mockReset();});
it('prunes events in ctid batches and resolves before removal',async()=>{
 m.rows=[[{deviceId:'device'}],[{id:'device'}],[{deviceId:'device'}],[{id:'row',deviceId:'device',orgId:'org',componentKey:'storcli:c0',componentType:'controller',health:'ok',state:'ok'}],[]];
 const result=await runHardwareHealthRetention(new Date('2026-09-23T00:00:00Z'));
 expect(result.components).toBe(1);expect(m.order).toEqual(['resolve','events','delete']);expect(m.prune).toHaveBeenCalledWith(expect.objectContaining({table:'device_hardware_events',batchSize:10000,maxBatches:100}));
});
it('does not remove rows or emit events if retirement fails',async()=>{
 m.rows=[[{deviceId:'device'}],[{id:'device'}],[{deviceId:'device'}],[{id:'row',componentKey:'slot'}]];m.retire.mockRejectedValue(new Error('alert resolution failed'));
 await expect(runHardwareHealthRetention()).rejects.toThrow('alert resolution failed');expect(m.order).toEqual([]);
});
it('leaves a component revived before the locked recheck untouched',async()=>{
 m.rows=[[{deviceId:'device'}],[{id:'device'}],[{deviceId:'device'}],[],[]];
 expect((await runHardwareHealthRetention()).components).toBe(0);expect(m.retire).not.toHaveBeenCalled();expect(m.order).toEqual([]);
});
it('registers a daily cron and closes resources',async()=>{
 await initializeHardwareHealthRetention();expect(m.add).toHaveBeenCalledWith('cleanup',{},expect.objectContaining({repeat:{pattern:'8 7 * * *'}}));await shutdownHardwareHealthRetention();expect(m.close).toHaveBeenCalledTimes(2);
});
