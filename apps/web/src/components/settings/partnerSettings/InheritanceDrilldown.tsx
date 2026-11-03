import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { CATALOG_BY_ID, type CatalogEntry, type InheritanceOrgRowDto, type InheritanceOwnValueDto } from '@breeze/shared';
import '@/lib/i18n';
import { fetchFieldOrgs, type InheritanceBucket } from '@/lib/api/partnerSettingsInheritance';
import { formatInheritanceValue } from './formatInheritanceValue';

const K = 'partnerSettingsPage.inheritance.drill';

type PageState = {
  rows: InheritanceOrgRowDto[];
  nextCursor: string | null;
  status: 'loading' | 'ready' | 'error';
};

/** Pages of the orgs behind one count; a new field or bucket starts over and drops late pages. */
function useFieldOrgs(fieldId: string, bucket: InheritanceBucket) {
  const [state, setState] = useState<PageState>({ rows: [], nextCursor: null, status: 'loading' });
  const generation = useRef(0);

  const load = useCallback(async (cursor: string | null, gen: number) => {
    setState(s => ({ ...s, status: 'loading' }));
    try {
      const page = await fetchFieldOrgs(fieldId, cursor, bucket);
      if (generation.current !== gen) return;
      setState(s => ({ rows: cursor ? [...s.rows, ...page.rows] : page.rows, nextCursor: page.nextCursor, status: 'ready' }));
    } catch (err) {
      if (generation.current !== gen) return;
      console.warn(`[partner-settings] drill-down for ${fieldId} (${bucket}) failed`, err);
      setState(s => ({ ...s, status: 'error' }));
    }
  }, [fieldId, bucket]);

  useEffect(() => {
    const gen = ++generation.current;
    setState({ rows: [], nextCursor: null, status: 'loading' });
    void load(null, gen);
  }, [load]);

  // A failed first page retries from the start; a failed later page retries that page.
  const retry = useCallback(() => { void load(state.rows.length ? state.nextCursor : null, generation.current); }, [load, state.rows.length, state.nextCursor]);
  const loadMore = useCallback(() => { if (state.nextCursor) void load(state.nextCursor, generation.current); }, [load, state.nextCursor]);

  return { ...state, retry, loadMore };
}

/** An org's own value as display text: the projection, or Set / Not set. A sealed field is presence-only, always. */
export function ownValueText(entry: CatalogEntry, own: InheritanceOwnValueDto, t: TFunction, locale: string): string {
  if (!entry.secret && own.set && own.value !== undefined) {
    const formatted = formatInheritanceValue(entry, own.value, t, locale);
    if (formatted) return formatted;
  }
  return t(/* i18n-dynamic */ own.set ? `${K}.set` : `${K}.notSet`);
}

export function orgSettingsHref(orgId: string, entry: CatalogEntry): string {
  const base = `/settings/organizations/${encodeURIComponent(orgId)}`;
  return entry.orgSettingsHash ? `${base}#${entry.orgSettingsHash}` : base;
}

/**
 * The orgs behind one count of one field (spec §5.4, §5.7): name (a link to
 * the org's own settings tab), its own value, and whether that value is in
 * effect. Read-only: the org's value is changed from the org's own settings.
 */
export default function InheritanceDrilldown({ fieldId, bucket }: { fieldId: string; bucket: InheritanceBucket }) {
  const { t, i18n } = useTranslation(['settings', 'common']);
  const entry = CATALOG_BY_ID[fieldId];
  const { rows, nextCursor, status, retry, loadMore } = useFieldOrgs(fieldId, bucket);
  if (!entry) return null;

  return (
    <div data-testid="partner-settings-drilldown" className="space-y-3">
      <p className="text-xs text-muted-foreground">{t(/* i18n-dynamic */ `${K}.readOnly`)}</p>
      {rows.length > 0 && (
        <ul className="divide-y rounded-md border">
          {rows.map(row => (
            <li key={row.orgId} data-testid={`partner-settings-drilldown-row-${row.orgId}`} className="space-y-1 px-3 py-2 text-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <a href={orgSettingsHref(row.orgId, entry)} className="min-w-0 truncate font-medium text-primary hover:underline">
                  {row.orgName}
                </a>
                <span className={`text-xs ${row.inEffect ? 'text-foreground' : 'text-muted-foreground'}`}>
                  {t(/* i18n-dynamic */ row.inEffect ? `${K}.inEffect` : `${K}.notInEffect`)}
                </span>
              </div>
              <div className="text-xs text-muted-foreground">
                <span>{t(/* i18n-dynamic */ `${K}.ownValue`)}</span>{' '}
                <span className="text-foreground">{ownValueText(entry, row.ownValue, t, i18n.language)}</span>
              </div>
              {row.channels && row.channels.length > 0 && (
                <ul aria-label={t(/* i18n-dynamic */ `${K}.channels`)} className="space-y-0.5 border-l pl-3 text-xs">
                  {row.channels.map(ch => (
                    <li key={ch.channelId} data-testid={`partner-settings-drilldown-channel-${ch.channelId}`} className="flex justify-between gap-3">
                      <span className="min-w-0 truncate">{ch.name}</span>
                      <span className="text-muted-foreground">{ownValueText(entry, ch.ownValue, t, i18n.language)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      {status === 'ready' && rows.length === 0 && (
        <p className="text-sm text-muted-foreground">{t(/* i18n-dynamic */ `${K}.empty`)}</p>
      )}
      {status === 'loading' && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          {t(/* i18n-dynamic */ `${K}.loading`)}
        </p>
      )}
      {status === 'error' && (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-destructive">
          {t(/* i18n-dynamic */ `${K}.error`)}
          <button type="button" onClick={retry} data-testid="partner-settings-drilldown-retry"
            className="rounded-md border px-2 py-1 text-xs font-medium text-foreground hover:bg-muted">
            {t('common:actions.retry')}
          </button>
        </div>
      )}
      {status === 'ready' && nextCursor && (
        <button type="button" onClick={loadMore} data-testid="partner-settings-drilldown-more"
          className="w-full rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted">
          {t(/* i18n-dynamic */ `${K}.loadMore`)}
        </button>
      )}
    </div>
  );
}
