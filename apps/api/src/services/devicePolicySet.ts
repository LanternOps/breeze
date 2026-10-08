/**
 * A device's candidate configuration-policy assignments for every feature the
 * agent heartbeat delivers, read in ONE statement (#8142, scaling W03 / W1a-2).
 *
 * Before this, each of ten heartbeat resolvers ran its own assignment query
 * (ten statements per beat). The set is a SUPERSET of every one of them:
 * ownership = the device's org OR its partner's partner-wide policies (raw
 * partner), targets = device / site / org / its groups / its partner (raw),
 * NO role/OS predicate. Each resolver then applies ITS OWN rules in TypeScript
 * (`applicableCandidates` with its `ApplicabilityRule`, plus whatever filtering
 * and ranking it already did) and must produce exactly what its own SQL did —
 * the parity suite proves that per resolver against real Postgres.
 *
 * Tenancy: the heartbeat loads this inside an ORG-scoped context
 * (accessibleOrgIds [deviceOrg], currentPartnerId = the device's partner), so
 * RLS — not the WHERE clause below — bounds every row to the device's own org
 * plus its own partner's partner-wide rows (the SELECT-only
 * *_partner_wide_select branches). The selectors only decide which of the
 * tenant's own assignments target THIS device. A set is for ONE device:
 * `policySetFor` throws when a resolver for device A is handed B's set.
 *
 * Settings: the five 1:1 settings tables are LEFT JOINed per feature type; a
 * null sub-object means "no settings row", which every inner-joining resolver
 * treats as "this candidate does not exist" — never as defaults.
 *
 * Order: assignment created_at, id, then link feature_type. Ranking ties that
 * today's SQL left to plan order are therefore won by the earliest assignment
 * (the legacy queries got the same ORDER BY, so both paths agree).
 */
import { and, asc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import {
  configPolicyAssignments,
  configPolicyEffectiveFeatureLinks,
  configPolicyEventLogSettings,
  configPolicyHardwareMonitoringSettings,
  configPolicyOnedriveSettings,
  configPolicyPatchSettings,
  configPolicyTimeSyncSettings,
  configurationPolicies,
} from '../db/schema';
import type { DeviceHierarchy, DeviceHierarchyOpts } from './deviceHierarchy';
import type { DbExecutor } from './monitors/monitorCompiler';
import { isQuickSupportOrgType } from './quickSupportOrg';
import { isUnassignedPoolOrgType } from './unassignedPool/orgType';

export const POLICY_SET_FEATURE_TYPES = [
  'event_log', 'hardware_monitoring', 'helper', 'monitors', 'onedrive_helper',
  'pam', 'patch', 'time_sync', 'warranty',
] as const;
export type PolicySetFeatureType = (typeof POLICY_SET_FEATURE_TYPES)[number];
export type PolicyAssignmentLevel = (typeof configPolicyAssignments.$inferSelect)['level'];

export type EventLogSettingsRow = Pick<typeof configPolicyEventLogSettings.$inferSelect,
  'id' | 'retentionDays' | 'maxEventsPerCycle' | 'collectCategories' | 'minimumLevel' | 'collectionIntervalMinutes' | 'rateLimitPerHour'>;
export type HardwareMonitoringSettingsRow = Pick<typeof configPolicyHardwareMonitoringSettings.$inferSelect,
  'id' | 'enabled' | 'pollIntervalMinutes' | 'diskHealthIntervalMinutes'>;
export type PatchSourceSettingsRow = Pick<typeof configPolicyPatchSettings.$inferSelect, 'id' | 'exclusiveWindowsUpdate'>;
export type TimeSyncSettingsRow = Pick<typeof configPolicyTimeSyncSettings.$inferSelect,
  'id' | 'enforceNtp' | 'ntpServers' | 'pollIntervalMinutes' | 'timezoneExpected' | 'pinnedTimezone' | 'timezoneAutoFix'>;
export type OnedriveSettingsRow = Pick<typeof configPolicyOnedriveSettings.$inferSelect,
  'id' | 'silentAccountConfig' | 'filesOnDemand' | 'kfmSilentOptIn' | 'kfmFolders' | 'kfmBlockOptOut' | 'tenantAssociationId' | 'restartOnChange'>;

export interface PolicySetLink {
  /** The UNDERLYING link id (a parent's id for an inherited link). */
  readonly id: string;
  readonly featureType: PolicySetFeatureType;
  readonly featurePolicyId: string | null;
  readonly inlineSettings: unknown;
  readonly eventLog: EventLogSettingsRow | null;
  readonly hardwareMonitoring: HardwareMonitoringSettingsRow | null;
  readonly patch: PatchSourceSettingsRow | null;
  readonly timeSync: TimeSyncSettingsRow | null;
  readonly onedrive: OnedriveSettingsRow | null;
}

export interface PolicyCandidate {
  readonly assignmentId: string;
  readonly level: PolicyAssignmentLevel;
  readonly targetId: string;
  readonly priority: number;
  readonly roleFilter: readonly string[] | null;
  readonly osFilter: readonly string[] | null;
  readonly assignmentCreatedAt: Date;
  /** The ASSIGNED policy (never the parent a link was inherited from). */
  readonly policyId: string;
  readonly policyName: string;
  readonly policyOrgId: string | null;
  readonly policyPartnerId: string | null;
  readonly parentPolicyId: string | null;
  readonly links: Readonly<Partial<Record<PolicySetFeatureType, PolicySetLink>>>;
}

export interface DevicePolicySet {
  readonly deviceId: string;
  readonly hierarchy: DeviceHierarchy;
  readonly candidates: readonly PolicyCandidate[];
}

/** One row of the set statement (exported for tests). */
export interface PolicySetRow {
  assignmentId: string;
  level: PolicyAssignmentLevel;
  targetId: string;
  priority: number;
  roleFilter: string[] | null;
  osFilter: string[] | null;
  assignmentCreatedAt: Date;
  policyId: string;
  policyName: string;
  policyOrgId: string | null;
  policyPartnerId: string | null;
  parentPolicyId: string | null;
  linkId: string | null;
  featureType: PolicySetFeatureType | null;
  featurePolicyId: string | null;
  inlineSettings: unknown;
  eventLog: EventLogSettingsRow | null;
  hardwareMonitoring: HardwareMonitoringSettingsRow | null;
  patch: PatchSourceSettingsRow | null;
  timeSync: TimeSyncSettingsRow | null;
  onedrive: OnedriveSettingsRow | null;
}

/** A left-joined nested object is present only when its primary key is. */
function present<T extends { id: string | null }>(value: T | null): (T & { id: string }) | null {
  return value && value.id !== null ? (value as T & { id: string }) : null;
}

export async function loadDevicePolicySet(hierarchy: DeviceHierarchy, executor: DbExecutor = db): Promise<DevicePolicySet> {
  const rows = await policySetQuery(hierarchy, executor);
  return groupPolicySetRows(hierarchy, rows.map((r) => ({
    ...r,
    featureType: r.featureType as PolicySetFeatureType | null,
    eventLog: present(r.eventLog),
    hardwareMonitoring: present(r.hardwareMonitoring),
    patch: present(r.patch),
    timeSync: present(r.timeSync),
    onedrive: present(r.onedrive),
  })));
}

/** The set statement, unexecuted — exported so the EXPLAIN probe in agentHotPathQueryBudget.integration.test.ts can EXPLAIN exactly it. */
export function policySetQuery(hierarchy: DeviceHierarchy, executor: DbExecutor = db) {
  const partnerId = hierarchy.org?.partnerId ?? null;
  const ownership: SQL = partnerId
    ? sql`(${configurationPolicies.orgId} = ${hierarchy.orgId} OR (${configurationPolicies.orgId} IS NULL AND ${configurationPolicies.partnerId} = ${partnerId}))`
    : sql`${configurationPolicies.orgId} = ${hierarchy.orgId}`;
  const targets: SQL[] = [
    and(eq(configPolicyAssignments.level, 'device'), eq(configPolicyAssignments.targetId, hierarchy.deviceId))!,
    and(eq(configPolicyAssignments.level, 'site'), eq(configPolicyAssignments.targetId, hierarchy.siteId))!,
    and(eq(configPolicyAssignments.level, 'organization'), eq(configPolicyAssignments.targetId, hierarchy.orgId))!,
  ];
  if (hierarchy.groupIds.length > 0) {
    targets.push(and(eq(configPolicyAssignments.level, 'device_group'), inArray(configPolicyAssignments.targetId, [...hierarchy.groupIds]))!);
  }
  if (partnerId) {
    targets.push(and(eq(configPolicyAssignments.level, 'partner'), eq(configPolicyAssignments.targetId, partnerId))!);
  }

  const link = configPolicyEffectiveFeatureLinks;
  const ev = configPolicyEventLogSettings;
  const hw = configPolicyHardwareMonitoringSettings;
  const pt = configPolicyPatchSettings;
  const ts = configPolicyTimeSyncSettings;
  const od = configPolicyOnedriveSettings;

  return executor
    .select({
      assignmentId: configPolicyAssignments.id,
      level: configPolicyAssignments.level,
      targetId: configPolicyAssignments.targetId,
      priority: configPolicyAssignments.priority,
      roleFilter: configPolicyAssignments.roleFilter,
      osFilter: configPolicyAssignments.osFilter,
      assignmentCreatedAt: configPolicyAssignments.createdAt,
      policyId: configurationPolicies.id,
      policyName: configurationPolicies.name,
      policyOrgId: configurationPolicies.orgId,
      policyPartnerId: configurationPolicies.partnerId,
      parentPolicyId: configurationPolicies.parentPolicyId,
      linkId: link.id,
      featureType: link.featureType,
      featurePolicyId: link.featurePolicyId,
      inlineSettings: link.inlineSettings,
      eventLog: {
        id: ev.id, retentionDays: ev.retentionDays, maxEventsPerCycle: ev.maxEventsPerCycle,
        collectCategories: ev.collectCategories, minimumLevel: ev.minimumLevel,
        collectionIntervalMinutes: ev.collectionIntervalMinutes, rateLimitPerHour: ev.rateLimitPerHour,
      },
      hardwareMonitoring: {
        id: hw.id, enabled: hw.enabled, pollIntervalMinutes: hw.pollIntervalMinutes, diskHealthIntervalMinutes: hw.diskHealthIntervalMinutes,
      },
      patch: { id: pt.id, exclusiveWindowsUpdate: pt.exclusiveWindowsUpdate },
      timeSync: {
        id: ts.id, enforceNtp: ts.enforceNtp, ntpServers: ts.ntpServers, pollIntervalMinutes: ts.pollIntervalMinutes,
        timezoneExpected: ts.timezoneExpected, pinnedTimezone: ts.pinnedTimezone, timezoneAutoFix: ts.timezoneAutoFix,
      },
      onedrive: {
        id: od.id, silentAccountConfig: od.silentAccountConfig, filesOnDemand: od.filesOnDemand,
        kfmSilentOptIn: od.kfmSilentOptIn, kfmFolders: od.kfmFolders, kfmBlockOptOut: od.kfmBlockOptOut,
        tenantAssociationId: od.tenantAssociationId, restartOnChange: od.restartOnChange,
      },
    })
    .from(configPolicyAssignments)
    .innerJoin(configurationPolicies, and(
      eq(configPolicyAssignments.configPolicyId, configurationPolicies.id),
      eq(configurationPolicies.status, 'active'),
    ))
    .leftJoin(link, and(
      eq(link.configPolicyId, configurationPolicies.id),
      inArray(link.featureType, [...POLICY_SET_FEATURE_TYPES]),
    ))
    .leftJoin(ev, and(eq(ev.featureLinkId, link.id), eq(link.featureType, 'event_log')))
    .leftJoin(hw, and(eq(hw.featureLinkId, link.id), eq(link.featureType, 'hardware_monitoring')))
    .leftJoin(pt, and(eq(pt.featureLinkId, link.id), eq(link.featureType, 'patch')))
    .leftJoin(ts, and(eq(ts.featureLinkId, link.id), eq(link.featureType, 'time_sync')))
    .leftJoin(od, and(eq(od.featureLinkId, link.id), eq(link.featureType, 'onedrive_helper')))
    .where(and(ownership, or(...targets)))
    .orderBy(asc(configPolicyAssignments.createdAt), asc(configPolicyAssignments.id), asc(link.featureType));
}

export function groupPolicySetRows(hierarchy: DeviceHierarchy, rows: readonly PolicySetRow[]): DevicePolicySet {
  const byAssignment = new Map<string, { row: PolicySetRow; links: Partial<Record<PolicySetFeatureType, PolicySetLink>> }>();
  for (const row of rows) {
    let entry = byAssignment.get(row.assignmentId);
    if (!entry) {
      entry = { row, links: {} };
      byAssignment.set(row.assignmentId, entry);
    }
    if (row.linkId === null || row.featureType === null) continue;
    if (entry.links[row.featureType]) {
      // Not reachable: (config_policy_id, feature_type) is unique and the view
      // only inherits a type the child lacks. Throwing takes the heartbeat's
      // set-error path (resolvers read their own), never a silent pick.
      throw new Error(`device policy set: two effective ${row.featureType} links for assignment ${row.assignmentId}`);
    }
    entry.links[row.featureType] = Object.freeze({
      id: row.linkId,
      featureType: row.featureType,
      featurePolicyId: row.featurePolicyId,
      inlineSettings: row.inlineSettings,
      eventLog: row.eventLog,
      hardwareMonitoring: row.hardwareMonitoring,
      patch: row.patch,
      timeSync: row.timeSync,
      onedrive: row.onedrive,
    });
  }
  const candidates = [...byAssignment.values()].map(({ row, links }) => Object.freeze({
    assignmentId: row.assignmentId,
    level: row.level,
    targetId: row.targetId,
    priority: row.priority,
    roleFilter: row.roleFilter,
    osFilter: row.osFilter,
    assignmentCreatedAt: row.assignmentCreatedAt,
    policyId: row.policyId,
    policyName: row.policyName,
    policyOrgId: row.policyOrgId,
    policyPartnerId: row.policyPartnerId,
    parentPolicyId: row.parentPolicyId,
    links: Object.freeze(links),
  }));
  return Object.freeze({ deviceId: hierarchy.deviceId, hierarchy, candidates: Object.freeze(candidates) });
}

// ---------------------------------------------------------------- guard

export interface DevicePolicySetOpts extends DeviceHierarchyOpts {
  policySet?: DevicePolicySet;
}

export class DevicePolicySetMismatchError extends Error {
  constructor(readonly setDeviceId: string, readonly resolverDeviceId: string) {
    super(`device policy set for ${setDeviceId} was passed to a resolver for ${resolverDeviceId}`);
    this.name = 'DevicePolicySetMismatchError';
  }
}

/** The caller's set for `deviceId`, or undefined to make the resolver read its own. */
export function policySetFor(deviceId: string, opts: DevicePolicySetOpts | undefined): DevicePolicySet | undefined {
  const set = opts?.policySet;
  if (!set) return undefined;
  if (set.deviceId !== deviceId || set.hierarchy.deviceId !== deviceId) {
    throw new DevicePolicySetMismatchError(set.deviceId, deviceId);
  }
  if (opts?.hierarchy && opts.hierarchy !== set.hierarchy) {
    throw new DevicePolicySetMismatchError(set.deviceId, deviceId);
  }
  return set;
}

export function withPolicySet(set: DevicePolicySet | null, hierarchy: DeviceHierarchy | null): DevicePolicySetOpts | undefined {
  if (set) return { hierarchy: set.hierarchy, policySet: set };
  return hierarchy ? { hierarchy } : undefined;
}

// ------------------------------------------------------------ selectors

export interface ApplicabilityRule {
  /** Whose partner-wide policies the resolver admits. */
  ownership: 'orgOrPartner' | 'orgOrPartnerUnlessUnassignedPool' | 'orgOnly';
  /** Whether a `level='partner'` assignment targets this device. */
  partnerTarget: 'partner' | 'partnerUnlessUnassignedPool' | 'partnerUnlessQuickSupportOrUnassignedPool';
  /** 'sql' = the resolver's buildRoleOsFilterConditions predicate. */
  roleOs: 'none' | 'sql';
}

/** Exactly `(filter IS NULL OR $v = ANY(filter))` for role and OS. */
export function sqlRoleOsMatch(
  c: { roleFilter: readonly string[] | null; osFilter: readonly string[] | null },
  device: { deviceRole: string | null; osType: string | null },
): boolean {
  const roleOk = c.roleFilter === null || (device.deviceRole !== null && c.roleFilter.includes(device.deviceRole));
  const osOk = c.osFilter === null || (device.osType !== null && c.osFilter.includes(device.osType));
  return roleOk && osOk;
}

export function applicableCandidates(set: DevicePolicySet, rule: ApplicabilityRule): PolicyCandidate[] {
  const h = set.hierarchy;
  const rawPartner = h.org?.partnerId ?? null;
  const orgType = h.org?.type;
  const ownerPartner = rule.ownership === 'orgOnly'
    ? null
    : rule.ownership === 'orgOrPartnerUnlessUnassignedPool' && isUnassignedPoolOrgType(orgType) ? null : rawPartner;
  const targetPartner = rule.partnerTarget === 'partner'
    ? rawPartner
    : rule.partnerTarget === 'partnerUnlessUnassignedPool'
      ? (isUnassignedPoolOrgType(orgType) ? null : rawPartner)
      : (isQuickSupportOrgType(orgType) || isUnassignedPoolOrgType(orgType) ? null : rawPartner);

  return set.candidates.filter((c) => {
    const owned = c.policyOrgId === h.orgId
      || (ownerPartner !== null && c.policyOrgId === null && c.policyPartnerId === ownerPartner);
    if (!owned) return false;
    const targeted =
      (c.level === 'device' && c.targetId === h.deviceId)
      || (c.level === 'site' && c.targetId === h.siteId)
      || (c.level === 'organization' && c.targetId === h.orgId)
      || (c.level === 'device_group' && h.groupIds.includes(c.targetId))
      || (c.level === 'partner' && targetPartner !== null && c.targetId === targetPartner);
    if (!targeted) return false;
    return rule.roleOs === 'none' || sqlRoleOsMatch(c, h);
  });
}

export function candidatesWithLink(
  set: DevicePolicySet,
  featureType: PolicySetFeatureType,
  rule: ApplicabilityRule,
): Array<{ candidate: PolicyCandidate; link: PolicySetLink }> {
  return applicableCandidates(set, rule).flatMap((candidate) => {
    const link = candidate.links[featureType];
    return link ? [{ candidate, link }] : [];
  });
}
