/**
 * "Outranked on N devices", per feature (#12472, plan W05a O1).
 *
 * For each feature a configuration policy has in effect (its own links, or its
 * parent's, through `config_policy_effective_feature_links`), on how many of
 * the devices the policy's own rows reach does ANOTHER policy win that
 * feature?
 *
 * SEMANTICS
 *  - `reached`: distinct devices the policy's own assignment rows reach (the
 *    W02a `direct` set), inside the caller's ceiling. The same for every feature.
 *  - A device parked in its partner's holding org takes no MSP-owned policy
 *    (the resolver drops its partner), so on it neither this policy's nor a
 *    competitor's MSP-owned rows decide anything. It still counts as reached,
 *    as in reach.
 *  - `outranked`: those of them where `resolveEffectiveConfig` would pick a
 *    different policy for the feature. The order is the resolver's own: level
 *    (device › device group › site › organization › all organizations), then
 *    priority ascending, then assignment age. A full tie is not counted: the
 *    resolver's order there is undefined, so it is not "another policy wins".
 *  - The policy's own status is ignored (owner decision Q6: an inactive policy
 *    is evaluated as if it were active). Competitors must be `active`, as in the
 *    resolver, and the policy never competes with itself.
 *  - A device reaches a policy's EXECUTION-GATED feature only through rows that
 *    are not a refused dynamic group, exactly as the resolver drops such rows
 *    (see `resolveEffectiveConfigWithExecutor`, step 5b). So on a gated feature
 *    a refused group of this policy delivers nothing (any competitor wins), and
 *    a competitor's refused group never wins.
 *
 * WHAT IT REVEALS. Counts only: no competitor policy id, name, target or row
 * ever leaves this function. Competitors are read under RLS alone, with no
 * `policyAccessCondition`, because a policy the caller may not list (an
 * MSP-managed one, for an organization tech) still really wins on the caller's
 * devices. The number is about the policy the caller asked for, on devices the
 * caller can see. That is the caller's own policy, or, since read scoping
 * (W03a), an MSP-managed policy that applies to the caller's organization: the
 * route reads it with `{ access: 'read' }`, so an organization caller can ask
 * for it. Reach and the caller's site ceiling / device pin decide which
 * devices are counted (`callerMaySeeDevice`, shared with reach), before any
 * cap is compared.
 *
 * TENANCY. Every statement runs on the ambient `db`, in the caller's request
 * context (`withDbAccessContext`) under forced RLS: never a system context and
 * never the resolver's partner-visibility widening. The partner-wide SELECT
 * branches make an organization caller's own partner's policies legible.
 *
 * ONE RESOLVER (plan D11). Rows are expanded with the W02a
 * `expandAssignmentsToDevices`, the shared resolver with the per-request memo,
 * under each row's OWN policy's owner clamp.
 *
 * COST (bounded). Six fixed reads (policy, features, own rows, the device read
 * over the reach, the competitor rows, the group gating), then one expansion
 * per distinct (row, owner) key, all charged to one REACH_STATEMENT_BUDGET.
 * Competitor rows are read only where they can touch a reached device (the
 * device, site, organization, partner or group of one), at most
 * PRECEDENCE_COMPETITOR_ROW_LIMIT of them, and a row that cannot beat this
 * policy's weakest own row is never expanded. Past any bound (the budget, the
 * row limit, or PRECEDENCE_SCAN_CAP reached devices) the answer is
 * `{ capped: true }`: an incomplete scan would undercount, so no numbers are
 * returned at all.
 */
import { and, eq, inArray, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import {
  configPolicyAssignments,
  configPolicyEffectiveFeatureLinks,
  configurationPolicies,
  deviceGroupMemberships,
  devices,
  organizations,
} from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import type { AssignmentExpansionScope, AssignmentToExpand } from './configPolicyAssignmentDevices';
import {
  REACH_STATEMENT_BUDGET,
  callerMaySeeDevice,
  expandAssignmentsToDevices,
  type ReachBudget,
} from './configPolicyReach';
import {
  RETIRED_CONFIG_FEATURE_TYPES,
  isExecutionGatedFeatureType,
  type ConfigFeatureType,
} from './configFeatureTypes';
import { resolveExecutionSafeGroupIds } from './executionTargetGating';
import { isUnassignedPoolOrgType } from './unassignedPool/orgType';

/** Past this many reached devices (inside the caller's ceiling) the answer is `capped`. */
export const PRECEDENCE_SCAN_CAP = 5000;

/** The most competitor assignment rows one request reads. Past it, `capped`. */
export const PRECEDENCE_COMPETITOR_ROW_LIMIT = 500;

export interface FeaturePrecedence {
  reached: number;
  outranked: number;
}

export type PolicyPrecedence =
  | { capped: true }
  | { capped: false; features: Partial<Record<ConfigFeatureType, FeaturePrecedence>> };

export interface PrecedenceLimits {
  scanCap: number;
  statementBudget: number;
  competitorRowLimit: number;
}

const PRECEDENCE_LIMITS: PrecedenceLimits = {
  scanCap: PRECEDENCE_SCAN_CAP,
  statementBudget: REACH_STATEMENT_BUDGET,
  competitorRowLimit: PRECEDENCE_COMPETITOR_ROW_LIMIT,
};

/** Policy, features, own rows, the device read, the competitor rows, the group gating. */
const FIXED_READS = 6;

/**
 * The resolver's level order (`LEVEL_PRIORITY` in configurationPolicy.ts,
 * `resolveEffectiveConfigWithExecutor` step 6). The parity integration test
 * pins the two together.
 */
const LEVEL_RANK: Record<string, number> = {
  device: 5,
  device_group: 4,
  site: 3,
  organization: 2,
  partner: 1,
};

interface RankedRow {
  level: string;
  priority: number;
  createdAt: Date;
}

/** True when `a` is strictly ahead of `b` in the resolver's order. */
function outranks(a: RankedRow, b: RankedRow): boolean {
  const levelDiff = (LEVEL_RANK[a.level] ?? 0) - (LEVEL_RANK[b.level] ?? 0);
  if (levelDiff !== 0) return levelDiff > 0;
  if (a.priority !== b.priority) return a.priority < b.priority;
  return a.createdAt.getTime() < b.createdAt.getTime();
}

type OwnRow = AssignmentToExpand & RankedRow & { id: string };
type CompetitorRow = OwnRow & {
  configPolicyId: string;
  policyOrgId: string | null;
  policyPartnerId: string | null;
  featureTypes: string[];
};

const CAPPED: PolicyPrecedence = { capped: true };

function uuidArray(ids: Iterable<string>): SQL {
  return sql`${sql.param([...ids])}::uuid[]`;
}

/**
 * Per feature, where another policy wins on the devices this policy reaches.
 * `null` when the caller's context cannot read the policy. See the header for
 * the semantics and the bound; `limits` exists for tests.
 */
export async function computePolicyPrecedence(
  auth: AuthContext,
  policyId: string,
  limits: Partial<PrecedenceLimits> = {},
): Promise<PolicyPrecedence | null> {
  const { scanCap, statementBudget, competitorRowLimit } = { ...PRECEDENCE_LIMITS, ...limits };

  const [policy] = await db
    .select({ id: configurationPolicies.id, orgId: configurationPolicies.orgId, partnerId: configurationPolicies.partnerId })
    .from(configurationPolicies)
    .where(eq(configurationPolicies.id, policyId))
    .limit(1);
  if (!policy) return null;

  const featureRows = await db
    .selectDistinct({ featureType: configPolicyEffectiveFeatureLinks.featureType })
    .from(configPolicyEffectiveFeatureLinks)
    .where(and(
      eq(configPolicyEffectiveFeatureLinks.configPolicyId, policyId),
      notInArray(configPolicyEffectiveFeatureLinks.featureType, [...RETIRED_CONFIG_FEATURE_TYPES]),
    ));
  const features = featureRows.map((row) => row.featureType as ConfigFeatureType);
  if (features.length === 0) return { capped: false, features: {} };

  const counts = (reached: number, outranked: Map<ConfigFeatureType, Set<string>> = new Map()): PolicyPrecedence => ({
    capped: false,
    features: Object.fromEntries(
      features.map((ft) => [ft, { reached, outranked: outranked.get(ft)?.size ?? 0 }]),
    ) as Partial<Record<ConfigFeatureType, FeaturePrecedence>>,
  });

  const ownRows: OwnRow[] = await db
    .select({
      id: configPolicyAssignments.id,
      level: configPolicyAssignments.level,
      targetId: configPolicyAssignments.targetId,
      roleFilter: configPolicyAssignments.roleFilter,
      osFilter: configPolicyAssignments.osFilter,
      priority: configPolicyAssignments.priority,
      createdAt: configPolicyAssignments.createdAt,
    })
    .from(configPolicyAssignments)
    .where(eq(configPolicyAssignments.configPolicyId, policyId))
    .orderBy(configPolicyAssignments.id);
  if (ownRows.length === 0) return counts(0);

  const memo = new Map<string, string[]>();
  const budget: ReachBudget = { remaining: statementBudget - FIXED_READS };
  const ownScope: AssignmentExpansionScope = { policyOrgId: policy.orgId, policyPartnerId: policy.partnerId };

  // One row at a time: the best own row per device needs each row's own set.
  const ownDevices = new Map<string, Set<string>>();
  for (const row of ownRows) {
    const { deviceIds, complete } = await expandAssignmentsToDevices([row], ownScope, memo, budget);
    if (!complete) return CAPPED;
    ownDevices.set(row.id, deviceIds);
  }

  const union = new Set<string>();
  for (const ids of ownDevices.values()) for (const id of ids) union.add(id);
  // The final say on which devices count: RLS, then the caller's site ceiling
  // and device pin. One array parameter, as in reach.
  // It also says which devices are parked in their partner's holding org: the
  // resolver delivers no MSP-owned policy to those (it drops the device's
  // partner), so an MSP-owned row never decides a feature there.
  const visible = new Map<string, { orgId: string; siteId: string | null }>();
  const parked = new Set<string>();
  if (union.size > 0) {
    const rows = await db
      .select({ id: devices.id, orgId: devices.orgId, siteId: devices.siteId, orgType: organizations.type })
      .from(devices)
      .innerJoin(organizations, eq(devices.orgId, organizations.id))
      .where(sql`${devices.id} = ANY(${uuidArray(union)})`);
    for (const row of rows) {
      if (!callerMaySeeDevice(auth, row.id, row.siteId)) continue;
      visible.set(row.id, { orgId: row.orgId, siteId: row.siteId });
      if (isUnassignedPoolOrgType(row.orgType)) parked.add(row.id);
    }
  }
  /** Whether a row of a policy with this owner can decide a feature on this device. */
  const deliversTo = (policyOrgId: string | null, deviceId: string) =>
    visible.has(deviceId) && (policyOrgId !== null || !parked.has(deviceId));
  if (visible.size > scanCap) return CAPPED;
  if (visible.size === 0) return counts(0);

  const deviceIds = [...visible.keys()];
  const siteIds = [...new Set([...visible.values()].flatMap((d) => (d.siteId ? [d.siteId] : [])))];
  const orgIds = [...new Set([...visible.values()].map((d) => d.orgId))];

  // Only rows that can touch a reached device. Read under RLS alone (see the
  // header): no policyAccessCondition.
  const touchesReach = or(
    and(eq(configPolicyAssignments.level, 'device'), sql`${configPolicyAssignments.targetId} = ANY(${uuidArray(deviceIds)})`),
    and(eq(configPolicyAssignments.level, 'site'), sql`${configPolicyAssignments.targetId} = ANY(${uuidArray(siteIds)})`),
    and(eq(configPolicyAssignments.level, 'organization'), sql`${configPolicyAssignments.targetId} = ANY(${uuidArray(orgIds)})`),
    and(
      eq(configPolicyAssignments.level, 'partner'),
      sql`${configPolicyAssignments.targetId} IN (SELECT ${organizations.partnerId} FROM ${organizations} WHERE ${organizations.id} = ANY(${uuidArray(orgIds)}))`,
    ),
    and(
      eq(configPolicyAssignments.level, 'device_group'),
      sql`${configPolicyAssignments.targetId} IN (SELECT ${deviceGroupMemberships.groupId} FROM ${deviceGroupMemberships} WHERE ${deviceGroupMemberships.deviceId} = ANY(${uuidArray(deviceIds)}))`,
    ),
  );
  const competitorRead: CompetitorRow[] = await db
    .select({
      id: configPolicyAssignments.id,
      configPolicyId: configPolicyAssignments.configPolicyId,
      level: configPolicyAssignments.level,
      targetId: configPolicyAssignments.targetId,
      roleFilter: configPolicyAssignments.roleFilter,
      osFilter: configPolicyAssignments.osFilter,
      priority: configPolicyAssignments.priority,
      createdAt: configPolicyAssignments.createdAt,
      policyOrgId: configurationPolicies.orgId,
      policyPartnerId: configurationPolicies.partnerId,
      featureTypes: sql<string[]>`array_agg(DISTINCT ${configPolicyEffectiveFeatureLinks.featureType}::text)`,
    })
    .from(configPolicyAssignments)
    .innerJoin(configurationPolicies, and(
      eq(configPolicyAssignments.configPolicyId, configurationPolicies.id),
      eq(configurationPolicies.status, 'active'),
      ne(configurationPolicies.id, policyId),
    ))
    .innerJoin(configPolicyEffectiveFeatureLinks, and(
      eq(configPolicyEffectiveFeatureLinks.configPolicyId, configurationPolicies.id),
      inArray(configPolicyEffectiveFeatureLinks.featureType, features),
    ))
    .where(touchesReach)
    .groupBy(configPolicyAssignments.id, configurationPolicies.id)
    .orderBy(configPolicyAssignments.id)
    .limit(competitorRowLimit + 1);
  if (competitorRead.length > competitorRowLimit) return CAPPED;

  const anyGated = features.some((ft) => isExecutionGatedFeatureType(ft));
  const groupTargets = [...ownRows, ...competitorRead]
    .filter((row) => row.level === 'device_group')
    .map((row) => row.targetId);
  const refused = new Set<string>();
  if (anyGated && groupTargets.length > 0) {
    const { refusedGroups } = await resolveExecutionSafeGroupIds(groupTargets);
    for (const group of refusedGroups) refused.add(group.id);
  }
  const isRefused = (row: AssignmentToExpand) => row.level === 'device_group' && refused.has(row.targetId);

  // A competitor that cannot beat the weakest own row cannot beat any device's
  // best own row, unless a device can have no own row at all: a gated feature
  // losing its own rows to the gating, or an MSP-owned policy on a parked device.
  let competitors = competitorRead;
  const ownCanBeAbsent = ownRows.some(isRefused) || (policy.orgId === null && parked.size > 0);
  if (!ownCanBeAbsent) {
    const weakest = ownRows.reduce((worst, row) => (outranks(worst, row) ? row : worst));
    competitors = competitors.filter((row) => outranks(row, weakest));
  }

  const competitorDevices = new Map<string, Set<string>>();
  for (const row of competitors) {
    const { deviceIds: reachedByRow, complete } = await expandAssignmentsToDevices(
      [row],
      { policyOrgId: row.policyOrgId, policyPartnerId: row.policyPartnerId },
      memo,
      budget,
    );
    if (!complete) return CAPPED;
    competitorDevices.set(row.id, reachedByRow);
  }

  // Best own row per visible device: over every row, and over the rows the
  // execution gating keeps (what a gated feature resolves through).
  const bestOwn = new Map<string, OwnRow>();
  const bestOwnUngated = new Map<string, OwnRow>();
  for (const row of ownRows) {
    const rowRefused = isRefused(row);
    for (const deviceId of ownDevices.get(row.id) ?? []) {
      if (!deliversTo(policy.orgId, deviceId)) continue;
      const best = bestOwn.get(deviceId);
      if (!best || outranks(row, best)) bestOwn.set(deviceId, row);
      if (rowRefused) continue;
      const bestUngated = bestOwnUngated.get(deviceId);
      if (!bestUngated || outranks(row, bestUngated)) bestOwnUngated.set(deviceId, row);
    }
  }

  const featureSet = new Set<string>(features);
  const outranked = new Map<ConfigFeatureType, Set<string>>();
  for (const row of competitors) {
    const rowRefused = isRefused(row);
    for (const deviceId of competitorDevices.get(row.id) ?? []) {
      if (!deliversTo(row.policyOrgId, deviceId)) continue;
      for (const raw of row.featureTypes) {
        if (!featureSet.has(raw)) continue;
        const ft = raw as ConfigFeatureType;
        const gated = isExecutionGatedFeatureType(ft);
        if (gated && rowRefused) continue;
        const own = gated ? bestOwnUngated.get(deviceId) : bestOwn.get(deviceId);
        if (own && !outranks(row, own)) continue;
        const bucket = outranked.get(ft) ?? new Set<string>();
        bucket.add(deviceId);
        outranked.set(ft, bucket);
      }
    }
  }

  return counts(visible.size, outranked);
}
