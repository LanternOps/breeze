import { sql } from 'drizzle-orm';
import { db } from '../../db';
import { writeRouteAudit, type AuthContext } from '../../services/auditEvents';

export function getPagination(query: { page?: string; limit?: string }) {
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit ?? '50', 10) || 50));
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
  orgId: string;
  patchId: string;
  ringId: string | null;
  status: 'approved' | 'rejected' | 'deferred' | 'pending';
  approvedBy?: string | null;
  approvedAt?: Date | null;
  deferUntil?: Date | null;
  notes?: string | null;
}) {
  // Use raw SQL for upsert because the unique index uses COALESCE expression
  await db.execute(sql`
    INSERT INTO patch_approvals (id, org_id, patch_id, ring_id, status, approved_by, approved_at, defer_until, notes, created_at, updated_at)
    VALUES (
      gen_random_uuid(),
      ${values.orgId},
      ${values.patchId},
      ${values.ringId},
      ${values.status},
      ${values.approvedBy ?? null},
      ${values.approvedAt ?? null},
      ${values.deferUntil ?? null},
      ${values.notes ?? null},
      NOW(),
      NOW()
    )
    ON CONFLICT (org_id, patch_id, COALESCE(ring_id, ${NIL_UUID}::uuid))
    DO UPDATE SET
      status = EXCLUDED.status,
      approved_by = EXCLUDED.approved_by,
      approved_at = EXCLUDED.approved_at,
      defer_until = EXCLUDED.defer_until,
      notes = EXCLUDED.notes,
      updated_at = NOW()
  `);
}

export function resolvePatchApprovalOrgId(
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

  if (auth.scope === 'partner' || auth.scope === 'system') {
    return { error: 'orgId is required for partner/system scope', status: 400 };
  }

  return { error: 'Organization context required', status: 400 };
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
