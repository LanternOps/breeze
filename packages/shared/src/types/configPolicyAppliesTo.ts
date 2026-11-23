/**
 * Where a configuration policy applies, summarized for the policy list and
 * detail reads (#12306, plan W01a).
 *
 * The API computes this in the caller's own request context. `assignmentCount`
 * counts every assignment row that context can read, while `targets` holds only
 * the rows the caller may list AND can name. "Not applied" therefore keys off
 * `assignmentCount`, never `targets.length`: a site-restricted tech who cannot
 * list an organization-level row must not be told the policy applies nowhere.
 */

export const APPLIES_TO_SUMMARY_TARGET_LIMIT = 3;

export type ConfigPolicyTargetLevel = 'partner' | 'organization' | 'site' | 'device_group' | 'device';

/** Most general to most specific. The order targets are listed in. */
export const TARGET_LEVEL_ORDER: readonly ConfigPolicyTargetLevel[] = [
  'partner',
  'organization',
  'site',
  'device_group',
  'device',
];

export interface ConfigPolicyAppliesToTarget {
  assignmentId: string;
  level: ConfigPolicyTargetLevel;
  targetId: string;
  /** Null only for 'partner' (render "All organizations"). Unnamed rows never appear. */
  name: string | null;
  roleFilter: string[] | null;
  osFilter: string[] | null;
}

export interface ConfigPolicyAppliesToSummary {
  /** Every assignment row the caller's RLS context reads, listable or not. */
  assignmentCount: number;
  /** A 'partner'-level row exists. */
  allOrganizations: boolean;
  /** At most APPLIES_TO_SUMMARY_TARGET_LIMIT rows the caller is authorized to list and can name. */
  targets: ConfigPolicyAppliesToTarget[];
  /** Policies whose parent is this one, visible to the caller. */
  childPolicyCount: number;
}

export type ConfigPolicyAppliesToState = 'applied' | 'not_applied' | 'in_use_through_children';

export function appliesToState(s: ConfigPolicyAppliesToSummary): ConfigPolicyAppliesToState {
  if (s.assignmentCount > 0) return 'applied';
  // A parent is never inert: its children carry it to devices.
  if (s.childPolicyCount > 0) return 'in_use_through_children';
  return 'not_applied';
}
