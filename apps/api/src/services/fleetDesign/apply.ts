/**
 * Fleet Design apply (Fleet Designer W03, #5653; spec §4.8 steps 1, 2, 3, 5;
 * step 4, scripts, W04 #5654 — see ./scripts.ts).
 *
 * Runs under the request's ambient `withDbAccessContext` transaction. Each
 * numbered step runs in its own `db.transaction`, which nests as a SAVEPOINT
 * on the ambient connection, so a failure in step N rolls back only step N:
 * steps < N stay applied AND recorded in the ledger, a `failed` row names the
 * step, and the caller is told `partial: { failedStep }` with
 * `rollbackAvailable` for what did land. Every write is idempotent through
 * the ledger: a ref with an `applied` row is skipped, never re-created.
 *
 * Guards that stay in force (never bypassed here): `createConfigPolicy`'s
 * owner union, `updateConfigPolicy(auth)`'s partner-wide gate,
 * `assignPolicy`'s `onConflictDoNothing`, `validateManualMembershipDevices`
 * before any membership row, `deviceFunction.ts` manual-wins.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type {
  FleetDesignApplyResult,
  FleetDesignApproval,
  FleetDesignBeforeImage,
  FleetDesignCreatedRefs,
  FleetDesignRule,
  FleetDesignWatch,
} from '@breeze/shared';
import { db } from '../../db';
import { deviceFunctionAssessments, deviceGroupMemberships, deviceGroups, devices } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { schedulePeripheralPolicyDevice } from '../../jobs/peripheralJobs';
import { requestLikeFromSnapshot, writeAuditEvent, type RequestLike } from '../auditEvents';
import {
  addFeatureLink,
  assignPolicy,
  createConfigPolicy,
  listFeatureLinks,
  updateConfigPolicy,
  updateFeatureLink,
} from '../configurationPolicy';
import { applyDesignFunctions } from '../deviceFunction';
import { addManualGroupMemberships, validateManualMembershipDevices } from '../groupMembership';
import { importBundle } from '../scriptBundle';
import { findReusableGroup, recordApplied, recordFailed, updateCreatedRefs } from './ledger';
import {
  FLEET_DESIGN_ASSIGNMENT_PRIORITY,
  FleetDesignApplyError,
  fleetDesignGroupName,
  previewFleetDesignApplyWithContext,
  type FleetDesignPreviewContext,
} from './preview';
import {
  FLEET_DESIGN_SCRIPT_TAG,
  buildScriptEnvelope,
  proposalRefForRule,
  withScriptCreated,
} from './scripts';

export { FLEET_DESIGN_ASSIGNMENT_PRIORITY };
export const FLEET_DESIGN_CHECK_INTERVAL_SECONDS = 60;

type ApplyTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface ApplyCtx extends FleetDesignPreviewContext {
  auth: AuthContext;
  orgId: string;
  reportRunId: string;
  userId: string;
  applied: string[];
  audit: RequestLike;
  /** Proposal item ref → script id, for every script created by this run (any apply). */
  createdScriptIds: Map<string, string>;
}

/**
 * A null from `recordApplied` means `(report_run_id, item_ref)` already
 * existed — but every call site pre-filters against `ctx.appliedRefs` under
 * the report-run row lock, so reaching it means the ledger disagrees with the
 * state this apply just wrote. The mutation has already committed inside the
 * step's savepoint, so it must not pass unnoticed.
 */
function warnUnrecordedApply(reportRunId: string, itemRef: string): void {
  console.error(`[fleetDesign] apply wrote ${itemRef} for run ${reportRunId} but its ledger row already existed — the mutation is not attributed to this apply`);
}

function stepKind(step: number): 'function' | 'retired' | 'policy' | 'script' | 'role_correction' {
  switch (step) {
    case 1: return 'function';
    case 2: return 'retired';
    case 3: return 'policy';
    case 4: return 'script';
    default: return 'role_correction';
  }
}

export async function applyFleetDesign(
  auth: AuthContext,
  reportRunId: string,
  approval: FleetDesignApproval,
  audit: RequestLike = requestLikeFromSnapshot({}),
): Promise<FleetDesignApplyResult> {
  const previewCtx = await previewFleetDesignApplyWithContext(auth, reportRunId, approval);
  const { preview } = previewCtx;
  const accepted = new Set(approval.displacementsAccepted);
  const unaccepted = preview.policies.flatMap((p) => p.displaces).filter((d) => !accepted.has(d.policyId));
  if (preview.blockers.length > 0 || unaccepted.length > 0) {
    throw new FleetDesignApplyError('blocked', { blockers: preview.blockers, unaccepted });
  }

  const ctx: ApplyCtx = {
    ...previewCtx,
    auth,
    orgId: previewCtx.locked.orgId,
    reportRunId,
    userId: auth.user.id,
    applied: [],
    audit,
    createdScriptIds: new Map(
      previewCtx.ledger
        .filter((r) => r.status === 'applied' && r.itemKind === 'script' && typeof r.createdRefs?.scriptId === 'string')
        .map((r) => [r.itemRef, r.createdRefs!.scriptId!]),
    ),
  };
  const skipped = [...preview.alreadyApplied];

  const steps: Array<[number, (tx: ApplyTransaction) => Promise<void>]> = [
    [1, (tx) => stepFunctions(ctx, tx)],
    [2, (tx) => stepRetire(ctx, tx)],
    [3, (tx) => stepMonitoring(ctx, tx)],
    [4, (tx) => stepScripts(ctx, tx)],
    [5, (tx) => stepRoleCorrections(ctx, tx)],
  ];
  for (const [n, run] of steps) {
    const before = ctx.applied.length;
    try {
      // Pass the savepoint handle explicitly: the db proxy still resolves to
      // the outer request transaction, including for nested helper transactions.
      await db.transaction(async (tx) => { await run(tx); });
    } catch (error) {
      // Anything this step recorded was rolled back with the savepoint.
      ctx.applied.length = before;
      const reason = error instanceof Error ? error.message.slice(0, 500) : String(error);
      await recordFailed({
        orgId: ctx.orgId, reportRunId, itemRef: `step:${n}`, itemKind: stepKind(n), step: n, error: reason, userId: ctx.userId,
      });
      return { applied: ctx.applied, skipped, partial: { failedStep: n, reason }, rollbackAvailable: ctx.applied.length > 0 };
    }
  }
  return { applied: ctx.applied, skipped, partial: null, rollbackAvailable: ctx.applied.length > 0 };
}

// ---------------------------------------------------------------------------
// Step 1: functions → assessments + one static group per function
// ---------------------------------------------------------------------------
async function stepFunctions(ctx: ApplyCtx, tx: ApplyTransaction): Promise<void> {
  const runId = ctx.locked.summary?.fleetDesign?.runId ?? null;
  for (const fn of ctx.preview.functions) {
    const itemRef = `functions:${fn.functionKey}`;
    if (ctx.appliedRefs.has(itemRef)) continue;
    const entry = ctx.outcome.sections.functions.find((f) => f.functionKey === fn.functionKey);
    if (!entry) continue; // preview already blocked this
    const wanted = ctx.wantedByFunction.get(fn.functionKey) ?? [];

    // Before-image: the active assessment per device (null = none), so
    // rollback can restore exactly what the designer superseded.
    const priorAssessmentIdByDevice: Record<string, string | null> = {};
    for (const d of wanted) priorAssessmentIdByDevice[d] = null;
    if (wanted.length > 0) {
      const active = await tx
        .select({ id: deviceFunctionAssessments.id, deviceId: deviceFunctionAssessments.deviceId })
        .from(deviceFunctionAssessments)
        .where(and(
          eq(deviceFunctionAssessments.orgId, ctx.orgId),
          inArray(deviceFunctionAssessments.deviceId, wanted),
          eq(deviceFunctionAssessments.active, true),
        ));
      for (const row of active) priorAssessmentIdByDevice[row.deviceId] = row.id;
    }

    const functionWrites = await applyDesignFunctions({
      orgId: ctx.orgId,
      reportRunId: ctx.reportRunId,
      runId,
      userId: ctx.userId,
      functions: [{ functionKey: entry.functionKey, label: entry.label, deviceIds: wanted, confidence: entry.confidence, evidence: entry.evidence }],
    }, tx);
    const written = wanted.length > 0
      ? await tx
        .select({ id: deviceFunctionAssessments.id })
        .from(deviceFunctionAssessments)
        .where(and(
          eq(deviceFunctionAssessments.orgId, ctx.orgId),
          eq(deviceFunctionAssessments.reportRunId, ctx.reportRunId),
          inArray(deviceFunctionAssessments.deviceId, wanted),
          eq(deviceFunctionAssessments.active, true),
        ))
      : [];

    // Group: reuse by id (the ledger's identity), else create a static group.
    let groupId = fn.groupId;
    let groupCreated = false;
    if (!groupId) {
      const [group] = await tx
        .insert(deviceGroups)
        .values({ orgId: ctx.orgId, name: fleetDesignGroupName(fn.label), type: 'static' })
        .returning({ id: deviceGroups.id });
      if (!group) throw new Error('Failed to create device group');
      groupId = group.id;
      groupCreated = true;
    }
    const [group] = await tx
      .select({ siteId: deviceGroups.siteId })
      .from(deviceGroups)
      .where(and(eq(deviceGroups.id, groupId), eq(deviceGroups.orgId, ctx.orgId)))
      .limit(1);
    if (!group) throw new Error('Fleet Design group disappeared during apply');

    const current = groupCreated ? [] : (await tx
      .select({ deviceId: deviceGroupMemberships.deviceId })
      .from(deviceGroupMemberships)
      .where(and(eq(deviceGroupMemberships.groupId, groupId), eq(deviceGroupMemberships.orgId, ctx.orgId)))).map((r) => r.deviceId);
    const devicesAdded = wanted.filter((d) => !current.includes(d));
    const devicesRemoved = current.filter((d) => !wanted.includes(d));

    if (devicesAdded.length > 0) {
      const validation = await validateManualMembershipDevices({ deviceIds: devicesAdded, orgId: ctx.orgId, siteId: group.siteId ?? null }, tx);
      if (!validation.ok) throw new Error(`membership_validation_failed: ${validation.error}`);
      await addManualGroupMemberships({ groupId, orgId: ctx.orgId, deviceIds: devicesAdded }, tx);
    }
    if (devicesRemoved.length > 0) {
      await tx
        .delete(deviceGroupMemberships)
        .where(and(
          eq(deviceGroupMemberships.groupId, groupId),
          eq(deviceGroupMemberships.orgId, ctx.orgId),
          inArray(deviceGroupMemberships.deviceId, devicesRemoved),
        ));
      for (const deviceId of devicesRemoved) {
        await schedulePeripheralPolicyDevice(deviceId, 'manual_membership_changed').catch((error) => {
          console.error(`[fleetDesign] failed to schedule peripheral reconciliation for ${deviceId}:`, error);
        });
      }
    }

    const createdRefs: FleetDesignCreatedRefs = { groupId, groupCreated, assessmentIds: written.map((w) => w.id), membershipSnapshot: wanted };
    const beforeImage: FleetDesignBeforeImage = { memberships: current, priorAssessmentIdByDevice };
    const row = await recordApplied({ orgId: ctx.orgId, reportRunId: ctx.reportRunId, itemRef, itemKind: 'function', step: 1, createdRefs, beforeImage, userId: ctx.userId }, tx);
    if (row) {
      ctx.applied.push(itemRef);
      ctx.appliedRefs.add(itemRef);
      ctx.preview.functions.find((f) => f.functionKey === fn.functionKey)!.groupId = groupId;
      writeAuditEvent(ctx.audit, {
        orgId: ctx.orgId, action: 'fleet_design.apply.function', resourceType: 'device_group', resourceId: groupId, resourceName: fleetDesignGroupName(fn.label),
        actorType: 'user', actorId: ctx.userId, actorEmail: ctx.auth.user.email,
        details: {
          reportRunId: ctx.reportRunId, functionKey: fn.functionKey, deviceCount: wanted.length, groupCreated,
          added: devicesAdded.length, removed: devicesRemoved.length,
          // What actually landed, not what was requested: a device deleted or
          // moved between the preview read and this write is counted, never
          // written and never thrown on (applyDesignFunctions' contract).
          assessmentsWritten: functionWrites.written, keptManual: functionWrites.keptManual, skippedForeign: functionWrites.skippedForeign,
        },
      });
    } else warnUnrecordedApply(ctx.reportRunId, itemRef);
  }
}

// ---------------------------------------------------------------------------
// Step 2: retire watches / rules in existing policies
// ---------------------------------------------------------------------------
type WatchSettings = { checkIntervalSeconds?: number; watches?: Array<Record<string, unknown> & { name: string; enabled?: boolean }> };
type RuleSettings = { items?: Array<Record<string, unknown> & { name: string }> };

/** The rewrite the retire step applies; rollback recomputes it to prove nothing else changed. */
export function retireRewrite(kind: 'watch' | 'rule', itemName: string, inlineSettings: unknown): unknown {
  if (kind === 'watch') {
    const s = (inlineSettings ?? {}) as WatchSettings;
    return { ...s, watches: (s.watches ?? []).map((w) => (w.name === itemName ? { ...w, enabled: false } : w)) };
  }
  const s = (inlineSettings ?? {}) as RuleSettings;
  return { ...s, items: (s.items ?? []).filter((r) => r.name !== itemName) };
}

async function stepRetire(ctx: ApplyCtx, tx: ApplyTransaction): Promise<void> {
  for (const [itemRef, resolved] of ctx.retiredResolved) {
    if (ctx.appliedRefs.has(itemRef)) continue;
    const { item, linkId, inlineSettings } = resolved;
    const next = retireRewrite(item.kind, item.itemName, inlineSettings);
    const updated = await updateFeatureLink(linkId, { inlineSettings: next }, item.policyId, undefined, tx);
    if (!updated) throw new Error(`retired_link_missing: ${itemRef}`);
    const row = await recordApplied({
      orgId: ctx.orgId, reportRunId: ctx.reportRunId, itemRef, itemKind: 'retired', step: 2,
      createdRefs: { policyId: item.policyId, linkId },
      beforeImage: { inlineSettings },
      userId: ctx.userId,
    }, tx);
    if (row) {
      ctx.applied.push(itemRef);
      ctx.appliedRefs.add(itemRef);
      writeAuditEvent(ctx.audit, {
        orgId: ctx.orgId, action: 'fleet_design.apply.retire', resourceType: 'configuration_policy', resourceId: item.policyId, resourceName: item.policyName,
        actorType: 'user', actorId: ctx.userId, actorEmail: ctx.auth.user.email,
        details: { reportRunId: ctx.reportRunId, kind: item.kind, itemName: item.itemName, itemRef },
      });
    } else warnUnrecordedApply(ctx.reportRunId, itemRef);
  }
}

// ---------------------------------------------------------------------------
// Step 3: monitoring → one policy per function, assigned to the function's group
// ---------------------------------------------------------------------------
export function describeAction(action: FleetDesignRule['action']): string {
  if (action === 'none') return 'none';
  return `${action.kind} ${action.ref}`;
}

export function toWatchItem(w: FleetDesignWatch) {
  return { watchType: w.watchType, name: w.name, enabled: true, alertOnStop: w.alertOnStop, autoRestart: w.autoRestart, rationale: w.rationale };
}

export function toRuleItem(r: FleetDesignRule, createdScriptId?: string) {
  const rationale = `${r.rationale} [Action: ${describeAction(r.action)}; Paging: ${r.paging}]`;
  return {
    name: r.name,
    severity: r.severity,
    kind: r.kind,
    condition: r.condition,
    responses: r.responses,
    deliveryMode: r.deliveryMode,
    deliveryChannelIds: r.deliveryChannelIds,
    cooldownMinutes: r.cooldownMinutes,
    rationale: createdScriptId ? withScriptCreated(rationale, createdScriptId) : rationale,
  };
}

/** The id of a script this run already created for the proposal a rule names, if any. */
function createdScriptIdFor(ctx: ApplyCtx, r: FleetDesignRule, functionKey: string): string | undefined {
  const ref = proposalRefForRule(ctx.outcome, r.action, functionKey);
  return ref ? ctx.createdScriptIds.get(ref) : undefined;
}

async function stepMonitoring(ctx: ApplyCtx, tx: ApplyTransaction): Promise<void> {
  for (const [functionKey, items] of ctx.monitoringByFunction) {
    const section = ctx.outcome.sections.monitoring.find((m) => m.functionKey === functionKey);
    if (!section) continue;
    const fn = ctx.preview.functions.find((f) => f.functionKey === functionKey);
    const resolvedGroupId = fn?.groupId ?? (await findReusableGroup(ctx.orgId, functionKey, tx))?.groupId ?? null;
    if (!resolvedGroupId) throw new Error(`function_group_missing: ${functionKey}`);

    const newWatchRefs = items.watches.map((n) => `monitoring:${functionKey}:watch:${n}`).filter((r) => !ctx.appliedRefs.has(r));
    const newRuleRefs = items.rules.map((n) => `monitoring:${functionKey}:rule:${n}`).filter((r) => !ctx.appliedRefs.has(r));
    if (newWatchRefs.length === 0 && newRuleRefs.length === 0) continue;
    const newWatches = items.watches.filter((n) => newWatchRefs.includes(`monitoring:${functionKey}:watch:${n}`)).map((n) => toWatchItem(section.watches[n]!));
    const newRules = items.rules.filter((n) => newRuleRefs.includes(`monitoring:${functionKey}:rule:${n}`)).map((n) => toRuleItem(section.alertRules[n]!, createdScriptIdFor(ctx, section.alertRules[n]!, functionKey)));

    const policyRef = `policy:${functionKey}`;
    const existingRow = ctx.policyRowByFunction.get(functionKey);
    const policyName = ctx.preview.policies.find((p) => p.functionKey === functionKey)?.policyName ?? fleetDesignGroupName(functionKey);
    let policyId: string;
    let createdRefs: FleetDesignCreatedRefs;

    if (existingRow?.createdRefs?.policyId) {
      // Second apply in the same run: union into the same policy's links.
      policyId = existingRow.createdRefs.policyId;
      const links = await listFeatureLinks(policyId, tx);
      const monitoringLink = links.find((l) => l.featureType === 'monitoring' && !l.featurePolicyId);
      const ruleLink = links.find((l) => l.featureType === 'alert_rule' && !l.featurePolicyId);
      let monitoringLinkId = monitoringLink?.id;
      let alertRuleLinkId = ruleLink?.id;
      if (newWatches.length > 0) {
        if (monitoringLink) {
          const cur = (monitoringLink.inlineSettings ?? {}) as WatchSettings;
          await updateFeatureLink(monitoringLink.id, { inlineSettings: { ...cur, watches: [...(cur.watches ?? []), ...newWatches] } }, policyId, undefined, tx);
        } else {
          const link = await addFeatureLink(policyId, 'monitoring', null, { checkIntervalSeconds: FLEET_DESIGN_CHECK_INTERVAL_SECONDS, watches: newWatches }, undefined, tx);
          monitoringLinkId = link?.id;
        }
      }
      if (newRules.length > 0) {
        if (ruleLink) {
          const cur = (ruleLink.inlineSettings ?? {}) as RuleSettings;
          await updateFeatureLink(ruleLink.id, { inlineSettings: { ...cur, items: [...(cur.items ?? []), ...newRules] } }, policyId, undefined, tx);
        } else {
          const link = await addFeatureLink(policyId, 'alert_rule', null, { items: newRules }, undefined, tx);
          alertRuleLinkId = link?.id;
        }
      }
      const after = await listFeatureLinks(policyId, tx);
      createdRefs = {
        ...existingRow.createdRefs,
        monitoringLinkId,
        alertRuleLinkId,
        linksSnapshot: snapshotLinks(after),
      };
      await updateCreatedRefs(existingRow.id, ctx.orgId, createdRefs, tx);
      // Keep the in-memory row current: step 4 (linkRulesToCreatedScripts)
      // rebuilds created_refs from it, and a stale copy would write back the
      // link ids this step just added.
      existingRow.createdRefs = createdRefs;
    } else {
      const policy = await createConfigPolicy(
        { orgId: ctx.orgId },
        {
          name: policyName,
          description: `Created by Fleet Design on ${new Date().toISOString().slice(0, 10)} from report run ${ctx.reportRunId}`,
          status: 'inactive',
        },
        ctx.userId,
        tx,
      );
      policyId = policy.id;
      const monitoringLink = newWatches.length > 0
        ? await addFeatureLink(policyId, 'monitoring', null, { checkIntervalSeconds: FLEET_DESIGN_CHECK_INTERVAL_SECONDS, watches: newWatches }, undefined, tx)
        : null;
      const ruleLink = newRules.length > 0
        ? await addFeatureLink(policyId, 'alert_rule', null, { items: newRules }, undefined, tx)
        : null;
      const assignment = await assignPolicy(policyId, 'device_group', resolvedGroupId, FLEET_DESIGN_ASSIGNMENT_PRIORITY, ctx.userId, undefined, undefined, tx);
      const activated = await updateConfigPolicy(policyId, { status: 'active' }, ctx.auth, tx);
      if (!activated) throw new Error(`policy_activation_failed: ${policyId}`);
      const after = await listFeatureLinks(policyId, tx);
      createdRefs = {
        policyId,
        groupId: resolvedGroupId,
        monitoringLinkId: monitoringLink?.id,
        alertRuleLinkId: ruleLink?.id,
        assignmentId: assignment?.id,
        linksSnapshot: snapshotLinks(after),
      };
      const row = await recordApplied({ orgId: ctx.orgId, reportRunId: ctx.reportRunId, itemRef: policyRef, itemKind: 'policy', step: 3, createdRefs, userId: ctx.userId }, tx);
      if (row) {
        ctx.applied.push(policyRef);
        ctx.appliedRefs.add(policyRef);
        ctx.policyRowByFunction.set(functionKey, row);
      } else warnUnrecordedApply(ctx.reportRunId, policyRef);
    }

    for (const ref of newWatchRefs) {
      const row = await recordApplied({ orgId: ctx.orgId, reportRunId: ctx.reportRunId, itemRef: ref, itemKind: 'watch', step: 3, createdRefs: { policyId }, userId: ctx.userId }, tx);
      if (row) { ctx.applied.push(ref); ctx.appliedRefs.add(ref); } else warnUnrecordedApply(ctx.reportRunId, ref);
    }
    for (const ref of newRuleRefs) {
      const row = await recordApplied({ orgId: ctx.orgId, reportRunId: ctx.reportRunId, itemRef: ref, itemKind: 'rule', step: 3, createdRefs: { policyId }, userId: ctx.userId }, tx);
      if (row) { ctx.applied.push(ref); ctx.appliedRefs.add(ref); } else warnUnrecordedApply(ctx.reportRunId, ref);
    }
    writeAuditEvent(ctx.audit, {
      orgId: ctx.orgId, action: 'fleet_design.apply.monitoring', resourceType: 'configuration_policy', resourceId: policyId, resourceName: policyName,
      actorType: 'user', actorId: ctx.userId, actorEmail: ctx.auth.user.email,
      details: { reportRunId: ctx.reportRunId, functionKey, groupId: resolvedGroupId, watches: newWatchRefs.length, rules: newRuleRefs.length, reusedPolicy: Boolean(existingRow) },
    });
  }
}

/** Order-independent, id-free view of a policy's inline links for the rollback comparison. */
export function snapshotLinks(links: Array<{ featureType: string; featurePolicyId: string | null; inlineSettings: unknown }>): { monitoring: unknown; alertRule: unknown } {
  const monitoring = links.find((l) => l.featureType === 'monitoring' && !l.featurePolicyId)?.inlineSettings ?? null;
  const alertRule = links.find((l) => l.featureType === 'alert_rule' && !l.featurePolicyId)?.inlineSettings ?? null;
  return { monitoring: canonical(monitoring), alertRule: canonical(alertRule) };
}

/** Stable JSON: sorted keys, `undefined` dropped — so two reads of the same rows compare equal. */
export function canonical(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.keys(v as Record<string, unknown>).sort().reduce<Record<string, unknown>>((acc, k) => { acc[k] = (v as Record<string, unknown>)[k]; return acc; }, {});
    }
    return v;
  }));
}

// ---------------------------------------------------------------------------
// Step 4 (W04 #5654): approved scripts → the bundle importer, org-owned
// ---------------------------------------------------------------------------
/**
 * One importer call for every pending script, so the tenancy chokepoint,
 * secret-variable rejection, tag linking and v1 version cut are the
 * importer's — never re-implemented here. Rename on a name collision (never
 * version or skip someone else's script). ANY per-entry failure fails the
 * whole step: the importer records per-entry errors rather than throwing, so
 * this rethrows, and the step's savepoint rolls back the scripts that did
 * land — a step is all-or-nothing, like every other step.
 *
 * Provenance (see ./scripts.ts): `ai_proposal`, approved by the applying
 * user, no proposal/review id, no approvalMethod — creating a script is not
 * authorising a run of it.
 */
async function stepScripts(ctx: ApplyCtx, tx: ApplyTransaction): Promise<void> {
  const pending = ctx.scriptsToCreate.filter((s) => !ctx.appliedRefs.has(s.itemRef));
  if (pending.length === 0) return;
  const approvedAt = new Date();
  const result = await importBundle(ctx.auth, buildScriptEnvelope(pending.map((p) => p.script)), {
    availability: 'org',
    orgId: ctx.orgId,
    mode: 'rename',
    tags: [FLEET_DESIGN_SCRIPT_TAG],
    provenanceFor: (_entry, index) => ({
      origin: 'ai_proposal',
      approvedBy: ctx.userId,
      approvedAt,
      changelog: `Created by Fleet Design from report run ${ctx.reportRunId} (${pending[index]?.itemRef ?? `entry ${index}`})`,
    }),
  }, tx);
  if ('error' in result) throw new Error(`script_scope_denied: ${result.error}`);
  if (result.errors.length > 0) {
    const detail = result.errors.map((e) => `${pending[e.index]?.itemRef ?? `entry ${e.index}`}: ${e.error}`).join('; ');
    throw new Error(`script_import_failed: ${detail}`);
  }

  const byIndex = new Map(result.scripts.map((r) => [r.index, r]));
  const createdNow: Array<{ itemRef: string; scriptId: string }> = [];
  for (const [index, item] of pending.entries()) {
    const entry = byIndex.get(index);
    if (!entry?.scriptId || (entry.action !== 'imported' && entry.action !== 'renamed')) {
      throw new Error(`script_import_failed: ${item.itemRef}: ${entry?.action ?? 'no result'}`);
    }
    const scriptName = entry.finalName ?? entry.name;
    const row = await recordApplied({
      orgId: ctx.orgId, reportRunId: ctx.reportRunId, itemRef: item.itemRef, itemKind: 'script', step: 4,
      createdRefs: { scriptId: entry.scriptId, scriptName }, userId: ctx.userId,
    }, tx);
    if (row) {
      ctx.applied.push(item.itemRef);
      ctx.appliedRefs.add(item.itemRef);
      ctx.createdScriptIds.set(item.itemRef, entry.scriptId);
      createdNow.push({ itemRef: item.itemRef, scriptId: entry.scriptId });
      writeAuditEvent(ctx.audit, {
        orgId: ctx.orgId, action: 'fleet_design.apply.script', resourceType: 'script', resourceId: entry.scriptId, resourceName: scriptName,
        actorType: 'user', actorId: ctx.userId, actorEmail: ctx.auth.user.email,
        details: { reportRunId: ctx.reportRunId, itemRef: item.itemRef, functionKey: item.functionKey, renamed: entry.action === 'renamed' },
      });
    } else warnUnrecordedApply(ctx.reportRunId, item.itemRef);
  }
  if (createdNow.length > 0) await linkRulesToCreatedScripts(ctx, new Set(createdNow.map((c) => c.itemRef)), tx);
}

/**
 * Spec §4.8 step 4: "the alert rules that reference them are updated with the
 * created ids". Rules were written by step 3 (this or an earlier apply) into
 * the function policy's inline alert_rule link; each one whose design rule
 * names a script created in THIS step gets `[script created: <id>]` appended
 * to its stored rationale (text only — alert rules have no action binding).
 * The policy ledger row's `linksSnapshot` is refreshed so rollback's
 * unmodified-since-apply comparison stays exact. A rule is matched by the
 * name + rationale step 3 wrote, so one a technician has since edited is
 * deliberately left alone (it is theirs now).
 */
async function linkRulesToCreatedScripts(ctx: ApplyCtx, createdRefs: Set<string>, tx: ApplyTransaction): Promise<void> {
  for (const [functionKey, policyRow] of ctx.policyRowByFunction) {
    const policyId = policyRow.createdRefs?.policyId;
    const section = ctx.outcome.sections.monitoring.find((m) => m.functionKey === functionKey);
    if (!policyId || !section) continue;
    // Stored rationale (as step 3 wrote it) → the rationale it should now carry.
    const rewrites = new Map<string, { name: string; rationale: string }>();
    for (const rule of section.alertRules) {
      const ref = proposalRefForRule(ctx.outcome, rule.action, functionKey);
      const scriptId = ref && createdRefs.has(ref) ? ctx.createdScriptIds.get(ref) : undefined;
      if (!scriptId) continue;
      const stored = toRuleItem(rule);
      rewrites.set(JSON.stringify([stored.name, stored.rationale]), { name: stored.name, rationale: withScriptCreated(stored.rationale, scriptId) });
    }
    if (rewrites.size === 0) continue;

    const links = await listFeatureLinks(policyId, tx);
    const ruleLink = links.find((l) => l.featureType === 'alert_rule' && !l.featurePolicyId);
    if (!ruleLink) continue; // no rule of this function was approved
    const cur = (ruleLink.inlineSettings ?? {}) as RuleSettings;
    let changed = false;
    const items = (cur.items ?? []).map((item) => {
      const next = rewrites.get(JSON.stringify([item.name, String(item.rationale ?? '')]));
      if (!next) return item;
      changed = true;
      return { ...item, rationale: next.rationale };
    });
    if (!changed) continue;
    const updated = await updateFeatureLink(ruleLink.id, { inlineSettings: { ...cur, items } }, policyId, undefined, tx);
    if (!updated) throw new Error(`rule_link_missing: ${policyId}`);
    const createdRefsNext: FleetDesignCreatedRefs = { ...policyRow.createdRefs, linksSnapshot: snapshotLinks(await listFeatureLinks(policyId, tx)) };
    await updateCreatedRefs(policyRow.id, ctx.orgId, createdRefsNext, tx);
    policyRow.createdRefs = createdRefsNext;
  }
}

// ---------------------------------------------------------------------------
// Step 5: role corrections (billing-relevant; source 'ai', never over 'manual')
// ---------------------------------------------------------------------------
async function stepRoleCorrections(ctx: ApplyCtx, tx: ApplyTransaction): Promise<void> {
  for (const rc of ctx.preview.roleCorrections) {
    const itemRef = `roleCorrections:${rc.deviceId}`;
    if (ctx.appliedRefs.has(itemRef)) continue;
    const [current] = await tx
      .select({ deviceRole: devices.deviceRole, deviceRoleSource: devices.deviceRoleSource })
      .from(devices)
      .where(and(eq(devices.id, rc.deviceId), eq(devices.orgId, ctx.orgId)))
      .limit(1);
    if (!current) throw new Error(`device_missing: ${rc.deviceId}`);
    const [updated] = await tx
      .update(devices)
      .set({ deviceRole: rc.to, deviceRoleSource: 'ai', updatedAt: new Date() })
      .where(and(
        eq(devices.id, rc.deviceId),
        eq(devices.orgId, ctx.orgId),
        sql`${devices.deviceRoleSource} <> 'manual'`,
      ))
      .returning({ id: devices.id });
    if (!updated) throw new Error(`role_is_manual: ${rc.deviceId}`);
    const row = await recordApplied({
      orgId: ctx.orgId, reportRunId: ctx.reportRunId, itemRef, itemKind: 'role_correction', step: 5,
      beforeImage: { deviceRole: current.deviceRole, deviceRoleSource: current.deviceRoleSource },
      userId: ctx.userId,
    }, tx);
    if (row) {
      ctx.applied.push(itemRef);
      ctx.appliedRefs.add(itemRef);
      writeAuditEvent(ctx.audit, {
        orgId: ctx.orgId, action: 'device.role.ai_correction', resourceType: 'device', resourceId: rc.deviceId, resourceName: rc.hostname,
        actorType: 'user', actorId: ctx.userId, actorEmail: ctx.auth.user.email,
        details: { from: current.deviceRole, to: rc.to, reportRunId: ctx.reportRunId },
      });
    } else warnUnrecordedApply(ctx.reportRunId, itemRef);
  }
}
