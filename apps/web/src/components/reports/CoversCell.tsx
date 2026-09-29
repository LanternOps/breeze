import { Building2, Layers } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * A multi-org series row's summary (W03 builds it from GET /reports/series).
 * The series kind renders only when this is passed with a `seriesId`.
 */
export type CoversSeriesSummary = {
  seriesId: string;
  targetMode: 'all' | 'selected';
  orgCount: number;
};

/**
 * What a saved report or run covers (multi-org report series spec §3.7):
 *  - org: an org-owned report — its org's name;
 *  - combined: a partner-owned report (`orgId` null — `reports_one_owner_chk`
 *    makes that partner-owned) — the existing cross-org aggregate;
 *  - series (W03): "All orgs · N" / "N orgs", one report per organization.
 * A W02 series CHILD row (seriesId and orgId both set) is an ordinary org row.
 */
export function CoversCell({
  testId,
  orgId,
  orgName,
  series,
}: {
  testId: string;
  /** The row's owning org; `null` = partner-owned; `undefined` = the API sent no owner. */
  orgId: string | null | undefined;
  orgName?: string | null;
  series?: CoversSeriesSummary | null;
}) {
  const { t } = useTranslation('reports');

  if (series?.seriesId) {
    const label =
      series.targetMode === 'all'
        ? t('reports.reportsList.covers.seriesAll', { count: series.orgCount })
        : t('reports.reportsList.covers.seriesSelected', { count: series.orgCount });
    return (
      <span
        data-testid={testId}
        data-covers-kind="series"
        className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
      >
        <Layers className="h-3 w-3" aria-hidden="true" />
        {label}
      </span>
    );
  }

  if (orgId === null) {
    return (
      <span
        data-testid={testId}
        data-covers-kind="combined"
        className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
      >
        <Layers className="h-3 w-3" aria-hidden="true" />
        {t('reports.reportsList.covers.combined')}
      </span>
    );
  }

  if (orgId === undefined) {
    return (
      <span data-testid={testId} data-covers-kind="unknown" className="text-sm text-muted-foreground">
        —
      </span>
    );
  }

  return (
    <span data-testid={testId} data-covers-kind="org" className="inline-flex items-center gap-1 text-sm">
      <Building2 className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
      {orgName ?? t('reports.reportsList.covers.unknownOrg')}
    </span>
  );
}
