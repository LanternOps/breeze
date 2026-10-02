import { Hono,type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { db,withSystemDbAccessContext } from '../../db';
import { zValidator } from '../../lib/validation';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';
import { requireAutopayEnabled } from '../../services/autopay/autopayGate';
import { resolveAutopayLinkIdentity,resolveAutopayReturnIdentity,getAutopayCustomerPage,completeOwnedAutopaySetup } from '../../services/autopay/customerViews';
import { withAcceptedAutopayDisclosure } from '../../services/autopay/consentText';
import { createAutopaySetupSession,stopAutopayByClient } from '../../services/autopay/enrollmentService';
import { withAutopayStopToken } from '../../services/autopay/enrollmentLifecycle';
import { autopayErrorHandler } from './errors';
export const publicAutopayRoutes=new Hono();
publicAutopayRoutes.onError(autopayErrorHandler);
const setup=z.object({methodType:z.enum(['card','us_bank_account']),consentAccepted:z.literal(true),disclosureHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const returning=z.object({token:z.string().min(1).max(512),checkoutSessionId:z.string().regex(/^cs_[A-Za-z0-9_]+$/).max(255)}).strict();
const boundary=(purpose:'enroll'|'stop_autopay',fromBody=false):MiddlewareHandler=>async(c,next)=>{
  // Extract credentials before validating mutation payloads. Return authority
  // includes the owned session, allowing an already-consumed enrollment token.
  const body:unknown=fromBody?await c.req.json().catch(()=>null):null;
  const credentials=body&&typeof body==='object'&&!Array.isArray(body)
    ?body as Record<string,unknown>:null;
  const token=fromBody?credentials?.token:c.req.param('token');
  const deniedStatus=c.req.method==='GET'?404:401;
  if(typeof token!=='string'||!token||token.length>512)
    return c.json({error:'Automatic payments not found'},deniedStatus);
  const sessionId=typeof credentials?.checkoutSessionId==='string'?credentials.checkoutSessionId:'';
  const identity=fromBody?await resolveAutopayReturnIdentity(token,sessionId):await resolveAutopayLinkIdentity(token,purpose);
  if(!identity)return c.json({error:'Automatic payments not found'},deniedStatus);
  c.set('autopayIdentity',identity);c.set('autopayPartnerId',identity.partnerId);
  c.header('Cache-Control','no-store');return next();
};
const gate=requireAutopayEnabled();
publicAutopayRoutes.post('/setup-return',boundary('enroll',true),gate,zValidator('json',returning),async c=>{
  return c.json(await completeOwnedAutopaySetup(c.get('autopayIdentity'),c.req.valid('json').checkoutSessionId));
});
publicAutopayRoutes.get('/:token',boundary('enroll'),gate,async c=>c.json(await getAutopayCustomerPage(c.get('autopayIdentity').orgId)));
publicAutopayRoutes.post('/:token/setup-session',boundary('enroll'),gate,zValidator('json',setup),async c=>{
  const identity=c.get('autopayIdentity'),input=c.req.valid('json');
  const page=await getAutopayCustomerPage(identity.orgId);
  return c.json(await withAcceptedAutopayDisclosure(input.disclosureHash,()=>createAutopaySetupSession({
    orgId:identity.orgId,tokenId:identity.tokenId,methodType:input.methodType,consentAccepted:true,returnTo:'public',
    contactEmail:page.contactEmail,ip:getTrustedClientIpOrUndefined(c)??null,userAgent:c.req.header('user-agent')??null,
  })));
});
publicAutopayRoutes.get('/:token/stop',boundary('stop_autopay'),async c=>{
  const page=await getAutopayCustomerPage(c.get('autopayIdentity').orgId);
  return c.json({partnerName:page.partnerName,orgName:page.orgName,processingWarning:page.processingWarning});
});
publicAutopayRoutes.post('/:token/stop',boundary('stop_autopay'),zValidator('json',z.object({}).strict()),async c=>{
  await withAutopayStopToken(c.req.param('token'),()=>withSystemDbAccessContext(
    ()=>stopAutopayByClient(db,{orgId:c.get('autopayIdentity').orgId,source:'link'})));return c.json({success:true});
});
