import type { Hono } from 'hono';
import { z } from 'zod';
import { optionalJsonValidator } from '../lib/validation';
import { runOutsideDbContext } from '../db';
import { getPortalEntraConfig } from '../config/portalEntra';
import { requireMfa, requirePermission, requireScope, type AuthContext } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { writeRouteAudit } from '../services/auditEvents';
import {
  PortalEntraProofError,
  getPortalEntraTenantStatus,
  proveEntraTenantFromM365Connection,
  removePortalEntraTenant,
  type PortalEntraTenantStatus,
} from '../services/portalEntraTenantProof';
import { buildPortalAppAdminConsentUrl } from '../services/portalOidc/entraClient';
import { PORTAL_ENTRA_PROOF_RUN_PATH, createPortalEntraProofRun } from '../services/portalOidc/proofRunStore';
import { parseTenantHint, resolveEntraTenantIdFromDomain } from '../services/portalOidc/tenantHint';
import { isHoldingOrg } from '../services/unassignedPool/protectedOrg';
import { PROTECTED_ORG_ERROR } from '../services/unassignedPool/orgType';
import { resolveAccessibleOrg } from './orgPortalSettings';

/**
 * MSP routes for the org's Entra tenant proof (portal registration W4 #11381,
 * plan Task 8, D6/D7, OD3; spec §5.4): read the proof state, prove the tenant
 * from the org's identity-first M365 connection, create a proof-run link for
 * the customer's tenant admin, and remove the tenant link.
 *
 * Registered onto orgRoutes so every route inherits its authMiddleware. Every
 * route is a 404 `PORTAL_ENTRA_NOT_CONFIGURED` while the portal Entra app env
 * is unset, so nothing here is reachable before ops turns the feature on.
 *
 * DB contexts. The org is authorized under the request's own context
 * (resolveAccessibleOrg). The Task 2 service then runs through
 * runOutsideDbContext: its writers open their own system-scope transaction
 * (the evidence is verified, and a displacement crosses partners) and refuse
 * to run inside a held context. A `PortalEntraProofError` caught below is
 * therefore never a failed statement on the request transaction — a refusal
 * is either thrown in JS before any write, or comes from a statement on the
 * service's own connection, whose transaction the service has already rolled
 * back — so mapping it to a 4xx cannot turn into a 500 at commit
 * (docs/agents/tenancy-rls.md, "A catch around a query needs
 * withDbTransaction"). No withDbTransaction is needed here.
 */

export const PORTAL_ENTRA_NOT_CONFIGURED = 'PORTAL_ENTRA_NOT_CONFIGURED';
export const PORTAL_ENTRA_TENANT_HINT_REQUIRED = 'PORTAL_ENTRA_TENANT_HINT_REQUIRED';
export const PORTAL_ENTRA_TENANT_HINT_INVALID = 'PORTAL_ENTRA_TENANT_HINT_INVALID';
export const PORTAL_ENTRA_TENANT_HINT_LOOKUP_FAILED = 'PORTAL_ENTRA_TENANT_HINT_LOOKUP_FAILED';

const AUDIT_LINK_CREATED = 'organization.portal_identity_proof.link_created';
const AUDIT_REMOVED = 'organization.portal_identity_proof.removed';

const NOT_CONFIGURED_BODY = {
  error: 'Sign in with Microsoft is not configured on this deployment',
  code: PORTAL_ENTRA_NOT_CONFIGURED,
} as const;
const HINT_REQUIRED_BODY = {
  error: "Enter the customer's Microsoft tenant ID or one of its verified domains.",
  code: PORTAL_ENTRA_TENANT_HINT_REQUIRED,
} as const;
const HINT_INVALID_BODY = {
  error: 'That is not a Microsoft tenant ID or a domain verified by a Microsoft tenant.',
  code: PORTAL_ENTRA_TENANT_HINT_INVALID,
} as const;
const HINT_LOOKUP_FAILED_BODY = {
  error: "Couldn't reach Microsoft to look up that domain. Try again, or enter the tenant ID.",
  code: PORTAL_ENTRA_TENANT_HINT_LOOKUP_FAILED,
} as const;
const ORG_HAS_OTHER_TENANT_BODY = {
  error: 'This organization is linked to a different Microsoft tenant. Remove that link before creating a proof link for another tenant.',
  code: 'PORTAL_ENTRA_ORG_HAS_OTHER_TENANT',
} as const;

/** `tenant`: a tenant GUID or a domain the tenant has verified (D6). Absent or blank → no hint. */
const proofLinkBodySchema = z.object({
  tenant: z.string().trim().max(253).optional(),
}).strict();

type TenantSource = 'mapping' | 'hint' | 'connection';

/** A provable tenant id (lowercased GUID, never the consumer tenant), or null. */
function provableTenant(value: string | null): string | null {
  if (!value) return null;
  const parsed = parseTenantHint(value);
  return parsed?.kind === 'guid' ? parsed.tid : null;
}

type ProofLinkTenant =
  | { ok: true; tenantId: string; source: TenantSource }
  | { ok: false; status: 409 | 422; body: { error: string; code: string } };

/**
 * The tenant a proof-run link is pinned to; never null (D6). In order: the
 * org's mapped tenant, the hint, the org's M365 connection tenant. A mapped
 * tenant always wins, so a hint naming a different tenant is refused rather
 * than producing a link whose proof would be refused at record time.
 */
function pickProofLinkTenant(status: PortalEntraTenantStatus, hintTenantId: string | null): ProofLinkTenant {
  if (status.tenantId) {
    const mapped = provableTenant(status.tenantId);
    if (!mapped || (hintTenantId && hintTenantId !== mapped)) {
      return { ok: false, status: 409, body: ORG_HAS_OTHER_TENANT_BODY };
    }
    return { ok: true, tenantId: mapped, source: 'mapping' };
  }
  if (hintTenantId) return { ok: true, tenantId: hintTenantId, source: 'hint' };
  const connection = provableTenant(status.connectionTenantId);
  if (connection) return { ok: true, tenantId: connection, source: 'connection' };
  return { ok: false, status: 422, body: HINT_REQUIRED_BODY };
}

/** The hint's tenant id; `null` for no hint; `undefined` for a hint that names no tenant; `'lookup_failed'` when Microsoft could not be asked. */
async function resolveHint(raw: string | undefined): Promise<string | null | undefined | 'lookup_failed'> {
  if (!raw) return null;
  const hint = parseTenantHint(raw);
  if (!hint) return undefined;
  if (hint.kind === 'guid') return hint.tid;
  const result = await resolveEntraTenantIdFromDomain(hint.domain);
  if (result.kind === 'tenant') return result.tid;
  return result.kind === 'lookup_failed' ? 'lookup_failed' : undefined;
}

function proofRefusal(err: unknown): { status: 409 | 422; body: { error: string; code: string } } {
  if (!(err instanceof PortalEntraProofError)) throw err;
  if (err.code === 'PORTAL_ENTRA_PROTECTED_ORG') return { status: 409, body: { ...PROTECTED_ORG_ERROR } };
  return { status: err.httpStatus, body: { error: err.message, code: err.code } };
}

function readStatus(orgId: string): Promise<PortalEntraTenantStatus> {
  return runOutsideDbContext(() => getPortalEntraTenantStatus(orgId));
}

export function registerPortalEntraTenantRoutes(orgRoutes: Hono): void {
  const requireOrgRead = requirePermission(PERMISSIONS.ORGS_READ.resource, PERMISSIONS.ORGS_READ.action);
  const requireOrgWrite = requirePermission(PERMISSIONS.ORGS_WRITE.resource, PERMISSIONS.ORGS_WRITE.action);

  orgRoutes.get(
    '/organizations/:id/portal-entra-tenant',
    requireScope('partner', 'system'),
    requireOrgRead,
    async (c) => {
      const cfg = getPortalEntraConfig();
      if (!cfg) return c.json(NOT_CONFIGURED_BODY, 404);
      const org = await resolveAccessibleOrg(c);
      if (org instanceof Response) return org;

      const status = await readStatus(org.id);
      const consentUrl = status.state === 'proven' && status.tenantId
        ? buildPortalAppAdminConsentUrl(cfg, status.tenantId)
        : null;
      return c.json({ data: { ...status, consentUrl } });
    },
  );

  orgRoutes.post(
    '/organizations/:id/portal-entra-tenant/prove-from-connection',
    requireScope('partner', 'system'),
    requireOrgWrite,
    requireMfa(),
    async (c) => {
      if (!getPortalEntraConfig()) return c.json(NOT_CONFIGURED_BODY, 404);
      const org = await resolveAccessibleOrg(c);
      if (org instanceof Response) return org;
      const auth = c.get('auth') as AuthContext;

      // The service audits `organization.portal_identity_proof.proven` (and any
      // `.displaced`) inside its own transaction.
      try {
        await runOutsideDbContext(() => proveEntraTenantFromM365Connection(org.id, auth.user.id));
      } catch (err) {
        const refusal = proofRefusal(err);
        return c.json(refusal.body, refusal.status);
      }
      return c.json({ data: await readStatus(org.id) });
    },
  );

  orgRoutes.post(
    '/organizations/:id/portal-entra-tenant/proof-links',
    requireScope('partner', 'system'),
    requireOrgWrite,
    requireMfa(),
    optionalJsonValidator(proofLinkBodySchema),
    async (c) => {
      const cfg = getPortalEntraConfig();
      if (!cfg) return c.json(NOT_CONFIGURED_BODY, 404);
      const org = await resolveAccessibleOrg(c);
      if (org instanceof Response) return org;
      // canAccessOrg is true for system scope: the holding org is never a target.
      if (await isHoldingOrg(org.id)) return c.json(PROTECTED_ORG_ERROR, 409);

      const hintTenantId = await resolveHint(c.req.valid('json').tenant);
      if (hintTenantId === 'lookup_failed') return c.json(HINT_LOOKUP_FAILED_BODY, 503);
      if (hintTenantId === undefined) return c.json(HINT_INVALID_BODY, 422);
      const tenant = pickProofLinkTenant(await readStatus(org.id), hintTenantId);
      if (!tenant.ok) return c.json(tenant.body, tenant.status);

      const auth = c.get('auth') as AuthContext;
      const run = await createPortalEntraProofRun({
        orgId: org.id,
        partnerId: org.partnerId,
        createdByUserId: auth.user.id,
        expectedTenantId: tenant.tenantId,
      });
      const url = new URL(PORTAL_ENTRA_PROOF_RUN_PATH, new URL(cfg.callbackUrl).origin);
      url.searchParams.set('run', run.token);
      const expiresAt = run.expiresAt.toISOString();

      // Never the token: it is the capability.
      writeRouteAudit(c, {
        orgId: org.id,
        action: AUDIT_LINK_CREATED,
        resourceType: 'organization',
        resourceId: org.id,
        details: { runId: run.runId, expectedTenantId: tenant.tenantId, tenantSource: tenant.source, expiresAt },
      });
      return c.json({ data: { url: url.toString(), expiresAt, expectedTenantId: tenant.tenantId } });
    },
  );

  orgRoutes.delete(
    '/organizations/:id/portal-entra-tenant',
    requireScope('partner', 'system'),
    requireOrgWrite,
    requireMfa(),
    async (c) => {
      if (!getPortalEntraConfig()) return c.json(NOT_CONFIGURED_BODY, 404);
      const org = await resolveAccessibleOrg(c);
      if (org instanceof Response) return org;

      // OD3: the proof lives on the AI for Office tenant mapping (D1), so this
      // also removes the org's AI for Office mapping.
      const result = await runOutsideDbContext(() => removePortalEntraTenant(org.id));
      if (result.removed) {
        writeRouteAudit(c, {
          orgId: org.id,
          action: AUDIT_REMOVED,
          resourceType: 'organization',
          resourceId: org.id,
          resourceName: result.tenantId,
          details: { tenantId: result.tenantId },
        });
      }
      return c.json({ data: result });
    },
  );
}
