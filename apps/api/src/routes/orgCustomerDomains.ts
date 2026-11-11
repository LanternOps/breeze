import type { Context, Hono } from 'hono';
import { z } from 'zod';
import {
  ERROR_CODES,
  createOrgCustomerDomainSchema,
  updateCustomerEmailDomainSchema,
  verifyCustomerDomainSchema,
} from '@breeze/shared';
import { runOutsideDbContext } from '../db';
import { zValidator } from '../lib/validation';
import { requireCustomerDomainGovernance } from '../middleware/customerDomainGovernance';
import { requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import { PERMISSIONS } from '../services/permissions';
import {
  DomainVerificationError,
  listOrgCustomerDomains,
  removeCustomerDomainVerification,
  startDnsVerification,
  verifyCustomerDomain,
} from '../services/portalDomainVerification';
import { checkRateLimit } from '../services/portal/rateLimit';
import {
  TicketConfigServiceError,
  createCustomerEmailDomain,
  deleteCustomerEmailDomain,
  updateCustomerEmailDomain,
} from '../services/ticketConfigService';
import { resolveAccessibleOrg } from './orgPortalSettings';

/**
 * Org-scoped customer sender-domain CRUD + ownership verification (portal
 * registration W5, #11382, plan Task 7, D9).
 *
 * Gate: identical to `/ticket-config/inbound-domains` (partner/system scope,
 * tickets:read for GET and tickets:write for mutations, then the shared
 * `requireCustomerDomainGovernance` admin check), plus the org must be
 * accessible to the caller and belong to their partner (`resolveAccessibleOrg`;
 * otherwise 404).
 *
 * DB contexts. Everything but the live check runs under the request's own
 * context. `verifyCustomerDomain` opens its own system-scope transaction and
 * refuses to run inside a held context, so it is called through
 * runOutsideDbContext after a request-context read proves the row is this
 * org's. No `withDbTransaction` is needed around the catches below: a
 * `DomainVerificationError` is thrown in JS after successful statements
 * (a 0-row UPDATE/SELECT, never a failed SQL statement) or from the
 * outside-context verify, whose transaction the service has already rolled
 * back; `TicketConfigServiceError`s likewise come from pre-checks or an empty
 * `ON CONFLICT DO NOTHING` result, not a failed statement. Mapping them to a
 * 4xx therefore cannot turn into a 500 at request-transaction commit
 * (docs/agents/tenancy-rls.md, "A catch around a query needs withDbTransaction").
 *
 * Audits: CRUD writes `ticket_customer_email_domain.{create,update,delete}`
 * here with the path org; verify / remove audit themselves in the service, and
 * starting DNS verification only issues a token (no audit, nothing granted).
 */

export const CUSTOMER_DOMAIN_NOT_FOUND = 'CUSTOMER_DOMAIN_NOT_FOUND';

/** 10 verification attempts per org + domain per hour, then blocked for an hour. */
const VERIFICATION_RATE_LIMIT = { windowMs: 60 * 60 * 1000, maxAttempts: 10, blockMs: 60 * 60 * 1000 };

const domainIdParam = z.object({ id: z.string().guid(), domainId: z.string().guid() });

function notFound(c: Context): Response {
  return c.json({ error: 'Customer domain not found', code: CUSTOMER_DOMAIN_NOT_FOUND }, 404);
}

function mapError(c: Context, err: unknown): Response {
  if (err instanceof DomainVerificationError) {
    return c.json({ error: err.message, code: err.code }, err.httpStatus);
  }
  if (err instanceof TicketConfigServiceError) {
    return c.json({ error: err.message, code: err.code }, err.status as 400 | 404 | 409);
  }
  throw err;
}

async function limited(c: Context, orgId: string, domainId: string): Promise<Response | null> {
  const rate = await checkRateLimit(`portal-domain-verify:${orgId}:${domainId}`, VERIFICATION_RATE_LIMIT);
  if (rate.allowed) return null;
  c.header('Retry-After', String(rate.retryAfterSeconds));
  return c.json({ error: 'Too many verification attempts. Please try again later.', code: ERROR_CODES.RATE_LIMITED }, 429);
}

export function registerOrgCustomerDomainRoutes(orgRoutes: Hono): void {
  const scopes = requireScope('partner', 'system');
  const readPerm = requirePermission(PERMISSIONS.TICKETS_READ.resource, PERMISSIONS.TICKETS_READ.action);
  const writePerm = requirePermission(PERMISSIONS.TICKETS_WRITE.resource, PERMISSIONS.TICKETS_WRITE.action);
  const BASE = '/organizations/:id/customer-domains';

  /** The domain, if it is this org's (request context). */
  async function ownedDomain(orgId: string, domainId: string) {
    const rows = await listOrgCustomerDomains(orgId);
    return rows.find((r) => r.id === domainId) ?? null;
  }

  orgRoutes.get(BASE, scopes, readPerm, requireCustomerDomainGovernance, async (c) => {
    const org = await resolveAccessibleOrg(c);
    if (org instanceof Response) return org;
    return c.json({ data: await listOrgCustomerDomains(org.id) });
  });

  orgRoutes.post(BASE, scopes, writePerm, requireCustomerDomainGovernance, zValidator('json', createOrgCustomerDomainSchema), async (c) => {
    const org = await resolveAccessibleOrg(c);
    if (org instanceof Response) return org;
    const auth = c.get('auth') as AuthContext;
    const body = c.req.valid('json');
    try {
      const row = await createCustomerEmailDomain(org.partnerId, { ...body, orgId: org.id }, { userId: auth.user.id });
      writeRouteAudit(c, {
        orgId: org.id,
        action: 'ticket_customer_email_domain.create',
        resourceType: 'ticket_customer_email_domain',
        resourceId: row.id,
        resourceName: row.domain,
        details: { partnerId: org.partnerId, orgId: org.id, changedFields: Object.keys(body) },
      });
      return c.json({ data: row }, 201);
    } catch (err) {
      return mapError(c, err);
    }
  });

  orgRoutes.patch(
    `${BASE}/:domainId`,
    scopes, writePerm, requireCustomerDomainGovernance,
    zValidator('param', domainIdParam), zValidator('json', updateCustomerEmailDomainSchema),
    async (c) => {
      const org = await resolveAccessibleOrg(c);
      if (org instanceof Response) return org;
      const { domainId } = c.req.valid('param');
      const body = c.req.valid('json');
      if (!(await ownedDomain(org.id, domainId))) return notFound(c);
      try {
        const row = await updateCustomerEmailDomain(org.partnerId, domainId, body);
        writeRouteAudit(c, {
          orgId: org.id,
          action: 'ticket_customer_email_domain.update',
          resourceType: 'ticket_customer_email_domain',
          resourceId: domainId,
          resourceName: row.domain,
          details: { partnerId: org.partnerId, changedFields: Object.keys(body) },
        });
        return c.json({ data: row });
      } catch (err) {
        return mapError(c, err);
      }
    },
  );

  orgRoutes.delete(
    `${BASE}/:domainId`,
    scopes, writePerm, requireCustomerDomainGovernance, zValidator('param', domainIdParam),
    async (c) => {
      const org = await resolveAccessibleOrg(c);
      if (org instanceof Response) return org;
      const { domainId } = c.req.valid('param');
      const existing = await ownedDomain(org.id, domainId);
      if (!existing) return notFound(c);
      try {
        await deleteCustomerEmailDomain(org.partnerId, domainId);
        writeRouteAudit(c, {
          orgId: org.id,
          action: 'ticket_customer_email_domain.delete',
          resourceType: 'ticket_customer_email_domain',
          resourceId: domainId,
          resourceName: existing.domain,
          details: { partnerId: org.partnerId, changedFields: ['deleted'] },
        });
        return c.body(null, 204);
      } catch (err) {
        return mapError(c, err);
      }
    },
  );

  orgRoutes.post(
    `${BASE}/:domainId/verification/dns`,
    scopes, writePerm, requireCustomerDomainGovernance, zValidator('param', domainIdParam),
    async (c) => {
      const org = await resolveAccessibleOrg(c);
      if (org instanceof Response) return org;
      const { domainId } = c.req.valid('param');
      // Ownership before the limiter, so foreign ids never create limiter keys.
      if (!(await ownedDomain(org.id, domainId))) return notFound(c);
      const blocked = await limited(c, org.id, domainId);
      if (blocked) return blocked;
      try {
        return c.json({ data: await startDnsVerification(org.id, domainId) });
      } catch (err) {
        return mapError(c, err);
      }
    },
  );

  orgRoutes.post(
    `${BASE}/:domainId/verification/check`,
    scopes, writePerm, requireCustomerDomainGovernance,
    zValidator('param', domainIdParam), zValidator('json', verifyCustomerDomainSchema),
    async (c) => {
      const org = await resolveAccessibleOrg(c);
      if (org instanceof Response) return org;
      const { domainId } = c.req.valid('param');
      const { method } = c.req.valid('json');
      const auth = c.get('auth') as AuthContext;
      if (!(await ownedDomain(org.id, domainId))) return notFound(c);
      const blocked = await limited(c, org.id, domainId);
      if (blocked) return blocked;
      try {
        const outcome = await runOutsideDbContext(() => verifyCustomerDomain({
          orgId: org.id,
          partnerId: org.partnerId,
          domainId,
          method,
          actorUserId: auth.user.id,
        }));
        return c.json({ data: outcome });
      } catch (err) {
        return mapError(c, err);
      }
    },
  );

  orgRoutes.delete(
    `${BASE}/:domainId/verification`,
    scopes, writePerm, requireCustomerDomainGovernance, zValidator('param', domainIdParam),
    async (c) => {
      const org = await resolveAccessibleOrg(c);
      if (org instanceof Response) return org;
      const { domainId } = c.req.valid('param');
      const auth = c.get('auth') as AuthContext;
      try {
        return c.json({ data: await removeCustomerDomainVerification(org.id, domainId, auth.user.id) });
      } catch (err) {
        return mapError(c, err);
      }
    },
  );
}
