import { Hono } from 'hono';
import { z } from 'zod';
import { PERMISSION_GRANTS as PERMISSIONS } from '@breeze/shared';
import { db,runOutsideDbContext,withSystemDbAccessContext } from '../../db';
import { authMiddleware,requirePermission } from '../../middleware/auth';
import { zValidator } from '../../lib/validation';
import { invoiceActorFrom } from '../invoices/invoices';
import { autopayErrorHandler } from './errors';
import { requireAutopayEnabled } from '../../services/autopay/autopayGate';
import { listAutopayEnrollments } from '../../services/autopay/enrollmentViews';
import { requestAutopay,pauseAutopay,resumeAutopay,turnOffAutopay } from '../../services/autopay/enrollmentService';
export const autopayRoutes=new Hono();
const manage=requirePermission(PERMISSIONS.BILLING_MANAGE.resource,PERMISSIONS.BILLING_MANAGE.action);
for(const path of ['/billing/autopay','/billing/autopay/requests','/orgs/:orgId/autopay']) {
  autopayRoutes.use(path,authMiddleware,manage,requireAutopayEnabled());
}
autopayRoutes.onError(autopayErrorHandler);
const orgParam=z.object({orgId:z.string().uuid()});
const allowed=(actor:ReturnType<typeof invoiceActorFrom>,ids:string[])=>actor.userId!==null&&actor.partnerId!==null&&
  ids.every(id=>actor.accessibleOrgIds===null||actor.accessibleOrgIds.includes(id));
autopayRoutes.get('/billing/autopay',async c=>{
  const data=await listAutopayEnrollments(invoiceActorFrom(c));
  return c.json({data,notRequestedCount:data.filter(row=>row.status==='not_requested').length});
});
autopayRoutes.post('/billing/autopay/requests',zValidator('json',z.object({
  orgIds:z.array(z.string().uuid()).min(1).max(500),recipientOverride:z.string().email().max(255).optional(),
}).strict()),async c=>{
  const actor=invoiceActorFrom(c),input=c.req.valid('json');
  if(!allowed(actor,input.orgIds))return c.json({error:'Organization not found'},404);
  return c.json(await runOutsideDbContext(()=>withSystemDbAccessContext(()=>requestAutopay(db,actor,{...input,orgIds:[...new Set(input.orgIds)]}))));
});
autopayRoutes.get('/orgs/:orgId/autopay',zValidator('param',orgParam),async c=>{
  const actor=invoiceActorFrom(c),{orgId}=c.req.valid('param');
  if(!allowed(actor,[orgId]))return c.json({error:'Organization not found'},404);
  const [data]=await listAutopayEnrollments(actor,orgId);
  return data?c.json(data):c.json({error:'Organization not found'},404);
});
autopayRoutes.patch('/orgs/:orgId/autopay',zValidator('param',orgParam),
  zValidator('json',z.object({action:z.enum(['pause','resume','turn_off'])}).strict()),async c=>{
    const actor=invoiceActorFrom(c),{orgId}=c.req.valid('param');
    if(!allowed(actor,[orgId]))return c.json({error:'Organization not found'},404);
    const action=c.req.valid('json').action;
    await runOutsideDbContext(()=>withSystemDbAccessContext(()=>({pause:pauseAutopay,resume:resumeAutopay,turn_off:turnOffAutopay}[action](db,actor,orgId))));
    return c.json({success:true});
  });
