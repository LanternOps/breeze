import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  TIME_SYNC_HEALTH,
  TIME_SYNC_FINDING_CODES,
  TIME_SYNC_DOMAIN_ROLES,
} from '@breeze/shared';
import '../../../lib/i18n';
import { fetchWithAuth } from '../../../stores/auth';
import { useOrgStore } from '../../../stores/orgStore';
import { useHashState } from '../../../lib/useHashState';
import { fetchAllSites } from '../../../lib/fetchAllSites';
import { downloadBlob } from '../../../lib/downloadBlob';
import {
  fleetQuery,
  INITIAL_FLEET_STATE,
  readFleetHash,
  type FleetState,
} from './fleetState';
import type { FleetTimeResult } from './fleetTypes';
import DomainGroupView, { TimeRows } from './DomainGroupView';
export default function FleetTimeSyncReport() {
  const { t } = useTranslation('devices');
  const currentOrgId = useOrgStore((s) => s.currentOrgId),
    organizations = useOrgStore((s) => s.organizations);
  const [state, setState] = useHashState(INITIAL_FLEET_STATE, readFleetHash);
  const [result, setResult] = useState<FleetTimeResult | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(false);
  const [sites, setSites] = useState<Array<{ id: string; name: string }>>([]),
    [siteError, setSiteError] = useState(false);
  const [refresh, setRefresh] = useState(0),
    [exporting, setExporting] = useState(false),
    [exportError, setExportError] = useState(false);
  const [from, setFrom] = useState(''),
    [to, setTo] = useState('');
  const query = useMemo(
    () => fleetQuery(state, currentOrgId).toString(),
    [state, currentOrgId],
  );
  const org = currentOrgId || state.orgId;
  const previousOrg = useRef(currentOrgId);
  const change = (patch: Partial<FleetState>) => {
    const next = { ...state, ...patch };
    setState(next);
    const hash = new URLSearchParams();
    for (const [key, value] of Object.entries(next))
      if (value !== '') hash.set(key, String(value));
    window.location.hash = hash.toString();
  };
  useEffect(() => {
    if (previousOrg.current === currentOrgId) return;
    previousOrg.current = currentOrgId;
    const next = { ...state, orgId: currentOrgId ?? '', siteId: '', page: 1 };
    setState(next);
    const hash = new URLSearchParams();
    for (const [key, value] of Object.entries(next))
      if (value !== '') hash.set(key, String(value));
    window.location.hash = hash.toString();
  }, [currentOrgId, state, setState]);
  useEffect(() => {
    const end = new Date();
    setTo(end.toISOString().slice(0, 10));
    setFrom(new Date(+end - 6 * 86_400_000).toISOString().slice(0, 10));
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError(false);
    setResult(null);
    void (async () => {
      try {
        const response = await fetchWithAuth(`/time-status?${query}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('load failed');
        const value = (await response.json()) as FleetTimeResult;
        if (active) setResult(value);
      } catch {
        if (active) setError(true);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
      controller.abort();
    };
  }, [query, refresh]);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setSites([]);
    setSiteError(false);
    void fetchAllSites<{ id: string; name: string }>(
      org
        ? `/orgs/sites?organizationId=${encodeURIComponent(org)}`
        : '/orgs/sites',
      { signal: controller.signal },
    )
      .then((value) => {
        if (active) setSites(value);
      })
      .catch(() => {
        if (active) setSiteError(true);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [org, refresh]);
  const rangeDays =
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000 +
    1;
  const validRange = Boolean(
    from &&
    to &&
    Number.isInteger(rangeDays) &&
    rangeDays >= 1 &&
    rangeDays <= 400,
  );
  async function download(history: boolean) {
    setExporting(true);
    setExportError(false);
    try {
      const params = new URLSearchParams(query);
      params.delete('page');
      params.delete('limit');
      if (history) {
        params.set('from', from);
        params.set('to', to);
      }
      const response = await fetchWithAuth(
        `/time-status/${history ? 'history/export' : 'export'}?${params}`,
      );
      if (!response.ok) throw new Error('export failed');
      const blob = await response.blob();
      downloadBlob(
        blob,
        history ? 'time-status-history.csv' : 'time-status.csv',
      );
    } catch {
      setExportError(true);
    } finally {
      setExporting(false);
    }
  }
  return (
    <div className="space-y-4" data-testid="fleet-time-sync">
      <div>
        <h1 className="text-2xl font-semibold">{t('timeFleet.title')}</h1>
        <p className="text-sm text-muted-foreground">
          {t('timeFleet.subtitle')}
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          {t('timeFleet.view')}
          <select
            className="ml-2 rounded border border-border bg-background p-2"
            value={state.view}
            data-testid="time-view"
            onChange={(e) =>
              change({
                view: e.target.value === 'domain' ? 'domain' : 'list',
                page: 1,
              })
            }
          >
            <option value="list">{t('timeFleet.list')}</option>
            <option value="domain">{t('timeFleet.byDomain')}</option>
          </select>
        </label>
        {(['health', 'finding', 'role'] as const).map((key) => (
          <label key={key} className="text-sm">
            {t(`timeFleet.${key}`)}
            <select
              className="ml-2 max-w-72 rounded border border-border bg-background p-2"
              value={state[key]}
              data-testid={`time-filter-${key}`}
              onChange={(e) => change({ [key]: e.target.value, page: 1 })}
            >
              <option value="">{t('timeFleet.all')}</option>
              {(key === 'health'
                ? TIME_SYNC_HEALTH
                : key === 'role'
                  ? TIME_SYNC_DOMAIN_ROLES
                  : TIME_SYNC_FINDING_CODES
              ).map((value) => (
                <option key={value} value={value}>
                  {key === 'finding'
                    ? t(`timeSync.findings.${value}.label`)
                    : t(
                        `timeFleet.${key === 'health' ? 'healthLabels' : 'roles'}.${value}`,
                      )}
                </option>
              ))}
            </select>
          </label>
        ))}
        <label className="text-sm">
          {t('timeFleet.organization')}
          <select
            className="ml-2 rounded border border-border bg-background p-2"
            value={org}
            disabled={Boolean(currentOrgId)}
            data-testid="time-filter-org"
            onChange={(e) =>
              change({ orgId: e.target.value, siteId: '', page: 1 })
            }
          >
            <option value="">{t('timeFleet.all')}</option>
            {organizations.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          {t('timeFleet.site')}
          <select
            className="ml-2 rounded border border-border bg-background p-2"
            value={state.siteId}
            data-testid="time-filter-site"
            onChange={(e) => change({ siteId: e.target.value, page: 1 })}
          >
            <option value="">{t('timeFleet.all')}</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="rounded border border-border px-3 py-2 text-sm"
          data-testid="time-refresh"
          onClick={() => setRefresh((n) => n + 1)}
        >
          {t('timeFleet.refresh')}
        </button>
      </div>
      {siteError && (
        <p role="alert" className="text-sm text-destructive">
          {t('timeFleet.siteError')}
        </p>
      )}
      <div className="flex flex-wrap items-end gap-3 rounded-md border border-border p-3">
        <button
          type="button"
          className="rounded border border-border px-3 py-2 text-sm disabled:opacity-50"
          data-testid="time-export-current"
          disabled={exporting}
          onClick={() => void download(false)}
        >
          {t('timeFleet.exportCurrent')}
        </button>
        <label className="text-sm">
          {t('timeFleet.from')}
          <input
            type="date"
            value={from}
            data-testid="time-from"
            className="ml-2 rounded border border-border bg-background p-2"
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label className="text-sm">
          {t('timeFleet.to')}
          <input
            type="date"
            value={to}
            data-testid="time-to"
            className="ml-2 rounded border border-border bg-background p-2"
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="rounded border border-border px-3 py-2 text-sm disabled:opacity-50"
          data-testid="time-export-history"
          disabled={exporting || !validRange}
          onClick={() => void download(true)}
        >
          {t('timeFleet.exportHistory')}
        </button>
        <p className="basis-full text-xs text-muted-foreground">
          {t('timeFleet.evidence')}
        </p>
        {!validRange && (
          <p className="text-xs text-destructive">
            {t('timeFleet.rangeError')}
          </p>
        )}
        {exportError && (
          <p
            role="alert"
            data-testid="time-export-error"
            className="text-sm text-destructive"
          >
            {t('timeFleet.exportError')}
          </p>
        )}
      </div>
      {loading && (
        <p role="status" data-testid="time-loading">
          {t('timeFleet.loading')}
        </p>
      )}
      {error && (
        <div role="alert" data-testid="time-load-error">
          <p>{t('timeFleet.loadError')}</p>
          <button
            type="button"
            data-testid="time-retry"
            onClick={() => setRefresh((n) => n + 1)}
          >
            {t('timeFleet.retry')}
          </button>
        </div>
      )}
      {!loading && !error && result && (
        <>
          <p className="text-sm text-muted-foreground">
            {t('timeFleet.count', { count: result.total })}
          </p>
          {result.data.length === 0 ? (
            <p data-testid="time-empty">{t('timeFleet.empty')}</p>
          ) : state.view === 'domain' ? (
            <DomainGroupView result={result} />
          ) : (
            <TimeRows rows={result.data} />
          )}
          <div className="flex items-center gap-3">
            <button
              type="button"
              data-testid="time-previous"
              disabled={state.page <= 1}
              onClick={() => change({ page: state.page - 1 })}
            >
              {t('timeFleet.previous')}
            </button>
            <span>{t('timeFleet.page', { page: result.page })}</span>
            <button
              type="button"
              data-testid="time-next"
              disabled={result.page * result.limit >= result.total}
              onClick={() => change({ page: state.page + 1 })}
            >
              {t('timeFleet.next')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
