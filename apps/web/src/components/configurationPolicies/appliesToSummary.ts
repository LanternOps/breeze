// The applies-to summary the configuration-policy list and detail reads carry
// (#12306, plan W01a task A1). Declared here, verbatim from the plan's shape,
// while the API part ships separately: either PR may merge first, so every
// reader treats a missing or malformed `appliesTo` as unknown, never as
// "not applied". When `@breeze/shared` exports these names, re-export them
// from there instead of declaring them twice.

export const APPLIES_TO_SUMMARY_TARGET_LIMIT = 3;

export type ConfigPolicyTargetLevel = 'partner' | 'organization' | 'site' | 'device_group' | 'device';

export interface ConfigPolicyAppliesToTarget {
  assignmentId: string;
  level: ConfigPolicyTargetLevel;
  targetId: string;
  /** null only for 'partner' (render "All organizations"); unnamed rows never appear. */
  name: string | null;
  roleFilter: string[] | null;
  osFilter: string[] | null;
}

export interface ConfigPolicyAppliesToSummary {
  /** Every assignment row the caller's RLS context reads, including rows it may not list. */
  assignmentCount: number;
  /** A 'partner'-level row exists. */
  allOrganizations: boolean;
  /** At most APPLIES_TO_SUMMARY_TARGET_LIMIT rows the caller is authorized to list. */
  targets: ConfigPolicyAppliesToTarget[];
  /** Policies whose parent is this one, visible to the caller. */
  childPolicyCount: number;
}

export type ConfigPolicyAppliesToState = 'applied' | 'not_applied' | 'in_use_through_children';

/** Most general to most specific. */
export const TARGET_LEVEL_ORDER: readonly ConfigPolicyTargetLevel[] = [
  'partner',
  'organization',
  'site',
  'device_group',
  'device',
];

export function appliesToState(s: ConfigPolicyAppliesToSummary): ConfigPolicyAppliesToState {
  if (s.assignmentCount > 0) return 'applied';
  if (s.childPolicyCount > 0) return 'in_use_through_children';
  return 'not_applied';
}
