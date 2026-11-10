/**
 * Public customer-portal self-registration routes (portal registration W6,
 * plan D3, D4, D8–D10, D12). Mounted with the other public portal routes;
 * no portal session, no DB context held.
 *
 * POST /auth/self-register  { email, name }
 *   One answer for every address (inv. 8): eligible, ineligible, existing and
 *   unknown addresses get the same status, body and headers, pass through the
 *   same three rate limits and do the same work — one enqueue. The handler
 *   reads no DB row and calls no domain lookup; the worker decides
 *   (services/portalSelfRegistration/worker.ts). Only syntax (400), the
 *   deployment capability (404), throttling (429, identical for every
 *   address) and a missing Redis client (503) change the response.
 *
 * POST /auth/self-register/verify  { token }
 *   The explicit confirm from the portal's verify page (never a GET: mail
 *   scanners prefetch links). Consumes the single-use link token atomically,
 *   re-validates org, domain and policy (complete.ts) and answers the outcome.
 *   Unknown, expired, reused and refused tokens all get the same 400.
 */
import { createHash } from 'crypto';
import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { rateLimitIpKey } from '../../services/clientIp';
import { ANONYMOUS_ACTOR_ID, writeAuditEventAsync } from '../../services/auditEvents';
import { getPortalSignInCapabilities } from '../../services/portalAccessPolicy';
import { emailDomainOf, enqueuePortalSelfRegistration } from '../../services/portalSelfRegistration';
import { completePortalSelfRegistration, type CompleteSelfRegistrationOutcome } from '../../services/portalSelfRegistration/complete';
import { reportSelfRegistrationFailure, safeErrorFields } from '../../services/portalSelfRegistration/errors';
import { getRedis } from '../../services/redis';
import { consumePortalSelfRegistrationToken } from './capabilityTokens';
import { checkRateLimit, getClientIp, normalizeEmail, sweepPortalState } from './helpers';
import { requestHost } from './requestHost';
import {
  PORTAL_USE_REDIS,
  SELF_REGISTER_DOMAIN_RATE_LIMIT,
  SELF_REGISTER_EMAIL_RATE_LIMIT,
  SELF_REGISTER_IP_RATE_LIMIT,
  SELF_REGISTER_VERIFY_RATE_LIMIT,
  selfRegisterSchema,
  selfRegisterVerifySchema,
} from './schemas';

export const selfRegistrationRoutes = new Hono();

export const SELF_REGISTER_ACCEPTED_MESSAGE = "If this address can request access, we've emailed you.";
export const SELF_REGISTER_INVALID_LINK = 'This link is invalid or has expired. Request access again.';
const TOO_MANY = 'Too many requests. Please try again later.';
const NOT_FOUND = 'Not found';
const UNAVAILABLE = 'Service temporarily unavailable';
/** The link was consumed but completion failed on an infrastructure error: the link is spent, so say so. */
export const SELF_REGISTER_REQUEST_AGAIN = 'Something went wrong. Request access again in a few minutes.';
/** D10 residual: the account exists but its invite token was not minted. */
export const SELF_REGISTER_ACCOUNT_PENDING_SETUP = "Your account was created, but we couldn't finish setting it up. Ask your IT provider to resend your invitation.";

const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

/** The deployment capability (D2). W06a ships it off; W06b turns it on. */
const selfRegistrationAvailable = () => getPortalSignInCapabilities().selfRegistration;

selfRegistrationRoutes.post('/auth/self-register', zValidator('json', selfRegisterSchema), async (c) => {
  sweepPortalState();
  c.header('Cache-Control', 'no-store');
  if (!selfRegistrationAvailable()) return c.json({ error: NOT_FOUND }, 404);
  if (PORTAL_USE_REDIS && !getRedis()) return c.json({ error: UNAVAILABLE }, 503);

  const { email, name } = c.req.valid('json');
  const normalizedEmail = normalizeEmail(email);
  // Syntax only: a zod-valid address the strict mailbox parse refuses still
  // takes every step below (the worker treats it as ineligible).
  const domainKey = emailDomainOf(normalizedEmail) ?? '_';
  const rateKeys = [
    { key: `portal:selfreg:ip:${rateLimitIpKey(getClientIp(c))}`, limit: SELF_REGISTER_IP_RATE_LIMIT },
    { key: `portal:selfreg:email:${sha256Hex(normalizedEmail)}`, limit: SELF_REGISTER_EMAIL_RATE_LIMIT },
    { key: `portal:selfreg:domain:${domainKey}`, limit: SELF_REGISTER_DOMAIN_RATE_LIMIT },
  ];
  for (const { key, limit } of rateKeys) {
    const rate = await checkRateLimit(key, limit);
    if (!rate.allowed) {
      c.header('Retry-After', String(rate.retryAfterSeconds));
      return c.json({ error: TOO_MANY }, 429);
    }
  }

  // A failed enqueue is logged without PII inside; the answer is the same 200.
  await enqueuePortalSelfRegistration({ email: normalizedEmail, name, host: requestHost(c) });
  return c.json({ success: true, message: SELF_REGISTER_ACCEPTED_MESSAGE });
});

selfRegistrationRoutes.post('/auth/self-register/verify', zValidator('json', selfRegisterVerifySchema), async (c) => {
  sweepPortalState();
  c.header('Cache-Control', 'no-store');
  if (!selfRegistrationAvailable()) return c.json({ error: NOT_FOUND }, 404);

  const rate = await checkRateLimit(`portal:selfreg-verify:ip:${rateLimitIpKey(getClientIp(c))}`, SELF_REGISTER_VERIFY_RATE_LIMIT);
  if (!rate.allowed) {
    c.header('Retry-After', String(rate.retryAfterSeconds));
    return c.json({ error: TOO_MANY }, 429);
  }
  // Pre-check the store BEFORE consuming, as forgot-password does: an outage
  // must not burn the link.
  if (PORTAL_USE_REDIS && !getRedis()) return c.json({ error: UNAVAILABLE }, 503);

  const { token } = c.req.valid('json');
  const payload = await consumePortalSelfRegistrationToken(token);
  if (!payload) {
    await writeAuditEventAsync(c, {
      orgId: null,
      partnerId: null,
      actorType: 'system',
      actorId: ANONYMOUS_ACTOR_ID,
      initiatedBy: 'manual',
      action: 'portal.auth.self_register.verify',
      resourceType: 'portal_auth',
      result: 'denied',
      details: { outcome: 'invalid_link' },
    });
    return c.json({ error: SELF_REGISTER_INVALID_LINK }, 400);
  }

  const audit = {
    orgId: payload.orgId,
    actorType: 'system' as const,
    actorId: ANONYMOUS_ACTOR_ID,
    actorEmail: payload.email,
    initiatedBy: 'manual' as const,
    action: 'portal.auth.self_register.verify',
  };

  // The token is already burned. An infrastructure failure past this point
  // must not surface the raw error (a failed query's message embeds the
  // address) through the global error handler, and must tell the requester
  // the link is spent.
  let result: CompleteSelfRegistrationOutcome;
  try {
    result = await completePortalSelfRegistration(payload);
  } catch (err) {
    console.error('[portal-self-registration] verify failed after consume', { orgId: payload.orgId, ...safeErrorFields(err) });
    reportSelfRegistrationFailure('verify failed after consume', err);
    await writeAuditEventAsync(c, { ...audit, resourceType: 'portal_auth', result: 'failure', details: { outcome: 'error' } });
    return c.json({ error: SELF_REGISTER_REQUEST_AGAIN }, 503);
  }

  switch (result.outcome) {
    case 'refused':
      await writeAuditEventAsync(c, {
        ...audit,
        resourceType: 'portal_auth',
        result: 'denied',
        details: { outcome: 'refused', reason: result.reason },
      });
      return c.json({ error: SELF_REGISTER_INVALID_LINK }, 400);
    case 'existing_account':
      await writeAuditEventAsync(c, { ...audit, resourceType: 'portal_auth', result: 'success', details: { outcome: 'existing_account' } });
      return c.json({ outcome: 'existing_account' });
    case 'request_sent':
      await writeAuditEventAsync(c, {
        ...audit,
        resourceType: 'portal_access_request',
        resourceId: result.requestId,
        result: 'success',
        details: { outcome: 'request_sent', mode: 'approval', created: result.created },
      });
      return c.json({ outcome: 'request_sent' });
    case 'request_unavailable':
      await writeAuditEventAsync(c, {
        ...audit,
        resourceType: 'portal_auth',
        result: 'denied',
        details: { outcome: 'request_unavailable', mode: 'approval', reason: 'requests_capped' },
      });
      return c.json({ outcome: 'request_unavailable' });
    case 'account_created':
      await writeAuditEventAsync(c, {
        ...audit,
        resourceType: 'portal_user',
        resourceId: result.portalUserId,
        result: 'success',
        details: { outcome: 'account_created', mode: 'instant', inviteIssued: result.inviteToken !== null },
      });
      if (!result.inviteToken) {
        // D10 residual (logged and reported in complete.ts): the account
        // exists, invited and visible to the MSP, who can resend the invite.
        return c.json({ error: SELF_REGISTER_ACCOUNT_PENDING_SETUP }, 503);
      }
      return c.json({ outcome: 'account_created', next: `/accept-invite?token=${encodeURIComponent(result.inviteToken)}` });
  }
});
