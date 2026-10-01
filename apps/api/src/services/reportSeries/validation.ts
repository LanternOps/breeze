/**
 * Multi-org report series — definition rules (spec §3.2 "Series
 * restrictions"). Pure; throws ReportSeriesError with the INDEX codes.
 */
import { BUSINESS_REPORT_TYPES } from '@breeze/shared';
import { selectsSomething } from '../reportConfigSchemas';
import { REPORT_GENERATORS, type ReportTypeDef } from '../reportRegistry';
import { ReportSeriesError } from './errors';

/**
 * Mirrors routes/reports/schemas.ts INTERNAL_REPORT_TYPES (the service layer
 * must not import the route layer); validation.test.ts pins that every
 * internal type is refused here.
 */
const SYSTEM_AUTHORED_REPORT_TYPES: ReadonlySet<string> = new Set(['ai_org_narrative', 'ai_fleet_design']);
const BUSINESS_TYPES: ReadonlySet<string> = new Set(BUSINESS_REPORT_TYPES);

function unsupported(type: string, reason: string): ReportSeriesError {
  return new ReportSeriesError('series_type_unsupported', 400, { type, reason });
}

/**
 * A series type must run for ONE organization under a human principal:
 *  - business types are partner aggregates by nature (PARTNER_ONLY_DELIVERY /
 *    audience msp_staff) — the "combined" report is a partner-owned row;
 *  - narrative / fleet design are system-authored;
 *  - managed-evidence types (registry `execution: 'managed_evidence'`) are
 *    refused per spec §3.2, even though they also have user-authored
 *    definitions (plan Contract concern 3).
 */
export function assertSeriesTypeSupported(type: string): void {
  const def = (REPORT_GENERATORS as Readonly<Record<string, ReportTypeDef | undefined>>)[type];
  if (!def) throw unsupported(type, 'unknown_type');
  if (SYSTEM_AUTHORED_REPORT_TYPES.has(type)) throw unsupported(type, 'system_authored');
  if (BUSINESS_TYPES.has(type) || def.audience === 'msp_staff') throw unsupported(type, 'partner_aggregate');
  if (def.execution !== 'user') throw unsupported(type, 'managed_evidence');
  if (!def.supportedScopes.includes('organization')) throw unsupported(type, 'not_org_executable');
}

/** Top-level config keys that select org-specific objects. */
const ORG_SPECIFIC_KEYS = ['sites', 'siteIds', 'deviceIds', 'groupIds', 'deviceGroupIds', 'orgId', 'orgIds'] as const;
/** `config.filters` keys that name org-specific objects (builder filters). */
const ORG_SPECIFIC_FILTER_KEYS = ['siteIds', 'deviceIds', 'groupIds', 'deviceGroupIds'] as const;
/** Builder `filterConditions[].field` values that name org-specific objects
 *  (`site` is the builder's field id; the others cover stored/legacy shapes). */
const ORG_SPECIFIC_CONDITION_FIELDS: ReadonlySet<string> = new Set(['site', 'siteId', 'device', 'deviceId', 'group', 'groupId']);

function orgSpecific(key: string): ReportSeriesError {
  return new ReportSeriesError('series_config_org_specific', 400, { key });
}

/**
 * A series config is copied verbatim onto every child, so it must not name a
 * site, device, group or org of any one tenant. "Names" means "selects
 * something" (reportConfigSchemas.selectsSomething): `sites: []` and
 * `filters: {}` are the org-wide default, not a selection.
 */
export function assertSeriesConfigOrgAgnostic(config: unknown): void {
  if (config === undefined || config === null) return;
  if (typeof config !== 'object' || Array.isArray(config)) throw orgSpecific('config');
  const record = config as Record<string, unknown>;
  for (const key of ORG_SPECIFIC_KEYS) {
    if (selectsSomething(record[key])) throw orgSpecific(key);
  }
  // `filters` (legacy schema) and `legacyFilters` (the builder's round-trip of
  // them) both carry org-specific selectors.
  for (const nestedKey of ['filters', 'legacyFilters'] as const) {
    const nested = record[nestedKey];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      for (const key of ORG_SPECIFIC_FILTER_KEYS) {
        if (selectsSomething((nested as Record<string, unknown>)[key])) throw orgSpecific(`${nestedKey}.${key}`);
      }
    }
  }
  // A builder condition on a site/device/group field names one org's object.
  if (Array.isArray(record.filterConditions)) {
    for (const condition of record.filterConditions) {
      const field = condition && typeof condition === 'object' ? (condition as Record<string, unknown>).field : undefined;
      if (typeof field === 'string' && ORG_SPECIFIC_CONDITION_FIELDS.has(field)) throw orgSpecific(`filterConditions.${field}`);
    }
  }
}
