/**
 * The registry and config values an org's agents are asked to collect for
 * policy compliance (#11976, #12130).
 *
 * The heartbeat hands every agent in an org the same probe list
 * (`buildPolicyProbeConfigUpdate`, cached per org). Compliance evaluation reads
 * the values those probes collected (`device_registry_state` /
 * `device_config_state`). A rule whose value is not on the list is never read,
 * so the evaluator asks this module whether a rule's value is collected
 * (`loadCollectedPolicyStateProbes`) and reports such a rule as not assessed
 * instead of as non-compliant.
 *
 * Moved out of routes/agents/helpers.ts so the evaluator can share it without
 * importing the heartbeat helpers. helpers.ts re-exports everything here, so
 * existing import sites and the suites that mock `./helpers` keep working.
 */
import { and, eq, isNull, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '../db';
import {
  automationPolicies,
  configPolicyComplianceRules,
  configPolicyEffectiveFeatureLinks,
  configurationPolicies,
  organizations,
} from '../db/schema';
import type {
  PolicyConfigProbeUpdate,
  PolicyProbeConfigUpdate,
  PolicyRegistryProbeUpdate,
} from '../routes/agents/schemas';
import {
  isAllowedPolicyConfigProbe,
  isAllowedPolicyRegistryProbe,
} from '../routes/agents/policyProbeSafety';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Identity of a registry probe: path and value name, trimmed, case-insensitive. */
export function policyRegistryProbeKey(registryPath: string, valueName: string): string {
  return `${registryPath.trim().toLowerCase()}::${valueName.trim().toLowerCase()}`;
}

/** Identity of a config probe: file path and key, trimmed, case-insensitive. */
export function policyConfigProbeKey(filePath: string, configKey: string): string {
  return `${filePath.trim().toLowerCase()}::${configKey.trim().toLowerCase()}`;
}

/**
 * localeCompare, then code points: localeCompare can tie two distinct strings,
 * and the per-org cap keeps the head of this order, so a tie must not fall
 * back to the order the rows were read in (#11976).
 */
function compareProbeText(left: string, right: string): number {
  const byLocale = left.localeCompare(right);
  if (byLocale !== 0) return byLocale;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function sortPolicyRegistryProbes(probes: PolicyRegistryProbeUpdate[]): PolicyRegistryProbeUpdate[] {
  return [...probes].sort((left, right) => {
    const pathCompare = compareProbeText(left.registry_path, right.registry_path);
    if (pathCompare !== 0) return pathCompare;
    return compareProbeText(left.value_name, right.value_name);
  });
}

export function sortPolicyConfigProbes(probes: PolicyConfigProbeUpdate[]): PolicyConfigProbeUpdate[] {
  return [...probes].sort((left, right) => {
    const pathCompare = compareProbeText(left.file_path, right.file_path);
    if (pathCompare !== 0) return pathCompare;
    return compareProbeText(left.config_key, right.config_key);
  });
}

export function derivePolicyStateProbesFromRules(rules: unknown): {
  registry: PolicyRegistryProbeUpdate[];
  config: PolicyConfigProbeUpdate[];
} {
  if (!Array.isArray(rules)) {
    return { registry: [], config: [] };
  }

  const registryProbes = new Map<string, PolicyRegistryProbeUpdate>();
  const configProbes = new Map<string, PolicyConfigProbeUpdate>();

  for (const rawRule of rules) {
    if (!isObject(rawRule)) {
      continue;
    }

    const type = readTrimmedString(rawRule.type ?? rawRule.name)?.toLowerCase();
    if (type === 'registry_check') {
      const registryPath = readTrimmedString(rawRule.registryPath ?? rawRule.registry_path);
      const valueName = readTrimmedString(rawRule.registryValueName ?? rawRule.registry_value_name);
      if (!registryPath || !valueName || !isAllowedPolicyRegistryProbe(registryPath)) {
        continue;
      }

      const dedupeKey = policyRegistryProbeKey(registryPath, valueName);
      if (!registryProbes.has(dedupeKey)) {
        registryProbes.set(dedupeKey, {
          registry_path: registryPath,
          value_name: valueName
        });
      }
      continue;
    }

    if (type === 'config_check') {
      const filePath = readTrimmedString(rawRule.configFilePath ?? rawRule.config_file_path);
      const configKey = readTrimmedString(rawRule.configKey ?? rawRule.config_key);
      if (!filePath || !configKey || !isAllowedPolicyConfigProbe(filePath, configKey)) {
        continue;
      }

      const dedupeKey = policyConfigProbeKey(filePath, configKey);
      if (!configProbes.has(dedupeKey)) {
        configProbes.set(dedupeKey, {
          file_path: filePath,
          config_key: configKey
        });
      }
    }
  }

  return {
    registry: sortPolicyRegistryProbes(Array.from(registryProbes.values())),
    config: sortPolicyConfigProbes(Array.from(configProbes.values()))
  };
}

/** A row of rules and whether its policy is partner-wide (org_id NULL). */
type ProbeSourceRow = { rules: unknown; ownerOrgId: string | null };

export async function buildPolicyProbeConfigUpdate(
  orgId: string | null | undefined,
  // #8053 W1a-1: the heartbeat passes the org's partner from the hierarchy it
  // loaded. `undefined` = read it here, as before; `null` = no partner.
  opts?: { partnerId?: string | null },
): Promise<PolicyProbeConfigUpdate | null> {
  if (!orgId) {
    return null;
  }

  // Dual-ownership (#2129): the device's probe list must also cover
  // partner-wide compliance policies (org_id NULL) owned by this org's
  // partner — the evaluation worker fans those out to this device, so the
  // agent has to collect their registry/config state too.
  const partnerId = opts?.partnerId !== undefined
    ? opts.partnerId
    : (await db
      .select({ partnerId: organizations.partnerId })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1))[0]?.partnerId ?? null;

  const ownershipCondition = partnerId
    ? or(
        eq(automationPolicies.orgId, orgId),
        and(isNull(automationPolicies.orgId), eq(automationPolicies.partnerId, partnerId))
      )
    : eq(automationPolicies.orgId, orgId);

  const policyRows: ProbeSourceRow[] = await db
    .select({ rules: automationPolicies.rules, ownerOrgId: automationPolicies.orgId })
    .from(automationPolicies)
    .where(
      and(
        ownershipCondition,
        eq(automationPolicies.enabled, true)
      )
    );

  // #11976: configuration-policy compliance rules are evaluated against the
  // same collected state (evaluateDeviceComplianceFromConfigPolicy reads
  // device_registry_state / device_config_state), so the agent has to collect
  // their values too. Without this, a configuration-policy registry check
  // reports "Registry value not found" for a value that exists, forever.
  //
  // The list is a per-org SUPERSET, like the automation-policy half above:
  // every active policy the org can own (its own + its partner's partner-wide),
  // with no assignment targeting. A probe on a device the rule does not target
  // costs one read-only registry/file read; per-device targeting would break the
  // per-org cache. The effective-links view carries links inherited from a
  // parent policy, exactly as resolveComplianceAssignmentForDevice reads them.
  const configPolicyOwnership = partnerId
    ? or(
        eq(configurationPolicies.orgId, orgId),
        and(isNull(configurationPolicies.orgId), eq(configurationPolicies.partnerId, partnerId))
      )
    : eq(configurationPolicies.orgId, orgId);

  // #12130: a link inherited from a parent policy is classified by the policy
  // that AUTHORED it (`sourcePolicyId`), so a partner-wide parent's rules count
  // as partner-wide under an org-owned child. Left join: a source row this
  // context cannot read falls back to the assigned policy's owner.
  const sourcePolicies = alias(configurationPolicies, 'probe_source_policy');
  const complianceRows: ProbeSourceRow[] = (await db
    .select({
      rules: configPolicyComplianceRules.rules,
      assignedOwnerOrgId: configurationPolicies.orgId,
      sourceId: sourcePolicies.id,
      sourceOwnerOrgId: sourcePolicies.orgId,
    })
    .from(configPolicyComplianceRules)
    .innerJoin(
      configPolicyEffectiveFeatureLinks,
      and(
        eq(configPolicyComplianceRules.featureLinkId, configPolicyEffectiveFeatureLinks.id),
        eq(configPolicyEffectiveFeatureLinks.featureType, 'compliance')
      )
    )
    .innerJoin(
      configurationPolicies,
      eq(configPolicyEffectiveFeatureLinks.configPolicyId, configurationPolicies.id)
    )
    .leftJoin(
      sourcePolicies,
      eq(configPolicyEffectiveFeatureLinks.sourcePolicyId, sourcePolicies.id)
    )
    .where(
      and(
        configPolicyOwnership,
        eq(configurationPolicies.status, 'active')
      )
    ))
    .map((row) => ({
      rules: row.rules,
      ownerOrgId: row.sourceId ? row.sourceOwnerOrgId : row.assignedOwnerOrgId,
    }));

  // #12130: the org's own policies and its partner's partner-wide policies are
  // collected separately so the cap can reserve capacity for each. A probe both
  // sides ask for counts as the org's own.
  const own = { registry: new Map<string, PolicyRegistryProbeUpdate>(), config: new Map<string, PolicyConfigProbeUpdate>() };
  const shared = { registry: new Map<string, PolicyRegistryProbeUpdate>(), config: new Map<string, PolicyConfigProbeUpdate>() };

  for (const row of [...policyRows, ...complianceRows]) {
    const bucket = row.ownerOrgId ? own : shared;
    const probes = derivePolicyStateProbesFromRules(row.rules);
    for (const probe of probes.registry) {
      const key = policyRegistryProbeKey(probe.registry_path, probe.value_name);
      if (!bucket.registry.has(key)) bucket.registry.set(key, probe);
    }
    for (const probe of probes.config) {
      const key = policyConfigProbeKey(probe.file_path, probe.config_key);
      if (!bucket.config.has(key)) bucket.config.set(key, probe);
    }
  }
  for (const key of own.registry.keys()) shared.registry.delete(key);
  for (const key of own.config.keys()) shared.config.delete(key);

  return {
    policy_registry_state_probes: sortPolicyRegistryProbes(capPolicyStateProbes(
      sortPolicyRegistryProbes(Array.from(own.registry.values())),
      sortPolicyRegistryProbes(Array.from(shared.registry.values())),
      orgId, 'registry')),
    policy_config_state_probes: sortPolicyConfigProbes(capPolicyStateProbes(
      sortPolicyConfigProbes(Array.from(own.config.values())),
      sortPolicyConfigProbes(Array.from(shared.config.values())),
      orgId, 'config')),
  };
}

/**
 * #11976: the most registry probes, and separately the most config probes, the
 * heartbeat sends one org's agents. Every active policy the org can own feeds
 * the list, so it is bounded here rather than by the number of rules authored.
 */
export const MAX_POLICY_STATE_PROBES_PER_ORG = 256;

/**
 * #12130: how many of each source's probes the cap keeps. The org's own
 * policies and its partner's partner-wide policies are each guaranteed half of
 * the cap, and a source that needs less than its half leaves the rest to the
 * other. Without the reserve, the sorted head of the merged list decided what
 * was kept, and one partner-wide policy with many rules could push every one of
 * an org's own rules off the list.
 */
function apportionPolicyStateProbeCap(
  ownCount: number,
  sharedCount: number,
  cap = MAX_POLICY_STATE_PROBES_PER_ORG,
): { ownKept: number; sharedKept: number } {
  const reserve = Math.floor(cap / 2);
  const ownKept = Math.min(ownCount, Math.max(reserve, cap - sharedCount));
  const sharedKept = Math.min(sharedCount, cap - ownKept);
  return { ownKept, sharedKept };
}

/**
 * Keeps each source's head (both lists already sorted), so the kept set is the
 * same on every beat whatever order the rows were read in. A rule past the cap
 * is not collected; the evaluator reports it as not assessed (#12130). The
 * warning names the org and the per-source counts so the excess can be traced.
 */
const DROPPED_PROBE_SAMPLE = 10;

function capPolicyStateProbes<T>(
  ownSorted: T[],
  sharedSorted: T[],
  orgId: string,
  kind: 'registry' | 'config',
): T[] {
  const total = ownSorted.length + sharedSorted.length;
  if (total <= MAX_POLICY_STATE_PROBES_PER_ORG) return [...ownSorted, ...sharedSorted];
  const { ownKept, sharedKept } = apportionPolicyStateProbeCap(ownSorted.length, sharedSorted.length);
  const dropped = [...ownSorted.slice(ownKept), ...sharedSorted.slice(sharedKept)];
  console.warn('[policyStateProbes] policy state probe list truncated', {
    orgId,
    kind,
    total,
    kept: ownKept + sharedKept,
    orgOwned: { total: ownSorted.length, kept: ownKept },
    partnerWide: { total: sharedSorted.length, kept: sharedKept },
    // Which rules go unassessed; the evaluator names each one per device too.
    droppedSample: dropped.slice(0, DROPPED_PROBE_SAMPLE),
  });
  return [...ownSorted.slice(0, ownKept), ...sharedSorted.slice(0, sharedKept)];
}

/** The probe keys an org's agents collect. */
export type CollectedPolicyStateProbes = {
  registry: ReadonlySet<string>;
  config: ReadonlySet<string>;
};

export function collectedPolicyStateProbesOf(update: PolicyProbeConfigUpdate | null): CollectedPolicyStateProbes {
  return {
    registry: new Set((update?.policy_registry_state_probes ?? [])
      .map((probe) => policyRegistryProbeKey(probe.registry_path, probe.value_name))),
    config: new Set((update?.policy_config_state_probes ?? [])
      .map((probe) => policyConfigProbeKey(probe.file_path, probe.config_key))),
  };
}

/**
 * The probes an org's agents are sent, built the way the heartbeat builds them.
 * Read fresh rather than from the heartbeat's per-process cache: the evaluator
 * usually runs in the worker, and the list may have changed since that cache
 * filled. Throws on a read failure; the caller's savepoint owns the error.
 */
export async function loadCollectedPolicyStateProbes(orgId: string): Promise<CollectedPolicyStateProbes> {
  return collectedPolicyStateProbesOf(await buildPolicyProbeConfigUpdate(orgId));
}
