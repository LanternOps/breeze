import { expect,it,vi } from 'vitest';
const m=vi.hoisted(()=>({access:vi.fn(),view:vi.fn()}));
vi.mock('../db',()=>({db:{select:vi.fn(),insert:vi.fn(),update:vi.fn(),delete:vi.fn(),execute:vi.fn()},runOutsideDbContext:(fn:any)=>fn(),withSystemDbAccessContext:(fn:any)=>fn(),withDbAccessContext:(_ctx:any,fn:any)=>fn()}));
vi.mock('./brainDeviceContext',()=>({getActiveDeviceContext:vi.fn(),getAllDeviceContext:vi.fn(),createDeviceContext:vi.fn(),resolveDeviceContext:vi.fn()}));
vi.mock('./aiTools',()=>({verifyDeviceAccess:m.access}));
vi.mock('./hardwareHealth/view',()=>({getDeviceHardwareHealthView:m.view}));
import { registerDeviceTools } from './aiToolsDevice';
import type { AiTool } from './aiTools';
it('checks access before the shared view and caps optional events',async()=>{
 const tools=new Map<string,AiTool>();registerDeviceTools(tools);const tool=tools.get('get_device_hardware_health');expect(tool).toMatchObject({tier:1,domain:'devices',deviceArgs:['deviceId']});
 m.access.mockResolvedValue({error:'Device not found or access denied'});m.view.mockClear();
 expect(JSON.parse(await tool!.handler({deviceId:'id'},{} as any))).toHaveProperty('error');expect(m.view).not.toHaveBeenCalled();
 m.access.mockResolvedValue({device:{id:'id'}});m.view.mockResolvedValue({health:'ok'});
 await tool!.handler({deviceId:'id',includeEvents:true},{} as any);expect(m.view).toHaveBeenLastCalledWith('id',{eventLimit:50});
 await tool!.handler({deviceId:'id'},{} as any);expect(m.view).toHaveBeenLastCalledWith('id',{eventLimit:0});
});
