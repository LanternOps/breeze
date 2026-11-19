/**
 * #11976 / #12130: what a stored compliance rule result may hand back to a
 * reader.
 *
 * Compliance details (`automation_policy_compliance.details.ruleResults`) are
 * returned to callers holding devices:read, while reading a registry value or a
 * config file live needs devices:execute. A `registry_check` or `config_check`
 * result therefore records only its outcome and the value the rule's author
 * wrote (policyEvaluationService.evaluateRegistryCheckRule /
 * evaluateConfigCheckRule).
 *
 * Results evaluated before that change carry the value the device reported
 * (`data.actualValue`) and, for registry checks, its type (`data.valueType`).
 * Every route and tool that returns raw details passes them through here so
 * those rows never return it either. Other rule types are returned unchanged.
 */

const OBSERVED_STATE_FIELDS = ['actualValue', 'valueType'] as const;
const STATE_RULE_TYPES: ReadonlySet<unknown> = new Set(['registry_check', 'config_check']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function withoutObservedStateValue(result: unknown): unknown {
  if (!isRecord(result) || !STATE_RULE_TYPES.has(result.ruleType) || !isRecord(result.data)) return result;
  if (!OBSERVED_STATE_FIELDS.some((field) => field in (result.data as Record<string, unknown>))) return result;
  const data = { ...result.data };
  for (const field of OBSERVED_STATE_FIELDS) delete data[field];
  return { ...result, data };
}

/** Returns `details` with any observed registry or config value removed from its rule results. */
export function withoutObservedStateValues<T>(details: T): T {
  if (!isRecord(details) || !Array.isArray(details.ruleResults)) return details;
  return { ...details, ruleResults: details.ruleResults.map(withoutObservedStateValue) } as T;
}
