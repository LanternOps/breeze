import { Hono } from 'hono';
import { authMiddleware,requireScope,requirePermission } from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { getDeviceWithOrgAndSiteCheck,SITE_ACCESS_DENIED } from './helpers';
import { getDeviceHardwareHealthView } from '../../services/hardwareHealth/view';
export const hardwareHealthRoutes=new Hono();
hardwareHealthRoutes.use('*',authMiddleware);
hardwareHealthRoutes.get('/:id/hardware-health',requireScope('organization','partner','system'),requirePermission(PERMISSIONS.DEVICES_READ.resource,PERMISSIONS.DEVICES_READ.action),async c=>{
 const deviceId=c.req.param('id')!;const device=await getDeviceWithOrgAndSiteCheck(c,deviceId,c.get('auth'));
 if(device===SITE_ACCESS_DENIED)return c.json({error:'Access to this site denied'},403);
 if(!device)return c.json({error:'Device not found'},404);
 const view=await getDeviceHardwareHealthView(deviceId);
 return view?c.json(view):c.json({error:'no_hardware_health'},404);
});
