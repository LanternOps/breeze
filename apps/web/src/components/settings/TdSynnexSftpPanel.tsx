import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Plug, RefreshCw, Search } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, handleActionError } from '../../lib/runAction';
import { isApiFailure, extractApiError } from '../../lib/apiError';
import { showToast } from '../shared/Toast';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';
import { formatNumber } from '@/lib/i18n/format';

// The API masks a populated password as this sentinel. It must never be echoed
// back on save (the service skips it, but the input is kept empty regardless so
// a "leave blank to keep current" save is the obvious default).
const MASKED = '********';
const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

const REGIONS = ['US', 'CA'] as const;
type Region = (typeof REGIONS)[number];

interface SftpStatus {
  configured: boolean;
  enabled: boolean;
  id?: string;
  region?: string;
  accountNumber?: string;
  // Derived server-side from region + account number. Rendered read-only so a
  // typo'd account number is obvious before the first nightly sync runs.
  username?: string | null;
  remoteFileName?: string | null;
  host?: string;
  credentials?: { password?: string };
  lastTestStatus?: string | null;
  lastTestAt?: string | null;
  lastTestError?: string | null;
  lastSyncStatus?: string | null;
  lastSyncAt?: string | null;
  lastSyncError?: string | null;
  lastFileName?: string | null;
  lastRowCount?: number | null;
}

interface SftpTestResult {
  success: boolean;
  fileFound: boolean;
  message?: string;
  error?: string | null;
}

// numeric columns come back from the API as strings (Drizzle numeric -> string).
interface SftpProduct {
  id?: string;
  synnexSku: string;
  mfgPartNo: string | null;
  name: string | null;
  description?: string | null;
  status?: string | null;
  currency: string | null;
  cost: string | number | null;
  msrp: string | number | null;
  totalQty: number | null;
  warehouses?: unknown;
  syncedAt?: string | null;
}

interface ConfigForm {
  enabled: boolean;
  region: Region;
  accountNumber: string;
  password: string;
}

const EMPTY_CONFIG: ConfigForm = {
  enabled: false,
  region: 'US',
  accountNumber: '',
  password: '',
};

function asRegion(value: string | undefined): Region {
  return REGIONS.includes(value as Region) ? (value as Region) : 'US';
}

function configFromStatus(status: SftpStatus | null): ConfigForm {
  if (!status) return EMPTY_CONFIG;
  return {
    enabled: status.enabled,
    region: asRegion(status.region),
    accountNumber: status.accountNumber ?? '',
    // Never seed the form with the mask sentinel — an empty field means
    // "keep the stored password".
    password: '',
  };
}

function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function TdSynnexSftpPanel() {
  const { t } = useTranslation('settings');
  const [status, setStatus] = useState<SftpStatus | null>(null);
  const [config, setConfig] = useState<ConfigForm>(EMPTY_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [testResult, setTestResult] = useState<SftpTestResult | null>(null);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [products, setProducts] = useState<SftpProduct[]>([]);
  const [searched, setSearched] = useState(false);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchWithAuth('/catalog/distributors/td-synnex-sftp/status');
      if (res.status === 401) {
        UNAUTHORIZED();
        return;
      }
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(errBody?.error ?? t('tdSynnexSftpPanel.tDSYNNEXPriceFileSettingsFailedToLoad'));
      }
      const body = (await res.json()) as { data: SftpStatus };
      setStatus(body.data);
      setConfig(configFromStatus(body.data));
    } catch (err) {
      console.error('[td-synnex-sftp] status load failed', err);
      showToast({
        message: err instanceof Error ? err.message : t('tdSynnexSftpPanel.tDSYNNEXPriceFileSettingsFailedToLoad'),
        type: 'error',
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  const loadProducts = useCallback(async (term: string) => {
    setSearching(true);
    try {
      const params = new URLSearchParams({ limit: '50', offset: '0' });
      if (term.trim()) params.set('q', term.trim());
      const res = await fetchWithAuth(`/catalog/distributors/td-synnex-sftp/products?${params.toString()}`);
      if (res.status === 401) {
        UNAUTHORIZED();
        return;
      }
      const body = (await res.json().catch(() => null)) as { data?: SftpProduct[]; error?: string } | null;
      // A null body means the response wasn't valid JSON — treat that as a
      // failure rather than silently rendering an empty result set.
      if (body === null) {
        throw new Error(t('tdSynnexSftpPanel.tDSYNNEXPriceFileSearchFailedInvalidResponse'));
      }
      if (isApiFailure(body, res.status)) {
        throw new Error(extractApiError(body, t('tdSynnexSftpPanel.tDSYNNEXPriceFileSearchFailed')));
      }
      setProducts(body?.data ?? []);
      setSearched(true);
    } catch (err) {
      showToast({
        message: err instanceof Error ? err.message : t('tdSynnexSftpPanel.tDSYNNEXPriceFileSearchFailed'),
        type: 'error',
      });
    } finally {
      setSearching(false);
    }
  }, []);

  const connectionLabel = useMemo(() => {
    // The service persists 'ok' / 'error' (not the EC panel's 'success'/'failed').
    if (status?.lastTestStatus === 'ok') return t('tdSynnexSftpPanel.lastTestSucceeded');
    if (status?.lastTestStatus === 'error') {
      return status.lastTestError ?? t('tdSynnexSftpPanel.lastTestFailed');
    }
    if (status?.configured) return t('tdSynnexSftpPanel.configured');
    return t('tdSynnexSftpPanel.notConfigured');
  }, [status, t]);

  const saveConfig = useCallback(async () => {
    setSaving(true);
    try {
      const password = config.password.trim();
      const result = await runAction<{ data: SftpStatus }>({
        request: () => fetchWithAuth('/catalog/distributors/td-synnex-sftp/config', {
          method: 'PUT',
          body: JSON.stringify({
            enabled: config.enabled,
            region: config.region,
            accountNumber: config.accountNumber.trim() || null,
            // Omit entirely when blank (or when it somehow still holds the mask)
            // so an unchanged password is never overwritten.
            ...(password && password !== MASKED ? { password } : {}),
          }),
        }),
        errorFallback: t('tdSynnexSftpPanel.tDSYNNEXPriceFileSettingsFailedToSave'),
        successMessage: t('tdSynnexSftpPanel.tDSYNNEXPriceFileSettingsSaved'),
        onUnauthorized: UNAUTHORIZED,
      });
      setStatus(result.data);
      setConfig(configFromStatus(result.data));
    } catch (err) {
      handleActionError(err, 'TD SYNNEX price file settings failed to save.');
    } finally {
      setSaving(false);
    }
  }, [config]);

  const testConnection = useCallback(async () => {
    setTesting(true);
    try {
      const result = await runAction<{ data: SftpTestResult }>({
        request: () => fetchWithAuth('/catalog/distributors/td-synnex-sftp/test', { method: 'POST' }),
        errorFallback: t('tdSynnexSftpPanel.tDSYNNEXPriceFileConnectionTestFailed'),
        onUnauthorized: UNAUTHORIZED,
      });
      const outcome = result.data;
      setTestResult(outcome);
      if (!outcome.success) {
        // The route answers HTTP 200 with { data: { success: false } }, which
        // runAction's top-level failure check cannot see — toast it here.
        showToast({
          message: outcome.error || t('tdSynnexSftpPanel.tDSYNNEXPriceFileConnectionTestFailed'),
          type: 'error',
        });
      } else {
        // A brand-new TD SYNNEX account authenticates ~24h before the first file
        // is generated. That is a successful connection, not a failure.
        showToast({
          message: outcome.fileFound
            ? t('tdSynnexSftpPanel.connectedAndTheNightlyFileWasFound')
            : t('tdSynnexSftpPanel.connectedButTheNightlyFileIsNotOnTheServerYet'),
          type: 'success',
        });
      }
    } catch (err) {
      handleActionError(err, 'TD SYNNEX price file connection test failed.');
    } finally {
      setTesting(false);
      // Refresh lastTestStatus / lastTestAt / lastTestError, which the test route
      // persists but does not return.
      void loadStatus();
    }
  }, [loadStatus]);

  const syncNow = useCallback(async () => {
    setSyncing(true);
    try {
      // Enqueues a background job — the toast must say "queued", never "synced".
      await runAction<{ data: { queued: boolean; jobId: string } }>({
        request: () => fetchWithAuth('/catalog/distributors/td-synnex-sftp/sync', { method: 'POST' }),
        errorFallback: t('tdSynnexSftpPanel.tDSYNNEXPriceFileSyncCouldNotBeQueued'),
        successMessage: t('tdSynnexSftpPanel.tDSYNNEXPriceFileSyncQueued'),
        onUnauthorized: UNAUTHORIZED,
      });
    } catch (err) {
      handleActionError(err, 'TD SYNNEX price file sync could not be queued.');
    } finally {
      setSyncing(false);
    }
  }, []);

  if (loading) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="td-synnex-sftp-loading">
        {t('tdSynnexSftpPanel.loadingTDSYNNEXPriceFile')}
      </p>
    );
  }

  const passwordConfigured = status?.credentials?.password === MASKED;

  return (
    <section className="space-y-4 border-t pt-6" data-testid="td-synnex-sftp-panel">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Plug className="h-4 w-4" aria-hidden="true" />
            {t('tdSynnexSftpPanel.tDSYNNEXPriceFile')}
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {t('tdSynnexSftpPanel.connectTheTDSYNNEXNightlySFTPPriceAndAvailabilityFeed')}
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="td-synnex-sftp-status-label">
          {status?.lastTestStatus === 'ok' && <CheckCircle2 className="h-4 w-4 text-green-600" aria-hidden="true" />}
          {connectionLabel}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-xs font-medium">
          {t('tdSynnexSftpPanel.region')}
          <select
            value={config.region}
            onChange={(e) => setConfig((f) => ({ ...f, region: asRegion(e.target.value) }))}
            className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            data-testid="td-synnex-sftp-region"
          >
            <option value="US">{t('tdSynnexSftpPanel.unitedStates')}</option>
            <option value="CA">{t('tdSynnexSftpPanel.canada')}</option>
          </select>
        </label>
        <label className="text-xs font-medium">
          {t('tdSynnexSftpPanel.accountNumber')}
          <input
            value={config.accountNumber}
            onChange={(e) => setConfig((f) => ({ ...f, accountNumber: e.target.value }))}
            inputMode="numeric"
            className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            data-testid="td-synnex-sftp-account-number"
          />
          <span className="mt-1 block font-normal text-muted-foreground">
            {t('tdSynnexSftpPanel.digitsOnlyTheSFTPUsernameAndFilenameAreDerivedFromIt')}
          </span>
        </label>
        <label className="text-xs font-medium">
          {t('tdSynnexSftpPanel.password')}
          <input
            value={config.password}
            onChange={(e) => setConfig((f) => ({ ...f, password: e.target.value }))}
            className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            placeholder={passwordConfigured ? MASKED : ''}
            type="password"
            autoComplete="new-password"
            data-testid="td-synnex-sftp-password"
          />
          {passwordConfigured && (
            <span className="mt-1 block font-normal text-muted-foreground" data-testid="td-synnex-sftp-password-hint">
              {t('tdSynnexSftpPanel.leaveBlankToKeepTheCurrentPassword')}
            </span>
          )}
        </label>
      </div>

      {/* Derived, server-computed connection details. Read-only on purpose: a
          typo'd account number shows up here immediately after a save. */}
      <dl className="grid gap-3 rounded-md border bg-muted/30 p-4 text-sm sm:grid-cols-3" data-testid="td-synnex-sftp-derived">
        <div>
          <dt className="text-xs text-muted-foreground">{t('tdSynnexSftpPanel.sFTPHost')}</dt>
          <dd data-testid="td-synnex-sftp-host">{status?.host ?? '-'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('tdSynnexSftpPanel.sFTPUsername')}</dt>
          <dd data-testid="td-synnex-sftp-username">{status?.username ?? '-'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('tdSynnexSftpPanel.remoteFile')}</dt>
          <dd data-testid="td-synnex-sftp-remote-file">{status?.remoteFileName ?? '-'}</dd>
        </div>
      </dl>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => setConfig((f) => ({ ...f, enabled: e.target.checked }))}
            data-testid="td-synnex-sftp-enabled"
          />
          {t('tdSynnexSftpPanel.enabled')}
        </label>
        <button
          type="button"
          onClick={() => void saveConfig()}
          disabled={saving}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          data-testid="td-synnex-sftp-save"
        >
          {saving ? t('tdSynnexSftpPanel.saving') : t('tdSynnexSftpPanel.saveSettings')}
        </button>
        <button
          type="button"
          onClick={() => void testConnection()}
          disabled={testing || !status?.configured}
          className="rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          data-testid="td-synnex-sftp-test"
        >
          {testing ? t('tdSynnexSftpPanel.testing') : t('tdSynnexSftpPanel.testConnection')}
        </button>
        <button
          type="button"
          onClick={() => void syncNow()}
          disabled={syncing || !status?.configured || !status?.enabled}
          className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          data-testid="td-synnex-sftp-sync"
        >
          <RefreshCw className={`h-4 w-4 ${syncing ? 'animate-spin' : ''}`} aria-hidden="true" />
          {syncing ? t('tdSynnexSftpPanel.queueing') : t('tdSynnexSftpPanel.syncNow')}
        </button>
      </div>

      {status?.lastTestStatus === 'error' && status.lastTestError && (
        <p className="text-sm text-red-600" data-testid="td-synnex-sftp-test-error">{status.lastTestError}</p>
      )}

      {/* Authenticated, but TD SYNNEX has not generated the file yet — an
          informational state, NOT a failure. */}
      {testResult?.success && !testResult.fileFound && (
        <p
          className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400"
          data-testid="td-synnex-sftp-file-pending"
        >
          <Clock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {t('tdSynnexSftpPanel.theConnectionWorksButTheFileIsNotAvailableYet')}
        </p>
      )}

      {/* Sync status */}
      <div className="space-y-2 border-t pt-4" data-testid="td-synnex-sftp-sync-status">
        <h3 className="text-sm font-semibold">{t('tdSynnexSftpPanel.lastSync')}</h3>
        <dl className="grid gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">{t('tdSynnexSftpPanel.status')}</dt>
            <dd data-testid="td-synnex-sftp-sync-state">
              {status?.lastSyncStatus ?? t('tdSynnexSftpPanel.never')}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('tdSynnexSftpPanel.when')}</dt>
            <dd data-testid="td-synnex-sftp-sync-at">
              {status?.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString() : '-'}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('tdSynnexSftpPanel.file')}</dt>
            <dd data-testid="td-synnex-sftp-last-file">{status?.lastFileName ?? '-'}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t('tdSynnexSftpPanel.rows')}</dt>
            <dd data-testid="td-synnex-sftp-last-row-count">
              {typeof status?.lastRowCount === 'number' ? formatNumber(status.lastRowCount) : '-'}
            </dd>
          </div>
        </dl>
        {status?.lastSyncError && (
          <p className="flex items-start gap-2 text-sm text-red-600" data-testid="td-synnex-sftp-sync-error">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            {status.lastSyncError}
          </p>
        )}
      </div>

      {/* Ingested price & availability rows */}
      <div className="space-y-3 border-t pt-4">
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void loadProducts(query);
              }}
              className="w-full rounded-md border bg-background py-1.5 pl-8 pr-2.5 text-sm"
              placeholder={t('tdSynnexSftpPanel.searchBySKUMfgPartOrName')}
              data-testid="td-synnex-sftp-search"
            />
          </div>
          <button
            type="button"
            onClick={() => void loadProducts(query)}
            disabled={searching}
            className="rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-50"
            data-testid="td-synnex-sftp-search-button"
          >
            {searching ? t('tdSynnexSftpPanel.searching') : t('tdSynnexSftpPanel.search')}
          </button>
        </div>

        {products.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y text-sm" data-testid="td-synnex-sftp-products">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="px-2 py-1 font-medium">{t('tdSynnexSftpPanel.sYNNEXSKU')}</th>
                  <th className="px-2 py-1 font-medium">{t('tdSynnexSftpPanel.mfgPartNo')}</th>
                  <th className="px-2 py-1 font-medium">{t('tdSynnexSftpPanel.name')}</th>
                  <th className="px-2 py-1 font-medium">{t('tdSynnexSftpPanel.cost')}</th>
                  <th className="px-2 py-1 font-medium">{t('tdSynnexSftpPanel.qty')}</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {products.map((product) => {
                  const cost = toNumber(product.cost);
                  return (
                    <tr key={product.synnexSku} data-testid={`td-synnex-sftp-product-${product.synnexSku}`}>
                      <td className="px-2 py-1">{product.synnexSku}</td>
                      <td className="px-2 py-1">{product.mfgPartNo ?? '-'}</td>
                      <td className="px-2 py-1">{product.name ?? '-'}</td>
                      <td className="px-2 py-1">
                        {cost !== null
                          ? `${product.currency ?? t('tdSynnexSftpPanel.uSD')} ${formatNumber(cost, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                          : '-'}
                      </td>
                      <td className="px-2 py-1">{product.totalQty ?? '-'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          searched && !searching && (
            <p className="text-sm text-muted-foreground" data-testid="td-synnex-sftp-products-empty">
              {t('tdSynnexSftpPanel.noPriceRowsYetRunASyncOnceTDSYNNEXHasGeneratedTheFile')}
            </p>
          )
        )}
      </div>
    </section>
  );
}

export default TdSynnexSftpPanel;
