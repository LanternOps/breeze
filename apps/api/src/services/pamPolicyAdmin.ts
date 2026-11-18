/**
 * PAM policy administration: the rule-removal cleanup, the tier-drift check
 * and the rule row builders, shared by the REST control plane (routes/pam.ts)
 * and the AI tool `manage_pam_rules` (full-control W11, #6781). Moved verbatim
 * out of routes/pam.ts so both callers write, check and clean up with ONE copy
 * of the rules. The pure schemas and shape validators live in pamPolicySchemas.ts.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { z } from 'zod';

import { db } from '../db';
import { elevationRequests, pamRules } from '../db/schema';
import {
  describePamRuleTierDrift,
  PAM_RULE_TIER_UNREACHABLE_CODE,
} from './pamRuleTierDrift';
import { requestPamCleanup } from './pamActuationLifecycle';
import type { RuleCriteriaShape, ruleBaseSchema, updateRuleSchema } from './pamPolicySchemas';

/** Elevation statuses that still hold (or are acquiring) privilege on a device. */
export const PAM_ACTIVE_ELEVATION_STATUSES = ['approved', 'auto_approved', 'actuating'] as const;
const ACTIVE_STATUSES = PAM_ACTIVE_ELEVATION_STATUSES;

export type PamTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function cleanupPamRuleActuations(
  tx: PamTx,
  input: { ruleId: string; orgId: string },
): Promise<number> {
  const result = await tx.execute<Record<string, unknown> & { id: string }>(sql`
    SELECT id
    FROM elevation_requests
    WHERE org_id = ${input.orgId}
      AND status IN ('approved', 'auto_approved', 'actuating')
      AND metadata ->> 'pam_rule_id' = ${input.ruleId}
    ORDER BY id
    FOR UPDATE
  `);
  const rows = ((result as { rows?: Array<{ id: string }> }).rows ?? result) as Array<{ id: string }>;
  for (const row of rows) {
    await tx
      .update(elevationRequests)
      .set({ status: 'revoked', revokedAt: new Date(), revokedReason: 'PAM rule removed', updatedAt: new Date() })
      .where(and(eq(elevationRequests.id, row.id), inArray(elevationRequests.status, [...ACTIVE_STATUSES])));
    await requestPamCleanup(tx, { elevationRequestId: row.id, cause: 'policy_removed' });
  }
  return rows.length;
}

/**
 * #3128: reject a tool-action rule pinned to a risk tier its tool selector can
 * no longer resolve to. Tool tiers are static code that ships with the API, so
 * a re-classification (#3105 moved three read-only execute_command
 * commandTypes from Tier 3 to Tier 2) can leave a stored rule permanently
 * unmatchable — and the engine's exact-equality match makes that silent.
 *
 * Deliberately NOT folded into validateRuleShape: that one feeds a Zod
 * superRefine on create, which would emit the generic validation-failure body.
 * Calling this from both handlers gives create and update the SAME
 * machine-readable 400, and keeps the check off the preview endpoint — a
 * dry-run must stay able to demonstrate that a stale rule matches nothing.
 *
 * Fails OPEN for an unrecognised tool name (see describePamRuleTierDrift).
 */
export function tierDriftResponse(
  rule: RuleCriteriaShape & { matchNegate?: readonly string[] | null },
): { error: string; code: string; validTiers: number[] } | null {
  const drift = describePamRuleTierDrift(rule);
  if (!drift) return null;
  return {
    error: drift.message,
    code: PAM_RULE_TIER_UNREACHABLE_CODE,
    validTiers: drift.validTiers,
  };
}

/** Row values for a validated rule create (the REST POST and the AI tool insert exactly this). */
export function pamRuleInsertValues(
  payload: z.infer<typeof ruleBaseSchema>,
  orgId: string,
  createdByUserId: string,
): typeof pamRules.$inferInsert {
  return {
    orgId: orgId,
    siteId: payload.siteId ?? null,
    name: payload.name,
    description: payload.description ?? null,
    enabled: payload.enabled ?? true,
    priority: payload.priority ?? 100,
    matchSigner: payload.matchSigner ?? null,
    matchSignerThumbprint: payload.matchSignerThumbprint
      ? payload.matchSignerThumbprint.toLowerCase()
      : null,
    matchSignerGroupId: payload.matchSignerGroupId ?? null,
    matchHash: payload.matchHash ? payload.matchHash.toLowerCase() : null,
    matchPathGlob: payload.matchPathGlob ?? null,
    matchParentImage: payload.matchParentImage ?? null,
    matchCommandLine: payload.matchCommandLine ?? null,
    matchUser: payload.matchUser ?? null,
    matchAdGroup: payload.matchAdGroup ?? null,
    matchToolName: payload.matchToolName ?? null,
    matchRiskTier: payload.matchRiskTier ?? null,
    matchNegate: payload.matchNegate ?? null,
    timeWindow: payload.timeWindow ?? null,
    verdict: payload.verdict,
    approvalDurationMinutes: payload.approvalDurationMinutes ?? null,
    createdByUserId: createdByUserId,
  };
}

/**
 * The SET clause for a validated rule update (the REST PATCH and the AI tool
 * apply exactly this). `existing` is the row read before the update.
 */
export function pamRuleUpdateSet(
  payload: z.infer<typeof updateRuleSchema>,
  existing: Pick<typeof pamRules.$inferSelect, 'suspendedVerdict'>,
  actorUserId: string,
): Partial<typeof pamRules.$inferInsert> {
  return {
    ...(payload.siteId !== undefined ? { siteId: payload.siteId } : {}),
    ...(payload.name !== undefined ? { name: payload.name } : {}),
    ...(payload.description !== undefined ? { description: payload.description } : {}),
    ...(payload.enabled !== undefined ? { enabled: payload.enabled } : {}),
    ...(payload.priority !== undefined ? { priority: payload.priority } : {}),
    ...(payload.matchSigner !== undefined ? { matchSigner: payload.matchSigner } : {}),
    ...(payload.matchSignerThumbprint !== undefined
      ? {
          matchSignerThumbprint: payload.matchSignerThumbprint
            ? payload.matchSignerThumbprint.toLowerCase()
            : null,
        }
      : {}),
    ...(payload.matchSignerGroupId !== undefined
      ? { matchSignerGroupId: payload.matchSignerGroupId }
      : {}),
    ...(payload.matchHash !== undefined
      ? { matchHash: payload.matchHash ? payload.matchHash.toLowerCase() : null }
      : {}),
    ...(payload.matchPathGlob !== undefined ? { matchPathGlob: payload.matchPathGlob } : {}),
    ...(payload.matchParentImage !== undefined
      ? { matchParentImage: payload.matchParentImage }
      : {}),
    ...(payload.matchCommandLine !== undefined
      ? { matchCommandLine: payload.matchCommandLine }
      : {}),
    ...(payload.matchUser !== undefined ? { matchUser: payload.matchUser } : {}),
    ...(payload.matchAdGroup !== undefined ? { matchAdGroup: payload.matchAdGroup } : {}),
    ...(payload.matchToolName !== undefined ? { matchToolName: payload.matchToolName } : {}),
    ...(payload.matchRiskTier !== undefined ? { matchRiskTier: payload.matchRiskTier } : {}),
    ...(payload.matchNegate !== undefined ? { matchNegate: payload.matchNegate } : {}),
    ...(payload.timeWindow !== undefined ? { timeWindow: payload.timeWindow } : {}),
    ...(payload.verdict !== undefined ? { verdict: payload.verdict } : {}),
    // An explicit verdict edit supersedes any pending quarantine: without
    // this, a later plain Re-approve click (payload.reapprove) would
    // restore the STALE pre-suspension verdict from suspendedVerdict and
    // silently overwrite the admin's fresh edit. payload.verdict and
    // payload.reapprove are mutually exclusive (rejected together above),
    // so this never fights the reapprove branch below.
    ...(payload.verdict !== undefined && existing.suspendedVerdict !== null
      ? { suspendedVerdict: null }
      : {}),
    ...(payload.approvalDurationMinutes !== undefined
      ? { approvalDurationMinutes: payload.approvalDurationMinutes }
      : {}),
    // §6B re-approval: restore the pre-suspension verdict and clear the
    // quarantine marker, stamped with who/when. Mutually exclusive with the
    // `payload.verdict` branch above (rejected together earlier).
    ...(payload.reapprove
      ? {
          verdict: existing.suspendedVerdict!,
          suspendedVerdict: null,
          reapprovedAt: new Date(),
          reapprovedByUserId: actorUserId,
        }
      : {}),
    updatedAt: new Date(),
  };
}
