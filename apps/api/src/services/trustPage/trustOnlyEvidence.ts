// Trust-page-only evidence (amendment 30): mfa_enforced_m365 from Microsoft 365 Conditional Access policies.
// It is overlaid onto loadPostureEvidence's controls by the trust page build and GET /controls, and is never
// read inside loadPostureEvidence, so the posture report's positional query order is untouched.
// Runs in the caller's DB context.
import { and, eq } from 'drizzle-orm';
import type { PostureControlEvidence } from '@breeze/shared';
import { db } from '../../db';
import { m365CaPolicies, m365SyncState } from '../../db/schema';
import { caPolicyEnforcesMfaForAllUsers } from '../m365CaMfaEnforcement';
import type { PostureEvidencePolicy } from '../postureEvidence';

type MfaEvidence = PostureControlEvidence['mfa_enforced_m365'];

const NO_DATA: MfaEvidence = { eligible: 0, assessed: 0, passing: 0, aggregatePct: null, newestEvidenceAt: null };

async function loadMfaEnforcedM365(orgId: string, asOf: Date, policy: PostureEvidencePolicy): Promise<MfaEvidence> {
  const syncRows = await db
    .select({ lastCompleteSnapshotAt: m365SyncState.lastCompleteSnapshotAt })
    .from(m365SyncState)
    .where(and(eq(m365SyncState.orgId, orgId), eq(m365SyncState.domain, 'ca_policies')));

  let snapshotAt: Date | null = null;
  for (const r of syncRows) {
    if (r.lastCompleteSnapshotAt && (!snapshotAt || r.lastCompleteSnapshotAt > snapshotAt)) snapshotAt = r.lastCompleteSnapshotAt;
  }
  if (!snapshotAt) return NO_DATA;
  if (asOf.getTime() - snapshotAt.getTime() > policy.maxSecurityStatusAgeDays * 86_400_000) return NO_DATA;

  const policies = await db
    .select({
      state: m365CaPolicies.state,
      isStale: m365CaPolicies.isStale,
      conditions: m365CaPolicies.conditions,
      grantControls: m365CaPolicies.grantControls,
    })
    .from(m365CaPolicies)
    .where(and(eq(m365CaPolicies.orgId, orgId), eq(m365CaPolicies.isStale, false)));

  // No synced CA policies: security defaults / per-user MFA are not read, so this is "not assessed", not "not met".
  if (policies.length === 0) return { ...NO_DATA, eligible: 1 };

  return {
    eligible: 1,
    assessed: 1,
    passing: policies.some(caPolicyEnforcesMfaForAllUsers) ? 1 : 0,
    aggregatePct: null,
    newestEvidenceAt: snapshotAt.toISOString(),
  };
}

export async function loadTrustOnlyEvidence(
  orgId: string,
  asOf: Date,
  policy: PostureEvidencePolicy,
): Promise<Partial<PostureControlEvidence>> {
  return { mfa_enforced_m365: await loadMfaEnforcedM365(orgId, asOf, policy) };
}
