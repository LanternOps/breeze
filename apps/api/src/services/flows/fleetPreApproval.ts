/**
 * Tool Catalog W06 (#5221) Task A6 — the FLEET lane of spec §6.3 rule 4
 * (plan Decision 5): a converted `run_script_on_targets` step runs unattended
 * only under a versioned `fleet_v1` binding of its whole execution contract
 * and a user-confirmed `maxTargets`, chosen at enable by an interactive user
 * and stored on the publication beside the W04 act-asset bindings.
 *
 * Eligibility (static, no I/O): the step is the built-in on a supervised
 * Tier-3 pin; NO for-each (one approval never fans out per item); the script,
 * parameters, run context and offline policy are literal; the selector is a
 * literal target or condition list, exactly `['{{trigger.device.id}}']`, or a
 * `fromStep` naming an earlier eligible fleet step. The material check (the
 * script exists, is the owner's, consults no tenant variable, and its
 * EFFECTIVE run context is not elevated) is `fleetScriptMaterialFromSnapshot`.
 *
 * The binding covers: publication, step, tool and owner; the script material
 * (device-independent snapshot digest); canonical parameters; the effective
 * run context; the offline policy and delivery deadline; the selector kind and
 * canonical definition, plus the definition digest of every DYNAMIC group it
 * names (static membership is live by design — the approval card says so);
 * and `maxTargets`. `revalidateFleetBinding` recomputes all of it before the
 * first dispatch: any difference — or a resolved count above `maxTargets`
 * (per step, per run, per execution org) — is `binding_drift`.
 *
 * Honour rule unchanged (W04 Decision 4 / W05 Decision 4): schedule, event and
 * UI runs only; never webhook or tool runs.
 */
import { createHash } from 'node:crypto';
import type { FlowDocumentV1, PreApprovalEligibility } from '@breeze/shared';
import type { FlowRunRow } from '../../db/schema/flowRuns';
import { canonicalizeArguments } from '../actionIntents/canonicalize';
import { runScriptDigestMaterial, type RunScriptSnapshot } from '../actionIntents/runScriptSnapshot';
import { deliveryTtlMs } from '../commandOfflinePolicy';
import { containsTemplate, type FlowStepPin } from '../flowValidator';
import type { ToolOwnerRef } from '../toolSources/resolver';
import { FLEET_TOOL, fleetBindingV1Schema, type FleetBindingV1 } from './fleetBindingSchema';

type FlowStep = FlowDocumentV1['steps'][number];
type Ineligible = Extract<PreApprovalEligibility, { eligible: false }>['reason'];

export const TRIGGER_DEVICE_SELECTOR = '{{trigger.device.id}}';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export { FLEET_TOOL, fleetBindingV1Schema, type FleetBindingV1 };

const ineligible = (reason: Ineligible): PreApprovalEligibility => ({ eligible: false, reason });
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Honour rule: the run was created honouring pre-approvals AND it is a
 * schedule, event or UI run. Checked on both — `flow_runs_pre_approvals_chk`
 * already keeps webhook and tool runs unhonoured; the trigger check stops a
 * forged flag from opening the lane.
 */
export function honoursFleetPreApproval(run: Pick<FlowRunRow, 'preApprovalsHonored' | 'triggerKind' | 'triggeredVia'>): boolean {
  if (!run.preApprovalsHonored) return false;
  if (run.triggerKind === 'schedule' || run.triggerKind === 'event') return true;
  return run.triggerKind === 'manual' && run.triggeredVia === 'ui';
}

export type FleetSelectorKind = FleetBindingV1['selector']['kind'];

/** The step's selector as the publication literally states it. */
export function fleetSelectorOf(input: Record<string, unknown>): { kind: FleetSelectorKind; value: unknown } | null {
  if (input.target !== undefined) return { kind: 'target', value: input.target };
  if (input.conditions !== undefined) return { kind: 'conditions', value: input.conditions };
  if (input.deviceIds !== undefined) return { kind: 'trigger_device', value: input.deviceIds };
  if (input.fromStep !== undefined) return { kind: 'from_step', value: input.fromStep };
  return null;
}

/** Group ids a literal selector names (a target's groups; a legacy `group` condition's value). */
export function fleetSelectorGroupIds(input: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const target = input.target as { groupIds?: unknown } | undefined;
  if (target && Array.isArray(target.groupIds)) for (const g of target.groupIds) if (typeof g === 'string') out.add(g);
  if (Array.isArray(input.conditions)) {
    for (const c of input.conditions as Array<Record<string, unknown>>) {
      if (c && c.type === 'group' && typeof c.value === 'string') out.add(c.value);
    }
  }
  return [...out].sort();
}

/** Static rule-4 checks for the fleet lane. `eligibleEarlier`: fleet steps before this one that are eligible. */
export function fleetPreApprovalEligibility(step: FlowStep, pin: FlowStepPin, eligibleEarlier: ReadonlySet<string>): PreApprovalEligibility {
  if (pin.source !== 'builtin' || pin.tool !== FLEET_TOOL || step.tool !== FLEET_TOOL) return ineligible('tool_not_supported');
  if (pin.tier !== 3) return ineligible('not_tier3');
  if (pin.approvalScope !== 'supervised') return ineligible('four_eyes');
  // One approval must never fan out per item.
  if (step.forEach) return ineligible('for_each');
  const input = step.input;
  if (typeof input.scriptId !== 'string' || containsTemplate(input.scriptId) || !UUID_RE.test(input.scriptId)) {
    return ineligible('script_not_literal');
  }
  for (const key of ['parameters', 'runAs', 'whenOffline'] as const) {
    if (containsTemplate(input[key])) return ineligible('run_context_not_literal');
  }
  const selector = fleetSelectorOf(input);
  if (!selector) return ineligible('selector_not_literal');
  switch (selector.kind) {
    case 'target':
    case 'conditions':
      if (containsTemplate(selector.value)) return ineligible('selector_not_literal');
      break;
    case 'trigger_device': {
      const ids = selector.value;
      if (!Array.isArray(ids) || ids.length !== 1 || ids[0] !== TRIGGER_DEVICE_SELECTOR) return ineligible('selector_not_literal');
      break;
    }
    case 'from_step': {
      const from = selector.value as { stepId?: unknown };
      if (typeof from?.stepId !== 'string' || !eligibleEarlier.has(from.stepId)) return ineligible('selector_not_literal');
      break;
    }
    default:
      return ineligible('selector_not_literal');
  }
  return { eligible: true };
}

export interface FleetScriptMaterial {
  /** Device-independent script digest (device orgs and variable references emptied). */
  scriptMaterialSha256: string;
  effectiveRunAs: string;
  /** The script consults tenant variables, whose values can change without the script changing. */
  variableDependent: boolean;
}

export function fleetScriptMaterialFromSnapshot(snapshot: RunScriptSnapshot, stepInput: Record<string, unknown>): FleetScriptMaterial {
  const content = runScriptDigestMaterial({ ...snapshot, deviceOrgIds: [], variableReferences: [] });
  const explicit = stepInput.runAs;
  return {
    scriptMaterialSha256: sha256(content),
    effectiveRunAs: typeof explicit === 'string' ? explicit : snapshot.script.runAs,
    variableDependent: snapshot.variableReferences.length > 0,
  };
}

function offlinePolicyOf(input: Record<string, unknown>): 'queue' | 'skip' {
  return input.whenOffline === 'skip' ? 'skip' : 'queue';
}

function canonicalSelector(input: Record<string, unknown>): { kind: FleetSelectorKind; canonicalSha256: string } {
  const selector = fleetSelectorOf(input);
  if (!selector) throw new Error('run_script_on_targets step has no selector');
  // Legacy conditions default their operator; canonicalize so `{type,value}` and `{type,operator:'is',value}` agree.
  const value = selector.kind === 'conditions' && Array.isArray(selector.value)
    ? (selector.value as Array<Record<string, unknown>>).map((c) => ({ operator: 'is', ...c }))
    : selector.value;
  return { kind: selector.kind, canonicalSha256: sha256(canonicalizeArguments({ kind: selector.kind, value } as Record<string, unknown>)) };
}

export function buildFleetBinding(i: {
  publicationId: string;
  step: FlowStep;
  owner: ToolOwnerRef;
  material: FleetScriptMaterial;
  maxTargets: number;
  /** groupId → definition digest, for every DYNAMIC group the selector names. */
  groupDefinitions: Record<string, string>;
}): FleetBindingV1 {
  if (i.material.effectiveRunAs !== 'system' && i.material.effectiveRunAs !== 'user') {
    throw new Error('A fleet pre-approval cannot bind an elevated run context');
  }
  const offlinePolicy = offlinePolicyOf(i.step.input);
  return fleetBindingV1Schema.parse({
    stepId: i.step.id,
    lane: 'fleet',
    kind: 'fleet_v1',
    publicationId: i.publicationId,
    tool: FLEET_TOOL,
    owner: { orgId: i.owner.orgId, partnerId: i.owner.partnerId },
    scriptId: i.step.input.scriptId,
    scriptMaterialSha256: i.material.scriptMaterialSha256,
    parametersSha256: sha256(canonicalizeArguments((i.step.input.parameters ?? {}) as Record<string, unknown>)),
    effectiveRunAs: i.material.effectiveRunAs,
    offlinePolicy,
    deliveryDeadlineSec: offlinePolicy === 'queue' ? Math.round(deliveryTtlMs('standard') / 1000) : 0,
    selector: { ...canonicalSelector(i.step.input), dynamicGroupDefinitions: i.groupDefinitions },
    maxTargets: i.maxTargets,
  });
}

/**
 * Before the first dispatch: the live contract must equal the bound one.
 * `step` is the PUBLICATION's step (literal), never the rendered input.
 */
export function revalidateFleetBinding(
  b: FleetBindingV1,
  live: {
    material: FleetScriptMaterial;
    step: FlowStep;
    owner: ToolOwnerRef;
    groupDefinitions: Record<string, string>;
    resolvedCount: number;
  },
): { ok: true } | { ok: false; code: 'binding_drift'; detail: string } {
  const drift = (detail: string) => ({ ok: false as const, code: 'binding_drift' as const, detail });
  if (live.step.id !== b.stepId || live.step.tool !== FLEET_TOOL) return drift('step');
  if (live.owner.orgId !== b.owner.orgId || live.owner.partnerId !== b.owner.partnerId) return drift('owner');
  if (live.step.input.scriptId !== b.scriptId) return drift('script');
  if (live.material.variableDependent) return drift('script now uses tenant variables');
  if (live.material.scriptMaterialSha256 !== b.scriptMaterialSha256) return drift('script changed');
  if (live.material.effectiveRunAs !== b.effectiveRunAs) return drift('run context changed');
  const contract = buildFleetBindingFields(live.step);
  if (contract.parametersSha256 !== b.parametersSha256) return drift('parameters changed');
  if (contract.offlinePolicy !== b.offlinePolicy || contract.deliveryDeadlineSec !== b.deliveryDeadlineSec) return drift('offline policy changed');
  if (contract.selector.kind !== b.selector.kind || contract.selector.canonicalSha256 !== b.selector.canonicalSha256) return drift('selector changed');
  const bound = b.selector.dynamicGroupDefinitions;
  const now = live.groupDefinitions;
  const keys = new Set([...Object.keys(bound), ...Object.keys(now)]);
  for (const k of keys) if (bound[k] !== now[k]) return drift('dynamic group definition changed');
  if (live.resolvedCount > b.maxTargets) return drift(`resolved ${live.resolvedCount} devices, above the approved ${b.maxTargets}`);
  return { ok: true };
}

function buildFleetBindingFields(step: FlowStep): Pick<FleetBindingV1, 'parametersSha256' | 'offlinePolicy' | 'deliveryDeadlineSec'> & { selector: { kind: FleetSelectorKind; canonicalSha256: string } } {
  const offlinePolicy = offlinePolicyOf(step.input);
  return {
    parametersSha256: sha256(canonicalizeArguments((step.input.parameters ?? {}) as Record<string, unknown>)),
    offlinePolicy,
    deliveryDeadlineSec: offlinePolicy === 'queue' ? Math.round(deliveryTtlMs('standard') / 1000) : 0,
    selector: canonicalSelector(step.input),
  };
}
