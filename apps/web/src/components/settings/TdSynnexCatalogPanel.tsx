import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Plug, Search } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, handleActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { navigateTo } from '@/lib/navigation';
import { loginPathWithNext } from '../../lib/authScope';

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

function productImportDefaults(product: TdSynnexProduct): ImportForm {
  const cost = product.cost ?? '';
  return {
    name: product.name,
    sku: product.sku ?? product.manufacturerPartNumber ?? '',
    description: product.description ?? '',
    unitPrice: cost,
    costBasis: cost,
    markupPercent: '',
    taxable: true,
  };
}

function toMoney(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

export default function TdSynnexCatalogPanel({ onImported }: { onImported?: () => void }) {
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
  const endpointReady = config.searchPath.trim().length > 0;

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchWithAuth('/catalog/distributors/td-synnex/status');
      if (res.status === 401) {
        UNAUTHORIZED();
        return;
      }
      if (!res.ok) throw new Error('failed');
      const body = (await res.json()) as { data: IntegrationStatus };
      setStatus(body.data);
      setConfig(configFromStatus(body.data));
    } catch {
      showToast({ message: 'TD SYNNEX settings failed to load.', type: 'error' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  const connectionLabel = useMemo(() => {
    if (status?.lastTestStatus === 'success') return 'Last test succeeded';
    if (status?.lastTestStatus === 'failed') return status.lastTestError ?? 'Last test failed';
    if (status?.configured) return 'Configured';
    return 'Not configured';
  }, [status]);

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
        errorFallback: 'TD SYNNEX settings failed to save.',
        successMessage: 'TD SYNNEX settings saved',
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
        errorFallback: 'TD SYNNEX connection test failed.',
        successMessage: 'TD SYNNEX connection test succeeded',
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
      if (!res.ok) throw new Error(body?.error ?? 'Search failed');
      setProducts(body?.data ?? []);
    } catch (err) {
      showToast({ message: err instanceof Error ? err.message : 'TD SYNNEX search failed.', type: 'error' });
    } finally {
      setSearching(false);
    }
  }, [query]);

  const openImport = (product: TdSynnexProduct) => {
    setDraftProduct(product);
    setImportForm(productImportDefaults(product));
  };

  const importProduct = useCallback(async () => {
    if (!draftProduct || !importForm) return;
    const unitPrice = toMoney(importForm.unitPrice);
    if (unitPrice === null) {
      showToast({ message: 'Enter a valid sell price.', type: 'error' });
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
        errorFallback: 'TD SYNNEX item import failed.',
        successMessage: `Imported ${importForm.name.trim()}`,
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
    return <p className="text-sm text-muted-foreground" data-testid="td-synnex-loading">Loading TD SYNNEX.</p>;
  }

  return (
    <section className="space-y-4 border-t pt-6" data-testid="td-synnex-panel">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Plug className="h-4 w-4" aria-hidden="true" />
            TD SYNNEX
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Connect Digital Bridge to search real-time distributor catalog data and import hardware into Breeze.
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="td-synnex-status-label">
          {status?.lastTestStatus === 'success' && <CheckCircle2 className="h-4 w-4 text-green-600" aria-hidden="true" />}
          {connectionLabel}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-xs font-medium">
          Base URL
          <input
            value={config.baseUrl}
            onChange={(e) => setConfig((f) => ({ ...f, baseUrl: e.target.value }))}
            className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            placeholder="https://..."
            data-testid="td-synnex-base-url"
          />
        </label>
        <label className="text-xs font-medium">
          Region
          <input
            value={config.region}
            onChange={(e) => setConfig((f) => ({ ...f, region: e.target.value }))}
            className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            data-testid="td-synnex-region"
          />
        </label>
        <label className="text-xs font-medium">
          Environment
          <select
            value={config.environment}
            onChange={(e) => setConfig((f) => ({ ...f, environment: e.target.value as ConfigForm['environment'] }))}
            className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            data-testid="td-synnex-environment"
          >
            <option value="sandbox">Sandbox</option>
            <option value="production">Production</option>
          </select>
        </label>
        <label className="text-xs font-medium">
          Auth type
          <select
            value={config.authType}
            onChange={(e) => setConfig((f) => ({ ...f, authType: e.target.value as ConfigForm['authType'] }))}
            className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            data-testid="td-synnex-auth-type"
          >
            <option value="api_key">API key headers</option>
            <option value="bearer">Bearer token</option>
            <option value="basic">Basic auth</option>
          </select>
        </label>
        <label className="text-xs font-medium">
          API key
          <input
            value={config.apiKey}
            onChange={(e) => setConfig((f) => ({ ...f, apiKey: e.target.value }))}
            className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            placeholder={MASKED}
            data-testid="td-synnex-api-key"
          />
        </label>
        <label className="text-xs font-medium">
          API secret
          <input
            value={config.apiSecret}
            onChange={(e) => setConfig((f) => ({ ...f, apiSecret: e.target.value }))}
            className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            placeholder={MASKED}
            type="password"
            data-testid="td-synnex-api-secret"
          />
        </label>
        <label className="text-xs font-medium">
          Account ID
          <input
            value={config.accountId}
            onChange={(e) => setConfig((f) => ({ ...f, accountId: e.target.value }))}
            className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            data-testid="td-synnex-account-id"
          />
        </label>
        <label className="text-xs font-medium">
          Test path
          <input
            value={config.testPath}
            onChange={(e) => setConfig((f) => ({ ...f, testPath: e.target.value }))}
            className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            placeholder="/..."
            data-testid="td-synnex-test-path"
          />
        </label>
        <label className="text-xs font-medium">
          Search path
          <input
            value={config.searchPath}
            onChange={(e) => setConfig((f) => ({ ...f, searchPath: e.target.value }))}
            className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            placeholder="/..."
            data-testid="td-synnex-search-path"
          />
        </label>
        <label className="text-xs font-medium">
          Search method
          <select
            value={config.searchMethod}
            onChange={(e) => setConfig((f) => ({ ...f, searchMethod: e.target.value as ConfigForm['searchMethod'] }))}
            className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            data-testid="td-synnex-search-method"
          >
            <option value="GET">GET</option>
            <option value="POST">POST</option>
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
          Enabled
        </label>
        <button
          type="button"
          onClick={() => void saveConfig()}
          disabled={saving || !config.baseUrl.trim()}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          data-testid="td-synnex-save"
        >
          {saving ? 'Saving.' : 'Save settings'}
        </button>
        <button
          type="button"
          onClick={() => void testConnection()}
          disabled={testing || !config.enabled || !config.testPath.trim()}
          className="rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          data-testid="td-synnex-test"
        >
          {testing ? 'Testing.' : 'Test connection'}
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
              placeholder="Search by SKU, manufacturer part number, or product name"
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
            {searching ? 'Searching.' : 'Search products'}
          </button>
        </div>

        {products.length > 0 && (
          <table className="min-w-full divide-y text-sm" data-testid="td-synnex-results">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="px-3 py-2 font-medium">Product</th>
                <th className="px-3 py-2 font-medium">SKU</th>
                <th className="px-3 py-2 font-medium">Cost</th>
                <th className="px-3 py-2 font-medium">Available</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {products.map((product) => (
                <tr key={product.sourceProductId} data-testid={`td-synnex-result-${product.sourceProductId}`}>
                  <td className="px-3 py-2">
                    <div className="font-medium">{product.name}</div>
                    <div className="text-xs text-muted-foreground">{product.vendor ?? 'Unknown vendor'}</div>
                  </td>
                  <td className="px-3 py-2">{product.sku ?? product.manufacturerPartNumber ?? 'N/A'}</td>
                  <td className="px-3 py-2">{product.cost ? `${product.currency ?? 'USD'} ${product.cost}` : 'N/A'}</td>
                  <td className="px-3 py-2">{product.availability ?? 'N/A'}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => openImport(product)}
                      className="text-sm text-primary hover:underline"
                      data-testid={`td-synnex-import-open-${product.sourceProductId}`}
                    >
                      Import
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {draftProduct && importForm && (
          <div className="space-y-3 rounded-md border bg-muted/30 p-4" data-testid="td-synnex-import-editor">
            <div>
              <h3 className="text-sm font-semibold">Import product</h3>
              <p className="mt-1 text-xs text-muted-foreground">{draftProduct.name}</p>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="text-xs font-medium">
                Name
                <input value={importForm.name} onChange={(e) => setImportForm((f) => f && ({ ...f, name: e.target.value }))} className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm" data-testid="td-synnex-import-name" />
              </label>
              <label className="text-xs font-medium">
                SKU
                <input value={importForm.sku} onChange={(e) => setImportForm((f) => f && ({ ...f, sku: e.target.value }))} className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm" data-testid="td-synnex-import-sku" />
              </label>
              <label className="text-xs font-medium">
                Sell price
                <input value={importForm.unitPrice} onChange={(e) => setImportForm((f) => f && ({ ...f, unitPrice: e.target.value }))} inputMode="decimal" className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm" data-testid="td-synnex-import-price" />
              </label>
              <label className="text-xs font-medium">
                Cost basis
                <input value={importForm.costBasis} onChange={(e) => setImportForm((f) => f && ({ ...f, costBasis: e.target.value }))} inputMode="decimal" className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm" data-testid="td-synnex-import-cost" />
              </label>
              <label className="text-xs font-medium">
                Markup percent
                <input value={importForm.markupPercent} onChange={(e) => setImportForm((f) => f && ({ ...f, markupPercent: e.target.value }))} inputMode="decimal" className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm" data-testid="td-synnex-import-markup" />
              </label>
              <label className="flex items-end gap-2 text-sm">
                <input type="checkbox" checked={importForm.taxable} onChange={(e) => setImportForm((f) => f && ({ ...f, taxable: e.target.checked }))} data-testid="td-synnex-import-taxable" />
                Taxable
              </label>
              <label className="text-xs font-medium md:col-span-2">
                Description
                <textarea value={importForm.description} onChange={(e) => setImportForm((f) => f && ({ ...f, description: e.target.value }))} className="mt-1 min-h-20 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm" data-testid="td-synnex-import-description" />
              </label>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void importProduct()}
                disabled={importing || !importForm.name.trim() || toMoney(importForm.unitPrice) === null}
                className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                data-testid="td-synnex-import-save"
              >
                {importing ? 'Importing.' : 'Import item'}
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
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
