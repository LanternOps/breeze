import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Save } from 'lucide-react';
import { BYO_MODEL_ID_PATTERN } from '@breeze/shared';
import { fetchWithAuth } from '../../../stores/auth';
import { runAction, ActionError } from '../../../lib/runAction';
import { showToast } from '../../shared/Toast';
import { navigateTo } from '@/lib/navigation';
import { Drawer } from '../../shared/Drawer';
import { registryFriendly } from './surfaceLabels';

const onUnauthorized = () => { void navigateTo('/login', { replace: true }); };

const PRICE_FIELDS = [
  { key: 'inputCentsPerM', testId: 'ai-manual-model-price-input', label: 'aiModels.offering.prices.input' },
  { key: 'outputCentsPerM', testId: 'ai-manual-model-price-output', label: 'aiModels.offering.prices.output' },
  { key: 'cacheReadCentsPerM', testId: 'ai-manual-model-price-cache-read', label: 'aiModels.offering.prices.cacheRead' },
  { key: 'cacheWriteCentsPerM', testId: 'ai-manual-model-price-cache-write', label: 'aiModels.offering.prices.cacheWrite' },
] as const;
type PriceKey = (typeof PRICE_FIELDS)[number]['key'];
type PriceDraft = Record<PriceKey, string>;
const EMPTY_PRICES: PriceDraft = { inputCentsPerM: '', outputCentsPerM: '', cacheReadCentsPerM: '', cacheWriteCentsPerM: '' };

/** All blank → null (unpriced); all four valid → rates; anything else → 'invalid'. */
function parsePrices(d: PriceDraft): Record<PriceKey, number> | null | 'invalid' {
  const raw = PRICE_FIELDS.map((f) => d[f.key].trim());
  if (raw.every((v) => v === '')) return null;
  const nums = raw.map(Number);
  if (raw.some((v) => v === '') || nums.some((n) => !Number.isFinite(n) || n < 0 || n > 1_000_000)) return 'invalid';
  return Object.fromEntries(PRICE_FIELDS.map((f, i) => [f.key, nums[i]])) as Record<PriceKey, number>;
}

/** Hand-entered model on a gateway connection (spec §6: manual entry is always allowed). */
export default function ManualModelForm({
  connectionId,
  onSaved,
  onClose,
}: {
  connectionId: string;
  onSaved: () => void | Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation('settings');
  const [modelId, setModelId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [prices, setPrices] = useState<PriceDraft>(EMPTY_PRICES);
  const [saving, setSaving] = useState(false);
  const friendly = registryFriendly(t);

  const parsedPrices = parsePrices(prices);
  const idOk = BYO_MODEL_ID_PATTERN.test(modelId.trim());
  const canSave = idOk && parsedPrices !== 'invalid' && displayName.length <= 120;
  const inputClass = 'h-10 w-full rounded-md border bg-background px-3 text-sm';

  const handleSave = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      const body: Record<string, unknown> = { modelId: modelId.trim() };
      if (displayName.trim()) body.displayName = displayName.trim();
      if (parsedPrices !== null) body.prices = parsedPrices;
      await runAction({
        request: () => fetchWithAuth(`/ai/models/connections/${connectionId}/offerings`, { method: 'POST', body: JSON.stringify(body) }),
        successMessage: t('aiModels.models.manual.added'),
        errorFallback: t('aiModels.models.manual.failed'),
        friendly,
        onUnauthorized,
      });
      await onSaved();
      onClose();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('aiModels.models.manual.failed') });
      // non-401 ActionError already toasted by runAction; the form stays open
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer open onClose={onClose} title={t('aiModels.models.manual.title')} dataTestId="ai-manual-model-drawer" closeDisabled={saving}>
      <div className="space-y-5">
        <div className="space-y-1">
          <label className="text-sm font-medium" htmlFor="ai-manual-model-id">{t('aiModels.models.manual.modelId')}</label>
          <input id="ai-manual-model-id" data-testid="ai-manual-model-id" className={inputClass} value={modelId} maxLength={200}
            autoComplete="off" disabled={saving} onChange={(e) => setModelId(e.target.value)} />
          <p className="text-xs text-muted-foreground">{t('aiModels.models.manual.modelIdHelp')}</p>
          {modelId.trim() !== '' && !idOk && (
            <p data-testid="ai-manual-model-id-invalid" role="alert" className="text-xs text-destructive">{t('aiModels.models.manual.modelIdInvalid')}</p>
          )}
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium" htmlFor="ai-manual-model-name">{t('aiModels.models.manual.displayName')}</label>
          <input id="ai-manual-model-name" data-testid="ai-manual-model-name" className={inputClass} value={displayName} maxLength={120}
            disabled={saving} onChange={(e) => setDisplayName(e.target.value)} />
        </div>
        <fieldset className="space-y-2" disabled={saving}>
          <legend className="text-sm font-medium">{t('aiModels.offering.pricesTitle')}</legend>
          <p className="text-xs text-muted-foreground">{t('aiModels.models.manual.pricesHint')}</p>
          <div className="grid grid-cols-2 gap-2">
            {PRICE_FIELDS.map((f) => (
              <label key={f.key} className="space-y-1 text-xs font-medium">
                {t(/* i18n-dynamic */ f.label)}
                <input data-testid={f.testId} className={inputClass} inputMode="decimal" value={prices[f.key]}
                  onChange={(e) => setPrices({ ...prices, [f.key]: e.target.value })} />
              </label>
            ))}
          </div>
          {parsedPrices === 'invalid' && (
            <p role="alert" className="text-xs text-destructive">{t('aiModels.offering.invalidPrices')}</p>
          )}
        </fieldset>
        <div className="flex justify-end gap-2 border-t pt-4">
          <button type="button" data-testid="ai-manual-model-cancel" onClick={onClose} disabled={saving}
            className="rounded-md border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50">
            {t('common:actions.cancel')}
          </button>
          <button type="button" data-testid="ai-manual-model-save" onClick={() => { void handleSave(); }} disabled={!canSave || saving}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {saving ? t('common:states.saving') : t('common:actions.save')}
          </button>
        </div>
      </div>
    </Drawer>
  );
}
