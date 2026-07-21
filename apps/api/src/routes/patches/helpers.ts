import { eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { organizations, patchPolicies } from '../../db/schema';
import { writeRouteAudit, type AuthContext } from '../../services/auditEvents';
import type { AuthContext as MiddlewareAuthContext } from '../../middleware/auth';
import { canManagePartnerWidePolicies, PartnerWideWriteDeniedError } from '../../services/partnerWideAccess';

// Max rows a patches list endpoint will return in a single page. Raised from
// 100 to 200 so the web patches table's "200" page-size option is actually
// honored server-side (issue #1316). The patches catalog is a global vendor
// list, so a 200-row page is a bounded, index-friendly scan.
//
// Blast radius: getPagination is shared, so this 200 cap also applies to
// GET /patches/approvals (operations via patch_approvals) and GET /patches/jobs.
// That is intentional and benign — both are tenant-scoped, indexed list queries
// (filtered by partner_id), so a higher page cap stays bounded and index-friendly.
export const MAX_PAGE_LIMIT = 200;

export function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(MAX_PAGE_LIMIT, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
  return { page, limit, offset: (page - 1) * limit };
}

export function inferPatchOs(
  osTypes: string[] | null,
  source: string,
  inferredOs?: string | null
): 'windows' | 'macos' | 'linux' | 'unknown' {
  if (Array.isArray(osTypes) && osTypes.length > 0) {
    const candidate = String(osTypes[0]).toLowerCase();
    if (candidate === 'windows' || candidate === 'macos' || candidate === 'linux') {
      return candidate;
    }
  }

  if (typeof inferredOs === 'string') {
    const candidate = inferredOs.toLowerCase();
    if (candidate === 'windows' || candidate === 'macos' || candidate === 'linux') {
      return candidate;
    }
  }

  switch (source) {
    case 'microsoft':
      return 'windows';
    case 'apple':
      return 'macos';
    case 'linux':
      return 'linux';
    default:
      return 'unknown';
  }
}

export function writePatchAuditForOrgIds(
  c: AuthContext,
  orgIds: string[] | Set<string> | string | null | undefined,
  event: {
    action: string;
    resourceType: string;
    resourceId?: string;
    resourceName?: string;
    result?: 'success' | 'failure' | 'denied';
    details?: Record<string, unknown>;
  }
): void {
  const orgIdList = Array.isArray(orgIds)
    ? orgIds
    : (typeof orgIds === 'string'
      ? [orgIds]
      : (orgIds ? Array.from(orgIds) : []));
  const uniqueOrgIds = [...new Set(orgIdList.filter(Boolean))];
  for (const orgId of uniqueOrgIds) {
    writeRouteAudit(c, { orgId, ...event });
  }
}

export const NIL_UUID = '00000000-0000-0000-0000-000000000000';

export async function upsertPatchApproval(values: {
  partnerId: string;
  patchId: string;
  ringId: string | null;
  status: 'approved' | 'rejected' | 'deferred' | 'pending';
  approvedBy?: string | null;
  approvedAt?: Date | null;
  deferUntil?: Date | null;
  notes?: string | null;
}, auth: Pick<MiddlewareAuthContext, 'scope' | 'partnerOrgAccess'>) {
  if (!canManagePartnerWidePolicies(auth)) {
    throw new PartnerWideWriteDeniedError();
  }

  // Use raw SQL for upsert because the unique index uses COALESCE expression.
  // Dates must be serialized to ISO strings before binding. postgres-js's
  // template-literal driver path (db.execute(sql`...`)) doesn't auto-coerce
  // Date instances and throws `TypeError: ... Received an instance of Date`
  // at the Bind step (#805 root cause).
  const approvedAtIso = values.approvedAt ? values.approvedAt.toISOString() : null;
  const deferUntilIso = values.deferUntil ? values.deferUntil.toISOString() : null;
  await db.execute(sql`
    INSERT INTO patch_approvals (id, partner_id, patch_id, ring_id, status, approved_by, approved_at, defer_until, notes, created_at, updated_at)
    VALUES (
      gen_random_uuid(), ${values.partnerId}, ${values.patchId}, ${values.ringId}, ${values.status},
      ${values.approvedBy ?? null}, ${approvedAtIso}, ${deferUntilIso}, ${values.notes ?? null}, NOW(), NOW()
    )
    ON CONFLICT (partner_id, patch_id, COALESCE(ring_id, ${NIL_UUID}::uuid))
    DO UPDATE SET
      status = EXCLUDED.status, approved_by = EXCLUDED.approved_by, approved_at = EXCLUDED.approved_at,
      defer_until = EXCLUDED.defer_until, notes = EXCLUDED.notes, updated_at = NOW()
  `);
}

export async function resolvePatchApprovalPartnerIdForRing(
  auth: { scope: 'system' | 'partner' | 'organization'; partnerId: string | null },
  requestedPartnerId?: string,
  ringId?: string | null
): Promise<{ partnerId: string } | { error: string; status: 400 | 403 | 404 }> {
  if (auth.scope === 'organization') {
    return { error: 'Patch approvals are managed at partner scope', status: 403 };
  }
  if (ringId) {
    const [ring] = await db
      .select({ partnerId: patchPolicies.partnerId })
      .from(patchPolicies)
      .where(eq(patchPolicies.id, ringId))
      .limit(1);
    if (!ring) return { error: 'Update ring not found', status: 404 };
    if (auth.scope !== 'system' && auth.partnerId !== ring.partnerId) {
      return { error: 'Access denied to this update ring', status: 403 };
    }
    return { partnerId: ring.partnerId };
  }
  if (requestedPartnerId) {
    if (auth.scope === 'partner' && auth.partnerId !== requestedPartnerId) {
      return { error: 'Access denied to this partner', status: 403 };
    }
    return { partnerId: requestedPartnerId };
  }
  if (auth.partnerId) return { partnerId: auth.partnerId };
  return { error: 'partnerId is required', status: 400 };
}

export async function resolvePartnerIdForOrg(orgId: string): Promise<string | null> {
  const [row] = await db
    .select({ partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return row?.partnerId ?? null;
}

export function resolvePatchReportOrgId(
  auth: {
    scope: 'system' | 'partner' | 'organization';
    orgId: string | null;
    accessibleOrgIds: string[] | null;
    canAccessOrg: (orgId: string) => boolean;
  },
  requestedOrgId?: string
): { orgId: string } | { error: string; status: 400 | 403 } {
  if (requestedOrgId) {
    if (!auth.canAccessOrg(requestedOrgId)) {
      return { error: 'Access denied to this organization', status: 403 };
    }

    return { orgId: requestedOrgId };
  }

  if (auth.orgId) {
    return { orgId: auth.orgId };
  }

  if (Array.isArray(auth.accessibleOrgIds) && auth.accessibleOrgIds.length === 1) {
    return { orgId: auth.accessibleOrgIds[0]! };
  }

  return { error: 'orgId is required when multiple organizations are accessible', status: 400 };
}
