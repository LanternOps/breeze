/**
 * Fleet Design apply preview (Fleet Designer W03, #5653; W04 #5654 adds the
 * step 4 scripts; spec §4.8).
 *
 * Resolves an approval against the CURRENT state of the org — which devices
 * still exist, which group a function already has, which policy each device's
 * monitoring currently comes from — so the technician approves exactly what
 * the apply will do, item by item. `applyFleetDesign` calls this again under
 * the same row lock and refuses to write when anything here is a blocker or
 * an unaccepted displacement.
 *
 * Cost: the displacement pass calls `resolveEffectiveConfig` once per device
 * a function's group will hold — O(devices), bounded by
 * FLEET_DESIGN_DEVICE_IDS_MAX (2,000). Preview is an explicit human action.
 */
import { and, eq } from 'drizzle-orm';
import {
  DEVICE_FUNCTION_LABELS,
  DEVICE_ROLES,
  isDeviceFunctionKey,
  type FleetDesignApplyPreview,
  type FleetDesignApplyPreviewFunction,
  type FleetDesignApplyPreviewPolicy,
  type FleetDesignApplyPreviewRetired,
  type FleetDesignApplyPreviewRoleCorrection,
  type FleetDesignApplyPreviewScript,
  type FleetDesignApproval,
  type FleetDesignOutcome,
  type FleetDesignRetiredItem,
} from '@breeze/shared';
import { db } from '../../db';
import { configurationPolicies, deviceGroupMemberships, devices } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { listFeatureLinks, policyAccessCondition, resolveEffectiveConfig } from '../configurationPolicy';
import { canManagePartnerWidePolicies } from '../partnerWideAccess';
import { findSecretVariableReferences, previewBundle } from '../scriptBundle';
import { findReusableGroup, loadLedger, lockReportRun, type FleetDesignLedgerRow, type LockedReportRun } from './ledger';
import { buildScriptEnvelope, parseAutomationRef, type FleetDesignScriptToCreate } from './scripts';

export type FleetDesignApplyErrorCode = 'not_found' | 'blocked' | 'no_outcome';

export class FleetDesignApplyError extends Error {
  constructor(
    public readonly code: FleetDesignApplyErrorCode,
    public readonly payload?: Record<string, unknown>,
  ) {
    super(code);
    this.name = 'FleetDesignApplyError';
  }
}

export interface OrgDeviceIndexEntry {
  id: string;
  hostname: string;
  deviceRole: string;
  deviceRoleSource: string;
  deviceFunctionSource: string | null;
}

export async function loadOrgDeviceIndex(orgId: string): Promise<Map<string, OrgDeviceIndexEntry>> {
  const rows = await db
    .select({
      id: devices.id,
      hostname: devices.hostname,
      deviceRole: devices.deviceRole,
      deviceRoleSource: devices.deviceRoleSource,
      deviceFunctionSource: devices.deviceFunctionSource,
    })
    .from(devices)
    .where(eq(devices.orgId, orgId));
  return new Map(rows.map((r) => [r.id, { ...r, hostname: r.hostname ?? '' }]));
}

export async function loadGroupMemberDeviceIds(groupId: string, orgId: string): Promise<string[]> {
  const rows = await db
    .select({ deviceId: deviceGroupMemberships.deviceId })
    .from(deviceGroupMemberships)
    .where(and(eq(deviceGroupMemberships.groupId, groupId), eq(deviceGroupMemberships.orgId, orgId)));
  return rows.map((r) => r.deviceId);
}

export function functionLabel(entry: { functionKey: string; label?: string }): string {
  if (entry.label) return entry.label;
  return isDeviceFunctionKey(entry.functionKey) ? DEVICE_FUNCTION_LABELS[entry.functionKey] : entry.functionKey;
}

export function fleetDesignGroupName(label: string): string {
  return `Fleet Design: ${label}`;
}

export function parseMonitoringRef(ref: string): { functionKey: string; kind: 'watch' | 'rule'; index: number } | null {
  const m = /^monitoring:(.+):(watch|rule):(\d+)$/.exec(ref);
  if (!m) return null;
  return { functionKey: m[1]!, kind: m[2] as 'watch' | 'rule', index: Number(m[3]) };
}

export function parseRetiredRef(ref: string): number | null {
  const m = /^retired:(\d+)$/.exec(ref);
  return m ? Number(m[1]) : null;
}

/** Everything preview resolves that apply needs again — returned alongside the DTO. */
export interface FleetDesignPreviewContext {
  locked: LockedReportRun;
  outcome: FleetDesignOutcome;
  ledger: FleetDesignLedgerRow[];
  appliedRefs: Set<string>;
  orgDevices: Map<string, OrgDeviceIndexEntry>;
  preview: FleetDesignApplyPreview;
  /** Per function: the device ids the group will hold after apply. */
  wantedByFunction: Map<string, string[]>;
  /** Per function: monitoring refs approved, split by kind and resolved to indices. */
  monitoringByFunction: Map<string, { watches: number[]; rules: number[] }>;
  /** Retired refs resolved to their design item + the link they live in. */
  retiredResolved: Map<string, { item: FleetDesignRetiredItem; linkId: string; inlineSettings: unknown; policyOrgId: string | null }>;
  /** `policy:<key>` ledger rows from THIS run (reuse target for a second apply). */
  policyRowByFunction: Map<string, FleetDesignLedgerRow>;
  /** Step 4 (W04): approved scripts not yet applied, in approval order. */
  scriptsToCreate: FleetDesignScriptToCreate[];
}

export async function previewFleetDesignApplyWithContext(
  auth: AuthContext,
  reportRunId: string,
  approval: FleetDesignApproval,
): Promise<FleetDesignPreviewContext> {
  const locked = await lockReportRun(reportRunId, (col) => auth.orgCondition(col));
  if (!locked) throw new FleetDesignApplyError('not_found');
  if (!locked.outcome) throw new FleetDesignApplyError('no_outcome');
  const { orgId, outcome } = locked;

  const ledger = await loadLedger(reportRunId, orgId);
  const appliedRefs = new Set(ledger.filter((r) => r.status === 'applied').map((r) => r.itemRef));
  const policyRowByFunction = new Map<string, FleetDesignLedgerRow>();
  for (const row of ledger) {
    if (row.status === 'applied' && row.itemKind === 'policy' && row.itemRef.startsWith('policy:')) {
      policyRowByFunction.set(row.itemRef.slice('policy:'.length), row);
    }
  }

  const orgDevices = await loadOrgDeviceIndex(orgId);
  const blockers: FleetDesignApplyPreview['blockers'] = [];
  const functions: FleetDesignApplyPreviewFunction[] = [];
  const wantedByFunction = new Map<string, string[]>();

  // --- Section 2: functions -> groups -------------------------------------
  for (const key of dedupe(approval.functions)) {
    const entry = outcome.sections.functions.find((f) => f.functionKey === key);
    if (!entry) { blockers.push({ itemRef: `functions:${key}`, reason: 'not_in_design' }); continue; }
    const label = functionLabel(entry);
    const reuse = await findReusableGroup(orgId, key);
    const current = reuse ? await loadGroupMemberDeviceIds(reuse.groupId, orgId) : [];
    const wanted = dedupe(entry.deviceIds).filter((d) => orgDevices.has(d));
    wantedByFunction.set(key, wanted);
    functions.push({
      functionKey: key,
      label,
      groupId: reuse?.groupId ?? null,
      groupName: fleetDesignGroupName(label),
      deviceCount: wanted.length,
      devicesAdded: wanted.filter((d) => !current.includes(d)),
      devicesRemoved: current.filter((d) => !wanted.includes(d)),
      keptManual: wanted.filter((d) => orgDevices.get(d)!.deviceFunctionSource === 'manual').length,
      missingDevices: dedupe(entry.deviceIds).filter((d) => !orgDevices.has(d)),
    });
  }

  // --- Section 3: monitoring -> one policy per function ---------------------
  const monitoringByFunction = new Map<string, { watches: number[]; rules: number[] }>();
  for (const ref of dedupe(approval.monitoring)) {
    const parsed = parseMonitoringRef(ref);
    if (!parsed) { blockers.push({ itemRef: ref, reason: 'malformed_ref' }); continue; }
    const section = outcome.sections.monitoring.find((m) => m.functionKey === parsed.functionKey);
    const list = section ? (parsed.kind === 'watch' ? section.watches : section.alertRules) : undefined;
    if (!section || !list || parsed.index >= list.length) { blockers.push({ itemRef: ref, reason: 'not_in_design' }); continue; }
    const bucket = monitoringByFunction.get(parsed.functionKey) ?? { watches: [], rules: [] };
    (parsed.kind === 'watch' ? bucket.watches : bucket.rules).push(parsed.index);
    monitoringByFunction.set(parsed.functionKey, bucket);
  }

  const policies: FleetDesignApplyPreviewPolicy[] = [];
  for (const [functionKey, items] of monitoringByFunction) {
    const fn = functions.find((f) => f.functionKey === functionKey);
    // Monitoring needs a group to target. Either the function is approved in
    // this apply (step 1 creates/reuses the group) or a previous apply left
    // one behind for this (org, function).
    let groupDevices: string[];
    let label: string;
    if (fn) {
      groupDevices = wantedByFunction.get(functionKey) ?? [];
      label = fn.label;
    } else {
      const reuse = await findReusableGroup(orgId, functionKey);
      if (!reuse) {
        for (const n of items.watches) blockers.push({ itemRef: `monitoring:${functionKey}:watch:${n}`, reason: 'function_not_approved' });
        for (const n of items.rules) blockers.push({ itemRef: `monitoring:${functionKey}:rule:${n}`, reason: 'function_not_approved' });
        continue;
      }
      groupDevices = await loadGroupMemberDeviceIds(reuse.groupId, orgId);
      const entry = outcome.sections.functions.find((f) => f.functionKey === functionKey);
      label = entry ? functionLabel(entry) : functionLabel({ functionKey });
    }
    wantedByFunction.set(functionKey, groupDevices);

    const reusedPolicyId = policyRowByFunction.get(functionKey)?.createdRefs?.policyId ?? null;
    const displaced = new Map<string, FleetDesignApplyPreviewPolicy['displaces'][number]>();
    for (const deviceId of groupDevices) {
      const eff = await resolveEffectiveConfig(deviceId, auth);
      // null means the device is no longer visible to this caller — it was
      // deleted or moved org between the device-index read above and here.
      // A device that is gone cannot be displaced, so skipping it is correct;
      // it is not masking a failure (resolveEffectiveConfig's only null is the
      // device lookup, configurationPolicy.ts:2120).
      if (!eff) continue;
      for (const featureType of ['monitoring', 'alert_rule'] as const) {
        const winner = eff.features[featureType];
        if (!winner || winner.sourceLevel === 'default') continue;
        if (reusedPolicyId && winner.sourcePolicyId === reusedPolicyId) continue;
        if (!wouldBeDisplaced(winner.sourceLevel, winner.sourcePriority)) continue;
        const k = `${winner.sourcePolicyId}:${featureType}`;
        const row = displaced.get(k) ?? { policyId: winner.sourcePolicyId, policyName: winner.sourcePolicyName, featureType, deviceCount: 0 };
        row.deviceCount += 1;
        displaced.set(k, row);
      }
    }
    policies.push({
      functionKey,
      policyName: fleetDesignGroupName(label),
      watchCount: items.watches.length,
      ruleCount: items.rules.length,
      displaces: [...displaced.values()],
    });
  }

  // --- Section 4: retired watches / rules ----------------------------------
  const retired: FleetDesignApplyPreviewRetired[] = [];
  const retiredResolved: FleetDesignPreviewContext['retiredResolved'] = new Map();
  for (const ref of dedupe(approval.retired)) {
    const n = parseRetiredRef(ref);
    const item = n === null ? undefined : outcome.sections.retired[n];
    if (!item) { blockers.push({ itemRef: ref, reason: 'not_in_design' }); continue; }
    const resolved = await resolveRetiredItem(auth, orgId, item);
    retired.push({
      itemRef: ref,
      policyId: item.policyId,
      policyName: resolved?.policyName ?? item.policyName,
      kind: item.kind,
      itemName: item.itemName,
      found: resolved?.found ?? false,
      editable: resolved?.editable ?? false,
    });
    if (!resolved || !resolved.found) { if (!appliedRefs.has(ref)) blockers.push({ itemRef: ref, reason: 'retired_item_not_found' }); continue; }
    if (!resolved.editable) { blockers.push({ itemRef: ref, reason: 'partner_wide_write_denied' }); continue; }
    retiredResolved.set(ref, { item, linkId: resolved.linkId, inlineSettings: resolved.inlineSettings, policyOrgId: resolved.policyOrgId });
  }

  // --- Section 5: automation scripts (W04) ---------------------------------
  // Checked against the SAME importer step 4 will call, with the same target,
  // so anything it would reject per entry (scope, an invalid entry, a secret
  // variable reference) blocks here instead of failing the step half-way.
  const scriptsToCreate: FleetDesignScriptToCreate[] = [];
  for (const ref of dedupe(approval.automation)) {
    const parsed = parseAutomationRef(ref);
    if (!parsed) { blockers.push({ itemRef: ref, reason: 'malformed_ref' }); continue; }
    const script = outcome.sections.automation.find((a) => a.functionKey === parsed.functionKey)?.scripts[parsed.index];
    if (!script) { blockers.push({ itemRef: ref, reason: 'not_in_design' }); continue; }
    if (appliedRefs.has(ref)) continue; // created by an earlier apply — skipped, never re-created
    scriptsToCreate.push({ itemRef: ref, functionKey: parsed.functionKey, script });
  }
  const scripts: FleetDesignApplyPreviewScript[] = [];
  if (scriptsToCreate.length > 0) {
    const check = await previewBundle(auth, buildScriptEnvelope(scriptsToCreate.map((s) => s.script)), { availability: 'org', orgId });
    for (const [index, item] of scriptsToCreate.entries()) {
      const { itemRef, functionKey, script } = item;
      let alreadyExists = false;
      if ('error' in check) {
        blockers.push({ itemRef, reason: 'script_scope_denied' });
      } else {
        const entry = check.entries.find((e) => e.index === index);
        if (!entry || entry.status === 'invalid') blockers.push({ itemRef, reason: 'script_invalid' });
        else if ((await findSecretVariableReferences(check.target, script.content)).length > 0) blockers.push({ itemRef, reason: 'script_secret_reference' });
        alreadyExists = entry?.status === 'name-conflict';
      }
      scripts.push({ itemRef, functionKey, name: script.name, language: script.language, osTypes: script.osTypes, alreadyExists });
    }
  }

  // --- Section 8: role corrections -----------------------------------------
  const roleCorrections: FleetDesignApplyPreviewRoleCorrection[] = [];
  for (const deviceId of dedupe(approval.roleCorrections)) {
    const ref = `roleCorrections:${deviceId}`;
    const proposal = outcome.sections.unsure.roleCorrections.find((r) => r.deviceId === deviceId);
    if (!proposal) { blockers.push({ itemRef: ref, reason: 'not_in_design' }); continue; }
    const device = orgDevices.get(deviceId);
    if (!device) { blockers.push({ itemRef: ref, reason: 'device_missing' }); continue; }
    if (!(DEVICE_ROLES as readonly string[]).includes(proposal.proposedRole)) { blockers.push({ itemRef: ref, reason: 'invalid_role' }); continue; }
    if (device.deviceRoleSource === 'manual') { blockers.push({ itemRef: ref, reason: 'role_is_manual' }); continue; }
    roleCorrections.push({ deviceId, hostname: device.hostname, from: device.deviceRole, to: proposal.proposedRole, billingRelevant: true });
  }

  const approvalRefs = [
    ...dedupe(approval.functions).map((k) => `functions:${k}`),
    ...dedupe(approval.monitoring),
    ...dedupe(approval.retired),
    ...dedupe(approval.automation),
    ...dedupe(approval.roleCorrections).map((d) => `roleCorrections:${d}`),
  ];
  const alreadyApplied = approvalRefs.filter((r) => appliedRefs.has(r));
  // A ref that is already applied is skipped by apply, so it cannot block it.
  const liveBlockers = blockers.filter((b) => !appliedRefs.has(b.itemRef));

  const preview: FleetDesignApplyPreview = { functions, policies, retired, scripts, roleCorrections, alreadyApplied, blockers: liveBlockers };
  return { locked, outcome, ledger, appliedRefs, orgDevices, preview, wantedByFunction, monitoringByFunction, retiredResolved, policyRowByFunction, scriptsToCreate };
}

export async function previewFleetDesignApply(
  auth: AuthContext,
  reportRunId: string,
  approval: FleetDesignApproval,
): Promise<FleetDesignApplyPreview> {
  const ctx = await previewFleetDesignApplyWithContext(auth, reportRunId, approval);
  return ctx.preview;
}

/**
 * Resolve a retired item against the policy's CURRENT inline link. `found`
 * means the named watch is present and enabled / the named rule is present.
 * `editable` follows `updateConfigPolicy`'s gate: org-owned, or partner-wide
 * with `canManagePartnerWidePolicies`. A policy owned by ANOTHER org (the
 * design named a policy that later moved, or a stale id) reads as not found.
 */
async function resolveRetiredItem(
  auth: AuthContext,
  orgId: string,
  item: FleetDesignRetiredItem,
): Promise<{ found: boolean; editable: boolean; policyName: string; linkId: string; inlineSettings: unknown; policyOrgId: string | null } | null> {
  const conditions = [eq(configurationPolicies.id, item.policyId)];
  const access = policyAccessCondition(auth);
  if (access) conditions.push(access);
  const [policy] = await db
    .select({ id: configurationPolicies.id, orgId: configurationPolicies.orgId, name: configurationPolicies.name })
    .from(configurationPolicies)
    .where(and(...conditions))
    .limit(1);
  if (!policy) return null;
  if (policy.orgId !== null && policy.orgId !== orgId) return null;

  const editable = policy.orgId !== null || canManagePartnerWidePolicies(auth);
  const featureType = item.kind === 'watch' ? 'monitoring' : 'alert_rule';
  const links = await listFeatureLinks(policy.id);
  const link = links.find((l) => l.featureType === featureType && !l.featurePolicyId);
  if (!link) return { found: false, editable, policyName: policy.name, linkId: '', inlineSettings: null, policyOrgId: policy.orgId };

  const settings = (link.inlineSettings ?? {}) as { watches?: Array<{ name: string; enabled?: boolean }>; items?: Array<{ name: string }> };
  const found = item.kind === 'watch'
    ? (settings.watches ?? []).some((w) => w.name === item.itemName && w.enabled !== false)
    : (settings.items ?? []).some((r) => r.name === item.itemName);
  return { found, editable, policyName: policy.name, linkId: link.id, inlineSettings: link.inlineSettings, policyOrgId: policy.orgId };
}

/**
 * Mirrors `resolveEffectiveConfig`'s winner order (level rank DESC, priority
 * ASC, created_at ASC): a Fleet Design assignment (device_group, priority
 * FLEET_DESIGN_ASSIGNMENT_PRIORITY = 100) out-ranks every site / org /
 * partner assignment, loses to a device-level one, and among device_group
 * assignments only beats a HIGHER priority number (ties go to the older
 * row, i.e. the existing one). Anything the new assignment cannot beat is
 * not displaced and must not be reported as such.
 */
const LEVEL_RANK: Record<string, number> = { device: 5, device_group: 4, site: 3, organization: 2, partner: 1 };
export const FLEET_DESIGN_ASSIGNMENT_PRIORITY = 100;
export function wouldBeDisplaced(sourceLevel: string, sourcePriority: number): boolean {
  const rank = LEVEL_RANK[sourceLevel] ?? 0;
  if (rank < LEVEL_RANK.device_group!) return true;
  if (rank > LEVEL_RANK.device_group!) return false;
  return sourcePriority > FLEET_DESIGN_ASSIGNMENT_PRIORITY;
}

function dedupe<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
