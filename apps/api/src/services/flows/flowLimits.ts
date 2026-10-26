/**
 * Tool Catalog W05 (#5220), plan Task A4 / Decision 15 — flow limits.
 *
 * One resolver: partner default → org override, where the org may only LOWER
 * the partner's value (a stated partner-ceiling exception to settings rule 3).
 * Stored under `flows` in `partners.settings` / `organizations.settings`;
 * every value is bounded by the platform ceiling in shared
 * (`FLOW_LIMIT_CEILINGS`).
 *
 * Fields are parsed one at a time: a malformed field falls back to the level
 * above on its own and never widens a sibling (a whole-object parse failure
 * would otherwise drop a valid lowered cap back to the default).
 */
import { eq } from 'drizzle-orm';
import {
  FLOW_LIMIT_DEFAULTS,
  FLOW_LIMIT_KEYS,
  flowLimitsSettingsSchema,
  type FlowDocumentV1,
  type FlowLimitKey,
  type FlowLimitsDto,
} from '@breeze/shared';
import { db, getCurrentDbAccessContext, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { organizations, partners } from '../../db/schema/orgs';
import type { ToolOwnerRef } from '../toolSources/resolver';

export interface EffectiveFlowLimits extends Record<FlowLimitKey, number> {
  source: FlowLimitsDto['source'];
  /** The partner values an org override may not exceed; null for a partner owner. */
  partnerCeiling: FlowLimitsDto['partnerCeiling'];
}

function fieldValue(settings: unknown, key: FlowLimitKey): number | undefined {
  const flowsBlob = settings && typeof settings === 'object' ? (settings as Record<string, unknown>).flows : undefined;
  if (!flowsBlob || typeof flowsBlob !== 'object' || Array.isArray(flowsBlob)) return undefined;
  if (!Object.hasOwn(flowsBlob, key)) return undefined;
  const parsed = flowLimitsSettingsSchema.shape[key].safeParse((flowsBlob as Record<string, unknown>)[key]);
  return parsed.success ? parsed.data : undefined;
}

/** Pure: the effective limits from the two settings blobs (org null ⇒ a partner owner). */
export function computeFlowLimits(partnerSettings: unknown, orgSettings: unknown | null): EffectiveFlowLimits {
  const out = {} as Record<FlowLimitKey, number>;
  const source = {} as FlowLimitsDto['source'];
  const ceiling = {} as Record<FlowLimitKey, number>;
  for (const key of FLOW_LIMIT_KEYS) {
    const partnerValue = fieldValue(partnerSettings, key);
    const partnerEffective = partnerValue ?? FLOW_LIMIT_DEFAULTS[key];
    ceiling[key] = partnerEffective;
    const orgValue = orgSettings === null ? undefined : fieldValue(orgSettings, key);
    if (orgValue !== undefined && orgValue <= partnerEffective) {
      out[key] = orgValue;
      source[key] = 'org';
    } else {
      out[key] = partnerEffective;
      source[key] = partnerValue !== undefined ? 'partner' : 'default';
    }
  }
  return { ...out, source, partnerCeiling: orgSettings === null ? null : ceiling };
}

async function readSettings(owner: ToolOwnerRef): Promise<{ partner: unknown; org: unknown | null }> {
  const [partner] = await db
    .select({ settings: partners.settings })
    .from(partners)
    .where(eq(partners.id, owner.partnerId))
    .limit(1);
  if (!owner.orgId) return { partner: partner?.settings ?? null, org: null };
  const [org] = await db
    .select({ settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, owner.orgId))
    .limit(1);
  return { partner: partner?.settings ?? null, org: org?.settings ?? {} };
}

/**
 * System read with explicit owner predicates. Joins an ambient SYSTEM
 * transaction (run admission); otherwise opens a short one of its own.
 */
export async function resolveFlowLimits(owner: ToolOwnerRef): Promise<EffectiveFlowLimits> {
  const settings = getCurrentDbAccessContext()?.scope === 'system'
    ? await readSettings(owner)
    : await runOutsideDbContext(() => withSystemDbAccessContext(() => readSettings(owner), 'flows.flowLimits.resolve'));
  return computeFlowLimits(settings.partner, settings.org);
}

/** A document's `limits.monthlyRuns` lowers, never raises, the owner's per-flow cap. */
export function effectiveFlowMonthlyCap(limits: EffectiveFlowLimits, doc: Pick<FlowDocumentV1, 'limits'>): number {
  const docCap = doc.limits?.monthlyRuns;
  return docCap !== undefined ? Math.min(docCap, limits.monthlyRunsPerFlow) : limits.monthlyRunsPerFlow;
}
