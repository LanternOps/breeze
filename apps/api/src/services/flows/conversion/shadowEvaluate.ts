/**
 * Tool Catalog W06 (#5221) Task A8 — the shadow comparison of one legacy
 * occurrence with what the converted flow would have done (plan Decision 3).
 * Pure; PR B's shadow hooks feed it and record the counters. Shadow never
 * executes anything and creates no flow runs.
 *
 * Kinds, by precedence: trigger_mismatch (the trigger matched on one engine
 * only — evaluated in BOTH directions) > over_cap (the flow's set exceeds the
 * fleet cap and would refuse) > target_set_mismatch (different devices, order
 * ignored) > would_park (a Tier-3 step would wait for approval where legacy
 * ran unattended). `detail` carries counts and step ids, never device ids.
 */
import { FLEET_MAX_TARGETS, type FlowDocumentV1, type ShadowDivergenceKind } from '@breeze/shared';
import { honoursFleetPreApproval } from '../fleetPreApproval';

export interface ShadowObservation {
  document: FlowDocumentV1;
  legacyMatched: boolean;
  flowMatched: boolean;
  legacyTargetIds: readonly string[];
  flowTargetIds: readonly string[];
  wouldParkStepIds: readonly string[];
}

export interface ShadowVerdict {
  divergent: boolean;
  kind: ShadowDivergenceKind | null;
  detail: string;
}

const AGREE: ShadowVerdict = { divergent: false, kind: null, detail: '' };

export function evaluateShadow(o: ShadowObservation): ShadowVerdict {
  if (o.legacyMatched !== o.flowMatched) {
    return { divergent: true, kind: 'trigger_mismatch', detail: o.flowMatched ? 'the flow trigger matched; the Job did not' : 'the Job matched; the flow trigger did not' };
  }
  if (!o.legacyMatched) return AGREE;
  const flowSet = new Set(o.flowTargetIds);
  if (flowSet.size > FLEET_MAX_TARGETS) {
    return { divergent: true, kind: 'over_cap', detail: `${flowSet.size} devices, above the ${FLEET_MAX_TARGETS}-device step cap` };
  }
  const legacySet = new Set(o.legacyTargetIds);
  const onlyLegacy = [...legacySet].filter((d) => !flowSet.has(d)).length;
  const onlyFlow = [...flowSet].filter((d) => !legacySet.has(d)).length;
  if (onlyLegacy > 0 || onlyFlow > 0) {
    return { divergent: true, kind: 'target_set_mismatch', detail: `${onlyLegacy} devices only on the Job, ${onlyFlow} only on the flow` };
  }
  if (o.wouldParkStepIds.length > 0) {
    return { divergent: true, kind: 'would_park', detail: `steps ${o.wouldParkStepIds.slice(0, 10).join(', ')} would wait for approval` };
  }
  return AGREE;
}

/**
 * The Tier-3 fleet steps that would park on this trigger: every one under a
 * webhook or tool run, a for-each, or no accepted pre-approval; otherwise the
 * run honours the accepted fleet pre-approvals (schedule, event, UI runs).
 */
export function wouldParkSteps(
  document: FlowDocumentV1,
  run: { triggerKind: string; triggeredVia: string },
  acceptedPreApprovalStepIds: readonly string[],
): string[] {
  const accepted = new Set(acceptedPreApprovalStepIds);
  const honours = honoursFleetPreApproval({ preApprovalsHonored: true, ...run } as Parameters<typeof honoursFleetPreApproval>[0]);
  return document.steps
    .filter((s) => s.tool === 'run_script_on_targets')
    .filter((s) => !honours || !!s.forEach || !accepted.has(s.id))
    .map((s) => s.id);
}
