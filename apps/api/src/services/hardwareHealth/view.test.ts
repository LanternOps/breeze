import { beforeEach,expect,it,vi } from 'vitest';
const m=vi.hoisted(()=>({rows:[] as any[][],policy:vi.fn()}));
vi.mock('../../db',()=>({db:{select:()=>{const rows=m.rows.shift()??[];const q:any={then:(a:any,b:any)=>Promise.resolve(rows).then(a,b)};for(const k of ['from','where','limit','orderBy'])q[k]=()=>q;return q;}}}));
vi.mock('../../routes/agents/helpers',()=>({resolveDeviceHardwareMonitoringPolicy:m.policy}));
import { getDeviceHardwareHealthView } from './view';
beforeEach(()=>{m.rows=[];m.policy.mockReset().mockResolvedValue({enabled:true,source:'default'});});
it('returns null before any snapshot and does not resolve policy',async()=>{m.rows=[[]];expect(await getDeviceHardwareHealthView('device')).toBeNull();expect(m.policy).not.toHaveBeenCalled();});
it('serializes all row dates and marks old disk observations unfresh',async()=>{
 const date=new Date('2000-01-01T00:00:00Z');
 m.rows=[[{health:'ok',collectorHealth:'ok',lastReceivedAt:date,lastCollectedAt:null,pollIntervalMinutes:10,diskHealthIntervalMinutes:60,tiersRun:['disk'],agentVersion:'1',sources:[]}],[{id:'component',source:'smartctl',lastSeenAt:date,firstSeenAt:date,createdAt:date,updatedAt:date,staleSince:null,sizeBytes:100}],[{id:'event',occurredAt:date,createdAt:date}]];
 const view=await getDeviceHardwareHealthView('device');expect(view!.components[0]).toMatchObject({fresh:false,sizeBytes:100,lastSeenAt:date.toISOString(),staleSince:null});expect(view!.events[0]!.occurredAt).toBe(date.toISOString());expect(view!.lastCollectedAt).toBeNull();
});
it('omits events on request and reports unavailable policy as null',async()=>{
 m.rows=[[{health:'unknown',collectorHealth:'ok',lastReceivedAt:null,lastCollectedAt:null,pollIntervalMinutes:null,diskHealthIntervalMinutes:null,tiersRun:[],agentVersion:null,sources:[]}],[]];m.policy.mockRejectedValue(new Error('policy read unavailable'));
 const view=await getDeviceHardwareHealthView('device',{eventLimit:0});expect(view!.events).toEqual([]);expect(view!.policy).toBeNull();
});
