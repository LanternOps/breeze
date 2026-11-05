/**
 * Full-control W16 PR B (#6786, T8): the auth-free snapshot a four-eyes Fleet Design
 * apply or rollback is pinned over.
 *
 * WHY NOT THE PREVIEW. `computeEffectDigestForRelease(tool, args, db)` has no auth
 * and runs system-scoped, while `previewFleetDesignApplyWithContext` reads
 * `policyAccessCondition(auth)`, `canManagePartnerWidePolicies(auth)` and
 * `previewBundle(auth, ...)`, and takes a row lock. So this is a separate read of
 * the inputs the preview resolves against: what the approver saw, as the state that
 * produced it. `applyTargets.test.ts` checks the two agree.
 *
 * Bound to the intent's org, never to a caller: a report of any other org reads as
 * missing, so an approver of one org cannot pass a design of another. The handler reads
 * it system-scoped too (under the report-run lock, on a second connection), so a
 * partner-wide row an org session sees differently cannot make a matching digest refuse.
 *
 * It holds no row lock and no plaintext destination: a notification channel's config
 * (for slack, teams and webhook the URL IS the credential) is hashed.
 */
import { createHash } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { FleetDesignApproval, FleetDesignOutcome, FleetDesignReportSummary } from '@breeze/shared';
import { sql } from 'drizzle-orm';
import type { Database } from '../../db';
import {
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configurationPolicies,
  deviceFunctionAssessments,
  deviceGroupMemberships,
  devices,
  fleetDesignAppliedItems,
  notificationChannelConfigs,
  notificationChannels,
  reportRuns,
  reports,
} from '../../db/schema';
import { FLEET_DESIGN_REPORT_TYPE } from '../aiAgents/fleetDesignReport';
import { findReusableGroup } from './ledger';
import { snapshotFleetMonitors } from './monitorAttachments';
import { parseAutomationRef } from './scripts';

type Executor = Database;

const sorted = <T>(values: Iterable<T>): T[] => [...new Set(values)].sort();

/** Stable text: sorted keys at every depth, `undefined` dropped. */
function stableText(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const source = v as Record<string, unknown>;
      return Object.fromEntries(Object.keys(source).sort().map((k) => [k, source[k]]));
    }
    return v;
  });
}

const sha256 = (value: unknown): string => createHash('sha256').update(stableText(value)).digest('hex');

/** The canonical approval: every array deduped and sorted, so card order cannot matter. */
function canonicalApproval(approval: FleetDesignApproval): FleetDesignApproval {
  return {
    functions: sorted(approval.functions),
    monitoring: sorted(approval.monitoring),
    retired: sorted(approval.retired),
    automation: sorted(approval.automation),
    legacy: sorted(approval.legacy),
    roleCorrections: sorted(approval.roleCorrections),
    displacementsAccepted: sorted(approval.displacementsAccepted),
  };
}

/** `monitoring:<key>:(watch|rule):<n>`. Local: `preview.ts` pulls the script importer's graph. */
function parseMonitoring(ref: string): { functionKey: string; kind: string; index: number } | null {
  const match = /^monitoring:(.+):(watch|rule):(\d+)$/.exec(ref);
  return match ? { functionKey: match[1]!, kind: match[2]!, index: Number(match[3]) } : null;
}

/** The stored design. Null for "missing / not a Fleet Design / not this org's" alike. */
async function loadOrgReport(reportRunId: string, orgId: string, database: Executor): Promise<{ outcome: FleetDesignOutcome | null } | null> {
  const [row] = await database
    .select({ summary: sql<FleetDesignReportSummary | null>`${reportRuns.result}->'summary'` })
    .from(reportRuns)
    .innerJoin(reports, eq(reportRuns.reportId, reports.id))
    .where(and(eq(reportRuns.id, reportRunId), eq(reports.orgId, orgId), eq(reports.type, FLEET_DESIGN_REPORT_TYPE)))
    .limit(1);
  if (!row) return null;
  return { outcome: row.summary?.fleetDesign?.outcome ?? null };
}

async function loadGroupMembers(groupId: string, orgId: string, database: Executor): Promise<string[]> {
  const rows = await database
    .select({ deviceId: deviceGroupMemberships.deviceId })
    .from(deviceGroupMemberships)
    .where(and(eq(deviceGroupMemberships.groupId, groupId), eq(deviceGroupMemberships.orgId, orgId)));
  return sorted(rows.map((r) => r.deviceId));
}

async function loadDeviceStates(deviceIds: readonly string[], orgId: string, database: Executor) {
  if (deviceIds.length === 0) return [];
  const rows = await database
    .select({
      id: devices.id,
      deviceRole: devices.deviceRole,
      deviceRoleSource: devices.deviceRoleSource,
      deviceFunctionSource: devices.deviceFunctionSource,
    })
    .from(devices)
    .where(and(eq(devices.orgId, orgId), inArray(devices.id, [...deviceIds])));
  return rows
    .map((r) => ({ deviceId: r.id, deviceRole: r.deviceRole, deviceRoleSource: r.deviceRoleSource, deviceFunctionSource: r.deviceFunctionSource }))
    .sort((a, b) => a.deviceId.localeCompare(b.deviceId));
}

/** A policy's owner, status, assignments and `monitors` link: what decides which devices a monitor reaches. */
async function loadPolicyStates(policyIds: readonly string[], orgId: string, database: Executor) {
  if (policyIds.length === 0) return [];
  const ids = sorted(policyIds);
  const policies = await database
    .select({ id: configurationPolicies.id, orgId: configurationPolicies.orgId, partnerId: configurationPolicies.partnerId, status: configurationPolicies.status })
    .from(configurationPolicies)
    .where(and(inArray(configurationPolicies.id, ids), eq(configurationPolicies.orgId, orgId)));
  const assignments = await database
    .select({
      id: configPolicyAssignments.id,
      configPolicyId: configPolicyAssignments.configPolicyId,
      level: configPolicyAssignments.level,
      targetId: configPolicyAssignments.targetId,
      priority: configPolicyAssignments.priority,
      roleFilter: configPolicyAssignments.roleFilter,
      osFilter: configPolicyAssignments.osFilter,
    })
    .from(configPolicyAssignments)
    .where(inArray(configPolicyAssignments.configPolicyId, ids));
  const links = await database
    .select({
      id: configPolicyFeatureLinks.id,
      configPolicyId: configPolicyFeatureLinks.configPolicyId,
      featurePolicyId: configPolicyFeatureLinks.featurePolicyId,
      inlineSettings: configPolicyFeatureLinks.inlineSettings,
    })
    .from(configPolicyFeatureLinks)
    .where(and(inArray(configPolicyFeatureLinks.configPolicyId, ids), eq(configPolicyFeatureLinks.featureType, 'monitors')));
  return ids.map((id) => {
    const policy = policies.find((p) => p.id === id);
    if (!policy) return { id, missing: true as const };
    return {
      id,
      orgId: policy.orgId,
      partnerId: policy.partnerId,
      status: policy.status,
      assignments: assignments
        .filter((a) => a.configPolicyId === id)
        .map((a) => ({ id: a.id, level: a.level, targetId: a.targetId, priority: a.priority, roleFilter: a.roleFilter, osFilter: a.osFilter }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      monitorsLink: links
        .filter((l) => l.configPolicyId === id)
        .map((l) => ({ id: l.id, featurePolicyId: l.featurePolicyId, settings: l.inlineSettings }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    };
  });
}

/** The destinations the approved rules page. A channel's config is hashed, never held. */
async function loadChannelStates(channelIds: readonly string[], database: Executor) {
  if (channelIds.length === 0) return [];
  const ids = sorted(channelIds);
  const channels = await database
    .select({
      id: notificationChannels.id,
      orgId: notificationChannels.orgId,
      partnerId: notificationChannels.partnerId,
      type: notificationChannels.type,
      name: notificationChannels.name,
      enabled: notificationChannels.enabled,
    })
    .from(notificationChannels)
    .where(inArray(notificationChannels.id, ids));
  const configs = await database
    .select({ channelId: notificationChannelConfigs.channelId, config: notificationChannelConfigs.config })
    .from(notificationChannelConfigs)
    .where(inArray(notificationChannelConfigs.channelId, ids));
  return ids.map((id) => {
    const channel = channels.find((c) => c.id === id);
    if (!channel) return { id, missing: true as const };
    return { ...channel, configHash: sha256(configs.find((c) => c.channelId === id)?.config ?? null) };
  });
}

export type FleetDesignApplyTargets = NonNullable<Awaited<ReturnType<typeof snapshotFleetDesignApplyTargets>>>;

export async function snapshotFleetDesignApplyTargets(reportRunId: string, orgId: string, approval: FleetDesignApproval, database: Executor) {
  const report = await loadOrgReport(reportRunId, orgId, database);
  if (!report?.outcome) return null;
  const { outcome } = report;
  const canonical = canonicalApproval(approval);

  const ledger = await database
    .select({
      itemRef: fleetDesignAppliedItems.itemRef,
      itemKind: fleetDesignAppliedItems.itemKind,
      status: fleetDesignAppliedItems.status,
      createdRefs: fleetDesignAppliedItems.createdRefs,
    })
    .from(fleetDesignAppliedItems)
    .where(and(eq(fleetDesignAppliedItems.reportRunId, reportRunId), eq(fleetDesignAppliedItems.orgId, orgId)));

  const monitoringRefs = canonical.monitoring.map(parseMonitoring).filter((r): r is NonNullable<typeof r> => r !== null);
  const functionKeys = sorted([...canonical.functions, ...monitoringRefs.map((r) => r.functionKey)]);

  // Group and members first, so the device read covers everything either the design
  // or the group names.
  const groups = new Map<string, { groupId: string | null; members: string[] }>();
  for (const key of functionKeys) {
    const reuse = await findReusableGroup(orgId, key, database);
    groups.set(key, { groupId: reuse?.groupId ?? null, members: reuse ? await loadGroupMembers(reuse.groupId, orgId, database) : [] });
  }
  const designDevices = (key: string): string[] =>
    canonical.functions.includes(key) ? sorted(outcome.sections.functions.find((f) => f.functionKey === key)?.deviceIds ?? []) : [];

  const named = sorted([
    ...canonical.roleCorrections,
    ...functionKeys.flatMap((key) => [...designDevices(key), ...(groups.get(key)?.members ?? [])]),
  ]);
  const deviceStates = await loadDeviceStates(named, orgId, database);
  const inOrg = new Set(deviceStates.map((d) => d.deviceId));

  const assessments = named.length === 0 ? [] : await database
    .select({
      id: deviceFunctionAssessments.id,
      deviceId: deviceFunctionAssessments.deviceId,
      functionKey: deviceFunctionAssessments.functionKey,
      source: deviceFunctionAssessments.source,
    })
    .from(deviceFunctionAssessments)
    .where(and(
      eq(deviceFunctionAssessments.orgId, orgId),
      inArray(deviceFunctionAssessments.deviceId, named),
      eq(deviceFunctionAssessments.active, true),
    ));

  const functions = functionKeys.map((functionKey) => {
    const group = groups.get(functionKey)!;
    const approved = canonical.functions.includes(functionKey);
    const design = designDevices(functionKey);
    // As the preview: an approved function's group will hold the design's devices that
    // still exist; a monitored function not approved here keeps its group's members.
    const wantedDeviceIds = approved ? design.filter((d) => inOrg.has(d)) : group.members;
    return {
      functionKey,
      approved,
      groupId: group.groupId,
      groupMemberIds: group.members,
      wantedDeviceIds,
      missingDeviceIds: approved ? design.filter((d) => !inOrg.has(d)) : [],
      assessments: assessments
        .filter((a) => wantedDeviceIds.includes(a.deviceId))
        .map((a) => ({ id: a.id, deviceId: a.deviceId, functionKey: a.functionKey, source: a.source }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    };
  });

  const monitoredKeys = new Set(monitoringRefs.map((r) => r.functionKey));
  const policyIds = ledger
    .filter((r) => r.status === 'applied' && r.itemKind === 'policy' && monitoredKeys.has(r.itemRef.slice('policy:'.length)))
    .map((r) => r.createdRefs?.policyId)
    .filter((id): id is string => typeof id === 'string');

  const scripts = canonical.automation.map((itemRef) => {
    const parsed = parseAutomationRef(itemRef);
    const script = parsed
      ? outcome.sections.automation.find((a) => a.functionKey === parsed.functionKey)?.scripts[parsed.index]
      : undefined;
    return { itemRef, contentHash: script ? sha256(script.content) : null };
  });

  const channelIds = monitoringRefs.flatMap((ref) => (ref.kind === 'rule'
    ? outcome.sections.monitoring.find((m) => m.functionKey === ref.functionKey)?.alertRules[ref.index]?.deliveryChannelIds ?? []
    : []));

  return {
    orgId,
    designHash: sha256(outcome),
    approval: canonical,
    functions,
    policies: await loadPolicyStates(policyIds, orgId, database),
    ledger: ledger
      .map((r) => ({ itemRef: r.itemRef, status: r.status }))
      .sort((a, b) => a.itemRef.localeCompare(b.itemRef)),
    devices: deviceStates,
    scripts,
    channels: await loadChannelStates(channelIds, database),
  };
}

export type FleetDesignRollbackTargets = NonNullable<Awaited<ReturnType<typeof snapshotFleetDesignRollbackTargets>>>;

/**
 * The ledger's `applied` rows in step order, plus the live state each would touch:
 * rollback compares and overwrites that state, so what it does depends on it.
 */
export async function snapshotFleetDesignRollbackTargets(reportRunId: string, orgId: string, database: Executor) {
  const report = await loadOrgReport(reportRunId, orgId, database);
  if (!report) return null;

  const rows = (await database
    .select({
      itemRef: fleetDesignAppliedItems.itemRef,
      itemKind: fleetDesignAppliedItems.itemKind,
      status: fleetDesignAppliedItems.status,
      step: fleetDesignAppliedItems.step,
      createdRefs: fleetDesignAppliedItems.createdRefs,
      beforeImage: fleetDesignAppliedItems.beforeImage,
    })
    .from(fleetDesignAppliedItems)
    .where(and(eq(fleetDesignAppliedItems.reportRunId, reportRunId), eq(fleetDesignAppliedItems.orgId, orgId)))
    .orderBy(asc(fleetDesignAppliedItems.step), asc(fleetDesignAppliedItems.appliedAt)))
    .filter((r) => r.status === 'applied');

  const ledger = rows
    .map((r) => ({ itemRef: r.itemRef, itemKind: r.itemKind, step: r.step, createdRefs: r.createdRefs ?? {}, beforeImageHash: sha256(r.beforeImage) }))
    .sort((a, b) => (a.step - b.step) || a.itemRef.localeCompare(b.itemRef));

  const roleDeviceIds = rows
    .filter((r) => r.itemKind === 'role_correction' && r.itemRef.startsWith('roleCorrections:'))
    .map((r) => r.itemRef.slice('roleCorrections:'.length));

  const functionRows = rows.filter((r) => r.itemKind === 'function');
  const groups = [];
  for (const groupId of sorted(functionRows.map((r) => r.createdRefs?.groupId).filter((id): id is string => typeof id === 'string'))) {
    groups.push({ groupId, members: await loadGroupMembers(groupId, orgId, database) });
  }
  const assessmentIds = sorted(functionRows.flatMap((r) => r.createdRefs?.assessmentIds ?? []));
  const liveAssessments = assessmentIds.length === 0 ? [] : await database
    .select({ id: deviceFunctionAssessments.id })
    .from(deviceFunctionAssessments)
    .where(and(
      eq(deviceFunctionAssessments.orgId, orgId),
      inArray(deviceFunctionAssessments.id, assessmentIds),
      eq(deviceFunctionAssessments.active, true),
    ));

  const policyRows = rows.filter((r) => r.itemKind === 'policy');
  const policyIds = policyRows.map((r) => r.createdRefs?.policyId).filter((id): id is string => typeof id === 'string');
  const monitorIds = sorted(policyRows.flatMap((r) => Object.values(r.createdRefs?.monitorIdsByItemRef ?? {})));

  return {
    orgId,
    ledger,
    devices: await loadDeviceStates(sorted(roleDeviceIds), orgId, database),
    groups,
    activeAssessmentIds: sorted(liveAssessments.map((a) => a.id)),
    policies: await loadPolicyStates(policyIds, orgId, database),
    monitors: await snapshotFleetMonitors(monitorIds, database),
  };
}
