import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { eq } from 'drizzle-orm';
import { hardwareHealthSnapshotSchema } from '@breeze/shared';
import { db } from '../../db';
import { devices } from '../../db/schema';
import { zValidator } from '../../lib/validation';
import { requireAgentRole } from '../../middleware/requireAgentRole';
import { ingestHardwareHealthSnapshot,InvalidHardwareSnapshotError } from '../../services/hardwareHealth/ingest';
export const hardwareHealthRoutes=new Hono();
hardwareHealthRoutes.use('*',requireAgentRole);
hardwareHealthRoutes.put('/:id/hardware-health',bodyLimit({maxSize:2*1024*1024,onError:c=>c.json({error:'Request body too large'},413)}),zValidator('json',hardwareHealthSnapshotSchema,(result,c)=>{
 if(!result.success){const path=result.error.issues[0]?.path.map(String).join('.')??'';console.warn('[hardware-health] invalid_snapshot',{path});return c.json({error:'invalid_snapshot',path},422);}
}),async c=>{
 const agentId=c.req.param('id');
 const [device]=await db.select().from(devices).where(eq(devices.agentId,agentId)).limit(1);
 if(!device)return c.json({error:'Device not found'},404);
 try{
  const result=await ingestHardwareHealthSnapshot({device,snapshot:c.req.valid('json'),writer:'agent',receivedAt:new Date()});
  return result.accepted?c.json({accepted:true,events:result.events}):c.json({error:result.reason},409);
 }catch(error){
  if(error instanceof InvalidHardwareSnapshotError){console.warn('[hardware-health] invalid_snapshot',{path:error.path});return c.json({error:'invalid_snapshot',path:error.path},422);}
  throw error;
 }
});
