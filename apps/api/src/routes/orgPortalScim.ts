import type { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '../lib/validation';
import { runOutsideDbContext } from '../db';
import { requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { getPortalEntraTenantStatus } from '../services/portalEntraTenantProof';
import {
  PortalScimTokenError,
  listPortalScimTokens,
  mintPortalScimToken,
  revokePortalScimToken,
} from '../services/portalScim/tokens';
import { countPortalScimUsers } from '../services/portalScim/users';
import { PORTAL_SCIM_BASE_PATH } from './portalScim';
import { resolveAccessibleOrg } from './orgPortalSettings';

/**
 * MSP routes for an org's Entra SCIM provisioning credential (portal
 * registration W9 #11386, plan D11): the status (proven tenant, Tenant URL,
 * tokens, counts), minting a token — the only response that ever carries the
 * secret — and revoking one.
 *
 * Registered onto orgRoutes so every route inherits its authMiddleware. Gates
 * as the W8 directory routes: partner|system scope; ORGS_READ to read;
 * ORGS_WRITE + MFA to change anything.
 *
 * DB contexts. The org is authorized under the request's own context
 * (resolveAccessibleOrg). Each service then runs through runOutsideDbContext
 * and opens its own system-scope transaction, so a PortalScimTokenError caught
 * below was thrown before any write or from a transaction that has already
 * rolled back: mapping it to a 4xx cannot turn into a 500 at the request's
 * commit. The services write their audit rows and mark the request audited.
 */

const mintBodySchema = z.object({
  label: z.string().trim().min(1, 'Give the token a name').max(100),
}).strict();

/** The Tenant URL the customer pastes into the Entra enterprise app, or null when the API's public URL is not configured. */
export function portalScimBaseUrl(): string | null {
  const base = (process.env.PUBLIC_API_URL || process.env.API_URL || '').trim().replace(/\/+$/, '');
  return base ? `${base}${PORTAL_SCIM_BASE_PATH}` : null;
}

async function mapRefusal(c: any, work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof PortalScimTokenError) {
      return c.json({ error: err.message, code: err.code }, err.httpStatus);
    }
    throw err;
  }
}

export function registerOrgPortalScimRoutes(orgRoutes: Hono): void {
  const requireOrgRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);
  const requireOrgWrite = requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);

  orgRoutes.get(
    '/organizations/:id/portal-scim',
    requireScope('partner', 'system'),
    requireOrgRead,
    async (c) => {
      const org = await resolveAccessibleOrg(c);
      if (org instanceof Response) return org;
      // In sequence, each outside the request's context (each opens its own).
      const tenant = await runOutsideDbContext(() => getPortalEntraTenantStatus(org.id));
      const tokens = await runOutsideDbContext(() => listPortalScimTokens(org.id));
      const counts = await runOutsideDbContext(() => countPortalScimUsers(org.id));
      return c.json({
        data: {
          tenant: { proven: tenant.state === 'proven', tenantId: tenant.state === 'proven' ? tenant.tenantId : null },
          baseUrl: portalScimBaseUrl(),
          tokens,
          counts,
        },
      });
    },
  );

  orgRoutes.post(
    '/organizations/:id/portal-scim/tokens',
    requireScope('partner', 'system'),
    requireOrgWrite,
    requireMfa(),
    zValidator('json', mintBodySchema),
    async (c) => {
      const org = await resolveAccessibleOrg(c);
      if (org instanceof Response) return org;
      const auth = c.get('auth') as AuthContext;
      const { label } = c.req.valid('json');
      return mapRefusal(c, async () => {
        const minted = await runOutsideDbContext(() => mintPortalScimToken({ orgId: org.id, label, actorUserId: auth.user.id }));
        c.header('Cache-Control', 'no-store');
        return c.json({ data: { token: minted.token, tokenInfo: minted.view, baseUrl: portalScimBaseUrl() } }, 201);
      });
    },
  );

  orgRoutes.delete(
    '/organizations/:id/portal-scim/tokens/:tokenId',
    requireScope('partner', 'system'),
    requireOrgWrite,
    requireMfa(),
    async (c) => {
      const org = await resolveAccessibleOrg(c);
      if (org instanceof Response) return org;
      const auth = c.get('auth') as AuthContext;
      const tokenId = c.req.param('tokenId');
      return mapRefusal(c, async () => {
        await runOutsideDbContext(() => revokePortalScimToken({ orgId: org.id, tokenId, actorUserId: auth.user.id }));
        return c.body(null, 204);
      });
    },
  );
}
