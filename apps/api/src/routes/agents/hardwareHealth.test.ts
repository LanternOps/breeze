import { beforeEach,expect,it,vi } from 'vitest';
import { Hono } from 'hono';
const m=vi.hoisted(()=>({ingest:vi.fn(),rows:[] as any[]}));
vi.mock('../../db',()=>({db:{select:()=>({from:()=>({where:()=>({limit:async()=>m.rows})})})}}));
vi.mock('../../services/hardwareHealth/ingest',()=>({ingestHardwareHealthSnapshot:m.ingest,InvalidHardwareSnapshotError:class extends Error{constructor(public path:string){super(path);}}}));
import { hardwareHealthRoutes } from './hardwareHealth';
import { InvalidHardwareSnapshotError } from '../../services/hardwareHealth/ingest';
const wire={snapshotId:'33333333-3333-4333-8333-333333333333',sequence:1,collectedAt:'2026-09-23T00:00:00Z',agentVersion:'1',pollIntervalMinutes:10,diskHealthIntervalMinutes:60,tiersRun:['raid'],sources:[],components:[]};
function request(body:unknown=wire,role='agent'){
 const app=new Hono();app.use('*',async(c,next)=>{if(role==='missing')return c.json({error:'Unauthorized'},401);c.set('agent',{role} as any);await next();});app.route('/',hardwareHealthRoutes);
 return app.request('/agent-1/hardware-health',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
}
beforeEach(()=>{m.rows=[{id:'11111111-1111-4111-8111-111111111111',orgId:'22222222-2222-4222-8222-222222222222'}];m.ingest.mockReset().mockResolvedValue({accepted:true,events:2,health:'critical'});});
it('returns only accepted and events and uses authenticated device ownership',async()=>{
 const res=await request();expect(res.status).toBe(200);expect(await res.json()).toEqual({accepted:true,events:2});expect(m.ingest).toHaveBeenCalledWith(expect.objectContaining({device:m.rows[0],writer:'agent',receivedAt:expect.any(Date)}));
});
it.each([['missing',401],['watchdog',403],['helper',403]] as const)('rejects %s credentials',async(role,status)=>{expect((await request(wire,role)).status).toBe(status);expect(m.ingest).not.toHaveBeenCalled();});
it('returns 404 for absent or RLS-hidden device',async()=>{m.rows=[];expect((await request()).status).toBe(404);expect(m.ingest).not.toHaveBeenCalled();});
it('rejects stale sequence as 409',async()=>{m.ingest.mockResolvedValue({accepted:false,reason:'stale_snapshot'});const res=await request();expect(res.status).toBe(409);expect(await res.json()).toEqual({error:'stale_snapshot'});});
it('caps bytes at 2 MiB before database writes',async()=>{expect((await request({...wire,agentVersion:'x'.repeat(2*1024*1024)})).status).toBe(413);expect(m.ingest).not.toHaveBeenCalled();});
it('returns precise 422 paths for structural and semantic failures',async()=>{
 let res=await request({...wire,sequence:-1});expect(res.status).toBe(422);expect(await res.json()).toEqual({error:'invalid_snapshot',path:'sequence'});
 m.ingest.mockRejectedValue(new InvalidHardwareSnapshotError('components.0.attributes'));res=await request();expect(res.status).toBe(422);expect(await res.json()).toEqual({error:'invalid_snapshot',path:'components.0.attributes'});
});
it('does not disguise database errors as invalid snapshots',async()=>{m.ingest.mockRejectedValue(new Error('DB unavailable'));expect((await request()).status).toBe(500);});
