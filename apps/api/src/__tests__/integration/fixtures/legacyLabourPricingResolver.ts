/**
 * Frozen W01 legacy oracle — test-only; never import into production code.
 * Verbatim resolveDefaultRate: services/timeEntryService.ts:246-254.
 * Verbatim billable expression: services/timeEntryService.ts:307.
 * References checked before W02 Tasks 6–7; the production service is unchanged.
 */
export function resolveDefaultRate(
  orgCurrency: string,
  org: { defaultHourlyRate: string | null; rateCurrency: string } | null,
  category: { defaultHourlyRate: string | null; rateCurrency: string | null } | null
): string | null {
  if (org?.defaultHourlyRate != null && org.rateCurrency === orgCurrency) return org.defaultHourlyRate;
  if (category?.defaultHourlyRate != null && category.rateCurrency === orgCurrency) return category.defaultHourlyRate;
  return null;
}

export interface LegacyOrgSettings {
  defaultBillable: boolean | null;
  defaultHourlyRate: string | null;
  rateCurrency: string;
}
export interface LegacyCategory {
  defaultBillable: boolean;
  defaultHourlyRate: string | null;
  rateCurrency: string | null;
}

export function legacyResolve({ orgSettings, category, orgCurrency }: {
  orgSettings: LegacyOrgSettings | null;
  category: LegacyCategory | null;
  orgCurrency: string;
}): { isBillable: boolean; hourlyRate: string | null } {
  return {
    isBillable: orgSettings?.defaultBillable ?? category?.defaultBillable ?? false,
    hourlyRate: resolveDefaultRate(orgCurrency, orgSettings, category),
  };
}
