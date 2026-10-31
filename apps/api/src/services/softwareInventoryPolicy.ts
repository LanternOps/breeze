/**
 * The quick approve / deny / clear software-policy writes behind
 * routes/softwareInventory.ts, shared with the AI software tools. Moved from
 * the route (after its middleware, the canMutateOrgWideGovernance gate, MFA,
 * org resolution and the holding-org check) so both callers run the same
 * code. Writes return `{ status, body }` — exactly what the route sends. The
 * inventory reads live in softwareInventoryReads.ts and are re-exported here.
 *
 * The writes are always org-scoped: `orgId` is a concrete org resolved by
 * resolveOrgId, so they never create or modify a partner-wide (org_id NULL)
 * software policy.
 */
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configurationPolicies,
  softwarePolicies,
} from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import type { RouteAuditInput } from './auditEvents';
import { recordSoftwarePolicyAudit } from './softwarePolicyService';
import { bumpApprovalGeneration } from './approvalGeneration';
import { checkDefaultListPlacement, type SoftwarePolicyCompetitor } from './softwarePolicyCoverage';

export * from './softwareInventoryReads';

// ============================================
// Org resolution
// ============================================

export type ResolveOrgIdResult =
  | { orgId: string }
  | { error: string; status: 400 | 403 };

export function resolveOrgId(auth: AuthContext, requestedOrgId?: string): ResolveOrgIdResult {
  if (requestedOrgId) {
    const accessibleOrgIds = auth.accessibleOrgIds ?? [];
    if (auth.orgId) {
      if (requestedOrgId !== auth.orgId) {
        return { error: 'Access to this organization denied', status: 403 };
      }
      return { orgId: requestedOrgId };
    }
    if (!accessibleOrgIds.includes(requestedOrgId)) {
      return { error: 'Access to this organization denied', status: 403 };
    }
    return { orgId: requestedOrgId };
  }

  if (auth.orgId) return { orgId: auth.orgId };
  if (Array.isArray(auth.accessibleOrgIds) && auth.accessibleOrgIds.length === 1) {
    const single = auth.accessibleOrgIds[0];
    if (single) return { orgId: single };
  }
  return { error: 'Organization context required', status: 400 };
}

// ============================================
// Config Policy Auto-Link Helper
// ============================================

/** The org's named default config policy, exactly as ensureDefaultConfigPolicyLink finds it. */
async function findDefaultConfigPolicy(orgId: string, configPolicyName: string) {
  const [configPolicy] = await db
    .select()
    .from(configurationPolicies)
    .where(
      and(
        eq(configurationPolicies.orgId, orgId),
        eq(configurationPolicies.name, configPolicyName),
        eq(configurationPolicies.status, 'active')
      )
    )
    .limit(1);
  return configPolicy;
}

export async function ensureDefaultConfigPolicyLink(
  orgId: string,
  softwarePolicyId: string,
  configPolicyName: string,
  userId: string | null
): Promise<void> {
  // Find or create the named config policy for this org
  let configPolicy = await findDefaultConfigPolicy(orgId, configPolicyName);

  if (!configPolicy) {
    [configPolicy] = await db
      .insert(configurationPolicies)
      .values({
        orgId,
        name: configPolicyName,
        description: 'Auto-created for default software policy',
        status: 'active',
        createdBy: userId,
      })
      .returning();
  }

  if (!configPolicy) return;

  // Upsert the software_policy feature link
  await db
    .insert(configPolicyFeatureLinks)
    .values({
      configPolicyId: configPolicy.id,
      featureType: 'software_policy',
      featurePolicyId: softwarePolicyId,
    })
    .onConflictDoUpdate({
      target: [configPolicyFeatureLinks.configPolicyId, configPolicyFeatureLinks.featureType],
      set: {
        featurePolicyId: softwarePolicyId,
        updatedAt: new Date(),
      },
    });

  // Ensure an org-level assignment exists
  await db
    .insert(configPolicyAssignments)
    .values({
      configPolicyId: configPolicy.id,
      level: 'organization',
      targetId: orgId,
      priority: 0,
      assignedBy: userId,
    })
    .onConflictDoNothing();
}

export const FOREIGN_DEFAULT_CONFIG_LINK_ERROR =
  'The org\'s default allow/blocklist configuration policy carries other settings; change it in the web app';

/**
 * True when the org's named default config policy (the one
 * ensureDefaultConfigPolicyLink would reuse) carries anything besides the one
 * `software_policy` link this flow manages, or its software_policy link points
 * at a policy other than `softwarePolicyId` (null = the default software policy
 * does not exist yet, so any existing link is foreign). Absent config policy =
 * nothing foreign.
 */
async function defaultConfigPolicyHasForeignLinks(
  orgId: string,
  configPolicyName: string,
  softwarePolicyId: string | null,
): Promise<boolean> {
  const configPolicy = await findDefaultConfigPolicy(orgId, configPolicyName);
  if (!configPolicy) return false;
  const links = await db
    .select({
      featureType: configPolicyFeatureLinks.featureType,
      featurePolicyId: configPolicyFeatureLinks.featurePolicyId,
    })
    .from(configPolicyFeatureLinks)
    .where(eq(configPolicyFeatureLinks.configPolicyId, configPolicy.id));
  return links.some((link) =>
    link.featureType !== 'software_policy' || link.featurePolicyId !== softwarePolicyId,
  );
}

// ============================================
// Quick approve / deny / clear
// ============================================

export type InventoryPolicyResult = {
  status: ContentfulStatusCode;
  body: Record<string, unknown>;
};

type InventoryPolicyWriteParams = {
  auth: AuthContext;
  /** Resolved by resolveOrgId and already checked against the holding org. */
  orgId: string;
  softwareName: string;
  vendor?: string;
  /**
   * The acting user: stamped as createdBy / assignedBy and as the
   * software_policy_audit actor_id (a users FK). The route passes
   * `auth.user.id`; an AI caller passes the user it acts for.
   */
  actorUserId: string | null;
  /** software_policy_audit.actor; default 'user' (the REST value). */
  actor?: 'user' | 'ai';
  audit: (event: RouteAuditInput) => void;
};

type InventoryListWriteParams = InventoryPolicyWriteParams & {
  /**
   * Refuse (409, nothing written) when the org's default allow/blocklist
   * config policy already carries settings this flow does not manage. Default
   * false (the route passes nothing).
   */
  refuseForeignConfigLink?: boolean;
};

type DefaultListRules = { software: Array<{ name: string; vendor?: string }>; allowUnknown?: boolean };

/**
 * The approve / deny success answer. `overrides` (only when non-empty) names
 * the software policies a newly created org default now wins devices from —
 * e.g. a partner-wide policy (#9635), so the caller can say so.
 */
function listWriteSuccess(created: boolean, policyId: string, overrides: SoftwarePolicyCompetitor[]): InventoryPolicyResult {
  const body: Record<string, unknown> = { success: true, policyId };
  if (overrides.length > 0) body.overrides = overrides;
  return { status: created ? 201 : 200, body };
}

/** POST /approve — add the title to the org's "Default Allowlist" (find or create). */
export async function approveInventorySoftware(params: InventoryListWriteParams): Promise<InventoryPolicyResult> {
  const { orgId, softwareName, vendor, actorUserId, audit } = params;
  const actor = params.actor ?? 'user';

  // #9635: refuse rather than feed a list that would govern no device.
  const placement = await checkDefaultListPlacement({
    orgId, mode: 'allowlist', policyName: 'Default Allowlist', configPolicyName: 'Default Allowlist Config',
  });
  if (!placement.ok) return { status: 409, body: placement.body };

  // Find or create "Default Allowlist" policy. The row is locked FOR UPDATE
  // while its rules JSON is read-modified-written, so two concurrent
  // approvals cannot lose an update.
  const outcome = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(softwarePolicies)
      .where(
        and(
          eq(softwarePolicies.orgId, orgId),
          eq(softwarePolicies.name, 'Default Allowlist'),
          eq(softwarePolicies.mode, 'allowlist'),
          // #6960: never adopt a policy generated from a config policy.
          isNull(softwarePolicies.managedByLinkId)
        )
      )
      .limit(1)
      .for('update');

    if (
      params.refuseForeignConfigLink &&
      await defaultConfigPolicyHasForeignLinks(orgId, 'Default Allowlist Config', existing?.id ?? null)
    ) {
      return { refused: true as const };
    }

    if (existing) {
      const rules = existing.rules as DefaultListRules;
      // Check if already present
      const alreadyExists = rules.software.some(
        (r) => r.name.toLowerCase() === softwareName.toLowerCase() &&
               (r.vendor ?? '').toLowerCase() === (vendor ?? '').toLowerCase()
      );

      if (!alreadyExists) {
        rules.software.push({ name: softwareName, vendor: vendor || undefined });
        await tx
          .update(softwarePolicies)
          .set({
            rules,
            updatedAt: new Date(),
            // Site-ceiling gate contract §3: editing the default allowlist/
            // blocklist rules is a governing edit a queued compliance job
            // needs to detect.
            approvalGeneration: bumpApprovalGeneration(softwarePolicies.approvalGeneration),
          })
          .where(eq(softwarePolicies.id, existing.id));
      }
      return { policy: existing, created: false };
    }

    // Create new default allowlist policy
    const [created] = await tx
      .insert(softwarePolicies)
      .values({
        orgId,
        name: 'Default Allowlist',
        description: 'Auto-created allowlist for approved software',
        mode: 'allowlist',
        rules: {
          software: [{ name: softwareName, vendor: vendor || undefined }],
          allowUnknown: false,
        },
        isActive: true,
        enforceMode: false,
        createdBy: actorUserId,
      })
      .returning();
    return { policy: created!, created: true };
  });

  if ('refused' in outcome) {
    return { status: 409, body: { error: FOREIGN_DEFAULT_CONFIG_LINK_ERROR } };
  }
  const { policy, created } = outcome;

  // Ensure config policy link exists (auto-link a new policy so devices can
  // receive it)
  let linkFailed = false;
  try {
    await ensureDefaultConfigPolicyLink(orgId, policy.id, 'Default Allowlist Config', actorUserId);
  } catch (err) {
    console.warn('[softwareInventory] Failed to auto-link config policy for Default Allowlist:', err);
    linkFailed = true;
  }

  const details = created
    ? { softwareName, vendor: vendor || null, mode: 'allowlist', created: true }
    : { softwareName, vendor: vendor || null, mode: 'allowlist' };

  recordSoftwarePolicyAudit({
    orgId,
    policyId: policy.id,
    action: 'inventory_approve',
    actor,
    actorId: actorUserId,
    details,
  }).catch((err) => {
    console.error('[softwareInventory] Audit write failed for inventory_approve:', err);
  });

  audit({
    orgId,
    action: 'software_policy.inventory_approve',
    resourceType: 'software_policy',
    resourceId: policy.id,
    resourceName: policy.name,
    details,
  });

  // W12 review: the AI path must not report success when devices will never receive the policy (the entry and its
  // audit rows are written; the org link is what failed). REST keeps its historical success answer.
  if (linkFailed && params.actor === 'ai') {
    return { status: 503, body: { error: 'The allowlist entry was saved but could not be linked to the organization; retry the same request', policyId: policy.id } };
  }

  return listWriteSuccess(created, policy.id, placement.overrides);
}

/** POST /deny — add the title to the org's "Default Blocklist" (find or create). */
export async function denyInventorySoftware(params: InventoryListWriteParams): Promise<InventoryPolicyResult> {
  const { orgId, softwareName, vendor, actorUserId, audit } = params;
  const actor = params.actor ?? 'user';

  // #9635: refuse rather than feed a list that would govern no device.
  const placement = await checkDefaultListPlacement({
    orgId, mode: 'blocklist', policyName: 'Default Blocklist', configPolicyName: 'Default Blocklist Config',
  });
  if (!placement.ok) return { status: 409, body: placement.body };

  // Find or create "Default Blocklist" policy, locked FOR UPDATE across the
  // rules read-modify-write (see approveInventorySoftware).
  const outcome = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(softwarePolicies)
      .where(
        and(
          eq(softwarePolicies.orgId, orgId),
          eq(softwarePolicies.name, 'Default Blocklist'),
          eq(softwarePolicies.mode, 'blocklist'),
          // #6960: never adopt a policy generated from a config policy.
          isNull(softwarePolicies.managedByLinkId)
        )
      )
      .limit(1)
      .for('update');

    if (
      params.refuseForeignConfigLink &&
      await defaultConfigPolicyHasForeignLinks(orgId, 'Default Blocklist Config', existing?.id ?? null)
    ) {
      return { refused: true as const };
    }

    if (existing) {
      const rules = existing.rules as DefaultListRules;
      const alreadyExists = rules.software.some(
        (r) => r.name.toLowerCase() === softwareName.toLowerCase() &&
               (r.vendor ?? '').toLowerCase() === (vendor ?? '').toLowerCase()
      );

      if (!alreadyExists) {
        rules.software.push({ name: softwareName, vendor: vendor || undefined });
        await tx
          .update(softwarePolicies)
          .set({
            rules,
            updatedAt: new Date(),
            // Site-ceiling gate contract §3: editing the default allowlist/
            // blocklist rules is a governing edit a queued compliance job
            // needs to detect.
            approvalGeneration: bumpApprovalGeneration(softwarePolicies.approvalGeneration),
          })
          .where(eq(softwarePolicies.id, existing.id));
      }
      return { policy: existing, created: false };
    }

    const [created] = await tx
      .insert(softwarePolicies)
      .values({
        orgId,
        name: 'Default Blocklist',
        description: 'Auto-created blocklist for denied software',
        mode: 'blocklist',
        rules: {
          software: [{ name: softwareName, vendor: vendor || undefined }],
        },
        isActive: true,
        enforceMode: false,
        createdBy: actorUserId,
      })
      .returning();
    return { policy: created!, created: true };
  });

  if ('refused' in outcome) {
    return { status: 409, body: { error: FOREIGN_DEFAULT_CONFIG_LINK_ERROR } };
  }
  const { policy, created } = outcome;

  // Ensure config policy link exists (auto-link a new policy so devices can
  // receive it)
  let linkFailed = false;
  try {
    await ensureDefaultConfigPolicyLink(orgId, policy.id, 'Default Blocklist Config', actorUserId);
  } catch (err) {
    console.warn('[softwareInventory] Failed to auto-link config policy for Default Blocklist:', err);
    linkFailed = true;
  }

  const details = created
    ? { softwareName, vendor: vendor || null, mode: 'blocklist', created: true }
    : { softwareName, vendor: vendor || null, mode: 'blocklist' };

  recordSoftwarePolicyAudit({
    orgId,
    policyId: policy.id,
    action: 'inventory_deny',
    actor,
    actorId: actorUserId,
    details,
  }).catch((err) => {
    console.error('[softwareInventory] Audit write failed for inventory_deny:', err);
  });

  audit({
    orgId,
    action: 'software_policy.inventory_deny',
    resourceType: 'software_policy',
    resourceId: policy.id,
    resourceName: policy.name,
    details,
  });

  // W12 review: the AI path must not report success when devices will never receive the policy (the entry and its
  // audit rows are written; the org link is what failed). REST keeps its historical success answer.
  if (linkFailed && params.actor === 'ai') {
    return { status: 503, body: { error: 'The blocklist entry was saved but could not be linked to the organization; retry the same request', policyId: policy.id } };
  }

  return listWriteSuccess(created, policy.id, placement.overrides);
}

/** POST /clear — remove the title from the org's Default Allowlist and Default Blocklist. */
export async function clearInventorySoftware(params: InventoryPolicyWriteParams): Promise<InventoryPolicyResult> {
  const { orgId, softwareName, vendor, actorUserId, audit } = params;
  const actor = params.actor ?? 'user';

  // Remove from both Default Allowlist and Default Blocklist, with both rows
  // locked FOR UPDATE across the rules read-modify-write.
  const changed = await db.transaction(async (tx) => {
    const defaults = await tx
      .select()
      .from(softwarePolicies)
      .where(
        and(
          eq(softwarePolicies.orgId, orgId),
          eq(softwarePolicies.isActive, true),
          sql`${softwarePolicies.name} IN ('Default Allowlist', 'Default Blocklist')`,
          isNull(softwarePolicies.managedByLinkId)
        )
      )
      .for('update');

    const changedPolicies: Array<(typeof defaults)[number]> = [];
    for (const policy of defaults) {
      const rules = policy.rules as DefaultListRules;
      if (!rules?.software) continue;

      const before = rules.software.length;
      rules.software = rules.software.filter(
        (r) =>
          !(r.name.toLowerCase() === softwareName.toLowerCase() &&
            (r.vendor ?? '').toLowerCase() === (vendor ?? '').toLowerCase())
      );

      if (rules.software.length < before) {
        await tx
          .update(softwarePolicies)
          .set({
            rules,
            updatedAt: new Date(),
            // Site-ceiling gate contract §3: editing the default allowlist/
            // blocklist rules is a governing edit a queued compliance job
            // needs to detect.
            approvalGeneration: bumpApprovalGeneration(softwarePolicies.approvalGeneration),
          })
          .where(eq(softwarePolicies.id, policy.id));
        changedPolicies.push(policy);
      }
    }
    return changedPolicies;
  });

  for (const policy of changed) {
    recordSoftwarePolicyAudit({
      orgId,
      policyId: policy.id,
      action: 'inventory_clear',
      actor,
      actorId: actorUserId,
      details: { softwareName, vendor: vendor || null, mode: policy.mode },
    }).catch((err) => {
      console.error('[softwareInventory] Audit write failed for inventory_clear:', err);
    });

    audit({
      orgId,
      action: 'software_policy.inventory_clear',
      resourceType: 'software_policy',
      resourceId: policy.id,
      resourceName: policy.name,
      details: { softwareName, vendor: vendor || null, mode: policy.mode },
    });
  }

  return { status: 200, body: { success: true, cleared: changed.length > 0 } };
}
