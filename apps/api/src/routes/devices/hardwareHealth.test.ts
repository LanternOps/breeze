import { beforeEach,expect,it,vi } from 'vitest';
const m=vi.hoisted(()=>({device:vi.fn(),view:vi.fn(),denied:Symbol('denied'),status:0,permissionDenied:false}));
vi.mock('../../middleware/auth',()=>({authMiddleware:async(c:any,next:any)=>{if(m.status===401)return c.json({error:'Unauthorized'},401);c.set('auth',{});return next();},requireScope:()=>async(c:any,next:any)=>m.status===403?c.json({error:'Forbidden'},403):next(),requirePermission:()=>async(c:any,next:any)=>m.permissionDenied?c.json({error:'Forbidden'},403):next()}));
vi.mock('./helpers',()=>({getDeviceWithOrgAndSiteCheck:m.device,SITE_ACCESS_DENIED:m.denied}));
vi.mock('../../services/hardwareHealth/view',()=>({getDeviceHardwareHealthView:m.view}));
import { hardwareHealthRoutes } from './hardwareHealth';
beforeEach(()=>{m.status=0;m.permissionDenied=false;m.device.mockReset().mockResolvedValue({id:'11111111-1111-4111-8111-111111111111'});m.view.mockReset().mockResolvedValue({health:'ok'});});
const request=()=>hardwareHealthRoutes.request('/11111111-1111-4111-8111-111111111111/hardware-health');
it('returns the shared view',async()=>{const res=await request();expect(res.status).toBe(200);expect(await res.json()).toEqual({health:'ok'});});
it.each([401,403])('stops forbidden caller %s before reading',async status=>{m.status=status;expect((await request()).status).toBe(status);expect(m.view).not.toHaveBeenCalled();});
it.each([[null,404],[m.denied,403]])('stops missing/cross-org/site result %s',async(value,status)=>{m.device.mockResolvedValue(value);expect((await request()).status).toBe(status);expect(m.view).not.toHaveBeenCalled();});
it('checks DEVICES_READ before lookup',async()=>{m.permissionDenied=true;expect((await request()).status).toBe(403);expect(m.device).not.toHaveBeenCalled();expect(m.view).not.toHaveBeenCalled();});
// sweep D15: no hardware-health report yet is an expected empty state (every
// device detail load hits this route) — 404 there logged as a console error
// for something that isn't broken. 200 keeps the same discriminant body.
it('distinguishes absent hardware data with a 200, not a 404',async()=>{m.view.mockResolvedValue(null);const res=await request();expect(res.status).toBe(200);expect(await res.json()).toEqual({error:'no_hardware_health'});});
it('surfaces backend failure',async()=>{m.view.mockRejectedValue(new Error('database'));expect((await request()).status).toBe(500);});
