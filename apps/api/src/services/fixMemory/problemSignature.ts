/**
 * AI Suggested Fixes W2 — `find_proven_fixes` deviceId + problem. A problem is
 * ONE structured alert-condition leaf (the alert_rules condition shape), fed
 * through W1's ruleConditionFacets, so it canonicalises exactly as a rule-based
 * alert with that condition does. Free text is refused by construction.
 */
import { z } from 'zod';
import { computeSignature, ruleConditionFacets, type FixOsFamily, type FixSignature } from './signature';

/** The leaf types leafFor() (signature.ts) understands. */
export const FIX_PROBLEM_LEAF_TYPES = [
  'metric', 'threshold', 'offline', 'patch_compliance', 'cert_expiry', 'event_log', 'service_stopped',
  'process_stopped', 'process_cpu_high', 'process_memory_high', 'bandwidth_high', 'disk_io_high',
  'network_errors', 'antivirus', 'backup_continuity', 'software_presence', 'hardware_health',
  'script_monitor', 'network_check',
] as const;

const field = z.string().trim().min(1).max(200);
export const fixProblemSchema = z.object({
  type: z.enum(FIX_PROBLEM_LEAF_TYPES),
  metric: field.optional(),
  operator: z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'neq']).optional(),
  serviceName: field.optional(),
  processName: field.optional(),
  name: field.optional(),
  presence: field.optional(),
  category: field.optional(),
  level: field.optional(),
  direction: field.optional(),
  errorType: field.optional(),
  check: field.optional(),
  componentTypes: z.array(field).max(10).optional(),
}).strict();
export type FixProblem = z.infer<typeof fixProblemSchema>;

export function signatureForProblem(input: { osFamily: FixOsFamily; problem: FixProblem }): FixSignature | null {
  const facets = ruleConditionFacets({ conditions: [input.problem] });
  if (!facets) return null;
  return computeSignature({ family: 'alert', condition: facets.condition, osFamily: input.osFamily, discriminator: facets.discriminator, rootInferred: false });
}
