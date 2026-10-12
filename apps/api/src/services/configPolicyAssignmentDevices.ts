/**
 * Expand ONE config-policy assignment row to the devices it targets, honouring
 * the assignment's role / OS filter (#8442).
 *
 * `config_policy_assignments.target_id` is polymorphic. What it points to
 * depends on `level`: 'device' → devices.id, 'device_group' →
 * device_groups.id, 'site' → sites.id, 'organization' → organizations.id,
 * 'partner' → **partners.id**. The row may also carry `role_filter` /
 * `os_filter`. The per-device effective-policy resolver has always applied
 * those (`buildRoleOsFilterConditions`). The patch scheduler and the
 * update-ring count each had their own copy of this expansion and ignored
 * them. So a workstation-only policy assigned at org level put the org's
 * servers into its scheduled patch jobs, and the ring page counted them too.
 *
 * This is the one patching resolver. Both the scheduler
 * (jobs/patchSchedulerWorker.ts) and the ring count/compliance scope
 * (routes/updateRingsHelpers.ts) call it, so the two cannot drift apart again.
 * The filter is applied with `matchesRoleOsFilter`, the predicate the backup
 * bulk resolver uses (#6001). It mirrors the per-device SQL predicate exactly:
 * a NULL filter matches every device, `[]` matches none, and a device without
 * a role or OS never matches a non-null filter. It applies at every level,
 * device-level included, just as the per-device resolver's WHERE clause does.
 *
 * Quick Support exclusion: ephemeral devices (`devices.isEphemeral`) live in the
 * hidden per-partner 'quick_support' org. Every branch that resolves a SET of
 * devices excludes them. The device-level branch is a by-id lookup of a machine
 * an operator chose, so it does not.
 */
import { and, eq, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { deviceGroupMemberships, deviceGroups, devices, organizations } from '../db/schema';
import {
  auditRefusedExecutionGroups,
  resolveExecutionSafeGroupIds,
  type RefusedExecutionGroup,
} from './executionTargetGating';
import { matchesRoleOsFilter, type RoleOsFilterable } from './featureConfigResolver';
import { notHoldingOrgCondition } from './unassignedPool/selectorPredicate';

/** An assignment row as the expansion needs it. The filters are REQUIRED keys: forgetting them was #8442. */
export interface AssignmentToExpand {
  level: string;
  targetId: string;
  roleFilter: RoleOsFilterable['roleFilter'];
  osFilter: RoleOsFilterable['osFilter'];
}

export interface AssignmentExpansionScope {
  /**
   * The owning policy's org. It is null for a partner-owned library policy
   * (#1724/#2280), which has no single owning org and can carry a
   * partner-level assignment and/or subset assignments into several of the
   * partner's orgs. When it is set, every level is clamped to it as
   * defense-in-depth. That includes a legacy org-owned policy that still
   * carries a partner-level assignment, which is now rejected at assign time.
   */
  policyOrgId: string | null;
  /**
   * The owning policy's partner. It is used only when policyOrgId is null, to
   * re-clamp subset levels (org/site/group/device) to the partner on every run.
   * The assign-time target check (validateAssignmentTarget) is a point-in-time
   * snapshot: an org later reparented to another partner would otherwise keep
   * resolving through the stale row (TOCTOU, #2280).
   */
  policyPartnerId: string | null;
  /**
   * The update-ring clamp. When this is set, every subset-level device must
   * also sit under this partner and outside its holding org. Callers that read
   * through a system-scope context (unrestricted accessible_org_ids) then get
   * a scope-independent result. The patch scheduler leaves it unset.
   */
  requirePartnerId?: string;
}

export interface AssignmentExpansionOptions {
  /**
   * What to do with a device_group whose dynamic rules key on an
   * execution-refused, agent-reported field (hostname, tags, deviceRole,
   * custom.*, ...).
   *  - 'resolve': patch SCHEDULING is protective (CONFIG_POLICY_FEATURE_TRUST_TIER).
   *    A device that misreports its own fields gains nothing from being patched
   *    more, and a hostname- or tag-keyed patch ring is a standard MSP pattern.
   *    The refusal is still audited.
   *  - 'exclude': update-ring counts and compliance leave the group out and
   *    surface a warning.
   */
  refusedGroups: 'resolve' | 'exclude';
  /** Audit action recorded for a refused group. */
  auditAction: string;
}

export interface ExpandedAssignment {
  deviceIds: string[];
  refusedGroups: RefusedExecutionGroup[];
}

type CandidateRow = { id: string; deviceRole: string | null; osType: string | null };

const candidateColumns = {
  id: devices.id,
  deviceRole: devices.deviceRole,
  osType: devices.osType,
};

/**
 * The partner-level ("all organizations") predicate. targetId is a PARTNER id,
 * so devices are reached through their org's `partner_id` and never through
 * `devices.org_id` (#3954). Exported so a unit test can pin the compiled SQL;
 * a Drizzle mock that ignores `.where()` cannot catch that regression.
 */
export function buildPartnerLevelCondition(partnerTargetId: string, policyOrgId: string | null): SQL {
  const conditions: SQL[] = [
    eq(organizations.partnerId, partnerTargetId),
    eq(devices.isEphemeral, false),
    // Never a device parked in the partner's holding org.
    notHoldingOrgCondition(),
  ];
  // Legacy backstop: an org-owned policy carrying a partner-level assignment
  // clamps to its own org.
  if (policyOrgId) conditions.push(eq(devices.orgId, policyOrgId));
  return and(...conditions)!;
}

/**
 * The clamp applied to every subset level. Every subset query joins
 * `organizations` on the DEVICE's org, so these conditions are evaluated
 * against the org the device actually sits in.
 */
function subsetClampConditions(scope: AssignmentExpansionScope): SQL[] {
  const conditions: SQL[] = [];
  if (scope.policyOrgId) {
    conditions.push(eq(devices.orgId, scope.policyOrgId));
  } else if (scope.policyPartnerId) {
    conditions.push(eq(organizations.partnerId, scope.policyPartnerId));
  }
  if (scope.requirePartnerId) {
    conditions.push(eq(organizations.partnerId, scope.requirePartnerId), notHoldingOrgCondition());
  }
  return conditions;
}

async function selectCandidates(
  assignment: AssignmentToExpand,
  scope: AssignmentExpansionScope,
  options: AssignmentExpansionOptions,
): Promise<{ rows: CandidateRow[]; refusedGroups: RefusedExecutionGroup[] }> {
  const { level, targetId } = assignment;

  if (level === 'partner') {
    // NOTE: this does NOT filter organizations by billing status, unlike the
    // auth-layer visibility scope. Patching a device is a security action that
    // should keep running for an org in a lapsed billing state.
    const rows = await db
      .select(candidateColumns)
      .from(devices)
      .innerJoin(organizations, eq(devices.orgId, organizations.id))
      .where(buildPartnerLevelCondition(targetId, scope.policyOrgId));
    return { rows, refusedGroups: [] };
  }

  const clamp = subsetClampConditions(scope);

  switch (level) {
    case 'device': {
      const rows = await db
        .select(candidateColumns)
        .from(devices)
        .innerJoin(organizations, eq(devices.orgId, organizations.id))
        .where(and(eq(devices.id, targetId), ...clamp))
        .limit(1);
      return { rows, refusedGroups: [] };
    }

    case 'device_group': {
      const { refusedGroups } = await resolveExecutionSafeGroupIds([targetId]);
      if (refusedGroups.length > 0) {
        auditRefusedExecutionGroups(scope.policyOrgId, options.auditAction, refusedGroups);
        if (options.refusedGroups === 'exclude') return { rows: [], refusedGroups };
      }
      // #3182 — the group id is dereferenced through device_group_memberships,
      // so both joins carry an org-equality condition, not a bare id match:
      // group.org_id = membership.org_id = device.org_id. A membership row
      // could name a group in another org until #3182's composite FK landed (a
      // cross-org device move produced exactly that shape), and the scheduler
      // runs under a system DB context with no RLS behind it. The query must
      // reject that shape on its own, without relying on the constraint.
      const rows = await db
        .select(candidateColumns)
        .from(deviceGroupMemberships)
        .innerJoin(
          deviceGroups,
          and(
            eq(deviceGroupMemberships.groupId, deviceGroups.id),
            eq(deviceGroups.orgId, deviceGroupMemberships.orgId),
          ),
        )
        .innerJoin(
          devices,
          and(
            eq(deviceGroupMemberships.deviceId, devices.id),
            eq(devices.orgId, deviceGroupMemberships.orgId),
          ),
        )
        .innerJoin(organizations, eq(devices.orgId, organizations.id))
        .where(and(eq(deviceGroupMemberships.groupId, targetId), eq(devices.isEphemeral, false), ...clamp));
      return { rows, refusedGroups };
    }

    case 'site':
    case 'organization': {
      const targetCondition = level === 'site' ? eq(devices.siteId, targetId) : eq(devices.orgId, targetId);
      const rows = await db
        .select(candidateColumns)
        .from(devices)
        .innerJoin(organizations, eq(devices.orgId, organizations.id))
        .where(and(targetCondition, eq(devices.isEphemeral, false), ...clamp));
      return { rows, refusedGroups: [] };
    }

    default:
      return { rows: [], refusedGroups: [] };
  }
}

/**
 * Resolve the devices one assignment targets, after its role / OS filter.
 * Returns de-duplicated device ids, plus any refused dynamic groups so a
 * caller can surface a warning.
 */
export async function resolveAssignmentDevices(
  assignment: AssignmentToExpand,
  scope: AssignmentExpansionScope,
  options: AssignmentExpansionOptions,
): Promise<ExpandedAssignment> {
  const { rows, refusedGroups } = await selectCandidates(assignment, scope, options);
  const deviceIds = new Set<string>();
  for (const row of rows) {
    if (matchesRoleOsFilter(assignment, row)) deviceIds.add(row.id);
  }
  return { deviceIds: [...deviceIds], refusedGroups };
}
