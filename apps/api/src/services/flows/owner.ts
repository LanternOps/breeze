/**
 * Tool Catalog W03 (#5218) — who owns the flow a caller is drafting or
 * validating.
 *
 * The flow validator resolves step tools, scripts, groups and devices against
 * the OWNER's catalog, in system context (W1 amendment 3: an org token cannot
 * see partner-wide tool sources through RLS). So the REAL caller must be
 * authorized for that owner before any of those system-scoped reads happen
 * (quorum P2.5) — this module is the only producer of a `ToolOwnerRef` from a
 * request, and every error path returns before touching the database.
 */
import { eq } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { organizations } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { resolveWritableToolOrgId } from '../aiToolWriteOrg';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../partnerWideAccess';
import type { ToolOwnerRef } from '../toolSources/resolver';

export interface FlowOwnerRequest {
  ownerScope?: 'organization' | 'partner';
  orgId?: string;
}

export type FlowOwnerResolution = { owner: ToolOwnerRef } | { error: string };

export async function resolveFlowOwnerForCaller(
  auth: AuthContext,
  req: FlowOwnerRequest,
  mode: 'read' | 'write',
): Promise<FlowOwnerResolution> {
  if (req.ownerScope === 'partner') {
    if (req.orgId) return { error: 'orgId cannot be combined with ownerScope "partner"' };
    if (auth.scope !== 'partner' || !auth.partnerId) {
      return { error: 'Partner-wide flows require a partner-scoped caller' };
    }
    // The gate is named here (not only in the service) so a partner-wide
    // validate/draft can never be resolved for a selected-access user.
    if (mode === 'write' && !canManagePartnerWidePolicies(auth)) {
      return { error: PARTNER_WIDE_WRITE_DENIED_MESSAGE };
    }
    return { owner: { orgId: null, partnerId: auth.partnerId } };
  }

  // Validation mirrors drafting: the same org a draft would land in.
  const resolved = resolveWritableToolOrgId(auth, req.orgId);
  if (!resolved.orgId) return { error: resolved.error ?? 'orgId is required for this operation' };
  const orgId = resolved.orgId;

  // Authorized above; the partner is re-derived from organizations (never the
  // token's partnerId), in system context so a partner token's RLS shape does
  // not matter.
  const rows = await runOutsideDbContext(() =>
    withSystemDbAccessContext(
      async () => db.select({ partnerId: organizations.partnerId }).from(organizations).where(eq(organizations.id, orgId)).limit(1),
      'resolveFlowOwnerForCaller',
    ),
  );
  const partnerId = rows[0]?.partnerId;
  if (!partnerId) return { error: 'Organization not found' };
  return { owner: { orgId, partnerId } };
}
