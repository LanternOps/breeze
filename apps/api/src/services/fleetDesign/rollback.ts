/**
 * Fleet Design rollback (Fleet Designer W03, #5653; spec §4.8).
 *
 * Reverses the ledger in reverse step order (5 → 4 → 3 → 2 → 1) and refuses any
 * item whose objects changed since the apply — a STATE comparison against
 * the ledger's `created_refs` / `before_image`, never `updated_at`. Each
 * ledger row runs in its own savepoint so a refusal or a thrown guard
 * (`deviceGroupDelete.ts`'s child/billing/quote guards) never aborts the
 * others; refused rows stay `applied` and can be retried after the
 * technician resolves them.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { FleetDesignRollbackRefusal, FleetDesignRollbackResult } from '@breeze/shared';
import { db } from '../../db';
import {
  configPolicyAssignments,
  configurationPolicies,
  deviceFunctionAssessments,
  deviceGroupMemberships,
  deviceGroups,
  devices,
  scriptTags,
  scriptToTags,
} from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { schedulePeripheralPolicyDevice } from '../../jobs/peripheralJobs';
import { requestLikeFromSnapshot, writeAuditEvent, type RequestLike } from '../auditEvents';
import { listFeatureLinks, policyAccessCondition, updateConfigPolicy, updateFeatureLink } from '../configurationPolicy';
import { deleteDeviceGroup } from '../deviceGroupDelete';
import { restoreDeviceFunction } from '../deviceFunction';
import { addManualGroupMemberships, validateManualMembershipDevices } from '../groupMembership';
import { canManagePartnerWidePolicies } from '../partnerWideAccess';
import { canonical, retireRewrite, snapshotLinks } from './apply';
import { snapshotFleetMonitors } from './monitorAttachments';
import { loadLedger, lockReportRun, markRolledBack, type FleetDesignLedgerRow } from './ledger';
import { FleetDesignApplyError } from './preview';
import { FLEET_DESIGN_SCRIPT_TAG } from './scripts';

type Refusal = { itemRef: string; reason: FleetDesignRollbackRefusal };

class RollbackRefused extends Error {
  constructor(public readonly reason: FleetDesignRollbackRefusal) {
    super(reason);
    this.name = 'RollbackRefused';
  }
}

interface RollbackCtx {
  auth: AuthContext;
  orgId: string;
  reportRunId: string;
  userId: string;
  audit: RequestLike;
  /** Group ids still targeted by a policy this rollback could NOT archive. */
  groupsStillTargeted: Set<string>;
  /** Devices whose pre-apply function could not be restored (the prior assessment is gone). */
  functionsNotRestored: string[];
  /** Untagging a created script is a script write (W04); the route resolves scripts:write. */
  canWriteScripts: boolean;
}

export interface FleetDesignRollbackOptions {
  /** Caller holds scripts:write. Default false — a script row is refused, never silently untagged. */
  canWriteScripts?: boolean;
}

export async function rollbackFleetDesign(
  auth: AuthContext,
  reportRunId: string,
  audit: RequestLike = requestLikeFromSnapshot({}),
  options: FleetDesignRollbackOptions = {},
): Promise<FleetDesignRollbackResult> {
  const locked = await lockReportRun(reportRunId, (col) => auth.orgCondition(col));
  if (!locked) throw new FleetDesignApplyError('not_found');
  const orgId = locked.orgId;
  const ledger = (await loadLedger(reportRunId, orgId)).filter((r) => r.status === 'applied');

  const ctx: RollbackCtx = {
    auth, orgId, reportRunId, userId: auth.user.id, audit, groupsStillTargeted: new Set(), functionsNotRestored: [],
    canWriteScripts: options.canWriteScripts === true,
  };
  const rolledBack: string[] = [];
  const refused: Refusal[] = [];

  // Reverse order: later steps first, and within a step the later rows first.
  const ordered = [...ledger].sort((a, b) => (b.step - a.step) || (b.appliedAt.getTime() - a.appliedAt.getTime()));
  // Watch/rule rows carry no state of their own — they ride on their policy row.
  const itemRowsByPolicy = new Map<string, FleetDesignLedgerRow[]>();
  for (const r of ordered) {
    if ((r.itemKind === 'watch' || r.itemKind === 'rule') && r.createdRefs?.policyId) {
      const list = itemRowsByPolicy.get(r.createdRefs.policyId) ?? [];
      list.push(r);
      itemRowsByPolicy.set(r.createdRefs.policyId, list);
    }
  }

  for (const row of ordered) {
    if (row.itemKind === 'watch' || row.itemKind === 'rule') continue; // handled with the policy row
    const group = row.itemKind === 'policy' ? itemRowsByPolicy.get(row.createdRefs?.policyId ?? '') ?? [] : [];
    try {
      await db.transaction(async () => {
        switch (row.itemKind) {
          case 'role_correction': await rollbackRoleCorrection(ctx, row); break;
          case 'policy': await rollbackPolicy(ctx, row); break;
          case 'retired': await rollbackRetired(ctx, row); break;
          case 'script': await rollbackScript(ctx, row); break;
          case 'function': await rollbackFunction(ctx, row); break;
          default: throw new RollbackRefused('modified_since_apply');
        }
        await markRolledBack([row.id, ...group.map((g) => g.id)], orgId, ctx.userId);
      });
      rolledBack.push(row.itemRef, ...group.map((g) => g.itemRef));
      const notRestored = ctx.functionsNotRestored.splice(0);
      writeAuditEvent(audit, {
        orgId, action: 'fleet_design.rollback.item', resourceType: 'report_run', resourceId: reportRunId,
        actorType: 'user', actorId: ctx.userId, actorEmail: auth.user.email,
        details: {
          itemRef: row.itemRef, itemKind: row.itemKind, step: row.step,
          ...(notRestored.length > 0 ? { functionsNotRestored: notRestored } : {}),
        },
      });
    } catch (error) {
      ctx.functionsNotRestored.length = 0;
      const reason: FleetDesignRollbackRefusal = error instanceof RollbackRefused ? error.reason : 'modified_since_apply';
      if (!(error instanceof RollbackRefused)) {
        console.error(`[fleetDesign] rollback of ${row.itemRef} (run ${reportRunId}) failed:`, error);
      }
      refused.push({ itemRef: row.itemRef, reason });
      if (row.itemKind === 'policy' && row.createdRefs?.groupId) ctx.groupsStillTargeted.add(row.createdRefs.groupId);
    }
  }
  return { rolledBack, refused };
}

// ---------------------------------------------------------------------------
// Step 5 ← role corrections
// ---------------------------------------------------------------------------
async function rollbackRoleCorrection(ctx: RollbackCtx, row: FleetDesignLedgerRow): Promise<void> {
  const deviceId = row.itemRef.slice('roleCorrections:'.length);
  const before = row.beforeImage ?? {};
  if (typeof before.deviceRole !== 'string' || typeof before.deviceRoleSource !== 'string') throw new RollbackRefused('modified_since_apply');
  // Restore only while the row still carries the correction; a later manual
  // or discovery write means the technician has moved on.
  const [updated] = await db
    .update(devices)
    .set({ deviceRole: before.deviceRole, deviceRoleSource: before.deviceRoleSource, updatedAt: new Date() })
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, ctx.orgId), eq(devices.deviceRoleSource, 'ai')))
    .returning({ id: devices.id });
  if (!updated) throw new RollbackRefused('modified_since_apply');
}

// ---------------------------------------------------------------------------
// Step 4 ← script (W04): spec §4.8 — "scripts are left in place but
// untagged". Only the `fleet-design` tag link goes; the script row, its
// versions and any other tag a technician added stay. No unmodified-since-
// apply check: removing our own tag is safe whatever happened to the script
// since, and a deleted script simply has nothing left to untag.
// ---------------------------------------------------------------------------
async function rollbackScript(ctx: RollbackCtx, row: FleetDesignLedgerRow): Promise<void> {
  if (!ctx.canWriteScripts) throw new RollbackRefused('scripts_write_required');
  const scriptId = row.createdRefs?.scriptId;
  if (!scriptId) throw new RollbackRefused('modified_since_apply');
  // Step 4 imports org-owned, so ensureTagIds created (or reused) the tag in
  // the org's own tag scope.
  const tags = await db
    .select({ id: scriptTags.id })
    .from(scriptTags)
    .where(and(eq(scriptTags.orgId, ctx.orgId), eq(scriptTags.name, FLEET_DESIGN_SCRIPT_TAG)));
  if (tags.length === 0) return;
  await db
    .delete(scriptToTags)
    .where(and(eq(scriptToTags.scriptId, scriptId), inArray(scriptToTags.tagId, tags.map((t) => t.id))));
}

// ---------------------------------------------------------------------------
// Step 3 ← policy: archive + unassign when links still equal the snapshot
// ---------------------------------------------------------------------------
async function rollbackPolicy(ctx: RollbackCtx, row: FleetDesignLedgerRow): Promise<void> {
  const policyId = row.createdRefs?.policyId;
  if (!policyId) throw new RollbackRefused('policy_missing');
  const conditions = [eq(configurationPolicies.id, policyId)];
  const access = policyAccessCondition(ctx.auth);
  if (access) conditions.push(access);
  const [policy] = await db
    .select({ id: configurationPolicies.id, orgId: configurationPolicies.orgId, status: configurationPolicies.status })
    .from(configurationPolicies)
    .where(and(...conditions))
    .limit(1);
  if (!policy) throw new RollbackRefused('policy_missing');
  if (policy.status === 'archived') throw new RollbackRefused('modified_since_apply');

  // Both sides through canonical(): `snapshotLinks` only sorts keys WITHIN
  // `monitoring` / `alertRule`, not the outer `{monitoring, alertRule}`
  // object — and a jsonb round trip does not preserve JS insertion order, so
  // `expected` (read back from `created_refs`) can carry its two top-level
  // keys in a different order than a freshly computed `current` even when
  // every value is byte-identical. Comparing the RAW `current` against
  // `canonical(expected)` made every legitimate rollback fail closed as
  // "modified_since_apply" (caught by fleetDesignApply.integration.test.ts
  // case 6 against real Postgres — a mocked-db unit test can't reproduce a
  // jsonb round trip).
  const current = canonical(snapshotLinks(await listFeatureLinks(policyId)));
  const expected = row.createdRefs?.linksSnapshot;
  if (!expected || JSON.stringify(current) !== JSON.stringify(canonical(expected))) throw new RollbackRefused('modified_since_apply');
  // W05c2: the monitor definitions this policy's apply created must also be
  // exactly as apply left them (author fields only). An edited or deleted
  // definition means a technician owns it now — refuse, never undo their work.
  const monitorIds = row.createdRefs?.monitorIdsByItemRef;
  if (monitorIds && Object.keys(monitorIds).length > 0) {
    const currentMonitors = await snapshotFleetMonitors(Object.values(monitorIds));
    if (JSON.stringify(canonical(currentMonitors)) !== JSON.stringify(canonical(row.createdRefs?.monitorSnapshots ?? null))) {
      throw new RollbackRefused('modified_since_apply');
    }
  }

  const assignmentConditions = [eq(configPolicyAssignments.configPolicyId, policyId)];
  if (row.createdRefs?.assignmentId) assignmentConditions.push(eq(configPolicyAssignments.id, row.createdRefs.assignmentId));
  else if (row.createdRefs?.groupId) {
    assignmentConditions.push(eq(configPolicyAssignments.level, 'device_group'), eq(configPolicyAssignments.targetId, row.createdRefs.groupId));
  }
  await db.delete(configPolicyAssignments).where(and(...assignmentConditions));
  const archived = await updateConfigPolicy(policyId, { status: 'archived' }, ctx.auth);
  if (!archived) throw new RollbackRefused('policy_missing');
}

// ---------------------------------------------------------------------------
// Step 2 ← retired: restore the before-image when the link still equals the
// post-apply value (recomputed from the before-image + the same rewrite)
// ---------------------------------------------------------------------------
async function rollbackRetired(ctx: RollbackCtx, row: FleetDesignLedgerRow): Promise<void> {
  const policyId = row.createdRefs?.policyId;
  const linkId = row.createdRefs?.linkId;
  const before = row.beforeImage?.inlineSettings;
  if (!policyId || !linkId || before === undefined) throw new RollbackRefused('modified_since_apply');

  const conditions = [eq(configurationPolicies.id, policyId)];
  const access = policyAccessCondition(ctx.auth);
  if (access) conditions.push(access);
  const [policy] = await db
    .select({ id: configurationPolicies.id, orgId: configurationPolicies.orgId })
    .from(configurationPolicies)
    .where(and(...conditions))
    .limit(1);
  if (!policy) throw new RollbackRefused('policy_missing');
  if (policy.orgId === null && !canManagePartnerWidePolicies(ctx.auth)) throw new RollbackRefused('partner_wide_write_denied');

  const links = await listFeatureLinks(policyId);
  const link = links.find((l) => l.id === linkId);
  if (!link) throw new RollbackRefused('policy_missing');

  // The design item is not stored on the ledger row; recompute the expected
  // post-apply state by finding which single item differs between the
  // before-image and the current settings.
  const kind = link.featureType === 'monitoring' ? 'watch' : 'rule';
  const expected = expectedAfterRetire(kind, before, link.inlineSettings);
  if (!expected || JSON.stringify(canonical(link.inlineSettings)) !== JSON.stringify(canonical(expected))) {
    throw new RollbackRefused('modified_since_apply');
  }
  const restored = await updateFeatureLink(linkId, { inlineSettings: before }, policyId);
  if (!restored) throw new RollbackRefused('policy_missing');
}

/**
 * Find the ONE item whose retirement turns `before` into `current`; return the
 * rewritten settings if exactly one such item exists (so the comparison in the
 * caller is exact), else null.
 */
function expectedAfterRetire(kind: 'watch' | 'rule', before: unknown, current: unknown): unknown | null {
  const b = (before ?? {}) as { watches?: Array<{ name: string }>; items?: Array<{ name: string }> };
  const names = (kind === 'watch' ? b.watches : b.items)?.map((i) => i.name) ?? [];
  const currentJson = JSON.stringify(canonical(current));
  const matches = names.filter((name) => JSON.stringify(canonical(retireRewrite(kind, name, before))) === currentJson);
  return matches.length === 1 ? retireRewrite(kind, matches[0]!, before) : null;
}

// ---------------------------------------------------------------------------
// Step 1 ← function: assessments back to the prior row; group deleted when its
// membership is exactly what the apply set, else the apply's additions removed
// ---------------------------------------------------------------------------
async function rollbackFunction(ctx: RollbackCtx, row: FleetDesignLedgerRow): Promise<void> {
  const refs = row.createdRefs ?? {};
  const before = row.beforeImage ?? {};
  const groupId = refs.groupId;
  if (!groupId) throw new RollbackRefused('modified_since_apply');
  if (ctx.groupsStillTargeted.has(groupId)) throw new RollbackRefused('modified_since_apply');

  // 1. Assessments: only devices whose ACTIVE row is one this apply wrote.
  const written = new Set(refs.assessmentIds ?? []);
  const prior = before.priorAssessmentIdByDevice ?? {};
  if (written.size > 0) {
    const active = await db
      .select({ id: deviceFunctionAssessments.id, deviceId: deviceFunctionAssessments.deviceId })
      .from(deviceFunctionAssessments)
      .where(and(
        eq(deviceFunctionAssessments.orgId, ctx.orgId),
        inArray(deviceFunctionAssessments.id, [...written]),
        eq(deviceFunctionAssessments.active, true),
      ));
    for (const a of active) {
      const outcome = await restoreDeviceFunction({ deviceId: a.deviceId, orgId: ctx.orgId, assessmentId: prior[a.deviceId] ?? null, userId: ctx.userId });
      // `cleared` where a prior assessment was recorded means that row is gone
      // (erased) and the device ends with NO function rather than the value it
      // had before the apply. The rollback still succeeded, but the divergence
      // must not be silent: it lands in the audit event for this row.
      if (outcome.outcome === 'cleared' && prior[a.deviceId]) ctx.functionsNotRestored.push(a.deviceId);
    }
  }

  // 2. Group.
  const [group] = await db
    .select({ id: deviceGroups.id, siteId: deviceGroups.siteId })
    .from(deviceGroups)
    .where(and(eq(deviceGroups.id, groupId), eq(deviceGroups.orgId, ctx.orgId)))
    .limit(1);
  if (!group) return; // already gone — nothing to restore

  const currentMembers = (await db
    .select({ deviceId: deviceGroupMemberships.deviceId })
    .from(deviceGroupMemberships)
    .where(and(eq(deviceGroupMemberships.groupId, groupId), eq(deviceGroupMemberships.orgId, ctx.orgId)))).map((m) => m.deviceId);
  const snapshot = refs.membershipSnapshot ?? [];
  const beforeMembers = before.memberships ?? [];
  const sameAsSnapshot = currentMembers.length === snapshot.length && currentMembers.every((d) => snapshot.includes(d));

  if (refs.groupCreated && sameAsSnapshot) {
    // Guards (children / billing / quotes) throw DeviceGroupDeleteError → refused.
    const result = await deleteDeviceGroup(groupId, ctx.orgId);
    for (const deviceId of result.affectedDeviceIds) {
      await schedulePeripheralPolicyDevice(deviceId, 'manual_membership_changed').catch((error) => {
        console.error(`[fleetDesign] failed to schedule peripheral reconciliation for ${deviceId}:`, error);
      });
    }
    return;
  }
  if (refs.groupCreated && !sameAsSnapshot) {
    // The technician has used the group since; hand it back to them intact.
    throw new RollbackRefused('group_has_other_members');
  }

  // Reused group: undo only this apply's membership delta.
  const added = snapshot.filter((d) => !beforeMembers.includes(d));
  const removed = beforeMembers.filter((d) => !snapshot.includes(d));
  const toRemove = added.filter((d) => currentMembers.includes(d));
  if (toRemove.length > 0) {
    await db
      .delete(deviceGroupMemberships)
      .where(and(eq(deviceGroupMemberships.groupId, groupId), eq(deviceGroupMemberships.orgId, ctx.orgId), inArray(deviceGroupMemberships.deviceId, toRemove)));
    for (const deviceId of toRemove) {
      await schedulePeripheralPolicyDevice(deviceId, 'manual_membership_changed').catch((error) => {
        console.error(`[fleetDesign] failed to schedule peripheral reconciliation for ${deviceId}:`, error);
      });
    }
  }
  const toRestore = removed.filter((d) => !currentMembers.includes(d));
  if (toRestore.length > 0) {
    const validation = await validateManualMembershipDevices({ deviceIds: toRestore, orgId: ctx.orgId, siteId: group.siteId ?? null });
    // A device removed by the apply that has since been deleted, moved org or
    // moved site cannot be put back. Refuse the whole row rather than report a
    // rollback that only half happened — the technician sees the reason and the
    // ledger row stays `applied` so it can be retried once they resolve it.
    // (The add-path in apply.ts throws on the same validation failure.)
    if (!validation.ok) throw new RollbackRefused('modified_since_apply');
    await addManualGroupMemberships({ groupId, orgId: ctx.orgId, deviceIds: toRestore });
  }
}
