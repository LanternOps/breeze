import { beforeEach,expect,it,vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
const m=vi.hoisted(()=>({retire:vi.fn(),keys:['collector:storcli','storcli:c0'],order:[] as string[]}));
vi.mock('./hardwareHealth/retire',()=>({resolveAlertsForRemovedComponents:m.retire}));
vi.mock('./sentry',()=>({captureMessage:vi.fn()}));
vi.mock('../db/lockTimeout',()=>({tightenLockTimeout:vi.fn(async()=>null),lockTimeoutWasChanged:()=>false}));
vi.mock('../routes/devices/core',()=>({DEVICE_DETACH_DEVICE_ID_TABLES:[],DEVICE_LINKED_DEVICE_ID_TABLES:[],DEVICE_LINK_DEPENDENT_COLUMNS:[],getDeviceCascadeDeleteTables:()=>['alerts','device_hardware_components','device_hardware_events','device_hardware_health']}));
import { deleteDeviceCascade,type DeviceDeletionTx } from './deviceDeletion';
const dialect=new PgDialect();
function tx():DeviceDeletionTx{
 return {
  execute:vi.fn(async query=>{
   const text=dialect.sqlToQuery(query as SQL).sql;m.order.push(text);
   if(text.includes('FROM device_hardware_components'))return m.keys.map(component_key=>({component_key}));
   if(text.includes('FOR UPDATE'))return Object.assign([{id:'device'}],{count:1});
   return [];
  }),
  delete:()=>({where:async()=>{m.order.push('delete-device');}}),
 };
}
beforeEach(()=>{m.keys=['collector:storcli','storcli:c0'];m.order=[];m.retire.mockReset().mockImplementation(async()=>{m.order.push('retire');return 0;});});
it('locks the device, retires every component key, then deletes dependents and the device',async()=>{
 await deleteDeviceCascade(tx(),'device');
 expect(m.retire).toHaveBeenCalledWith('device',['collector:storcli','storcli:c0']);
 const retired=m.order.indexOf('retire');
 expect(retired).toBeGreaterThan(m.order.findIndex(q=>q.includes('FOR UPDATE')));
 expect(m.order.findIndex(q=>q.startsWith('DELETE'))).toBeGreaterThan(retired);
 expect(m.order.indexOf('delete-device')).toBeGreaterThan(retired);
});
it('deletes devices with no hardware without calling retirement',async()=>{
 m.keys=[];await deleteDeviceCascade(tx(),'device');expect(m.retire).not.toHaveBeenCalled();expect(m.order).toContain('delete-device');
});
it('propagates retirement errors before any destructive statement',async()=>{
 m.retire.mockRejectedValue(new Error('retirement unavailable'));
 await expect(deleteDeviceCascade(tx(),'device')).rejects.toThrow('retirement unavailable');
 expect(m.order.some(q=>q.startsWith('DELETE')||q==='delete-device')).toBe(false);
});
