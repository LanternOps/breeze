import '@/lib/i18n';
import { useTranslation } from 'react-i18next';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Plug, Search } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, handleActionError } from '../../lib/runAction';
import { isApiFailure, extractApiError } from '../../lib/apiError';
import { showToast } from '../shared/Toast';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';
import { computeMarginBreakdown, priceFromCostMarkup, formatMarginSummary } from './marginMath';
import CatalogEnrichButton from '../catalog/CatalogEnrichButton';

const MASKED = '********';
const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

interface IntegrationStatus {
  configured: boolean;
  enabled: boolean;
  environment?: 'sandbox' | 'production';
  region?: string;
  baseUrl?: string;
  authType?: 'api_key' | 'bearer' | 'basic';
  credentials?: { apiKey?: string; apiSecret?: string };
  settings?: {
    accountId?: string;
    testPath?: string;
    searchPath?: string;
    searchMethod?: 'GET' | 'POST';
    detailsPath?: string;
    availabilityPath?: string;
  };
  lastTestStatus?: string | null;
  lastTestAt?: string | null;
  lastTestError?: string | null;
}

interface ConfigForm {
  enabled: boolean;
  environment: 'sandbox' | 'production';
  region: string;
  baseUrl: string;
  authType: 'api_key' | 'bearer' | 'basic';
  apiKey: string;
  apiSecret: string;
  accountId: string;
  testPath: string;
  searchPath: string;
  searchMethod: 'GET' | 'POST';
}

interface TdSynnexProduct {
  source: 'td_synnex_digital_bridge';
  sourceProductId: string;
  sku: string | null;
  manufacturerPartNumber: string | null;
  vendor: string | null;
  name: string;
  description: string | null;
  cost: string | null;
  currency: string | null;
  availability: number | null;
  warehouses: Array<Record<string, unknown>>;
  raw: Record<string, unknown>;
  lastRefreshedAt: string;
}

interface ImportForm {
  name: string;
  sku: string;
  description: string;
  unitPrice: string;
  costBasis: string;
  markupPercent: string;
  taxable: boolean;
}

const EMPTY_CONFIG: ConfigForm = {
  enabled: false,
  environment: 'sandbox',
  region: 'US',
  baseUrl: '',
  authType: 'api_key',
  apiKey: '',
  apiSecret: '',
  accountId: '',
  testPath: '',
  searchPath: '',
  searchMethod: 'GET',
};

function configFromStatus(status: IntegrationStatus | null): ConfigForm {
  if (!status?.configured && !status?.baseUrl) return EMPTY_CONFIG;
  return {
    enabled: status.enabled,
    environment: status.environment ?? 'sandbox',
    region: status.region ?? 'US',
    baseUrl: status.baseUrl ?? '',
    authType: status.authType ?? 'api_key',
    apiKey: status.credentials?.apiKey ?? '',
    apiSecret: status.credentials?.apiSecret ?? '',
    accountId: status.settings?.accountId ?? '',
    testPath: status.settings?.testPath ?? '',
    searchPath: status.settings?.searchPath ?? '',
    searchMethod: status.settings?.searchMethod ?? 'GET',
  };
}

function productImportDefaults(
  product: TdSynnexProduct,
  defaultMarkupPct: number | null,
  autoTaxHardware: boolean,
): ImportForm {
  const cost = product.cost ?? '';
  const costNum = Number(cost);
  // Apply the partner's default markup (over cost) to pre-fill the sell
  // price when we have a numeric cost. Fall back to cost == price otherwise.
  const hasMarkup = defaultMarkupPct != null && cost !== '' && Number.isFinite(costNum);
  const unitPrice = hasMarkup ? String(priceFromCostMarkup(costNum, defaultMarkupPct)) : cost;
  return {
    name: product.name,
    sku: product.sku ?? product.manufacturerPartNumber ?? '',
    description: product.description ?? '',
    unitPrice,
    costBasis: cost,
    markupPercent: hasMarkup ? String(defaultMarkupPct) : '',
    // Distributor imports are hardware; default taxable to the partner policy.
    taxable: autoTaxHardware,
  };
}

function toMoney(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

export default function TdSynnexCatalogPanel({ onImported }: { onImported?: () => void }) {
  const { t } = useTranslation('settings');
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [config, setConfig] = useState<ConfigForm>(EMPTY_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [products, setProducts] = useState<TdSynnexProduct[]>([]);
  const [draftProduct, setDraftProduct] = useState<TdSynnexProduct | null>(null);
  const [importForm, setImportForm] = useState<ImportForm | null>(null);
  const [importing, setImporting] = useState(false);
  // Partner-level default markup % used to pre-fill the sell price.
  const [defaultMarkupPct, setDefaultMarkupPct] = useState<number | null>(null);
  // Partner policy: do newly imported (hardware) items default to taxable?
  const [autoTaxHardware, setAutoTaxHardware] = useState(true);
  const endpointReady = config.searchPath.trim().length > 0;

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchWithAuth('/catalog/distributors/td-synnex/status');
      if (res.status === 401) {
        UNAUTHORIZED();
        return;
      }
      if (!res.ok) throw new Error(t('tdSynnexCatalogPanel.failed'));
      const body = (await res.json()) as { data: IntegrationStatus };
      setStatus(body.data);
      setConfig(configFromStatus(body.data));
    } catch (err) {
      console.error('[td-synnex] status load failed', err);
      showToast({ message: t('tdSynnexCatalogPanel.tDSYNNEXSettingsFailedToLoad'), type: 'error' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  // Load the partner default markup once so imports can pre-fill the sell price.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithAuth('/orgs/partners/me');
        if (!res.ok) return;
        const p = (await res.json()) as { defaultMarkupPercent?: string | number | null; autoTaxHardware?: boolean };
        if (cancelled) return;
        if (p.defaultMarkupPercent != null) {
          const pct = Number(p.defaultMarkupPercent);
          if (Number.isFinite(pct)) setDefaultMarkupPct(pct);
        }
        if (typeof p.autoTaxHardware === 'boolean') setAutoTaxHardware(p.autoTaxHardware);
      } catch {
        // Non-fatal: import just falls back to cost == price.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const connectionLabel = useMemo(() => {
    if (status?.lastTestStatus === 'success') return t('tdSynnexCatalogPanel.lastTestSucceeded');
    if (status?.lastTestStatus === 'failed') return status.lastTestError ?? t('tdSynnexCatalogPanel.lastTestFailed');
    if (status?.configured) return t('tdSynnexCatalogPanel.configured');
    return t('tdSynnexCatalogPanel.notConfigured');
  }, [status, t]);

  const saveConfig = useCallback(async () => {
    setSaving(true);
    try {
      const result = await runAction<{ data: IntegrationStatus }>({
        request: () => fetchWithAuth('/catalog/distributors/td-synnex/config', {
          method: 'PUT',
          body: JSON.stringify({
            enabled: config.enabled,
            environment: config.environment,
            region: config.region.trim(),
            baseUrl: config.baseUrl.trim(),
            authType: config.authType,
            credentials: {
              apiKey: config.apiKey.trim(),
              apiSecret: config.apiSecret.trim(),
            },
            settings: {
              accountId: config.accountId.trim() || undefined,
              testPath: config.testPath.trim() || undefined,
              searchPath: config.searchPath.trim() || undefined,
              searchMethod: config.searchMethod,
            },
          }),
        }),
        errorFallback: t('tdSynnexCatalogPanel.tDSYNNEXSettingsFailedToSave'),
        successMessage: t('tdSynnexCatalogPanel.tDSYNNEXSettingsSaved'),
        onUnauthorized: UNAUTHORIZED,
      });
      setStatus(result.data);
      setConfig(configFromStatus(result.data));
    } catch (err) {
      handleActionError(err, 'TD SYNNEX settings failed to save.');
    } finally {
      setSaving(false);
    }
  }, [config]);

  const testConnection = useCallback(async () => {
    setTesting(true);
    try {
      const result = await runAction<{ data: IntegrationStatus }>({
        request: () => fetchWithAuth('/catalog/distributors/td-synnex/test', { method: 'POST' }),
        errorFallback: t('tdSynnexCatalogPanel.tDSYNNEXConnectionTestFailed'),
        successMessage: t('tdSynnexCatalogPanel.tDSYNNEXConnectionTestSucceeded'),
        onUnauthorized: UNAUTHORIZED,
      });
      setStatus(result.data);
      setConfig(configFromStatus(result.data));
    } catch (err) {
      handleActionError(err, 'TD SYNNEX connection test failed.');
      void loadStatus();
    } finally {
      setTesting(false);
    }
  }, [loadStatus]);

  const searchProducts = useCallback(async () => {
    if (!query.trim()) return;
    setSearching(true);
    setProducts([]);
    try {
      const res = await fetchWithAuth(`/catalog/distributors/td-synnex/search?q=${encodeURIComponent(query.trim())}&limit=20`);
      if (res.status === 401) {
        UNAUTHORIZED();
        return;
      }
      const body = await res.json().catch(() => null) as { data?: TdSynnexProduct[]; error?: string } | null;
      // Honor the runAction failure contract: a non-2xx status OR an HTTP-200
      // { success:false } body both count as failures (CLAUDE.md no-silent-mutations).
      if (isApiFailure(body, res.status)) {
        throw new Error(extractApiError(body, t('tdSynnexCatalogPanel.tDSYNNEXSearchFailed')));
      }
      setProducts(body?.data ?? []);
    } catch (err) {
      showToast({ message: err instanceof Error ? err.message : t('tdSynnexCatalogPanel.tDSYNNEXSearchFailed'), type: 'error' });
    } finally {
      setSearching(false);
    }
  }, [query]);

  const openImport = (product: TdSynnexProduct) => {
    setDraftProduct(product);
    setImportForm(productImportDefaults(product, defaultMarkupPct, autoTaxHardware));
  };

  const importProduct = useCallback(async () => {
    if (!draftProduct || !importForm) return;
    const unitPrice = toMoney(importForm.unitPrice);
    if (unitPrice === null) {
      showToast({ message: t('tdSynnexCatalogPanel.enterAValidSellPrice'), type: 'error' });
      return;
    }
    setImporting(true);
    try {
      await runAction({
        request: () => fetchWithAuth('/catalog/distributors/td-synnex/import', {
          method: 'POST',
          body: JSON.stringify({
            product: draftProduct,
            item: {
              name: importForm.name.trim(),
              sku: importForm.sku.trim() || null,
              description: importForm.description.trim() || null,
              unitPrice,
              costBasis: toMoney(importForm.costBasis),
              markupPercent: toMoney(importForm.markupPercent),
              taxable: importForm.taxable,
            },
          }),
        }),
        errorFallback: t('tdSynnexCatalogPanel.tDSYNNEXItemImportFailed'),
        successMessage: t('tdSynnexCatalogPanel.imported', { name: importForm.name.trim() }),
        onUnauthorized: UNAUTHORIZED,
      });
      setDraftProduct(null);
      setImportForm(null);
      if (onImported) onImported();
    } catch (err) {
      handleActionError(err, 'TD SYNNEX item import failed.');
    } finally {
      setImporting(false);
    }
  }, [draftProduct, importForm, onImported]);

  if (loading) {
    return <p className="text-sm text-muted-foreground" data-testid="td-synnex-loading">{t('tdSynnexCatalogPanel.loadingTDSYNNEX')}</p>;
  }

  return (
    <section className="space-y-4 border-t pt-6" data-testid="td-synnex-panel">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Plug className="h-4 w-4" aria-hidden="true" />
            {t('tdSynnexCatalogPanel.tDSYNNEX')}</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {t('tdSynnexCatalogPanel.connectDigitalBridgeToSearchRealTimeDistributorCatalogDa')}</p>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="td-synnex-status-label">
          {status?.lastTestStatus === 'success' && <CheckCircle2 className="h-4 w-4 text-green-600" aria-hidden="true" />}
          {connectionLabel}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-xs font-medium">
          {t('tdSynnexCatalogPanel.baseURL')}<input
            value={config.baseUrl}
            onChange={(e) => setConfig((f) => ({ ...f, baseUrl: e.target.value }))}
            className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            placeholder={t('tdSynnexCatalogPanel.https')}
            data-testid="td-synnex-base-url"
          />
        </label>
        <label className="text-xs font-medium">
          {t('tdSynnexCatalogPanel.region')}<input
            value={config.region}
            onChange={(e) => setConfig((f) => ({ ...f, region: e.target.value }))}
            className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            data-testid="td-synnex-region"
          />
        </label>
        <label className="text-xs font-medium">
          {t('tdSynnexCatalogPanel.environment')}<select
            value={config.environment}
            onChange={(e) => setConfig((f) => ({ ...f, environment: e.target.value as ConfigForm['environment'] }))}
            className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            data-testid="td-synnex-environment"
          >
            <option value="sandbox">{t('tdSynnexCatalogPanel.sandbox')}</option>
            <option value="production">{t('tdSynnexCatalogPanel.production')}</option>
          </select>
        </label>
        <label className="text-xs font-medium">
          {t('tdSynnexCatalogPanel.authType')}<select
            value={config.authType}
            onChange={(e) => setConfig((f) => ({ ...f, authType: e.target.value as ConfigForm['authType'] }))}
            className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            data-testid="td-synnex-auth-type"
          >
            <option value="api_key">{t('tdSynnexCatalogPanel.aPIKeyHeaders')}</option>
            <option value="bearer">{t('tdSynnexCatalogPanel.bearerToken')}</option>
            <option value="basic">{t('tdSynnexCatalogPanel.basicAuth')}</option>
          </select>
        </label>
        <label className="text-xs font-medium">
          {t('tdSynnexCatalogPanel.aPIKey')}<input
            value={config.apiKey}
            onChange={(e) => setConfig((f) => ({ ...f, apiKey: e.target.value }))}
            className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            placeholder={MASKED}
            data-testid="td-synnex-api-key"
          />
        </label>
        <label className="text-xs font-medium">
          {t('tdSynnexCatalogPanel.aPISecret')}<input
            value={config.apiSecret}
            onChange={(e) => setConfig((f) => ({ ...f, apiSecret: e.target.value }))}
            className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            placeholder={MASKED}
            type="password"
            data-testid="td-synnex-api-secret"
          />
        </label>
        <label className="text-xs font-medium">
          {t('tdSynnexCatalogPanel.accountID')}<input
            value={config.accountId}
            onChange={(e) => setConfig((f) => ({ ...f, accountId: e.target.value }))}
            className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            data-testid="td-synnex-account-id"
          />
        </label>
        <label className="text-xs font-medium">
          {t('tdSynnexCatalogPanel.testPath')}<input
            value={config.testPath}
            onChange={(e) => setConfig((f) => ({ ...f, testPath: e.target.value }))}
            className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            placeholder="/..."
            data-testid="td-synnex-test-path"
          />
        </label>
        <label className="text-xs font-medium">
          {t('tdSynnexCatalogPanel.searchPath')}<input
            value={config.searchPath}
            onChange={(e) => setConfig((f) => ({ ...f, searchPath: e.target.value }))}
            className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            placeholder="/..."
            data-testid="td-synnex-search-path"
          />
        </label>
        <label className="text-xs font-medium">
          {t('tdSynnexCatalogPanel.searchMethod')}<select
            value={config.searchMethod}
            onChange={(e) => setConfig((f) => ({ ...f, searchMethod: e.target.value as ConfigForm['searchMethod'] }))}
            className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            data-testid="td-synnex-search-method"
          >
            <option value="GET">{t('tdSynnexCatalogPanel.gET')}</option>
            <option value="POST">{t('tdSynnexCatalogPanel.pOST')}</option>
          </select>
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => setConfig((f) => ({ ...f, enabled: e.target.checked }))}
            data-testid="td-synnex-enabled"
          />
          {t('tdSynnexCatalogPanel.enabled')}</label>
        <button
          type="button"
          onClick={() => void saveConfig()}
          disabled={saving || !config.baseUrl.trim()}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          data-testid="td-synnex-save"
        >
          {saving ? t('tdSynnexCatalogPanel.saving') : t('tdSynnexCatalogPanel.saveSettings')}
        </button>
        <button
          type="button"
          onClick={() => void testConnection()}
          disabled={testing || !config.enabled || !config.testPath.trim()}
          className="rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          data-testid="td-synnex-test"
        >
          {testing ? t('tdSynnexCatalogPanel.testing') : t('tdSynnexCatalogPanel.testConnection')}
        </button>
      </div>

      <div className="space-y-3 border-t pt-4">
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void searchProducts();
              }}
              className="w-full rounded-md border bg-background py-1.5 pl-8 pr-2.5 text-sm"
              placeholder={t('tdSynnexCatalogPanel.searchBySKUManufacturerPartNumberOrProductName')}
              data-testid="td-synnex-search-query"
            />
          </div>
          <button
            type="button"
            onClick={() => void searchProducts()}
            disabled={searching || !query.trim() || !status?.enabled || !endpointReady}
            className="rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-50"
            data-testid="td-synnex-search"
          >
            {searching ? t('tdSynnexCatalogPanel.searching') : t('tdSynnexCatalogPanel.searchProducts')}
          </button>
        </div>

        {products.length > 0 && (
          <table className="min-w-full divide-y text-sm" data-testid="td-synnex-results">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="px-3 py-2 font-medium">{t('tdSynnexCatalogPanel.product')}</th>
                <th className="px-3 py-2 font-medium">{t('tdSynnexCatalogPanel.sKU')}</th>
                <th className="px-3 py-2 font-medium">{t('tdSynnexCatalogPanel.cost')}</th>
                <th className="px-3 py-2 font-medium">{t('tdSynnexCatalogPanel.available')}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {products.map((product) => (
                <tr key={product.sourceProductId} data-testid={`td-synnex-result-${product.sourceProductId}`}>
                  <td className="px-3 py-2">
                    <div className="font-medium">{product.name}</div>
                    <div className="text-xs text-muted-foreground">{product.vendor ?? t('tdSynnexCatalogPanel.unknownVendor')}</div>
                  </td>
                  <td className="px-3 py-2">{product.sku ?? product.manufacturerPartNumber ?? t('tdSynnexCatalogPanel.nA')}</td>
                  <td className="px-3 py-2">{product.cost ? `${product.currency ?? t('tdSynnexCatalogPanel.uSD')} ${product.cost}` : t('tdSynnexCatalogPanel.nA')}</td>
                  <td className="px-3 py-2">{product.availability ?? t('tdSynnexCatalogPanel.nA')}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => openImport(product)}
                      className="text-sm text-primary hover:underline"
                      data-testid={`td-synnex-import-open-${product.sourceProductId}`}
                    >
                      {t('tdSynnexCatalogPanel.import')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {draftProduct && importForm && (
          <div className="space-y-3 rounded-md border bg-muted/30 p-4" data-testid="td-synnex-import-editor">
            <div>
              <h3 className="text-sm font-semibold">{t('tdSynnexCatalogPanel.importProduct')}</h3>
              <p className="mt-1 text-xs text-muted-foreground">{draftProduct.name}</p>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="text-xs font-medium">
                {t('tdSynnexCatalogPanel.name')}<input value={importForm.name} onChange={(e) => setImportForm((f) => f && ({ ...f, name: e.target.value }))} className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm" data-testid="td-synnex-import-name" />
              </label>
              <label className="text-xs font-medium">
                {t('tdSynnexCatalogPanel.sKU')}<input value={importForm.sku} onChange={(e) => setImportForm((f) => f && ({ ...f, sku: e.target.value }))} className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm" data-testid="td-synnex-import-sku" />
              </label>
              <label className="text-xs font-medium">
                {t('tdSynnexCatalogPanel.sellPrice')}<input value={importForm.unitPrice} onChange={(e) => setImportForm((f) => f && ({ ...f, unitPrice: e.target.value }))} inputMode="decimal" className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm" data-testid="td-synnex-import-price" />
              </label>
              <label className="text-xs font-medium">
                {t('tdSynnexCatalogPanel.costBasis')}<input value={importForm.costBasis} onChange={(e) => setImportForm((f) => f && ({ ...f, costBasis: e.target.value }))} inputMode="decimal" className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm" data-testid="td-synnex-import-cost" />
              </label>
              <label className="text-xs font-medium">
                {t('tdSynnexCatalogPanel.markupPercent')}<input value={importForm.markupPercent} onChange={(e) => setImportForm((f) => f && ({ ...f, markupPercent: e.target.value }))} inputMode="decimal" className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm" data-testid="td-synnex-import-markup" />
              </label>
              <label className="flex items-end gap-2 text-sm">
                <input type="checkbox" checked={importForm.taxable} onChange={(e) => setImportForm((f) => f && ({ ...f, taxable: e.target.checked }))} data-testid="td-synnex-import-taxable" />
                {t('tdSynnexCatalogPanel.taxable')}</label>
              <div className="md:col-span-2" data-testid="td-synnex-import-enrich">
                <p className="text-xs font-medium">{t('tdSynnexCatalogPanel.cleanUpNameAmpDescriptionWithAI')}</p>
                <p className="mb-2 mt-0.5 text-xs text-muted-foreground">
                  {t('tdSynnexCatalogPanel.searchTheWebByProductNameOrSKUToRewriteTheRawDistributor')}</p>
                <CatalogEnrichButton
                  hint="hardware"
                  idSuffix="td-synnex-import"
                  onApply={(result) => setImportForm((f) => f && ({
                    ...f,
                    name: result.draft.name || f.name,
                    description: result.draft.description ?? f.description,
                  }))}
                />
              </div>
              <label className="text-xs font-medium md:col-span-2">
                {t('tdSynnexCatalogPanel.description')}<textarea value={importForm.description} onChange={(e) => setImportForm((f) => f && ({ ...f, description: e.target.value }))} className="mt-1 min-h-20 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm" data-testid="td-synnex-import-description" />
              </label>
            </div>
            {(() => {
              const breakdown = computeMarginBreakdown(toMoney(importForm.costBasis), toMoney(importForm.unitPrice));
              if (!breakdown) return null;
              const negative = breakdown.profit < 0;
              return (
                <p
                  className={`text-xs font-medium ${negative ? 'text-red-600' : 'text-muted-foreground'}`}
                  data-testid="td-synnex-import-margin"
                >
                  {formatMarginSummary(breakdown, draftProduct.currency ?? t('tdSynnexCatalogPanel.uSD'))}
                  {negative ? ' — selling below cost' : ''}
                </p>
              );
            })()}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void importProduct()}
                disabled={importing || !importForm.name.trim() || toMoney(importForm.unitPrice) === null}
                className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                data-testid="td-synnex-import-save"
              >
                {importing ? t('tdSynnexCatalogPanel.importing') : t('tdSynnexCatalogPanel.importItem')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setDraftProduct(null);
                  setImportForm(null);
                }}
                className="rounded-md border px-3 py-1.5 text-sm font-medium"
                data-testid="td-synnex-import-cancel"
              >
                {t('tdSynnexCatalogPanel.cancel')}</button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
