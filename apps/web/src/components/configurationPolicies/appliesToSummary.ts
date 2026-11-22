import { configTargetLevelLabel } from './configPolicyLabels';

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

const isStringArrayOrNull = (v: unknown): v is string[] | null =>
  v === null || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

function parseTarget(raw: unknown): ConfigPolicyAppliesToTarget | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.assignmentId !== 'string' || typeof t.targetId !== 'string') return null;
  if (!TARGET_LEVEL_ORDER.includes(t.level as ConfigPolicyTargetLevel)) return null;
  if (t.name !== null && typeof t.name !== 'string') return null;
  const roleFilter = t.roleFilter ?? null;
  const osFilter = t.osFilter ?? null;
  if (!isStringArrayOrNull(roleFilter) || !isStringArrayOrNull(osFilter)) return null;
  return {
    assignmentId: t.assignmentId,
    level: t.level as ConfigPolicyTargetLevel,
    targetId: t.targetId,
    name: t.name,
    roleFilter,
    osFilter,
  };
}

/**
 * The `appliesTo` field of a list row or detail read, or null when it is
 * absent (an API a release behind) or malformed. Null means "unknown": no
 * reader may turn it into a "not applied" claim.
 */
export function parseAppliesTo(raw: unknown): ConfigPolicyAppliesToSummary | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  if (!isCount(s.assignmentCount) || !isCount(s.childPolicyCount)) return null;
  if (typeof s.allOrganizations !== 'boolean' || !Array.isArray(s.targets)) return null;
  const targets: ConfigPolicyAppliesToTarget[] = [];
  for (const rawTarget of s.targets) {
    const target = parseTarget(rawTarget);
    if (!target) return null;
    targets.push(target);
  }
  return {
    assignmentCount: s.assignmentCount,
    allOrganizations: s.allOrganizations,
    targets,
    childPolicyCount: s.childPolicyCount,
  };
}

export type FormattedAppliesToTarget = {
  key: string;
  text: string;
  roleFilter: string[] | null;
  osFilter: string[] | null;
};

/**
 * The targets to name, in the API's order, and how many more rows apply.
 * `more` counts from the unfiltered `assignmentCount`, so rows the caller may
 * not list still show as "+N" rather than vanishing.
 */
export function formatAppliesToTargets(s: ConfigPolicyAppliesToSummary): {
  shown: FormattedAppliesToTarget[];
  more: number;
} {
  const shown = s.targets.slice(0, APPLIES_TO_SUMMARY_TARGET_LIMIT).map((t) => ({
    key: t.assignmentId,
    text: t.level === 'partner' ? configTargetLevelLabel('partner') : (t.name ?? ''),
    roleFilter: t.roleFilter,
    osFilter: t.osFilter,
  }));
  return { shown, more: Math.max(0, s.assignmentCount - shown.length) };
}

export type ConfigPolicyStatus = 'active' | 'inactive' | 'archived';

/**
 * How loudly to say a policy applies to nothing (plan D2a). Only an active,
 * unapplied policy with no children warns; an inactive one is a neutral
 * "not applied yet"; an archived one says nothing.
 */
export function notAppliedTone(
  status: ConfigPolicyStatus,
  state: ConfigPolicyAppliesToState,
): 'warning' | 'neutral' | null {
  if (state !== 'not_applied') return null;
  if (status === 'active') return 'warning';
  if (status === 'inactive') return 'neutral';
  return null;
}
