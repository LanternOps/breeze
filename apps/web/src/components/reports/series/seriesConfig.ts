import { BUSINESS_REPORT_TYPES, MANAGED_EVIDENCE_REPORT_TYPES } from '@breeze/shared';
import { isBusinessReportType } from '../businessReportAccess';
import type { ReportBuilderFormValues } from '../ReportBuilder';
import type { CoversMode, CoversValue, SeriesDefinition, SeriesDetail, SeriesRecipientRule, SeriesSchedule, SeriesTargets } from './types';

/** Spec §3.2: the org's primary contact by default. */
export const DEFAULT_RECIPIENT_RULE: SeriesRecipientRule = { primaryContact: true, roles: [] };

/** Recurring-only (INDEX: the series zod schema rejects one_time). */
export const SERIES_SCHEDULES: readonly SeriesSchedule[] = ['daily', 'weekly', 'monthly'];
export function isSeriesSchedule(value: string | undefined): value is SeriesSchedule {
  return !!value && (SERIES_SCHEDULES as readonly string[]).includes(value);
}

/**
 * Types a series refuses (spec §3.2, INDEX "Series types"). A SUPERSET of the
 * server's `assertSeriesTypeSupported` on purpose: over-refusing here only hides
 * an option; under-refusing is a 400 the user could not have avoided.
 * `ai_org_narrative` / `ai_fleet_design` mirror SYSTEM_MANAGED_REPORT_TYPES in
 * ../ReportsList.tsx (listed here, not imported, so ReportsList can import this
 * module without a cycle; seriesConfig.test.ts pins the parity).
 * If W02 exported SERIES_UNSUPPORTED_REPORT_TYPES from @breeze/shared, import
 * it here instead (Contract concern 7).
 */
const SERIES_REFUSED_TYPES: ReadonlySet<string> = new Set<string>([
  ...BUSINESS_REPORT_TYPES,
  ...MANAGED_EVIDENCE_REPORT_TYPES,
  'ai_org_narrative',
  'ai_fleet_design',
]);

export function isSeriesEligibleReportType(type: string | undefined): boolean {
  return !!type && !SERIES_REFUSED_TYPES.has(type);
}

/**
 * The Covers choices for a report type. `partnerWide` is
 * `useDefaultReportOwnerScope().canChoose`. Series and Combined are disjoint by
 * type: Combined is the partner-owned aggregate, whose only types are the
 * business trio (the registry's `supportedScopes` 'partner'); a series refuses
 * exactly those.
 */
export function availableCoversModes(type: string | undefined, partnerWide: boolean): CoversMode[] {
  if (!partnerWide) return ['org'];
  if (isBusinessReportType(type)) return ['org', 'combined'];
  if (isSeriesEligibleReportType(type)) return ['org', 'series'];
  return ['org'];
}

/** Builder filter fields that name an org's own entities (ReportBuilder fieldDefinitionsByType). */
export const ORG_SPECIFIC_CONDITION_FIELDS: ReadonlySet<string> = new Set(['site']);

// Top-level keys that name sites/devices/groups/orgs (reportConfigSchemas.ts:
// `sites` on the posture-family schemas, the refused business selectors).
const ORG_SPECIFIC_TOP_LEVEL_KEYS = ['sites', 'siteIds', 'deviceIds', 'groupIds', 'deviceGroupIds', 'orgId', 'orgIds'] as const;
// Keys inside `filters` (legacyReportConfigSchema) and the builder's `legacyFilters` round-trip.
const ORG_SPECIFIC_FILTER_KEYS = ['siteIds', 'deviceIds', 'groupIds', 'deviceGroupIds'] as const;
const NESTED_FILTER_OBJECTS = ['filters', 'legacyFilters'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The config a series may store (spec §3.2 "No org-specific references"; the
 * server answers 400 `series_config_org_specific` otherwise). Also drops
 * `emailRecipients`: a series carries its internal CC as `internalCc`, and
 * W02 writes it into each child's `config.emailRecipients`.
 */
export function stripSeriesConfig(config: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(config ?? {}) };
  for (const key of ORG_SPECIFIC_TOP_LEVEL_KEYS) delete out[key];
  delete out.emailRecipients;
  for (const nestedKey of NESTED_FILTER_OBJECTS) {
    const nested = out[nestedKey];
    if (!isRecord(nested)) continue;
    const kept = { ...nested };
    for (const key of ORG_SPECIFIC_FILTER_KEYS) delete kept[key];
    if (Object.keys(kept).length === 0) delete out[nestedKey];
    else out[nestedKey] = kept;
  }
  if (Array.isArray(out.filterConditions)) {
    out.filterConditions = out.filterConditions.filter(
      (c) => !(isRecord(c) && typeof c.field === 'string' && ORG_SPECIFIC_CONDITION_FIELDS.has(c.field)),
    );
  }
  return out;
}

function nonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/** True when the config names at least one site/device/group/org. */
export function configNamesOrgEntities(config: Record<string, unknown> | undefined): boolean {
  if (!config) return false;
  if (ORG_SPECIFIC_TOP_LEVEL_KEYS.some((k) => nonEmptyArray(config[k]) || (k === 'orgId' && typeof config[k] === 'string'))) return true;
  for (const nestedKey of NESTED_FILTER_OBJECTS) {
    const nested = config[nestedKey];
    if (isRecord(nested) && ORG_SPECIFIC_FILTER_KEYS.some((k) => nonEmptyArray(nested[k]))) return true;
  }
  return Array.isArray(config.filterConditions)
    && config.filterConditions.some((c) => isRecord(c) && typeof c.field === 'string' && ORG_SPECIFIC_CONDITION_FIELDS.has(c.field));
}

/** Same loose regex as ReportBuilder's addEmailRecipient and the API's
 *  legacyReportConfigSchema.emailRecipients — never stricter than either. */
const REPORT_RECIPIENT_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isReportRecipientEmail(value: string): boolean {
  return REPORT_RECIPIENT_EMAIL.test(value.trim());
}

/** Spec §3.5 rule match: org-level primary contact, or any role overlap. */
export function matchesRecipientRule(
  contact: { isPrimary: boolean; siteId: string | null; roles: string[] },
  rule: SeriesRecipientRule,
): boolean {
  if (rule.primaryContact && contact.isPrimary && contact.siteId === null) return true;
  return rule.roles.some((role) => contact.roles.includes(role));
}

export function sameTargets(a: SeriesTargets, b: SeriesTargets): boolean {
  if (a.targetMode !== b.targetMode || a.orgIds.length !== b.orgIds.length) return false;
  const bs = new Set(b.orgIds);
  return a.orgIds.every((id) => bs.has(id));
}

/** The first org a series covers, in the given (sorted) org order. The
 *  builder's live preview needs one concrete org; a series has none of its own. */
export function firstCoveredOrgId(targets: SeriesTargets, orgs: readonly { id: string }[]): string | null {
  const ids = new Set(targets.orgIds);
  const hit = orgs.find((org) => (targets.targetMode === 'all' ? !ids.has(org.id) : ids.has(org.id)));
  return hit?.id ?? null;
}

export function coversFromSeries(detail: SeriesDetail): CoversValue {
  return {
    mode: 'series',
    targetMode: detail.series.targetMode,
    orgIds: [...detail.targets],
    recipientRule: detail.series.recipientRule,
    internalCc: [...detail.series.internalCc],
  };
}

/** The builder's defaultValues for editing a series (mirrors ReportEditPage's
 *  mapping, plus the schedule detail so a save doesn't reset the time to 09:00). */
export function seriesBuilderDefaults(series: SeriesDefinition): Partial<ReportBuilderFormValues> {
  const config = series.config ?? {};
  const schedule = isRecord(config.schedule) ? config.schedule : {};
  return {
    name: series.name,
    type: series.type,
    schedule: series.schedule,
    format: series.format,
    dateRange: (config.dateRange as ReportBuilderFormValues['dateRange']) ?? { preset: 'last_30_days' },
    filters: (config.filters as ReportBuilderFormValues['filters']) ?? {},
    ...(typeof schedule.time === 'string' ? { scheduleTime: schedule.time } : {}),
    ...(typeof schedule.day === 'string' ? { scheduleDay: schedule.day } : {}),
    ...(typeof schedule.date === 'string' ? { scheduleDate: schedule.date } : {}),
  };
}
