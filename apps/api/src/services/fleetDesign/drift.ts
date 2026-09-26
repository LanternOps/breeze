/**
 * Fleet Design drift (Fleet Designer W05, #5655; spec §4.12).
 *
 * A scheduled design run that follows an APPLIED one reports how the live
 * fleet has moved away from the approved design. The comparison is
 * deterministic and server-side — the model never computes it:
 *
 *   approved  = the newest report run for the org with at least one
 *               `applied`, non-rolled-back `policy` ledger row, rebuilt from
 *               that run's ledger (`fleet_design_applied_items`) plus its
 *               stored outcome (`report_runs.result.summary.fleetDesign`);
 *   live      = the org's configuration policies (watches, rules,
 *               assignments) and the function groups' memberships, loaded
 *               UNBOUNDED by id so the byte-capped evidence bundle can never
 *               make an applied policy look "missing";
 *   drift     = `computeDrift(approved, live)` → `{ missing, extra, changed }`.
 *
 * What counts as `extra` is deliberately narrow so a quarterly report is not
 * a wall of noise: an item on a policy the design itself created, an item
 * the design retired that is live again, or an item on an ORG policy created
 * after the design was applied. Pre-existing policies the designer chose not
 * to retire are the technician's, not drift. Partner-wide policies are never
 * an org design's to own.
 *
 * Nothing here writes. A scheduled design run cannot reach the apply
 * service (the W01 contract test proves the profile's reachable tools).
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FleetDesignDrift, FleetDesignOutcome, FleetDesignReportSummary } from '@breeze/shared';
import { db } from '../../db';
import { deviceGroupMemberships, fleetDesignAppliedItems, reportRuns } from '../../db/schema';

export interface ApprovedDesignWatch { watchType: string; name: string; enabled: boolean }
export interface ApprovedDesignRule { name: string; severity: string; cooldownMinutes: number }
export interface ApprovedDesignFunction {
  functionKey: string;
  label: string;
  groupId: string | null;
  policyId: string | null;
  deviceIds: string[];
  watches: ApprovedDesignWatch[];
  rules: ApprovedDesignRule[];
}
export interface ApprovedDesignRetired { kind: 'watch' | 'rule'; policyId: string; policyName: string; itemName: string }

/** The approved design as the ledger recorded it — display fields only. */
export interface ApprovedDesignSummary {
  reportRunId: string;
  appliedAt: string;
  functions: ApprovedDesignFunction[];
  retired: ApprovedDesignRetired[];
}

export interface DriftLivePolicy {
  id: string;
  name: string;
  status: string;
  ownerScope: 'organization' | 'partner';
  createdAt: string | null;
  watches: ApprovedDesignWatch[];
  rules: ApprovedDesignRule[];
}
export interface DriftLiveState {
  policies: DriftLivePolicy[];
  assignments: { policyId: string; level: string; targetId: string; priority: number; roleFilter: string[] | null }[];
  /** group id → device ids, for every group the approved design owns. */
  groupMembers: Record<string, string[]>;
}

type LedgerRowLike = {
  itemRef: string;
  itemKind: string;
  status: string;
  step: number;
  createdRefs: unknown;
  appliedAt: Date | string;
};

const MONITORING_REF = /^monitoring:(.+):(watch|rule):(\d+)$/;

/**
 * A JS array interpolated straight into drizzle's `sql` tag is spread as a
 * list of chunks, not bound as one array parameter — `ANY(${ids})` renders
 * `ANY($1)` with a bare uuid string and Postgres answers "malformed array
 * literal". Build the array literal explicitly (timeSuggestionService.ts
 * does the same).
 */
export function uuidArray(ids: readonly string[]) {
  return ids.length === 0
    ? sql`ARRAY[]::uuid[]`
    : sql`ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::uuid[]`;
}
const RETIRED_REF = /^retired:(\d+)$/;

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Pure: rebuild the approved design from one run's ledger rows and its
 * stored outcome. Only `applied` rows count — rolled-back and failed rows
 * are not part of what was approved. Null when the run carries no applied
 * policy (nothing to drift against).
 */
export function buildApprovedDesign(rows: LedgerRowLike[], outcome: FleetDesignOutcome, reportRunId: string): ApprovedDesignSummary | null {
  const applied = rows.filter((r) => r.status === 'applied');
  if (!applied.some((r) => r.itemKind === 'policy')) return null;

  const byFunction = new Map<string, ApprovedDesignFunction>();
  const ensure = (functionKey: string): ApprovedDesignFunction => {
    let fn = byFunction.get(functionKey);
    if (!fn) {
      const entry = outcome.sections.functions.find((f) => f.functionKey === functionKey);
      fn = {
        functionKey,
        label: entry?.label ?? functionKey,
        groupId: null,
        policyId: null,
        deviceIds: entry?.deviceIds ?? [],
        watches: [],
        rules: [],
      };
      byFunction.set(functionKey, fn);
    }
    return fn;
  };

  let appliedAt = 0;
  for (const row of applied) {
    appliedAt = Math.max(appliedAt, new Date(iso(row.appliedAt)).getTime());
    const refs = (row.createdRefs ?? {}) as Record<string, unknown>;
    if (row.itemKind === 'function' && row.itemRef.startsWith('functions:')) {
      const fn = ensure(row.itemRef.slice('functions:'.length));
      if (typeof refs.groupId === 'string') fn.groupId = refs.groupId;
      if (Array.isArray(refs.membershipSnapshot)) fn.deviceIds = refs.membershipSnapshot.filter((d): d is string => typeof d === 'string');
    } else if (row.itemKind === 'policy' && row.itemRef.startsWith('policy:')) {
      const fn = ensure(row.itemRef.slice('policy:'.length));
      if (typeof refs.policyId === 'string') fn.policyId = refs.policyId;
      if (!fn.groupId && typeof refs.groupId === 'string') fn.groupId = refs.groupId;
    }
  }

  for (const row of applied) {
    if (row.itemKind !== 'watch' && row.itemKind !== 'rule') continue;
    const m = MONITORING_REF.exec(row.itemRef);
    if (!m) continue;
    const [, functionKey, kind, indexText] = m;
    const section = outcome.sections.monitoring.find((s) => s.functionKey === functionKey);
    const index = Number(indexText);
    const fn = ensure(functionKey!);
    if (kind === 'watch') {
      const w = section?.watches[index];
      if (w) fn.watches.push({ watchType: w.watchType, name: w.name, enabled: true });
    } else {
      const r = section?.alertRules[index];
      if (r) fn.rules.push({ name: r.name, severity: r.severity, cooldownMinutes: r.cooldownMinutes });
    }
  }

  const retired: ApprovedDesignRetired[] = [];
  for (const row of applied) {
    if (row.itemKind !== 'retired') continue;
    const m = RETIRED_REF.exec(row.itemRef);
    if (!m) continue;
    const item = outcome.sections.retired[Number(m[1])];
    if (item) retired.push({ kind: item.kind, policyId: item.policyId, policyName: item.policyName, itemName: item.itemName });
  }

  return {
    reportRunId,
    appliedAt: new Date(appliedAt).toISOString(),
    functions: [...byFunction.values()],
    retired,
  };
}

/**
 * The newest applied design for the org: the latest `applied` `policy`
 * ledger row (rolled-back ones excluded by the predicate) names the run.
 */
export async function loadApprovedDesign(orgId: string): Promise<ApprovedDesignSummary | null> {
  const [newest] = await db
    .select({ reportRunId: fleetDesignAppliedItems.reportRunId })
    .from(fleetDesignAppliedItems)
    .where(and(
      eq(fleetDesignAppliedItems.orgId, orgId),
      eq(fleetDesignAppliedItems.itemKind, 'policy'),
      eq(fleetDesignAppliedItems.status, 'applied'),
    ))
    .orderBy(desc(fleetDesignAppliedItems.appliedAt))
    .limit(1);
  if (!newest) return null;

  const rows = await db
    .select()
    .from(fleetDesignAppliedItems)
    .where(and(eq(fleetDesignAppliedItems.reportRunId, newest.reportRunId), eq(fleetDesignAppliedItems.orgId, orgId)));

  const [run] = await db
    .select({ summary: sql<FleetDesignReportSummary | null>`${reportRuns.result}->'summary'` })
    .from(reportRuns)
    .where(eq(reportRuns.id, newest.reportRunId))
    .limit(1);
  const outcome = run?.summary?.fleetDesign?.outcome;
  if (!outcome) return null;

  return buildApprovedDesign(rows as LedgerRowLike[], outcome, newest.reportRunId);
}

type LivePolicyRow = { id: string; name: string; status: string; org_id: string | null; created_at: Date | string | null };
type LiveWatchRow = { policy_id: string; name: string; watch_type: string; enabled: boolean };
type LiveRuleRow = { policy_id: string; name: string; severity: string; cooldown_minutes: number };
type LiveMonitorRow = {
  policy_id: string; name: string; kind: string; condition: unknown;
  severity: string; cooldown_minutes: number; enabled: boolean; item_kind: string | null;
};
type LiveAssignmentRow = { policy_id: string; level: string; target_id: string; priority: number; role_filter: string[] | null };

/**
 * The org's live configuration as the drift comparison needs it. Every
 * statement carries the org predicate; partner-wide rows are read only so
 * the approved design's own policy is found even if a technician moved it.
 */
export async function loadDriftLiveState(orgId: string, approved: ApprovedDesignSummary): Promise<DriftLiveState> {
  const ownPolicyIds = approved.functions.map((f) => f.policyId).filter((id): id is string => typeof id === 'string');
  const retiredPolicyIds = approved.retired.map((r) => r.policyId);
  const pinned = [...new Set([...ownPolicyIds, ...retiredPolicyIds])];
  // Pinned ids come from THIS org's own ledger, so the only legitimate way one
  // of them is not `org_id = $org` is a partner-wide row (`org_id IS NULL`).
  // Never a bare id match: that would let a foreign org's row through.
  const pinnedPredicate = pinned.length > 0 ? sql`OR (cp.id = ANY(${uuidArray(pinned)}) AND cp.org_id IS NULL)` : sql``;

  const policies = await db.execute<LivePolicyRow>(sql`
    SELECT cp.id, cp.name, cp.status::text AS status, cp.org_id, cp.created_at
    FROM configuration_policies cp
    WHERE (cp.org_id = ${orgId} ${pinnedPredicate}) AND cp.status <> 'archived'
  `);
  const policyRows = [...policies];
  const policyIds = policyRows.map((p) => p.id);

  const watches: LiveWatchRow[] = [];
  const rules: LiveRuleRow[] = [];
  // W05c2 (#6371): Fleet Design now applies watches and rules as monitor
  // attachments. Classify each attached definition by the LEDGER item kind
  // that created it (a service definition can come from a rule proposal);
  // an attachment no design item created is classified by its definition
  // kind — service/process as a watch, anything else as a rule.
  const monitorRows = policyIds.length === 0 ? [] : [...await db.execute<LiveMonitorRow>(sql`
    SELECT fl.config_policy_id AS policy_id, md.name, md.kind::text AS kind, md.condition,
           md.severity::text AS severity, md.cooldown_minutes,
           (md.enabled AND pm.enabled) AS enabled, origin.item_kind
      FROM config_policy_monitors pm
      JOIN config_policy_feature_links fl ON fl.id = pm.feature_link_id AND fl.config_policy_id = ANY(${uuidArray(policyIds)})
      JOIN monitor_definitions md ON md.id = pm.monitor_id
      LEFT JOIN LATERAL (
        SELECT li.item_kind FROM fleet_design_applied_items li
         WHERE li.org_id = ${orgId} AND li.status = 'applied'
           AND li.item_kind IN ('watch', 'rule')
           AND li.created_refs->>'monitorId' = md.id::text
         ORDER BY li.applied_at DESC LIMIT 1
      ) origin ON true
  `)];
  for (const monitor of monitorRows) {
    const isWatch = monitor.item_kind
      ? monitor.item_kind === 'watch'
      : monitor.kind === 'service' || monitor.kind === 'process';
    if (isWatch) {
      const condition = (monitor.condition ?? {}) as Record<string, unknown>;
      watches.push({
        policy_id: monitor.policy_id,
        name: String(condition.serviceName ?? condition.processName ?? monitor.name),
        watch_type: monitor.kind,
        enabled: monitor.enabled,
      });
    } else {
      rules.push({ policy_id: monitor.policy_id, name: monitor.name, severity: monitor.severity, cooldown_minutes: monitor.cooldown_minutes });
    }
  }
  const assignments = policyIds.length === 0 ? [] : [...await db.execute<LiveAssignmentRow>(sql`
    SELECT a.config_policy_id AS policy_id, a.level::text AS level, a.target_id::text AS target_id, a.priority, a.role_filter
    FROM config_policy_assignments a
    WHERE a.config_policy_id = ANY(${uuidArray(policyIds)})
  `)];

  const watchesByPolicy = new Map<string, ApprovedDesignWatch[]>();
  for (const w of watches) {
    const list = watchesByPolicy.get(w.policy_id) ?? [];
    list.push({ watchType: w.watch_type, name: w.name, enabled: w.enabled });
    watchesByPolicy.set(w.policy_id, list);
  }
  const rulesByPolicy = new Map<string, ApprovedDesignRule[]>();
  for (const r of rules) {
    const list = rulesByPolicy.get(r.policy_id) ?? [];
    list.push({ name: r.name, severity: r.severity, cooldownMinutes: r.cooldown_minutes });
    rulesByPolicy.set(r.policy_id, list);
  }

  const groupIds = approved.functions.map((f) => f.groupId).filter((id): id is string => typeof id === 'string');
  const groupMembers: Record<string, string[]> = {};
  for (const id of groupIds) groupMembers[id] = [];
  if (groupIds.length > 0) {
    const members = await db
      .select({ groupId: deviceGroupMemberships.groupId, deviceId: deviceGroupMemberships.deviceId })
      .from(deviceGroupMemberships)
      .where(and(eq(deviceGroupMemberships.orgId, orgId), inArray(deviceGroupMemberships.groupId, groupIds)));
    for (const m of members) (groupMembers[m.groupId] ??= []).push(m.deviceId);
  }

  return {
    policies: policyRows.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      ownerScope: p.org_id ? 'organization' : 'partner',
      createdAt: p.created_at ? iso(p.created_at) : null,
      watches: watchesByPolicy.get(p.id) ?? [],
      rules: rulesByPolicy.get(p.id) ?? [],
    })),
    assignments: assignments.map((a) => ({ policyId: a.policy_id, level: a.level, targetId: a.target_id, priority: a.priority, roleFilter: a.role_filter })),
    groupMembers,
  };
}

/** Devices a policy reaches through its assignments (group-level only — the design assigns by group). */
function assignedDeviceCount(policyId: string, live: DriftLiveState): number {
  const ids = new Set<string>();
  for (const a of live.assignments) {
    if (a.policyId !== policyId || a.level !== 'device_group') continue;
    for (const d of live.groupMembers[a.targetId] ?? []) ids.add(d);
  }
  return ids.size;
}

/** Pure diff of the approved design against the live state. */
export function computeDrift(approved: ApprovedDesignSummary, live: DriftLiveState): FleetDesignDrift {
  const drift: FleetDesignDrift = { approvedReportRunId: approved.reportRunId, appliedAt: approved.appliedAt, missing: [], extra: [], changed: [] };
  const policyById = new Map(live.policies.map((p) => [p.id, p]));
  const ownPolicyIds = new Set<string>();

  for (const fn of approved.functions) {
    if (fn.policyId) {
      ownPolicyIds.add(fn.policyId);
      const policy = policyById.get(fn.policyId);
      const policyName = policy?.name ?? fn.label;
      if (!policy) {
        for (const w of fn.watches) drift.missing.push({ functionKey: fn.functionKey, kind: 'watch', name: w.name });
        for (const r of fn.rules) drift.missing.push({ functionKey: fn.functionKey, kind: 'rule', name: r.name });
        drift.missing.push({ functionKey: fn.functionKey, kind: 'assignment', name: policyName });
      } else {
        const approvedWatchKeys = new Set(fn.watches.map((w) => `${w.watchType}:${w.name}`));
        const approvedRuleNames = new Set(fn.rules.map((r) => r.name));
        for (const w of fn.watches) {
          const liveWatch = policy.watches.find((x) => x.watchType === w.watchType && x.name === w.name);
          if (!liveWatch) { drift.missing.push({ functionKey: fn.functionKey, kind: 'watch', name: w.name }); continue; }
          if (liveWatch.enabled !== w.enabled) {
            drift.changed.push({ functionKey: fn.functionKey, kind: 'watch', name: w.name, field: 'enabled', approved: String(w.enabled), live: String(liveWatch.enabled) });
          }
        }
        for (const r of fn.rules) {
          const liveRule = policy.rules.find((x) => x.name === r.name);
          if (!liveRule) { drift.missing.push({ functionKey: fn.functionKey, kind: 'rule', name: r.name }); continue; }
          if (liveRule.severity !== r.severity) {
            drift.changed.push({ functionKey: fn.functionKey, kind: 'rule', name: r.name, field: 'severity', approved: r.severity, live: liveRule.severity });
          }
          if (liveRule.cooldownMinutes !== r.cooldownMinutes) {
            drift.changed.push({ functionKey: fn.functionKey, kind: 'rule', name: r.name, field: 'cooldownMinutes', approved: String(r.cooldownMinutes), live: String(liveRule.cooldownMinutes) });
          }
        }
        const deviceCount = assignedDeviceCount(policy.id, live);
        for (const w of policy.watches) {
          if (!approvedWatchKeys.has(`${w.watchType}:${w.name}`)) drift.extra.push({ policyId: policy.id, policyName: policy.name, kind: 'watch', name: w.name, deviceCount });
        }
        for (const r of policy.rules) {
          if (!approvedRuleNames.has(r.name)) drift.extra.push({ policyId: policy.id, policyName: policy.name, kind: 'rule', name: r.name, deviceCount });
        }
        const assigned = fn.groupId
          ? live.assignments.some((a) => a.policyId === policy.id && a.level === 'device_group' && a.targetId === fn.groupId)
          : live.assignments.some((a) => a.policyId === policy.id);
        if (!assigned) drift.missing.push({ functionKey: fn.functionKey, kind: 'assignment', name: policyName });
      }
    }
    if (fn.groupId) {
      const members = new Set(live.groupMembers[fn.groupId] ?? []);
      for (const d of fn.deviceIds) {
        if (!members.has(d)) drift.missing.push({ functionKey: fn.functionKey, kind: 'group_member', name: d });
      }
    }
  }

  for (const item of approved.retired) {
    const policy = policyById.get(item.policyId);
    if (!policy) continue;
    const liveAgain = item.kind === 'watch'
      ? policy.watches.some((w) => w.name === item.itemName && w.enabled)
      : policy.rules.some((r) => r.name === item.itemName);
    if (liveAgain) drift.extra.push({ policyId: policy.id, policyName: policy.name, kind: item.kind, name: item.itemName, deviceCount: assignedDeviceCount(policy.id, live) });
  }

  const appliedAtMs = new Date(approved.appliedAt).getTime();
  for (const policy of live.policies) {
    if (policy.ownerScope !== 'organization' || ownPolicyIds.has(policy.id)) continue;
    if (!policy.createdAt || new Date(policy.createdAt).getTime() <= appliedAtMs) continue;
    const deviceCount = assignedDeviceCount(policy.id, live);
    for (const w of policy.watches) drift.extra.push({ policyId: policy.id, policyName: policy.name, kind: 'watch', name: w.name, deviceCount });
    for (const r of policy.rules) drift.extra.push({ policyId: policy.id, policyName: policy.name, kind: 'rule', name: r.name, deviceCount });
  }

  return drift;
}
