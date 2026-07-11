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
import { formatNumber } from '@/lib/i18n/format';

const MASKED = '********';
const UNAUTHORIZED = () => void navigateTo(loginPathWithNext(), { replace: true });

interface EcStatus {
  configured: boolean;
  enabled: boolean;
  region?: string;
  credentials?: { email?: string; password?: string; customerNo?: string };
  settings?: { defaultWarehouse?: string; hideZeroInv?: boolean; defaultMarkupPercent?: number };
  lastTestStatus?: string | null;
  lastTestAt?: string | null;
  lastTestError?: string | null;
}

interface EcWarehouseStock {
  code: string | null;
  available: number;
  onOrder: number;
  bo: number;
  eta: string | null;
}

interface EcProduct {
  source: 'td_synnex_ec_express';
  synnexSku: string;
  mfgPartNo: string | null;
  status: string | null;
  name: string;
  description: string | null;
  currency: string | null;
  cost: number | null;
  msrp: number | null;
  discount: number | null;
  totalQty: number | null;
  warehouses: EcWarehouseStock[];
  weight: number | null;
  parcelShippable: string | null;
  raw: Record<string, unknown>;
}

interface ConfigForm {
  enabled: boolean;
  region: string;
  customerNo: string;
  email: string;
  password: string;
}

const EMPTY_CONFIG: ConfigForm = {
  enabled: false,
  region: 'US',
  customerNo: '',
  email: '',
  password: '',
};

function configFromStatus(status: EcStatus | null): ConfigForm {
  if (!status?.configured && !status?.credentials) return EMPTY_CONFIG;
  return {
    enabled: status.enabled,
    region: status.region ?? 'US',
    customerNo: status.credentials?.customerNo ?? '',
    email: status.credentials?.email ?? '',
    password: status.credentials?.password ?? '',
  };
}

function toMoney(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

function sellPriceDefault(product: EcProduct, defaultMarkupPct: number | null): string {
  // Prefer the partner default markup (over cost) when we have a cost;
  // otherwise fall back to MSRP, then cost.
  if (defaultMarkupPct != null && product.cost != null && Number.isFinite(product.cost)) {
    return priceFromCostMarkup(product.cost, defaultMarkupPct).toFixed(2);
  }
  const value = product.msrp ?? product.cost;
  return value === null || value === undefined ? '' : value.toFixed(2);
}

function TdSynnexEcExpressPanel() {
  const { t } = useTranslation('settings');
  const [status, setStatus] = useState<EcStatus | null>(null);
  const [config, setConfig] = useState<ConfigForm>(EMPTY_CONFIG);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [products, setProducts] = useState<EcProduct[]>([]);
  const [sellPrices, setSellPrices] = useState<Record<string, string>>({});
  const [importingSku, setImportingSku] = useState<string | null>(null);
  // Partner-level default markup % used to pre-fill sell prices.
  const [defaultMarkupPct, setDefaultMarkupPct] = useState<number | null>(null);
  // Partner policy: do newly imported (hardware) items default to taxable?
  const [autoTaxHardware, setAutoTaxHardware] = useState(true);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchWithAuth('/catalog/distributors/td-synnex-ec/status');
      if (res.status === 401) {
        UNAUTHORIZED();
        return;
      }
      if (!res.ok) {
        const errBody = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(errBody?.error ?? t('tdSynnexEcExpressPanel.tDSYNNEXPricingSettingsFailedToLoad'));
      }
      const body = (await res.json()) as { data: EcStatus };
      setStatus(body.data);
      setConfig(configFromStatus(body.data));
    } catch (err) {
      console.error('[td-synnex-ec] status load failed', err);
      showToast({
        message: err instanceof Error ? err.message : t('tdSynnexEcExpressPanel.tDSYNNEXPricingSettingsFailedToLoad'),
        type: 'error',
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  // Load the partner default markup once so lookups can pre-fill the sell price.
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
        // Non-fatal: sell price just falls back to MSRP/cost.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const connectionLabel = useMemo(() => {
    if (status?.lastTestStatus === 'success') return t('tdSynnexEcExpressPanel.lastTestSucceeded');
    if (status?.lastTestStatus === 'failed') return status.lastTestError ?? t('tdSynnexEcExpressPanel.lastTestFailed');
    if (status?.configured) return t('tdSynnexEcExpressPanel.configured');
    return t('tdSynnexEcExpressPanel.notConfigured');
  }, [status, t]);

  const saveConfig = useCallback(async () => {
    setSaving(true);
    try {
      const result = await runAction<{ data: EcStatus }>({
        request: () => fetchWithAuth('/catalog/distributors/td-synnex-ec/config', {
          method: 'PUT',
          body: JSON.stringify({
            enabled: config.enabled,
            region: config.region.trim(),
            credentials: {
              customerNo: config.customerNo.trim(),
              email: config.email.trim(),
              password: config.password.trim(),
            },
          }),
        }),
        errorFallback: t('tdSynnexEcExpressPanel.tDSYNNEXPricingSettingsFailedToSave'),
        successMessage: t('tdSynnexEcExpressPanel.tDSYNNEXPricingSettingsSaved'),
        onUnauthorized: UNAUTHORIZED,
      });
      setStatus(result.data);
      setConfig(configFromStatus(result.data));
    } catch (err) {
      handleActionError(err, 'TD SYNNEX Pricing settings failed to save.');
    } finally {
      setSaving(false);
    }
  }, [config]);

  const testConnection = useCallback(async () => {
    setTesting(true);
    try {
      const result = await runAction<{ data: EcStatus }>({
        request: () => fetchWithAuth('/catalog/distributors/td-synnex-ec/test', { method: 'POST' }),
        errorFallback: t('tdSynnexEcExpressPanel.tDSYNNEXPricingConnectionTestFailed'),
        successMessage: t('tdSynnexEcExpressPanel.tDSYNNEXPricingConnectionTestSucceeded'),
        onUnauthorized: UNAUTHORIZED,
      });
      setStatus(result.data);
      setConfig(configFromStatus(result.data));
    } catch (err) {
      handleActionError(err, 'TD SYNNEX Pricing connection test failed.');
      void loadStatus();
    } finally {
      setTesting(false);
    }
  }, [loadStatus]);

  const lookup = useCallback(async () => {
    if (!query.trim()) return;
    setSearching(true);
    setProducts([]);
    setSellPrices({});
    try {
      const res = await fetchWithAuth(`/catalog/distributors/td-synnex-ec/lookup?q=${encodeURIComponent(query.trim())}`);
      if (res.status === 401) {
        UNAUTHORIZED();
        return;
      }
      const body = await res.json().catch(() => null) as { data?: EcProduct[]; error?: string } | null;
      // A null body means the response wasn't valid JSON — treat that as a failure
      // rather than silently rendering an empty result set.
      if (body === null) {
        throw new Error(t('tdSynnexEcExpressPanel.tDSYNNEXPricingLookupFailedInvalidResponse'));
      }
      // Honor the runAction failure contract: a non-2xx status OR an HTTP-200
      // { success:false } body both count as failures (CLAUDE.md no-silent-mutations).
      if (isApiFailure(body, res.status)) {
        throw new Error(extractApiError(body, t('tdSynnexEcExpressPanel.tDSYNNEXPricingLookupFailed')));
      }
      const results = body?.data ?? [];
      setProducts(results);
      setSellPrices(Object.fromEntries(results.map((p) => [p.synnexSku, sellPriceDefault(p, defaultMarkupPct)])));
    } catch (err) {
      showToast({ message: err instanceof Error ? err.message : t('tdSynnexEcExpressPanel.tDSYNNEXPricingLookupFailed'), type: 'error' });
    } finally {
      setSearching(false);
    }
  }, [query, defaultMarkupPct]);

  const importProduct = useCallback(async (product: EcProduct) => {
    const sellPrice = toMoney(sellPrices[product.synnexSku] ?? '');
    if (sellPrice === null) {
      showToast({ message: t('tdSynnexEcExpressPanel.enterAValidSellPrice'), type: 'error' });
      return;
    }
    setImportingSku(product.synnexSku);
    try {
      await runAction({
        request: () => fetchWithAuth('/catalog/distributors/td-synnex-ec/import', {
          method: 'POST',
          body: JSON.stringify({
            product,
            item: {
              name: product.name,
              sku: product.synnexSku || product.mfgPartNo || null,
              description: product.description ?? null,
              unitPrice: sellPrice,
              costBasis: product.cost !== null && Number.isFinite(product.cost)
                ? Number(product.cost.toFixed(2))
                : null,
              taxable: autoTaxHardware,
            },
          }),
        }),
        errorFallback: t('tdSynnexEcExpressPanel.tDSYNNEXPricingItemImportFailed'),
        successMessage: t('tdSynnexEcExpressPanel.imported', { name: product.name }),
        onUnauthorized: UNAUTHORIZED,
      });
    } catch (err) {
      handleActionError(err, 'TD SYNNEX Pricing item import failed.');
    } finally {
      setImportingSku(null);
    }
  }, [sellPrices, autoTaxHardware]);

  if (loading) {
    return <p className="text-sm text-muted-foreground" data-testid="td-synnex-ec-loading">{t('tdSynnexEcExpressPanel.loadingTDSYNNEXPricing')}</p>;
  }

  return (
    <section className="space-y-4 border-t pt-6" data-testid="td-synnex-ec-panel">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Plug className="h-4 w-4" aria-hidden="true" />
            {t('tdSynnexEcExpressPanel.tDSYNNEXPricing')}</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {t('tdSynnexEcExpressPanel.connectTDSYNNEXECExpressToLookUpRealTimePricingAndAvaila')}</p>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="td-synnex-ec-status-label">
          {status?.lastTestStatus === 'success' && <CheckCircle2 className="h-4 w-4 text-green-600" aria-hidden="true" />}
          {connectionLabel}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-xs font-medium">
          {t('tdSynnexEcExpressPanel.customerNo')}<input
            value={config.customerNo}
            onChange={(e) => setConfig((f) => ({ ...f, customerNo: e.target.value }))}
            className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            data-testid="td-synnex-ec-customer-no"
          />
        </label>
        <label className="text-xs font-medium">
          {t('tdSynnexEcExpressPanel.region')}<input
            value={config.region}
            onChange={(e) => setConfig((f) => ({ ...f, region: e.target.value }))}
            className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            data-testid="td-synnex-ec-region"
          />
        </label>
        <label className="text-xs font-medium">
          {t('tdSynnexEcExpressPanel.email')}<input
            value={config.email}
            onChange={(e) => setConfig((f) => ({ ...f, email: e.target.value }))}
            className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            data-testid="td-synnex-ec-email"
          />
        </label>
        <label className="text-xs font-medium">
          {t('tdSynnexEcExpressPanel.password')}<input
            value={config.password}
            onChange={(e) => setConfig((f) => ({ ...f, password: e.target.value }))}
            className="mt-1 w-full rounded-md border bg-background px-2.5 py-1.5 text-sm"
            placeholder={MASKED}
            type="password"
            data-testid="td-synnex-ec-password"
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => setConfig((f) => ({ ...f, enabled: e.target.checked }))}
            data-testid="td-synnex-ec-enabled"
          />
          {t('tdSynnexEcExpressPanel.enabled')}</label>
        <button
          type="button"
          onClick={() => void saveConfig()}
          disabled={saving}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          data-testid="td-synnex-ec-save"
        >
          {saving ? t('tdSynnexEcExpressPanel.saving') : t('tdSynnexEcExpressPanel.saveSettings')}
        </button>
        <button
          type="button"
          onClick={() => void testConnection()}
          disabled={testing || !config.enabled}
          className="rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          data-testid="td-synnex-ec-test"
        >
          {testing ? t('tdSynnexEcExpressPanel.testing') : t('tdSynnexEcExpressPanel.testConnection')}
        </button>
      </div>

      {status?.lastTestStatus === 'failed' && status.lastTestError && (
        <p className="text-sm text-red-600" data-testid="td-synnex-ec-test-error">{status.lastTestError}</p>
      )}

      <div className="space-y-3 border-t pt-4">
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void lookup();
              }}
              className="w-full rounded-md border bg-background py-1.5 pl-8 pr-2.5 text-sm"
              placeholder={t('tdSynnexEcExpressPanel.sYNNEXSKUOrMfgPart')}
              data-testid="td-synnex-ec-lookup-query"
            />
          </div>
          <button
            type="button"
            onClick={() => void lookup()}
            disabled={searching || !query.trim() || !status?.enabled}
            className="rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-50"
            data-testid="td-synnex-ec-lookup"
          >
            {searching ? t('tdSynnexEcExpressPanel.lookingUp') : t('tdSynnexEcExpressPanel.lookUp')}
          </button>
        </div>

        {products.length > 0 && (
          <div className="space-y-3" data-testid="td-synnex-ec-results">
            {products.map((product) => (
              <div
                key={product.synnexSku}
                className="space-y-3 rounded-md border bg-muted/30 p-4"
                data-testid={`td-synnex-ec-result-${product.synnexSku}`}
              >
                <div className="flex flex-col gap-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{product.name}</span>
                    {product.status && (
                      <span className="text-xs text-muted-foreground">{product.status}</span>
                    )}
                  </div>
                  {product.description && (
                    <p className="text-xs text-muted-foreground">{product.description}</p>
                  )}
                  <div className="text-xs text-muted-foreground">
                    {t('tdSynnexEcExpressPanel.sYNNEXSKU')}{product.synnexSku}
                    {product.mfgPartNo ? t('tdSynnexEcExpressPanel.manufacturerPart', { part: product.mfgPartNo }) : ''}
                  </div>
                </div>

                <div className="grid gap-2 text-sm sm:grid-cols-3">
                  <div>
                    <div className="text-xs text-muted-foreground">{t('tdSynnexEcExpressPanel.yourCost')}</div>
                    <div>{product.cost !== null ? `${product.currency ?? t('tdSynnexEcExpressPanel.uSD')} ${formatNumber(product.cost, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : t('tdSynnexEcExpressPanel.nA')}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">{t('tdSynnexEcExpressPanel.mSRP')}</div>
                    <div>{product.msrp !== null ? `${product.currency ?? t('tdSynnexEcExpressPanel.uSD')} ${formatNumber(product.msrp, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : t('tdSynnexEcExpressPanel.nA')}</div>
                  </div>
                  <div>
                    <div className="text-xs text-muted-foreground">{t('tdSynnexEcExpressPanel.totalAvailable')}</div>
                    <div>{product.totalQty ?? t('tdSynnexEcExpressPanel.nA')}</div>
                  </div>
                </div>

                {product.warehouses.length > 0 && (
                  <table className="min-w-full divide-y text-xs" data-testid={`td-synnex-ec-warehouses-${product.synnexSku}`}>
                    <thead>
                      <tr className="text-left text-muted-foreground">
                        <th className="px-2 py-1 font-medium">{t('tdSynnexEcExpressPanel.warehouse')}</th>
                        <th className="px-2 py-1 font-medium">{t('tdSynnexEcExpressPanel.available')}</th>
                        <th className="px-2 py-1 font-medium">{t('tdSynnexEcExpressPanel.onOrder')}</th>
                        <th className="px-2 py-1 font-medium">{t('tdSynnexEcExpressPanel.eTA')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {product.warehouses.map((wh, idx) => (
                        <tr key={`${product.synnexSku}-${wh.code ?? idx}`}>
                          <td className="px-2 py-1">{wh.code ?? t('tdSynnexEcExpressPanel.nA')}</td>
                          <td className="px-2 py-1">{wh.available}</td>
                          <td className="px-2 py-1">{wh.onOrder}</td>
                          <td className="px-2 py-1">{wh.eta ?? '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                <div className="flex flex-wrap items-end gap-2">
                  <label className="text-xs font-medium">
                    {t('tdSynnexEcExpressPanel.sellPrice')}<input
                      value={sellPrices[product.synnexSku] ?? ''}
                      onChange={(e) => setSellPrices((s) => ({ ...s, [product.synnexSku]: e.target.value }))}
                      inputMode="decimal"
                      className="mt-1 w-32 rounded-md border bg-background px-2.5 py-1.5 text-sm"
                      data-testid="td-synnex-ec-sell-price"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => void importProduct(product)}
                    disabled={importingSku === product.synnexSku || toMoney(sellPrices[product.synnexSku] ?? '') === null}
                    className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                    data-testid="td-synnex-ec-import"
                  >
                    {importingSku === product.synnexSku ? t('tdSynnexEcExpressPanel.importing') : t('tdSynnexEcExpressPanel.importToCatalog')}
                  </button>
                </div>
                {(() => {
                  const breakdown = computeMarginBreakdown(product.cost, toMoney(sellPrices[product.synnexSku] ?? ''));
                  if (!breakdown) return null;
                  const negative = breakdown.profit < 0;
                  return (
                    <p
                      className={`text-xs font-medium ${negative ? 'text-red-600' : 'text-muted-foreground'}`}
                      data-testid={`td-synnex-ec-margin-${product.synnexSku}`}
                    >
                      {formatMarginSummary(breakdown, product.currency ?? t('tdSynnexEcExpressPanel.uSD'))}
                      {negative ? ' — selling below cost' : ''}
                    </p>
                  );
                })()}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export default TdSynnexEcExpressPanel;
