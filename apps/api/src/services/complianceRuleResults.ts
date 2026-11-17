/**
 * #11976: what a stored compliance rule result may hand back to a reader.
 *
 * Compliance details (`automation_policy_compliance.details.ruleResults`) are
 * returned to callers holding devices:read, while reading a registry value
 * live needs devices:execute. A `registry_check` result therefore records only
 * its outcome and the value the rule's author wrote
 * (policyEvaluationService.evaluateRegistryCheckRule).
 *
 * Results evaluated before that change carry the value the device reported
 * (`data.actualValue`) and its type (`data.valueType`). Every route and tool
 * that returns raw details passes them through here so those rows never
 * return it either. Other rule types are returned unchanged.
 */

const OBSERVED_REGISTRY_FIELDS = ['actualValue', 'valueType'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function withoutObservedRegistryValue(result: unknown): unknown {
  if (!isRecord(result) || result.ruleType !== 'registry_check' || !isRecord(result.data)) return result;
  if (!OBSERVED_REGISTRY_FIELDS.some((field) => field in (result.data as Record<string, unknown>))) return result;
  const data = { ...result.data };
  for (const field of OBSERVED_REGISTRY_FIELDS) delete data[field];
  return { ...result, data };
}

/** Returns `details` with any observed registry value removed from its rule results. */
export function withoutObservedRegistryValues<T>(details: T): T {
  if (!isRecord(details) || !Array.isArray(details.ruleResults)) return details;
  return { ...details, ruleResults: details.ruleResults.map(withoutObservedRegistryValue) } as T;
}
