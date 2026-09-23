/**
 * Config-shape rules shared by every web path that writes a business report
 * (#3198) — the create modal in `ReportTemplates`, and the edit page +
 * `ReportBuilder` save path.
 *
 * The server's business config schemas (`apps/api/src/services/
 * reportConfigSchemas.ts`, `BUSINESS_SELECTOR_REFUSALS`) answer 400 when any of
 * these legacy builder selectors "selects something": a business report
 * selects by its own period and its owner scope, never by these.
 */
export const BUSINESS_REFUSED_CONFIG_KEYS = [
  'dateRange',
  'filters',
  'sites',
  'orgId',
  'orgIds',
  'siteIds',
  'deviceIds',
] as const;

/** Every option key a business options form owns. The edit page drops these
 *  from the stored config before overlaying the form's mapped config, so an
 *  option the form deliberately OMITS (SLA "Automatic" group-by, AR unset
 *  as-of) does not survive from the stored row. */
export const BUSINESS_OPTION_CONFIG_KEYS = [
  'period',
  'groupBy',
  'includeNoSla',
  'weeklyCapacityHours',
  'asOf',
  'includePaidInPeriod',
] as const;

export function omitConfigKeys(
  config: Record<string, unknown> | undefined,
  keys: readonly string[],
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(config ?? {}) };
  for (const key of keys) delete next[key];
  return next;
}
