// apps/web/src/components/backup/BackupHealthOverview.tsx
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { BackupHealth, BackupHealthRow, BackupHealthSummary } from '@breeze/shared';

import { cn, widthPercentClass } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import BackupHealthDeviceTable from './BackupHealthDeviceTable';
import { recencyBuckets, statusBuckets } from './backupHealthBuckets';
import '../../lib/i18n';

type Filters = {
  health: BackupHealth | 'all';
  source: 'all' | 'breeze' | 'provider';
  search: string;
  withBackup: boolean;
};

const EMPTY_FILTERS: Filters = { health: 'all', source: 'all', search: '', withBackup: true };

function BarGroup({
  title,
  testIdPrefix,
  buckets,
  label,
}: {
  title: string;
  testIdPrefix: string;
  buckets: Array<{ id: string; count: number; percent: number; className: string }>;
  label: (id: string) => string;
}) {
  return (
    <div className="rounded-lg border bg-card p-5 shadow-xs">
      <h3 className="text-base font-semibold text-foreground">{title}</h3>
      <div className="mt-4 space-y-3">
        {buckets.map((bucket) => (
          <div key={bucket.id} data-testid={`${testIdPrefix}-${bucket.id}`} className="space-y-1">
            <div className="flex items-center justify-between text-sm">
              <span className="text-foreground">{label(bucket.id)}</span>
              <span className="text-xs text-muted-foreground">
                <span>{bucket.count}</span>
                <span> · </span>
                <span>{bucket.percent}</span>
                <span>%</span>
              </span>
            </div>
            {/* Same bar shape as the storage-provider bars (BackupOverviewContent.tsx:344). */}
            <div className="h-2 w-full rounded-full bg-muted">
              <div className={cn('h-2 rounded-full', bucket.className, widthPercentClass(bucket.percent))} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function BackupHealthOverview({ orgId }: { orgId: string | null }) {
  const { t } = useTranslation('backup');
  const [rows, setRows] = useState<BackupHealthRow[]>([]);
  const [summary, setSummary] = useState<BackupHealthSummary | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [unmappedDevices, setUnmappedDevices] = useState(0);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (cursor: string | null, append: boolean) => {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      if (orgId) params.set('orgId', orgId);
      if (filters.health !== 'all') params.set('health', filters.health);
      if (filters.source !== 'all') params.set('source', filters.source);
      if (filters.search.trim()) params.set('search', filters.search.trim());
      params.set('withBackup', String(filters.withBackup));
      if (cursor) params.set('cursor', cursor);
      try {
        const response = await fetchWithAuth(`/backup/health/devices?${params.toString()}`);
        if (!response.ok) throw new Error(`${response.status}`);
        const payload = await response.json();
        const data = payload?.data ?? {};
        setRows((current) => (append ? [...current, ...(data.rows ?? [])] : (data.rows ?? [])));
        setSummary(data.summary ?? null);
        setNextCursor(data.nextCursor ?? null);
        setStale(Boolean(data.stale));
        setUnmappedDevices(Number(data.unmappedDevices ?? 0));
      } catch (err) {
        console.error('[BackupHealthOverview] load:', err);
        // An empty table under a failed fetch reads as "nothing needs
        // attention". Say what actually happened instead.
        setError(t('backupHealth.error'));
      } finally {
        setLoading(false);
      }
    },
    [filters, orgId, t],
  );

  useEffect(() => {
    void load(null, false);
  }, [load]);

  const patchFilters = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-foreground">{t('backupHealth.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('backupHealth.subtitle')}</p>
      </div>

      {stale && (
        <div data-testid="backup-health-stale" className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t('backupHealth.staleBanner')}</span>
        </div>
      )}

      {unmappedDevices > 0 && (
        <div data-testid="backup-health-unmapped" className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
          {t('backupHealth.unmappedNotice', { value: unmappedDevices })}
        </div>
      )}

      {error && (
        <div data-testid="backup-health-error" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {summary && (
        <>
          <div className="flex flex-wrap gap-4 text-sm text-muted-foreground">
            <span data-testid="backup-health-coverage">
              {t('backupHealth.coverage', { covered: summary.endpoints.covered, total: summary.endpoints.total })}
            </span>
            <span data-testid="backup-health-provider-only">
              {t('backupHealth.providerOnly', { value: summary.providerOnly })}
            </span>
            <span data-testid="backup-health-m365">
              {t('backupHealth.m365Accounts', { value: summary.m365Accounts })}
            </span>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <BarGroup
              title={t('backupHealth.statusTitle')}
              testIdPrefix="backup-health-status"
              buckets={statusBuckets(summary.byStatus)}
              label={(id) => t(/* i18n-dynamic */ `backupHealth.status.${id}`)}
            />
            <BarGroup
              title={t('backupHealth.recencyTitle')}
              testIdPrefix="backup-health-recency"
              buckets={recencyBuckets(summary.byRecency)}
              label={(id) => t(/* i18n-dynamic */ `backupHealth.recency.${id}`)}
            />
          </div>
        </>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <select
          data-testid="backup-health-filter-health"
          value={filters.health}
          onChange={(e) => patchFilters({ health: e.target.value as Filters['health'] })}
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          <option value="all">{t('backupHealth.healthAll')}</option>
          {(['critical', 'warning', 'healthy', 'unknown'] as const).map((value) => (
            <option key={value} value={value}>
              {t(/* i18n-dynamic */ `backupHealth.health.${value}`)}
            </option>
          ))}
        </select>
        <select
          data-testid="backup-health-filter-source"
          value={filters.source}
          onChange={(e) => patchFilters({ source: e.target.value as Filters['source'] })}
          className="h-9 rounded-md border bg-background px-2 text-sm"
        >
          <option value="all">{t('backupHealth.sourceAll')}</option>
          <option value="breeze">{t('backupHealth.sourceBreeze')}</option>
          <option value="provider">{t('integrations:backupProviders.cove')}</option>
        </select>
        <input
          data-testid="backup-health-filter-search"
          value={filters.search}
          placeholder={t('backupHealth.searchPlaceholder')}
          onChange={(e) => patchFilters({ search: e.target.value })}
          className="h-9 min-w-[220px] rounded-md border bg-background px-2 text-sm"
        />
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            data-testid="backup-health-filter-without-backup"
            type="checkbox"
            checked={!filters.withBackup}
            onChange={(e) => patchFilters({ withBackup: !e.target.checked })}
          />
          <span>{t('backupHealth.includeWithoutBackup')}</span>
        </label>
        {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>

      {!error && <BackupHealthDeviceTable rows={rows} />}

      {nextCursor && (
        <div className="flex justify-center">
          <button
            type="button"
            data-testid="backup-health-load-more"
            disabled={loading}
            onClick={() => void load(nextCursor, true)}
            className="rounded-md border bg-card px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {t('backupHealth.loadMore')}
          </button>
        </div>
      )}
    </div>
  );
}
