import { eq } from 'drizzle-orm';
import { Hono, type Context, type Next } from 'hono';
import { z } from 'zod';
import { db } from '../db';
import { partners } from '../db/schema';
import { enqueueTestSend } from '../jobs/sendingDomainsWorker';
import { zValidator } from '../lib/validation';
import { authMiddleware, requireMfa, requirePartner, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import { isPartnerLaneConfigured } from '../services/emailDomains/config';
import {
  SendingDomainServiceError, createSendingDomain, deleteSenderIdentity, getSendingDomainsCapability,
  listSendingDomains, requestDomainCheck, requestDomainRemoval, upsertSenderIdentity,
  type CapabilityPartnerRow,
} from '../services/emailDomains/sendingDomainService';
import { PERMISSIONS } from '../services/permissions';
import { requireCapability } from '../services/partnerTrust';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE, canManagePartnerWidePolicies } from '../services/partnerWideAccess';
import { rateLimiter } from '../services/rate-limit';
import { getRedis } from '../services/redis';

/**
 * Partner-facing sending-domain management (spec §7).
 *
 * NO handler here calls the email-domain provider. Routes write intent rows and
 * enqueue `sync-domain`; the worker owns every outbound call (spec §2). That is
 * why none of these routes needs SELF_MANAGED_DB_CONTEXT_ROUTES: nothing in a
 * handler makes a slow network call while the request transaction holds a
 * pooled connection (#1105). `partnerSendingDomains.test.ts` enforces it with a
 * source scan.
 */
export const partnerSendingDomainsRoutes = new Hono();

const requireOrgWrite = requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);

/**
 * Epic #2135. A sending domain and a sender identity are partner-wide BY
 * CONSTRUCTION: the From address they set applies to every org under the MSP,
 * including orgs created later. Partner SCOPE alone is not enough — an
 * `orgAccess: 'selected'` user has partner scope and must not be able to
 * re-point the MSP's customer-facing sender. Exactly the shape
 * `PATCH /partners/me` carries inline (`routes/orgs.ts:911-916`) and the shape
 * `partnerServicePrincipals.ts` was fixed to in the 2026-08-16 security review.
 *
 * `partner-wide-write-coverage.test.ts` additionally requires the helper to be
 * MENTIONED wherever a partner-axis table is mutated; the two service files
 * this router calls carry allowlist entries pointing back at this gate.
 */
const requirePartnerWideAdmin = async (c: Context, next: Next) => {
  if (!canManagePartnerWidePolicies(c.get('auth'))) {
    return c.json({ error: PARTNER_WIDE_WRITE_DENIED_MESSAGE }, 403);
  }
  return next();
};

const TEST_SEND_LIMIT_PER_HOUR = 5;
const TEST_SEND_WINDOW_SECONDS = 3600;

const streamParamSchema = z.object({ stream: z.enum(['support', 'billing', 'general']) });
const idParamSchema = z.object({ id: z.string().guid() });
const createBodySchema = z.object({ domain: z.string().trim().min(3).max(253) });
const identityBodySchema = z.object({
  sendingDomainId: z.string().guid(),
  localPart: z.string().trim().min(1).max(64),
  displayName: z.string().trim().max(78).nullable().optional(),
  replyTo: z.string().trim().email().max(320).nullable().optional(),
});

partnerSendingDomainsRoutes.use('*', authMiddleware);
partnerSendingDomainsRoutes.use('*', requireScope('partner'));
partnerSendingDomainsRoutes.use('*', requirePartner);

/**
 * With EMAIL_DOMAINS_PROVIDER unset the whole feature does not exist on this
 * instance, so every route 404s BEFORE any auth-specific gate reports something
 * more interesting (spec §5.1 "none", §7).
 */
partnerSendingDomainsRoutes.use('*', async (c: Context, next: Next) => {
  if (!isPartnerLaneConfigured()) {
    return c.json({ error: 'sending_domains_unsupported' }, 404);
  }
  return next();
});

function partnerId(c: Context): string {
  return (c.get('auth') as AuthContext).partnerId as string;
}

/** The partner row the capability evaluator needs. Read under the caller's own RLS context. */
async function loadCapabilityPartner(c: Context): Promise<CapabilityPartnerRow | null> {
  const [row] = await db
    .select({
      id: partners.id, status: partners.status,
      trustState: partners.trustState, probationEnrollments: partners.probationEnrollments,
    })
    .from(partners)
    .where(eq(partners.id, partnerId(c)))
    .limit(1);
  return row ?? null;
}

function fail(c: Context, err: unknown): Response {
  if (err instanceof SendingDomainServiceError) {
    return c.json({ error: err.code, message: err.message }, err.status);
  }
  throw err;
}

// --- reads -----------------------------------------------------------------

partnerSendingDomainsRoutes.get('/', async (c) => {
  const partner = await loadCapabilityPartner(c);
  if (!partner) return c.json({ error: 'not_found' }, 404);
  try {
    return c.json(await listSendingDomains(partner));
  } catch (err) {
    return fail(c, err);
  }
});

// --- writes ----------------------------------------------------------------
// Same stack as PATCH /partners/me (routes/orgs.ts:904): scope -> partner ->
// organizations:write -> MFA -> capability -> validator -> handler.

partnerSendingDomainsRoutes.post(
  '/',
  requireOrgWrite,
  requireMfa(),
  requirePartnerWideAdmin,
  requireCapability('custom_sending_domain'),
  zValidator('json', createBodySchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    try {
      const created = await createSendingDomain({
        partnerId: partnerId(c), domain: c.req.valid('json').domain, userId: auth.user.id,
      });
      writeRouteAudit(c as never, {
        orgId: null,
        action: 'partner_sending_domain.create',
        resourceType: 'partner_sending_domain',
        resourceId: created.id,
        resourceName: created.domain,
        details: { partnerId: partnerId(c), status: created.status },
      });
      return c.json(created, 201);
    } catch (err) {
      return fail(c, err);
    }
  },
);

partnerSendingDomainsRoutes.post(
  '/:id/check',
  requireOrgWrite,
  requireMfa(),
  requirePartnerWideAdmin,
  requireCapability('custom_sending_domain'),
  zValidator('param', idParamSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    try {
      const updated = await requestDomainCheck({ partnerId: partnerId(c), domainId: id });
      writeRouteAudit(c as never, {
        orgId: null, action: 'partner_sending_domain.check', resourceType: 'partner_sending_domain',
        resourceId: id, resourceName: updated.domain, details: { status: updated.status },
      });
      return c.json(updated, 202);
    } catch (err) {
      return fail(c, err);
    }
  },
);

partnerSendingDomainsRoutes.delete(
  '/:id',
  requireOrgWrite,
  requireMfa(),
  requirePartnerWideAdmin,
  requireCapability('custom_sending_domain'),
  zValidator('param', idParamSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    try {
      await requestDomainRemoval({ partnerId: partnerId(c), domainId: id });
      writeRouteAudit(c as never, {
        orgId: null, action: 'partner_sending_domain.remove', resourceType: 'partner_sending_domain',
        resourceId: id, details: { partnerId: partnerId(c) },
      });
      return c.json({ status: 'removing' }, 202);
    } catch (err) {
      return fail(c, err);
    }
  },
);

partnerSendingDomainsRoutes.put(
  '/identities/:stream',
  requireOrgWrite,
  requireMfa(),
  requirePartnerWideAdmin,
  requireCapability('custom_sending_domain'),
  zValidator('param', streamParamSchema),
  zValidator('json', identityBodySchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { stream } = c.req.valid('param');
    const body = c.req.valid('json');
    try {
      const identity = await upsertSenderIdentity({
        partnerId: partnerId(c), stream, sendingDomainId: body.sendingDomainId,
        localPart: body.localPart, displayName: body.displayName ?? null,
        replyTo: body.replyTo ?? null, userId: auth.user.id,
      });
      writeRouteAudit(c as never, {
        orgId: null, action: 'partner_sender_identity.upsert', resourceType: 'partner_sender_identity',
        resourceId: identity.id, resourceName: `${identity.localPart}@${stream}`,
        details: { partnerId: partnerId(c), stream, sendingDomainId: body.sendingDomainId },
      });
      return c.json(identity);
    } catch (err) {
      return fail(c, err);
    }
  },
);

partnerSendingDomainsRoutes.delete(
  '/identities/:stream',
  requireOrgWrite,
  requireMfa(),
  requirePartnerWideAdmin,
  requireCapability('custom_sending_domain'),
  zValidator('param', streamParamSchema),
  async (c) => {
    const { stream } = c.req.valid('param');
    try {
      await deleteSenderIdentity({ partnerId: partnerId(c), stream });
      writeRouteAudit(c as never, {
        orgId: null, action: 'partner_sender_identity.delete', resourceType: 'partner_sender_identity',
        resourceId: null, details: { partnerId: partnerId(c), stream },
      });
      return c.body(null, 204);
    } catch (err) {
      return fail(c, err);
    }
  },
);

partnerSendingDomainsRoutes.post(
  '/:id/test',
  requireOrgWrite,
  requireMfa(),
  requirePartnerWideAdmin,
  requireCapability('custom_sending_domain'),
  zValidator('param', idParamSchema),
  async (c) => {
    const auth = c.get('auth') as AuthContext;
    const { id } = c.req.valid('param');

    const rate = await rateLimiter(
      getRedis(), `rl:sending-domains:test:${partnerId(c)}`, TEST_SEND_LIMIT_PER_HOUR, TEST_SEND_WINDOW_SECONDS,
    );
    if (!rate.allowed) {
      c.header('Retry-After', String(Math.max(1, Math.ceil((rate.resetAt.getTime() - Date.now()) / 1000))));
      return c.json({ error: 'rate_limited', message: 'Too many test sends. Try again shortly.' }, 429);
    }

    // The recipient is ALWAYS the calling user's own verified address, taken
    // from the auth context. A body-supplied address would turn this into an
    // open relay for arbitrary mail from a customer-trusted domain (spec §7).
    try {
      await enqueueTestSend(id, auth.user.id);
      writeRouteAudit(c as never, {
        orgId: null, action: 'partner_sending_domain.test', resourceType: 'partner_sending_domain',
        resourceId: id, details: { partnerId: partnerId(c) },
      });
      return c.json({ status: 'queued' }, 202);
    } catch (err) {
      return fail(c, err);
    }
  },
);
