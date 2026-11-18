/**
 * The `service_running` compliance bridge, pure half (#6958 PR E, plan D4).
 *
 * A DNS-filtering client installed from a zip has no Add/Remove Programs
 * entry, so inventory never proves it is present. The periodic bridge lets a
 * fresh service observation (from the monitoring watches the heartbeat derives
 * from `software_compliance_status.service_watches`) stand in for inventory,
 * and reports a client that is installed but not running.
 *
 * Only allowlist rules with a `catalogId` whose latest catalog version carries
 * a `service_running` clause for the device's OS participate. Everything else
 * passes through unchanged. Decision per (rule, service name), the plan's D4
 * table:
 *
 *   inventory | fresh status        | result
 *   ----------+---------------------+---------------------------------------------
 *   no        | none / error        | service_unverified (low; a telemetry gap
 *             |                     |   must never reinstall)
 *   no        | not_found           | missing (kept; drives install remediation)
 *   no        | stopped             | not_running (high)
 *   any       | running             | compliant — EXCEPT a rule with vendor /
 *             |                     |   minVersion / maxVersion and no inventory
 *             |                     |   match keeps `missing` (AND semantics)
 *   yes       | stopped / not_found | not_running
 *   yes       | none / error        | service_unverified
 *
 * A rule with several names takes the WORST per-name outcome:
 * not_running > missing > service_unverified > compliant (a stopped service
 * proves an install; a fresh absence outranks a telemetry gap).
 *
 * "No inventory" is read from the presence of the rule's own `missing`
 * violation. A rule with neither a `missing` violation nor an inventory match
 * is left alone. Only catalog ids present in `serviceNamesByCatalogId`
 * participate, so the caller narrows that map to the rules applicable to the
 * device (#6960 managed applicability, #10126) and filters the result
 * afterwards: a not-applicable rule's `missing` is never turned into a
 * service violation here.
 *
 * Pure: no database, no clock (the caller passes `now`).
 */
import { detectionRulesSchema } from '@breeze/shared';
import type { SoftwarePolicyViolation } from '../db/schema';

export type ServiceObservation = {
  status: 'running' | 'stopped' | 'not_found' | 'error';
  observedAt: Date;
  /**
   * The reporting agent is at or above MIN_AGENT_VERSION_SERVICE_RUNNING_RULE,
   * where `not_found` means absent. Older macOS agents report every query
   * error as `not_found`, and older Linux agents conflate exec failures, so
   * their `not_found` is read as `error`.
   */
  agentSupportsAbsence: boolean;
};

/** Only observations at most this old count. */
export const SERVICE_STATE_FRESHNESS_MS = 60 * 60 * 1000;
/** Derived service watches per (device), after sorting. */
export const MAX_DERIVED_SERVICE_WATCHES = 50;

/**
 * The observation-map key: identical to `watchKey('service', name)` in
 * services/monitoringActiveWatches.ts (pinned by a test). Re-stated here so
 * this module stays free of that file's route-helper import chain.
 */
export function serviceObservationKey(name: string): string {
  return `service:${name.toLowerCase()}`;
}

type ServiceRule = { name: string; catalogId?: string; vendor?: string; minVersion?: string; maxVersion?: string };

/**
 * The `service_running` names a catalog version declares for a device OS.
 * `supportedOs` null or empty applies to every OS; otherwise the OS is matched
 * case-insensitively (the chunked-upload UI stores "Windows"). Unparseable
 * rules yield none. Deduped case-insensitively, first spelling kept, in
 * declaration order.
 */
export function serviceNamesForOs(detectionRules: unknown, supportedOs: unknown, osType: string): string[] {
  if (Array.isArray(supportedOs) && supportedOs.length > 0) {
    const os = osType.toLowerCase();
    const applies = supportedOs.some((entry) => typeof entry === 'string' && entry.toLowerCase() === os);
    if (!applies) return [];
  }
  const parsed = detectionRulesSchema.safeParse(detectionRules);
  if (!parsed.success) return [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const clause of parsed.data) {
    if (clause.type !== 'service_running') continue;
    const key = clause.serviceName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(clause.serviceName);
  }
  return names;
}

type Outcome = 'compliant' | 'service_unverified' | 'missing' | 'not_running';
const OUTCOME_RANK: Record<Outcome, number> = { compliant: 0, service_unverified: 1, missing: 2, not_running: 3 };

type EffectiveObservation = { status: ServiceObservation['status']; observedAt: Date } | null;

function effectiveObservation(observation: ServiceObservation | undefined, now: Date): EffectiveObservation {
  if (!observation) return null;
  const age = now.getTime() - observation.observedAt.getTime();
  if (Number.isNaN(age) || age > SERVICE_STATE_FRESHNESS_MS) return null;
  if (observation.status === 'not_found' && !observation.agentSupportsAbsence) {
    return { status: 'error', observedAt: observation.observedAt };
  }
  return { status: observation.status, observedAt: observation.observedAt };
}

function outcomeFor(obs: EffectiveObservation, inventoryMatched: boolean, constrained: boolean): Outcome {
  const status = obs?.status ?? null;
  if (status === 'running') return !inventoryMatched && constrained ? 'missing' : 'compliant';
  if (status === 'stopped') return 'not_running';
  if (status === 'not_found') return inventoryMatched ? 'not_running' : 'missing';
  return 'service_unverified';
}

export function applyServiceRules(input: {
  mode: 'allowlist' | 'blocklist' | 'audit';
  /** From evaluateSoftwareInventory. */
  violations: SoftwarePolicyViolation[];
  rules: ServiceRule[];
  inventoryMatchedRuleNames: Set<string>;
  /** OS-filtered `service_running` names per catalog id, for the rules applicable to this device. */
  serviceNamesByCatalogId: Map<string, string[]>;
  /** ONE device's observations, keyed by serviceObservationKey(name). */
  observations: Map<string, ServiceObservation>;
  now: Date;
}): SoftwarePolicyViolation[] {
  if (input.mode !== 'allowlist') return input.violations;

  const removed = new Set<number>();
  const added: SoftwarePolicyViolation[] = [];
  const replaced = new Map<number, SoftwarePolicyViolation>();
  const detectedAt = input.now.toISOString();

  for (const rule of input.rules) {
    if (!rule.catalogId) continue;
    const names = input.serviceNamesByCatalogId.get(rule.catalogId) ?? [];
    if (names.length === 0) continue;

    const missingIndex = input.violations.findIndex((v, i) =>
      !removed.has(i) && !replaced.has(i)
      && v.type === 'missing' && v.rule?.name === rule.name && v.rule?.catalogId === rule.catalogId);
    const inventoryMatched = missingIndex === -1;
    if (inventoryMatched && !input.inventoryMatchedRuleNames.has(rule.name)) continue;

    const constrained = Boolean(rule.vendor || rule.minVersion || rule.maxVersion);
    let worst: { outcome: Outcome; name: string; obs: EffectiveObservation } | null = null;
    for (const name of names) {
      const obs = effectiveObservation(input.observations.get(serviceObservationKey(name)), input.now);
      const outcome = outcomeFor(obs, inventoryMatched, constrained);
      if (!worst || OUTCOME_RANK[outcome] > OUTCOME_RANK[worst.outcome]) worst = { outcome, name, obs };
    }
    if (!worst) continue;

    if (worst.outcome === 'missing') continue; // keep the existing violation as-is
    if (worst.outcome === 'compliant') {
      if (missingIndex !== -1) removed.add(missingIndex);
      continue;
    }
    const observedStatus = worst.obs && worst.obs.status !== 'running' ? worst.obs.status : null;
    const violation: SoftwarePolicyViolation = {
      type: worst.outcome,
      rule: {
        name: rule.name,
        catalogId: rule.catalogId,
        ...(rule.minVersion ? { minVersion: rule.minVersion } : {}),
        ...(rule.maxVersion ? { maxVersion: rule.maxVersion } : {}),
      },
      service: {
        name: worst.name,
        observedStatus,
        observedAt: worst.obs ? worst.obs.observedAt.toISOString() : null,
      },
      severity: worst.outcome === 'not_running' ? 'high' : 'low',
      detectedAt,
    };
    if (missingIndex !== -1) replaced.set(missingIndex, violation);
    else added.push(violation);
  }

  if (removed.size === 0 && replaced.size === 0 && added.length === 0) return input.violations;
  const out: SoftwarePolicyViolation[] = [];
  input.violations.forEach((v, i) => {
    if (removed.has(i)) return;
    out.push(replaced.get(i) ?? v);
  });
  return out.concat(added);
}
