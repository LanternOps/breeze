import { createHash } from 'node:crypto';
import { canonicalizeArguments } from '@breeze/shared/canonicalize';
import type { TopologyPolicyDefinition, TopologyPolicyRoutingContext, TopologyScope } from '@breeze/shared';
import type { TopologyArmAuthorityRecord } from './monitoringAuthorityRecord';

/**
 * Deterministic digest of a policy's EXECUTABLE effect (M3-D7). Moving scheduler
 * timestamps, template provenance and the alert runtime state are excluded, so
 * a settings write that leaves the effect unchanged keeps the arm; anything
 * that would make a run do something else changes the digest.
 */
export function topologyPolicyEffectDigest(input: {
  scope: TopologyScope;
  policyId: string;
  definition: TopologyPolicyDefinition;
  targets: ReadonlyArray<{ id: string; revision: string; purpose: string; position: number }>;
  contexts: ReadonlyArray<TopologyPolicyRoutingContext>;
  authority: Pick<TopologyArmAuthorityRecord, 'permissionVersion'> & { userId: string; authEpoch: number; mfaEpoch: number } | null;
}): string {
  const d = input.definition;
  const effect = {
    scope: input.scope,
    policyId: input.policyId,
    recipeId: d.recipeId,
    recipeVersion: d.recipeVersion,
    subject: d.subject,
    families: [...d.families].sort(),
    origin: d.origin,
    intervalSeconds: d.intervalSeconds,
    jitterPercent: d.jitterPercent,
    alertSettings: { alertsEnabled: d.alertsEnabled, failureThreshold: d.failureThreshold, recoveryThreshold: d.recoveryThreshold },
    targets: [...input.targets].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)),
    contexts: [...input.contexts].sort((a, b) => a.contextKey.localeCompare(b.contextKey) || a.family.localeCompare(b.family)),
    authority: input.authority,
  };
  return createHash('sha256').update(canonicalizeArguments(effect)).digest('hex');
}

/** The policy's MATERIAL configuration only (no contexts, no authority): used by the diff-aware compiler. */
export function topologyPolicyMaterialDigest(input: {
  definition: TopologyPolicyDefinition;
  targets: ReadonlyArray<{ id: string; revision: string; purpose: string; position: number }>;
}): string {
  const { enabled: _intent, ...definition } = input.definition;
  return createHash('sha256').update(canonicalizeArguments({
    definition,
    targets: [...input.targets].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)),
  })).digest('hex');
}
