import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useOrgStore, type Organization } from '../../../stores/orgStore';
import type { SeriesTargetMode, SeriesTargets } from './types';

/** Mirrors the reconciler's eligibility (spec §3.3): active or trial. */
export function eligibleOrganizations(orgs: Organization[] | undefined): Organization[] {
  return (orgs ?? [])
    .filter((o) => o.status === 'active' || o.status === 'trial')
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function coveredOrgCount(targets: SeriesTargets, eligible: Organization[]): number {
  const ids = new Set(targets.orgIds);
  return targets.targetMode === 'all'
    ? eligible.filter((o) => !ids.has(o.id)).length
    : eligible.filter((o) => ids.has(o.id)).length;
}

/**
 * All orgs (live) + exclusions, or Chosen orgs (spec D2). One checkbox list in
 * both modes, where "ticked" always means "covered"; `orgIds` keeps the stored
 * meaning (exclusions in 'all', inclusions in 'selected'). Ids of orgs not in
 * the eligible list (suspended, not loaded) are preserved untouched.
 */
export function SeriesTargetingFields({
  value,
  onChange,
}: {
  value: SeriesTargets;
  onChange: (next: SeriesTargets) => void;
}) {
  const { t } = useTranslation('reports');
  const { organizations } = useOrgStore();
  const eligible = useMemo(() => eligibleOrganizations(organizations), [organizations]);
  const [query, setQuery] = useState('');
  const ids = new Set(value.orgIds);
  const isCovered = (orgId: string) => (value.targetMode === 'all' ? !ids.has(orgId) : ids.has(orgId));
  const needle = query.trim().toLowerCase();
  const shown = needle ? eligible.filter((o) => o.name.toLowerCase().includes(needle)) : eligible;

  const setMode = (mode: SeriesTargetMode) => {
    if (mode === value.targetMode) return;
    onChange({ targetMode: mode, orgIds: [] });
  };
  const toggle = (orgId: string) =>
    onChange({
      targetMode: value.targetMode,
      orgIds: ids.has(orgId) ? value.orgIds.filter((id) => id !== orgId) : [...value.orgIds, orgId],
    });

  return (
    <fieldset data-testid="series-targeting" className="space-y-3">
      <legend className="text-xs font-medium uppercase text-muted-foreground">{t('reports.series.targeting.legend')}</legend>
      {(['all', 'selected'] as const).map((mode) => (
        <label key={mode} className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="series-target-mode"
            className="mt-1"
            data-testid={`series-target-mode-${mode}`}
            checked={value.targetMode === mode}
            onChange={() => setMode(mode)}
          />
          <span>
            <span className="font-medium">{t(/* i18n-dynamic */ `reports.series.targeting.${mode}`)}</span>
            <span className="block text-xs text-muted-foreground">{t(/* i18n-dynamic */ `reports.series.targeting.${mode}Hint`)}</span>
          </span>
        </label>
      ))}
      <input
        type="search"
        data-testid="series-target-search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('reports.series.targeting.search')}
        aria-label={t('reports.series.targeting.search')}
        className="h-9 w-full rounded-md border bg-background px-3 text-sm"
      />
      <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border p-2">
        {shown.length === 0 ? (
          <p className="px-1 py-2 text-xs text-muted-foreground">{t('reports.series.targeting.empty')}</p>
        ) : (
          shown.map((org) => (
            <label key={org.id} className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted/40">
              <input type="checkbox" data-testid={`series-target-org-${org.id}`} checked={isCovered(org.id)} onChange={() => toggle(org.id)} />
              {org.name}
            </label>
          ))
        )}
      </div>
      <p data-testid="series-target-summary" className="text-xs text-muted-foreground">
        {t('reports.series.targeting.summary', { covered: coveredOrgCount(value, eligible), total: eligible.length })}
      </p>
      {value.targetMode === 'selected' && value.orgIds.length === 0 && (
        <p data-testid="series-target-none-selected" role="status" className="text-xs text-destructive">
          {t('reports.series.targeting.noneSelected')}
        </p>
      )}
    </fieldset>
  );
}
