import { captureException } from '../../services/sentry';
import {getConfirmPaymentView,confirmInvoicePayment} from '../../services/autopay/confirmPayment';
import { HTTPException } from 'hono/http-exception';
import { portalBase } from '../../services/portalUrl';
import { InvoiceServiceError } from '../../services/invoiceTypes';
import { getSkipInvoiceView, skipInvoice } from '../../services/autopay/invoiceControls';
import { sendAutopayStaffEmail } from '../../services/autopay/staffNotifications';
import { Hono,type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { db,runOutsideDbContext,withSystemDbAccessContext } from '../../db';
import { zValidator } from '../../lib/validation';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';
import { requireAutopayEnabled } from '../../services/autopay/autopayGate';
import { resolveAutopayLinkIdentity,resolveAutopayReturnIdentity,getAutopayCustomerPage,completeOwnedAutopaySetup,describeAutopayLinkFailure,getAutopayStopView } from '../../services/autopay/customerViews';
import { loadAutopayBranding } from '../../services/autopay/customerBranding';
import { withAcceptedAutopayDisclosure } from '../../services/autopay/consentText';
import { createAutopaySetupSession,stopAutopayByClient } from '../../services/autopay/enrollmentService';
import { withAutopayStopToken } from '../../services/autopay/enrollmentLifecycle';
import { autopayErrorHandler } from './errors';
export const publicAutopayRoutes=new Hono();
publicAutopayRoutes.onError((error, c) => {
  if ((c.req.path.endsWith('/skip')||c.req.path.endsWith('/confirm')) && error instanceof HTTPException && error.status < 500) {
    return c.json({ error: 'Invalid request' }, error.status);
  }
  if ((c.req.path.endsWith('/skip')||c.req.path.endsWith('/confirm')) && !(error instanceof InvoiceServiceError)) {
    console.error('[autopay] Public payment control failed', error);
    captureException(error,undefined,{autopay_phase:c.req.path.endsWith('/skip')?'skip':'confirm'});
    return c.json({ error: 'The request could not be completed.' }, 500);
  }
  return autopayErrorHandler(error, c);
});
const setup=z.object({methodType:z.enum(['card','us_bank_account']),consentAccepted:z.literal(true),disclosureHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const returning=z.object({token:z.string().min(1).max(512),checkoutSessionId:z.string().regex(/^cs_[A-Za-z0-9_]+$/).max(255)}).strict();
const boundary=(purpose:'enroll'|'stop_autopay'|'skip_invoice'|'confirm_payment',fromBody=false):MiddlewareHandler=>async(c,next)=>{
  // Extract credentials before validating mutation payloads. Return authority
  // includes the owned session, allowing an already-consumed enrollment token.
  const body:unknown=fromBody?await c.req.json().catch(()=>null):null;
  const credentials=body&&typeof body==='object'&&!Array.isArray(body)
    ?body as Record<string,unknown>:null;
  const token=fromBody?credentials?.token:c.req.param('token');
  const deniedStatus=c.req.method==='GET'||purpose==='confirm_payment'?404:401;
  // A client page (GET) is told why its link cannot be used (expired, replaced, already
  // used); mutations keep the bare refusal.
  const deny=async(value:unknown)=>c.req.method==='GET'&&!fromBody&&typeof value==='string'&&value&&value.length<=512
    ?c.json(await describeAutopayLinkFailure(value,purpose),deniedStatus)
    :c.json({error:'Automatic payments not found'},deniedStatus);
  if(typeof token!=='string'||!token||token.length>512)return deny(token);
  const sessionId=typeof credentials?.checkoutSessionId==='string'?credentials.checkoutSessionId:'';
  const identity=fromBody?await resolveAutopayReturnIdentity(token,sessionId):await resolveAutopayLinkIdentity(token,purpose);
  if(!identity)return deny(token);
  c.set('autopayIdentity',identity);c.set('autopayPartnerId',identity.partnerId);
  c.header('Cache-Control','no-store');return next();
};
// Setup refused while switched off still names the MSP, so the page can say who to ask.
const enabled=requireAutopayEnabled();
const gate:MiddlewareHandler=async(c,next)=>{
  let passed=false;
  const refused=await enabled(c,async()=>{passed=true;await next();});
  if(passed||!(refused instanceof Response))return refused;
  const body=await refused.clone().json().catch(()=>({})) as Record<string,unknown>;
  const identity=c.get('autopayIdentity');
  // R10: the refusal still goes out unbranded, but a failed read is never silent.
  const branding=await runOutsideDbContext(()=>withSystemDbAccessContext(()=>loadAutopayBranding(db,
    {orgId:identity.orgId,partnerId:identity.partnerId}))).catch((error:unknown)=>{
    console.error('[autopay] Branding for a switched-off refusal could not be read',error);
    captureException(error,undefined,{autopay_phase:'gate_branding'});
    return {};
  });
  return c.json({...body,data:branding},refused.status as 404);
};
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
publicAutopayRoutes.get('/:token/stop',boundary('stop_autopay'),async c=>c.json(await getAutopayStopView(c.get('autopayIdentity').orgId)));
publicAutopayRoutes.post('/:token/stop',boundary('stop_autopay'),zValidator('json',z.object({}).strict()),async c=>{
  await withAutopayStopToken(c.req.param('token'),()=>withSystemDbAccessContext(
    ()=>stopAutopayByClient(db,{orgId:c.get('autopayIdentity').orgId,source:'link'})));return c.json({success:true});
});

/** JSON admission for token mutations. Tokens still supply authority without Origin. */
export const publicJsonPost: MiddlewareHandler = async (c, next) => {
  if (!(c.req.header('content-type') ?? '').toLowerCase().includes('application/json')) {
    return c.json({ error: 'Invalid request' }, 400);
  }
  const origin = c.req.header('origin');
  if (origin && origin !== new URL(portalBase()).origin) return c.json({ error: 'Invalid request' }, 403);
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  return next();
};
// No rollout gate: skipping only reduces charging, and a charge deferred while switched
// off still runs when the switch returns, so the client must be able to skip it.
publicAutopayRoutes.get('/:token/skip', boundary('skip_invoice'), async c => {
  return c.json(await withSystemDbAccessContext(() => getSkipInvoiceView(db, c.req.param('token'))));
});
publicAutopayRoutes.post('/:token/skip', boundary('skip_invoice'), publicJsonPost,
  zValidator('json', z.object({}).strict()), async c => {
    const result = await withSystemDbAccessContext(() => db.transaction(tx => skipInvoice(tx, c.req.param('token'))));
    if (result.status === 'pending') return c.json(result, 202);
    if (result.staffNotice) await sendAutopayStaffEmail(result.staffNotice);
    return c.json({ status: result.status });
  });

publicAutopayRoutes.get('/:token/confirm',boundary('confirm_payment'),async c=>
  c.json(await getConfirmPaymentView(c.req.param('token'))));
publicAutopayRoutes.post('/:token/confirm',boundary('confirm_payment'),publicJsonPost,
  zValidator('json',z.object({}).strict()),async c=>{
    try{return c.json(await confirmInvoicePayment(c.req.param('token')));}
    catch(error){
      if(error instanceof InvoiceServiceError&&error.status===404)return c.json({error:'Link unavailable'},404);
      console.error('[autopay] Public confirmation failed',error);
      captureException(error,undefined,{autopay_phase:'confirm'});
      // R5: code and reason let the page tell "under review" from "still processing".
      if(error instanceof InvoiceServiceError && error.status<500)return c.json({error:error.message,code:error.code,
        ...(error.details?{details:error.details}:{})},error.status);
      return c.json({error:'Payment could not be confirmed. Refresh the invoice to check its status.'},500);
    }
  });
