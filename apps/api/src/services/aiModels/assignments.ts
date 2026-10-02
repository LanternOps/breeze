/**
 * Effective model assignment for one (surface, role): the partner-wide row
 * with the org override applied TIGHTEN-ONLY (spec §5.4, quorum #11). The
 * merge is pure and total: an invalid stored options object is ignored with a
 * warning, never thrown, so a bad row can't take a surface down.
 */
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import {
  AI_SURFACE_ROLES,
  EFFORT_LEVELS,
  offeringOptionsSchema,
  type AiSurface,
  type OfferingOptions,
} from '@breeze/shared';
import { db } from '../../db';
import { aiModelAssignments, type AiModelAssignmentRow } from '../../db/schema';

export type AssignmentRowInput = Pick<
  AiModelAssignmentRow,
  'id' | 'role' | 'defaultOfferingId' | 'permittedOfferingIds' | 'allowUserChoice' | 'options' | 'fallbackOfferingIds' | 'fallbackMayCrossFunding'
>;

export type PermittedSet = { kind: 'all' } | { kind: 'list'; offeringIds: readonly string[] };

export type AssignmentMergeWarning =
  | 'org_default_not_permitted'
  | 'org_fallbacks_not_permitted'
  | 'org_effort_clamped'
  | 'org_speed_clamped'
  | 'org_budget_thinking_clamped'
  | 'invalid_partner_options'
  | 'invalid_org_options';

export interface EffectiveAssignment {
  surface: AiSurface;
  role: string;
  defaultOfferingId: string | null;
  defaultSource: 'org' | 'partner' | 'none';
  permitted: PermittedSet;
  allowUserChoice: boolean;
  options: OfferingOptions;
  fallbackOfferingIds: readonly string[];
  fallbackMayCrossFunding: boolean;
  sources: { partnerRowId: string | null; partnerRole: string | null; orgRowId: string | null; orgRole: string | null };
  warnings: readonly AssignmentMergeWarning[];
}

export function isPermitted(set: PermittedSet, offeringId: string): boolean {
  return set.kind === 'all' || set.offeringIds.includes(offeringId);
}

function toSet(ids: readonly string[] | null | undefined): PermittedSet | null {
  return ids === null || ids === undefined ? null : { kind: 'list', offeringIds: [...ids] };
}

function intersect(partner: PermittedSet, org: PermittedSet | null): PermittedSet {
  if (org === null || org.kind === 'all') return partner;
  if (partner.kind === 'all') return org;
  return { kind: 'list', offeringIds: org.offeringIds.filter((id) => partner.offeringIds.includes(id)) };
}

function parseOptions(raw: unknown): OfferingOptions | null {
  if (raw === null || raw === undefined) return {};
  const parsed = offeringOptionsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

const effortIndex = (e: string) => EFFORT_LEVELS.indexOf(e as (typeof EFFORT_LEVELS)[number]);

export function clampOrgOptions(
  partner: OfferingOptions,
  org: OfferingOptions | null,
): { options: OfferingOptions; warnings: AssignmentMergeWarning[] } {
  const warnings: AssignmentMergeWarning[] = [];
  const out: OfferingOptions = {};
  const o = org ?? {};

  const effort = o.effort === undefined
    ? partner.effort
    : partner.effort === undefined
      ? o.effort
      : effortIndex(o.effort) <= effortIndex(partner.effort) ? o.effort : (warnings.push('org_effort_clamped'), partner.effort);
  if (effort !== undefined) out.effort = effort;

  let speed = partner.speed;
  if (o.speed === 'standard') speed = 'standard';
  else if (o.speed === 'fast') {
    if (partner.speed !== 'fast') warnings.push('org_speed_clamped');
    // speed stays the partner's choice (undefined = provider default)
  }
  if (speed !== undefined) out.speed = speed;

  const thinkingDisplay = o.thinkingDisplay ?? partner.thinkingDisplay;
  if (thinkingDisplay !== undefined) out.thinkingDisplay = thinkingDisplay;

  // W05: tighten-only. An org may turn manual-budget thinking OFF; it may
  // turn it ON only where the partner already did (it costs output tokens).
  let budgetThinking = partner.budgetThinking;
  if (o.budgetThinking === 'off') budgetThinking = 'off';
  else if (o.budgetThinking === 'on') {
    if (partner.budgetThinking === 'on') budgetThinking = 'on';
    else warnings.push('org_budget_thinking_clamped');
  }
  if (budgetThinking !== undefined) out.budgetThinking = budgetThinking;

  return { options: out, warnings };
}

export function mergeEffectiveAssignment(input: {
  surface: AiSurface;
  role: string;
  partner: AssignmentRowInput | null;
  org: AssignmentRowInput | null;
}): EffectiveAssignment {
  const { partner, org } = input;
  const warnings: AssignmentMergeWarning[] = [];

  const partnerSet: PermittedSet = toSet(partner?.permittedOfferingIds) ?? { kind: 'all' };
  const permitted = intersect(partnerSet, toSet(org?.permittedOfferingIds));

  let defaultOfferingId: string | null = partner?.defaultOfferingId ?? null;
  let defaultSource: EffectiveAssignment['defaultSource'] = defaultOfferingId ? 'partner' : 'none';
  if (org?.defaultOfferingId) {
    if (isPermitted(permitted, org.defaultOfferingId)) {
      defaultOfferingId = org.defaultOfferingId;
      defaultSource = 'org';
    } else {
      warnings.push('org_default_not_permitted');
    }
  }

  const partnerOptions = parseOptions(partner?.options);
  if (partnerOptions === null) warnings.push('invalid_partner_options');
  const orgOptions = org ? parseOptions(org.options) : {};
  if (orgOptions === null) warnings.push('invalid_org_options');
  const clamped = clampOrgOptions(partnerOptions ?? {}, org && org.options !== null ? orgOptions ?? {} : null);
  warnings.push(...clamped.warnings);

  const partnerFallbacks = partner?.fallbackOfferingIds ?? [];
  let fallbackOfferingIds: readonly string[] = partnerFallbacks;
  if (org?.fallbackOfferingIds) {
    if (org.fallbackOfferingIds.every((id) => isPermitted(partnerSet, id))) fallbackOfferingIds = [...org.fallbackOfferingIds];
    else warnings.push('org_fallbacks_not_permitted');
  }

  return {
    surface: input.surface,
    role: input.role,
    defaultOfferingId,
    defaultSource,
    permitted,
    allowUserChoice: (partner?.allowUserChoice ?? true) && (org?.allowUserChoice ?? true),
    options: clamped.options,
    fallbackOfferingIds,
    fallbackMayCrossFunding: (partner?.fallbackMayCrossFunding ?? false) && (org?.fallbackMayCrossFunding ?? true),
    sources: {
      partnerRowId: partner?.id ?? null,
      partnerRole: partner?.role ?? null,
      orgRowId: org?.id ?? null,
      orgRole: org?.role ?? null,
    },
    warnings,
  };
}

function pickForRole<T extends { role: string }>(rows: T[], role: string): T | null {
  return rows.find((r) => r.role === role) ?? rows.find((r) => r.role === 'default') ?? null;
}

export async function getEffectiveAssignment(input: {
  partnerId: string;
  orgId: string | null;
  surface: AiSurface;
  role?: string;
}): Promise<EffectiveAssignment> {
  const role = input.role ?? 'default';
  if (!AI_SURFACE_ROLES[input.surface].includes(role)) {
    throw new Error(`Role "${role}" is not defined for surface "${input.surface}".`);
  }
  const owner = input.orgId
    ? or(
        and(isNull(aiModelAssignments.orgId), eq(aiModelAssignments.partnerId, input.partnerId)),
        and(eq(aiModelAssignments.orgId, input.orgId), eq(aiModelAssignments.offeringPartnerId, input.partnerId)),
      )
    : and(isNull(aiModelAssignments.orgId), eq(aiModelAssignments.partnerId, input.partnerId));
  const rows = await db
    .select()
    .from(aiModelAssignments)
    .where(and(
      eq(aiModelAssignments.surface, input.surface),
      inArray(aiModelAssignments.role, role === 'default' ? ['default'] : [role, 'default']),
      owner,
    ));
  return mergeEffectiveAssignment({
    surface: input.surface,
    role,
    partner: pickForRole(rows.filter((r) => r.orgId === null), role),
    org: pickForRole(rows.filter((r) => r.orgId !== null), role),
  });
}
