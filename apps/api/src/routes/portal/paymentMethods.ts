import { Hono,type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { db,withSystemDbAccessContext } from '../../db';
import { zValidator } from '../../lib/validation';
import { portalAuthMiddleware } from './auth';
import { portalFinancialMutationGuard } from './helpers';
import { requireAutopayEnabled } from '../../services/autopay/autopayGate';
import { resolveAutopayOrgIdentity,getAutopayCustomerPage,completeOwnedAutopaySetup } from '../../services/autopay/customerViews';
import { withAcceptedAutopayDisclosure } from '../../services/autopay/consentText';
import { createAutopaySetupSession,stopAutopayByClient } from '../../services/autopay/enrollmentService';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';
import { autopayErrorHandler } from '../autopay/errors';
export const portalPaymentMethodRoutes=new Hono();
portalPaymentMethodRoutes.onError(autopayErrorHandler);
const identity:MiddlewareHandler=async(c,next)=>{
  const owned=await resolveAutopayOrgIdentity(c.get('portalAuth').user.orgId);
  if(!owned)return c.json({error:'Automatic payments not found'},404);
  c.set('autopayIdentity',owned);c.set('autopayPartnerId',owned.partnerId);c.header('Cache-Control','no-store');return next();
};
for(const path of ['/payment-methods','/payment-methods/setup-session','/payment-methods/setup-return','/autopay/stop']){
  portalPaymentMethodRoutes.use(path,portalAuthMiddleware,identity,...(path==='/autopay/stop'?[]:[requireAutopayEnabled()]),portalFinancialMutationGuard);
}
portalPaymentMethodRoutes.get('/payment-methods',async c=>c.json(await getAutopayCustomerPage(c.get('portalAuth').user.orgId)));
portalPaymentMethodRoutes.post('/payment-methods/setup-session',zValidator('json',z.object({
  methodType:z.enum(['card','us_bank_account']),consentAccepted:z.literal(true),disclosureHash:z.string().regex(/^[a-f0-9]{64}$/),
}).strict()),async c=>{
  const auth=c.get('portalAuth'),input=c.req.valid('json');
  return c.json(await withAcceptedAutopayDisclosure(input.disclosureHash,()=>createAutopaySetupSession({
    orgId:auth.user.orgId,methodType:input.methodType,consentAccepted:true,returnTo:'portal',contactEmail:auth.user.email,
    ip:getTrustedClientIpOrUndefined(c)??null,userAgent:c.req.header('user-agent')??null,
  })));
});
portalPaymentMethodRoutes.post('/payment-methods/setup-return',zValidator('json',z.object({checkoutSessionId:z.string().regex(/^cs_[A-Za-z0-9_]+$/).max(255)}).strict()),
  async c=>c.json(await completeOwnedAutopaySetup(c.get('autopayIdentity'),c.req.valid('json').checkoutSessionId)));
portalPaymentMethodRoutes.post('/autopay/stop',zValidator('json',z.object({}).strict()),async c=>{
  const auth=c.get('portalAuth');await withSystemDbAccessContext(()=>stopAutopayByClient(db,{orgId:auth.user.orgId,source:'portal',portalUserId:auth.user.id}));
  return c.json({success:true});
});
