/**
 * Tool Catalog W04 (#5219), spec §6.3 rule 4 — the act-mode asset pre-approval
 * lane (plan Open Decision 3).
 *
 * A step is pre-approvable iff its tool is `run_script`, `scriptId` is a
 * literal, `groupId` is absent, every other input key except `deviceIds` is
 * literal or absent (it changes what executes, so it is folded into the
 * binding), the step has no for-each (one approval must never fan out), the
 * script has no tenant-variable binding, and its approval scope is
 * `supervised`. The rendered single-device check happens at run time (A7).
 *
 * The binding is a SHA-256 over the script's content material
 * (`runScriptDigestMaterial` with `deviceOrgIds` and `variableReferences`
 * emptied — the device set is chosen per run) plus the step's literal run
 * context. Enable computes it from a device-less snapshot; the step executor
 * recomputes it with `preApprovalMaterialFromSnapshot` from the SAME snapshot
 * it pins for dispatch, so the two can be compared byte for byte.
 *
 * Pre-approval is never in the flow document (W03's
 * `pre_approval_not_available` stays); it is chosen at enable by an
 * interactive user and stored on the publication.
 */
import { createHash } from 'crypto';
import type { FlowDocumentV1, PreApprovalEligibility } from '@breeze/shared';
import { db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { canonicalizeArguments } from '../actionIntents/canonicalize';
import {
  buildRunScriptSnapshot,
  runScriptDigestMaterial,
  type RunScriptSnapshot,
} from '../actionIntents/runScriptSnapshot';
import { containsTemplate, type FlowStepPin } from '../flowValidator';
import { loadTenantVariableScope } from '../tenantVariableResolution';
import type { ToolOwnerRef } from '../toolSources/resolver';
import { findOwnedScriptIds } from './ownedReferences';

export interface FlowPreApprovalBinding {
  stepId: string;
  lane: 'act_asset';
  assetKind: 'script';
  scriptId: string;
  contentDigest: string;
}

export type PreApprovalIneligibleReason = Extract<PreApprovalEligibility, { eligible: false }>['reason'];

export interface ScriptPreApprovalMaterial {
  contentDigest: string;
  /** The script consults tenant variables, whose values can change without the script changing (Decision 3). */
  variableDependent: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Stands in for the device set when the binding is computed at enable. Never
 * a real org id (version nibble 0), never digested: the material empties
 * `deviceOrgIds` and `variableReferences` before hashing.
 */
const PLACEHOLDER_DEVICE_ORG_ID = '00000000-0000-0000-0000-000000000000';
const PLACEHOLDER_DEVICE_ID = '00000000-0000-0000-0000-000000000001';

/** Input keys that pick the TARGET, not what executes; everything else is run context. */
const TARGET_KEYS: ReadonlySet<string> = new Set(['scriptId', 'deviceIds']);

const ineligible = (reason: PreApprovalIneligibleReason): PreApprovalEligibility => ({ eligible: false, reason });

/** Static rule-4 checks, no I/O. `scriptPreApprovalMaterial` completes them. */
export function preApprovalEligibility(step: FlowDocumentV1['steps'][number], pin: FlowStepPin): PreApprovalEligibility {
  if (pin.source === 'tenant') return ineligible('tenant_tool');
  if (pin.tier !== 3) return ineligible('not_tier3');
  if (pin.source !== 'core' || step.tool !== 'run_script' || pin.tool !== 'run_script') return ineligible('tool_not_supported');
  if (pin.approvalScope !== 'supervised') return ineligible('four_eyes');
  const input = step.input;
  if (typeof input.scriptId !== 'string' || containsTemplate(input.scriptId) || !UUID_RE.test(input.scriptId)) {
    return ineligible('script_not_literal');
  }
  if (Object.hasOwn(input, 'groupId')) return ineligible('group_target');
  // A for-each would turn one approval into up to maxItems unattended runs.
  if (step.forEach) return ineligible('run_context_not_literal');
  for (const [key, value] of Object.entries(input)) {
    if (TARGET_KEYS.has(key)) continue;
    if (containsTemplate(value)) return ineligible('run_context_not_literal');
  }
  return { eligible: true };
}

/** The literal run context folded into the binding: every input key except the target keys. */
function runContextOf(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!TARGET_KEYS.has(key) && value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * The binding material for a snapshot of the script, whatever device set it
 * was built for. A7's executor calls this on the snapshot it pins for
 * dispatch; enable calls it (via `scriptPreApprovalMaterial`) on a
 * device-less one. Both must agree for unchanged content.
 */
export function preApprovalMaterialFromSnapshot(
  snapshot: RunScriptSnapshot,
  stepInput: Record<string, unknown>,
): ScriptPreApprovalMaterial {
  const content = runScriptDigestMaterial({ ...snapshot, deviceOrgIds: [], variableReferences: [] });
  const material = JSON.stringify({
    v: 1,
    lane: 'act_asset',
    content,
    runContext: canonicalizeArguments(runContextOf(stepInput)),
  });
  return {
    contentDigest: createHash('sha256').update(material).digest('hex'),
    variableDependent: snapshot.variableReferences.length > 0,
  };
}

function inSystemContext<T>(fn: () => Promise<T>, label: string): Promise<T> {
  if (getCurrentDbAccessContext()?.scope === 'system') return fn();
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, label));
}

/**
 * The script's binding material at enable time, or null when the script does
 * not exist (soft-deleted included) — the caller reports `script_not_found`.
 *
 * Built through `buildRunScriptSnapshot` so the content material is exactly
 * what the release path pins. There is no real device yet, so the device ->
 * org lookup is replaced by one placeholder device in a placeholder org: the
 * snapshot then lists one variable reference per key the script consults
 * (state 'absent' for the placeholder), which is what `variableDependent`
 * reads, and the digest empties both device-dependent fields. System context:
 * a script read by id with no tenant predicate — ownership is the caller's
 * job (`assessPreApprovals` checks it first).
 *
 * Plan deviation: the plan's signature took only `scriptId`; the step's
 * literal input is needed to fold `parameters` / `runAs` into the binding.
 */
export async function scriptPreApprovalMaterial(
  scriptId: string,
  stepInput: Record<string, unknown>,
): Promise<ScriptPreApprovalMaterial | null> {
  const built = await inSystemContext(
    () => buildRunScriptSnapshot({ scriptId, deviceIds: [PLACEHOLDER_DEVICE_ID] }, db, {
      loadScope: (orgIds, database) => loadTenantVariableScope(orgIds, { database }),
      loadDeviceOrgs: async (deviceIds) => deviceIds.map((id) => ({ id, orgId: PLACEHOLDER_DEVICE_ORG_ID })),
    }),
    'flows.scriptPreApprovalMaterial',
  );
  if (built.kind !== 'snapshot') return null;
  return preApprovalMaterialFromSnapshot(built.snapshot, stepInput);
}

export interface PreApprovalAssessment {
  /** Every tier-3 step (and every explicitly requested step), keyed by step id. */
  eligibility: Record<string, PreApprovalEligibility>;
  /** The binding of every eligible step, keyed by step id. */
  bindings: Record<string, FlowPreApprovalBinding>;
}

/**
 * Rule 4 for a whole document: the static checks, then script ownership (a
 * script the owner does not own reads exactly like a missing one), then the
 * material. Used by enable (to bind the requested steps) and by getFlow (so
 * the enable dialog never guesses).
 */
export async function assessPreApprovals(
  doc: FlowDocumentV1,
  pins: FlowStepPin[],
  owner: ToolOwnerRef,
  requestedStepIds: Iterable<string> = [],
): Promise<PreApprovalAssessment> {
  const requested = new Set(requestedStepIds);
  const pinById = new Map(pins.map((p) => [p.stepId, p]));
  const eligibility: Record<string, PreApprovalEligibility> = {};
  const bindings: Record<string, FlowPreApprovalBinding> = {};
  const candidates: Array<{ step: FlowDocumentV1['steps'][number]; scriptId: string }> = [];

  for (const step of doc.steps) {
    const pin = pinById.get(step.id);
    if (!pin || (pin.tier !== 3 && !requested.has(step.id))) continue;
    const e = preApprovalEligibility(step, pin);
    if (!e.eligible) {
      eligibility[step.id] = e;
      continue;
    }
    candidates.push({ step, scriptId: step.input.scriptId as string });
  }
  if (candidates.length === 0) return { eligibility, bindings };

  const owned = await findOwnedScriptIds(owner, candidates.map((c) => c.scriptId));
  for (const { step, scriptId } of candidates) {
    if (!owned.has(scriptId)) {
      eligibility[step.id] = ineligible('script_not_found');
      continue;
    }
    const material = await scriptPreApprovalMaterial(scriptId, step.input);
    if (!material) {
      eligibility[step.id] = ineligible('script_not_found');
      continue;
    }
    if (material.variableDependent) {
      eligibility[step.id] = ineligible('variable_dependent');
      continue;
    }
    eligibility[step.id] = { eligible: true };
    bindings[step.id] = { stepId: step.id, lane: 'act_asset', assetKind: 'script', scriptId, contentDigest: material.contentDigest };
  }
  return { eligibility, bindings };
}
