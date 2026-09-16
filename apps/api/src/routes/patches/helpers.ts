import { and, eq, sql } from 'drizzle-orm';
import type { AuditResult } from '@breeze/shared';
import { db } from '../../db';
import { organizations, patchApprovals, patchPolicies } from '../../db/schema';
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
    result?: AuditResult;
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

// Declines a patch across EVERY ring approval row for the partner, not just
// the blanket (ringId=null) one. Root cause of #5585: the evaluator matches
// either the ring-specific row OR the blanket row (patchApprovalEvaluator.ts),
// so a blanket-only decline left previously approved ring rows live and their
// devices kept the patch approved. Also always upserts the blanket row itself
// so a patch with no prior approval anywhere still gets an explicit rejection,
// matching single-ring decline's always-upsert behavior.
//
// Each ring's upsert is written per-item (mirrors the bulk-approve loop in
// approvals.ts): a failure on one ring is logged and recorded in
// `failedRingIds` rather than aborting the whole call, so a caller that
// already got rings A and B declined isn't told the operation failed outright
// and left to guess which rings, if any, actually changed. A
// PartnerWideWriteDeniedError is the one exception — it means the caller
// never had authority to write ANY of these rows (not a per-ring transient
// failure), so it propagates immediately instead of being recorded as one
// failed ring among others.
export async function declineAllRingApprovals(
  partnerId: string,
  patchId: string,
  note: string | null,
  auth: Pick<MiddlewareAuthContext, 'scope' | 'partnerOrgAccess'>
): Promise<{ ringIds: (string | null)[]; failedRingIds: (string | null)[] }> {
  const rows = await db
    .select({ ringId: patchApprovals.ringId })
    .from(patchApprovals)
    .where(and(eq(patchApprovals.partnerId, partnerId), eq(patchApprovals.patchId, patchId)));

  const ringIds = new Set<string | null>(rows.map((r) => r.ringId));
  ringIds.add(null);

  const declined: (string | null)[] = [];
  const failed: (string | null)[] = [];

  for (const ringId of ringIds) {
    try {
      await upsertPatchApproval({
        partnerId,
        patchId,
        ringId,
        status: 'rejected',
        notes: note,
      }, auth);
      declined.push(ringId);
    } catch (err) {
      if (err instanceof PartnerWideWriteDeniedError) throw err;
      // Same rationale as the bulk-approve per-id catch in approvals.ts: log
      // every per-ring failure so an operator asking "why is this patch still
      // approved in ring X after I declined it everywhere?" has something to
      // correlate against.
      console.error(
        `[Patches] declineAllRingApprovals failed for patch=${patchId} partner=${partnerId} ring=${ringId ?? 'blanket'}:`,
        err
      );
      failed.push(ringId);
    }
  }

  return { ringIds: declined, failedRingIds: failed };
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
