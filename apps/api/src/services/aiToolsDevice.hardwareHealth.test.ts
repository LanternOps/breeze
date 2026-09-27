import { expect,it,vi } from 'vitest';
const m=vi.hoisted(()=>({access:vi.fn(),view:vi.fn(),getReliability:vi.fn(),getOffenders:vi.fn()}));
vi.mock('../db',()=>({db:{select:vi.fn(),insert:vi.fn(),update:vi.fn(),delete:vi.fn(),execute:vi.fn()},runOutsideDbContext:(fn:any)=>fn(),withSystemDbAccessContext:(fn:any)=>fn(),withDbAccessContext:(_ctx:any,fn:any)=>fn()}));
vi.mock('./brainDeviceContext',()=>({getActiveDeviceContext:vi.fn(),getAllDeviceContext:vi.fn(),createDeviceContext:vi.fn(),resolveDeviceContext:vi.fn()}));
vi.mock('./aiTools',()=>({verifyDeviceAccess:m.access}));
vi.mock('./hardwareHealth/view',()=>({getDeviceHardwareHealthView:m.view}));
vi.mock('./reliabilityScoring',()=>({getDeviceReliability:m.getReliability,getDeviceReliabilityOffenders:m.getOffenders}));
import { registerDeviceTools } from './aiToolsDevice';
import type { AiTool } from './aiTools';
it('checks access before the shared view and caps optional events',async()=>{
 const tools=new Map<string,AiTool>();registerDeviceTools(tools);const tool=tools.get('get_device_hardware_health');expect(tool).toMatchObject({tier:1,domain:'devices',deviceArgs:['deviceId']});
 m.access.mockResolvedValue({error:'Device not found or access denied'});m.view.mockClear();
 expect(JSON.parse(await tool!.handler({deviceId:'id'},{} as any))).toHaveProperty('error');expect(m.view).not.toHaveBeenCalled();
 m.access.mockResolvedValue({device:{id:'id'}});m.view.mockResolvedValue({health:'ok'});
 await tool!.handler({deviceId:'id',includeEvents:true},{} as any);expect(m.view).toHaveBeenLastCalledWith('id',{eventLimit:50});
 await tool!.handler({deviceId:'id'},{} as any);expect(m.view).toHaveBeenLastCalledWith('id',{eventLimit:0});
 expect(m.getReliability).not.toHaveBeenCalled();expect(m.getOffenders).not.toHaveBeenCalled();
});
it('#7132: includeReliability adds the score drivers and hardware offenders, never fetched otherwise',async()=>{
 const tools=new Map<string,AiTool>();registerDeviceTools(tools);const tool=tools.get('get_device_hardware_health');
 m.access.mockResolvedValue({device:{id:'id'}});m.view.mockResolvedValue({health:'ok'});
 m.getReliability.mockResolvedValue({reliabilityScore:38,trendDirection:'degrading',drivers:[{factor:'hardwareErrors',label:'Hardware errors',score:0,weight:20,lostPoints:20,evidence:{hardwareErrorCount30d:50}}]});
 m.getOffenders.mockResolvedValue({services:[],hardware:[{key:'filtermanager',label:'Microsoft-Windows-FilterManager',count:50,lastOccurrence:'2026-09-10T01:26:00.000Z'}],hangs:[]});
 const result=JSON.parse(await tool!.handler({deviceId:'id',includeReliability:true},{} as any));
 expect(m.getReliability).toHaveBeenCalledWith('id');expect(m.getOffenders).toHaveBeenCalledWith('id',30,5);
 expect(result.reliability).toMatchObject({score:38,trendDirection:'degrading'});
 expect(result.reliability.drivers[0]).toMatchObject({factor:'hardwareErrors'});
 expect(result.hardwareOffenders30d).toEqual([{key:'filtermanager',label:'Microsoft-Windows-FilterManager',count:50,lastOccurrence:'2026-09-10T01:26:00.000Z'}]);
});
