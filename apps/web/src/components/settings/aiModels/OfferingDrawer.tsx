import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Loader2, RefreshCw, Save } from 'lucide-react';
import {
  AI_MODEL_REQUIRED_PERMISSION_CHOICES,
  EFFORT_LEVELS,
  MODEL_SPEEDS,
  THINKING_DISPLAYS,
  type AiOfferingDto,
  type ModelRates,
  type OfferingOptions,
} from '@breeze/shared';
import { fetchWithAuth } from '../../../stores/auth';
import { runAction, ActionError } from '../../../lib/runAction';
import { formatCurrency } from '../../../lib/i18n/format';
import { showToast } from '../../shared/Toast';
import { navigateTo } from '@/lib/navigation';
import { Drawer } from '../../shared/Drawer';
import { registryFriendly } from './surfaceLabels';

const PREMIUM_PERMISSION = AI_MODEL_REQUIRED_PERMISSION_CHOICES[0];

const RATE_KEYS = ['inputCentsPerM', 'outputCentsPerM', 'cacheReadCentsPerM', 'cacheWriteCentsPerM'] as const;
type RateKey = (typeof RATE_KEYS)[number];
type RateDraft = Record<RateKey, string>;

// Literal key maps: the i18n keyUsage test cannot check template keys.
const EFFORT_KEYS = {
  low: 'aiModels.offering.effort.low', medium: 'aiModels.offering.effort.medium', high: 'aiModels.offering.effort.high',
  xhigh: 'aiModels.offering.effort.xhigh', max: 'aiModels.offering.effort.max',
} as const;
const DISPLAY_KEYS = {
  omitted: 'aiModels.offering.display.omitted', summarized: 'aiModels.offering.display.summarized', updates: 'aiModels.offering.display.updates',
} as const;
const PRICE_FIELDS: Array<{ key: RateKey; testId: string; label: string }> = [
  { key: 'inputCentsPerM', testId: 'ai-offering-price-input', label: 'aiModels.offering.prices.input' },
  { key: 'outputCentsPerM', testId: 'ai-offering-price-output', label: 'aiModels.offering.prices.output' },
  { key: 'cacheReadCentsPerM', testId: 'ai-offering-price-cacheRead', label: 'aiModels.offering.prices.cacheRead' },
  { key: 'cacheWriteCentsPerM', testId: 'ai-offering-price-cacheWrite', label: 'aiModels.offering.prices.cacheWrite' },
];
const PRICE_SOURCE_KEYS = {
  platform: 'aiModels.offering.priceSource.platform',
  catalog: 'aiModels.offering.priceSource.catalog',
  linked_platform: 'aiModels.offering.priceSource.linked_platform',
  offering: 'aiModels.offering.priceSource.offering',
} as const;

const ratesToDraft = (rates: ModelRates | null): RateDraft => ({
  inputCentsPerM: rates ? String(rates.inputCentsPerM) : '',
  outputCentsPerM: rates ? String(rates.outputCentsPerM) : '',
  cacheReadCentsPerM: rates ? String(rates.cacheReadCentsPerM) : '',
  cacheWriteCentsPerM: rates ? String(rates.cacheWriteCentsPerM) : '',
});

/** All four blank → null (unpriced); all four valid → rates; anything else → 'invalid'. */
function draftToRates(draft: RateDraft): ModelRates | null | 'invalid' {
  const raw = RATE_KEYS.map((key) => draft[key].trim());
  if (raw.every((value) => value === '')) return null;
  const numbers = raw.map(Number);
  if (raw.some((value) => value === '') || numbers.some((n) => !Number.isFinite(n) || n < 0)) return 'invalid';
  const [inputCentsPerM, outputCentsPerM, cacheReadCentsPerM, cacheWriteCentsPerM] = numbers as [number, number, number, number];
  return { inputCentsPerM, outputCentsPerM, cacheReadCentsPerM, cacheWriteCentsPerM };
}

const sameRates = (a: ModelRates | null, b: ModelRates | null) =>
  a === b || (a !== null && b !== null && RATE_KEYS.every((k) => a[k] === b[k]));

type Effort = (typeof EFFORT_LEVELS)[number];
type Display = (typeof THINKING_DISPLAYS)[number];
type Speed = (typeof MODEL_SPEEDS)[number];
type Allowed = NonNullable<AiOfferingDto['allowedOptions']>;

interface Draft {
  displayName: string;
  prices: RateDraft;
  /** Checked efforts. Unrestricted (no stored list) starts as every supported level. */
  efforts: Effort[];
  allowFast: boolean;
  premium: boolean;
  defaultEffort: '' | Effort;
  defaultDisplay: '' | Display;
  defaultSpeed: '' | Speed;
  refusalFallback: string;
}

function draftFrom(o: AiOfferingDto): Draft {
  const support = o.optionSupport;
  const storedEfforts = o.allowedOptions?.effort;
  const storedSpeeds = o.allowedOptions?.speed;
  return {
    displayName: o.displayNameOverride ?? '',
    prices: ratesToDraft(o.ownPrices),
    efforts: EFFORT_LEVELS.filter((l) => support.effort.includes(l) && (storedEfforts ? storedEfforts.includes(l) : true)),
    allowFast: support.speed.includes('fast') && (storedSpeeds ? storedSpeeds.includes('fast') : true),
    premium: o.requiredPermission === PREMIUM_PERMISSION,
    defaultEffort: o.defaultOptions?.effort ?? '',
    defaultDisplay: o.defaultOptions?.thinkingDisplay ?? '',
    defaultSpeed: o.defaultOptions?.speed ?? '',
    refusalFallback: o.refusalFallbackOfferingId ?? '',
  };
}

/** Fast opt-in on a platform-funded offering needs the premium permission (API rule, spec §15 #7). */
const premiumForced = (o: AiOfferingDto, d: Draft) => o.funding === 'platform' && d.allowFast && o.fastRates !== null;
const effectivePremium = (o: AiOfferingDto, d: Draft) => d.premium || premiumForced(o, d);

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

const compact = <T extends object>(obj: T): T | null => {
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined);
  return entries.length === 0 ? null : (Object.fromEntries(entries) as T);
};

/**
 * Builds the PATCH body. allowedOptions MERGES into the stored list and only
 * touches the keys the user actually changed (effort, speed): a rename or price
 * edit must never drop a stored restriction such as speed: ['standard'] or
 * thinkingDisplay (Codex review finding 7).
 */
function buildPatch(o: AiOfferingDto, d: Draft, initial: Draft): Record<string, unknown> | 'invalid_prices' {
  const patch: Record<string, unknown> = { expectedUpdatedAt: o.updatedAt };
  const name = d.displayName.trim() || null;
  if (name !== o.displayNameOverride) patch.displayName = name;

  if (o.pricesEditable) {
    const prices = draftToRates(d.prices);
    if (prices === 'invalid') return 'invalid_prices';
    if (!sameRates(prices, o.ownPrices)) patch.prices = prices;
  }

  const merged: Allowed = { ...(o.allowedOptions ?? {}) };
  if (!sameSet(d.efforts, initial.efforts)) {
    if (sameSet(d.efforts, o.optionSupport.effort)) delete merged.effort;
    else merged.effort = [...d.efforts];
  }
  if (d.allowFast !== initial.allowFast) {
    if (d.allowFast) delete merged.speed; // unrestricted = everything the model supports
    else merged.speed = ['standard'];
  }
  const allowed = compact(merged);
  if (JSON.stringify(allowed) !== JSON.stringify(o.allowedOptions ?? null)) patch.allowedOptions = allowed;

  const defaults = compact<OfferingOptions>({
    effort: d.defaultEffort || undefined,
    thinkingDisplay: d.defaultDisplay || undefined,
    speed: d.defaultSpeed || undefined,
  });
  if (JSON.stringify(defaults) !== JSON.stringify(o.defaultOptions ?? null)) patch.defaultOptions = defaults;

  // Only when the admin changed premium/allowFast, compared with the drawer's
  // initial EFFECTIVE value. A legacy platform row (allowedOptions null,
  // requiredPermission null, fast rate) opens with fast already allowed, so its
  // effective premium is true while the stored value is null; comparing against
  // the stored value would gate the whole model on any unrelated edit.
  const premiumNow = effectivePremium(o, d);
  if (premiumNow !== effectivePremium(o, initial)) {
    const perm = premiumNow ? PREMIUM_PERMISSION : null;
    if (perm !== o.requiredPermission) patch.requiredPermission = perm;
  }

  const fb = d.refusalFallback || null;
  if (fb !== o.refusalFallbackOfferingId) patch.refusalFallbackOfferingId = fb;
  return patch;
}

const onUnauthorized = () => { void navigateTo('/login', { replace: true }); };

function rateText(rates: ModelRates, t: TFunction<'settings'>): string {
  return t('aiModels.models.ratePair', { input: formatCurrency(rates.inputCentsPerM / 100), output: formatCurrency(rates.outputCentsPerM / 100) });
}

export interface OfferingDrawerProps {
  offering: AiOfferingDto;
  /** Every offering in the snapshot (the refusal-fallback candidates). */
  offerings: AiOfferingDto[];
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}

export default function OfferingDrawer({ offering, offerings, onClose, onSaved }: OfferingDrawerProps) {
  const { t } = useTranslation('settings');
  const initial = useMemo(() => draftFrom(offering), [offering]);
  const [draft, setDraft] = useState<Draft>(initial);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const friendly = registryFriendly(t);

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const support = offering.optionSupport;
  const forced = premiumForced(offering, draft);
  const fastListed = offering.fastRates !== null && draft.allowFast;

  const effortOptions = EFFORT_LEVELS.filter((l) => draft.efforts.includes(l));
  const storedDisplays = offering.allowedOptions?.thinkingDisplay;
  const displayOptions = THINKING_DISPLAYS.filter((x) => support.thinkingDisplay.includes(x) && (storedDisplays ? storedDisplays.includes(x) : true));
  const speedOptions: Speed[] = fastListed ? ['standard', 'fast'] : ['standard'];

  const fallbackCandidates = offerings.filter((x) => x.id !== null && x.id !== offering.id && x.enabled && x.connectionId === offering.connectionId);

  const patchOrInvalid = buildPatch(offering, draft, initial);
  const dirty = patchOrInvalid === 'invalid_prices' || Object.keys(patchOrInvalid).length > 1;

  const toggleEffort = (level: Effort, on: boolean) => {
    const efforts = EFFORT_LEVELS.filter((l) => (l === level ? on : draft.efforts.includes(l)));
    if (efforts.length === 0) return; // an allow-list cannot be empty; leave at least one
    set({ efforts, defaultEffort: draft.defaultEffort && efforts.includes(draft.defaultEffort) ? draft.defaultEffort : '' });
  };

  // Verify re-runs discovery for the offering's connection; platform rows are verified by the operator.
  const canVerify = offering.id !== null && offering.funding !== 'platform' && offering.connectionId !== null;

  const handleVerify = async () => {
    if (offering.id === null || saving || verifying) return;
    setVerifying(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/ai/models/offerings/${offering.id}/verify`, { method: 'POST' }),
        successMessage: t('aiModels.offering.verifyQueued'),
        errorFallback: t('aiModels.offering.verifyFailed'),
        friendly,
        onUnauthorized,
      });
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('aiModels.offering.verifyFailed') });
      // other ActionErrors already toasted by runAction; the drawer stays open
    } finally {
      setVerifying(false);
    }
  };

  const handleSave = async () => {
    if (saving || !dirty) return;
    if (patchOrInvalid === 'invalid_prices') {
      showToast({ type: 'error', message: t('aiModels.offering.invalidPrices') });
      return;
    }
    setSaving(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/ai/models/offerings/${offering.id}`, { method: 'PATCH', body: JSON.stringify(patchOrInvalid) }),
        successMessage: t('aiModels.offering.saved'),
        errorFallback: t('aiModels.offering.saveFailed'),
        friendly,
        onUnauthorized,
      });
      await onSaved();
      onClose();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (err instanceof ActionError && err.code === 'stale_write') {
        // Already toasted by runAction: reload the fresh row and close so the next open starts from it.
        await onSaved();
        onClose();
        return;
      }
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('aiModels.offering.saveFailed') });
      // other ActionErrors (incl. the 403 approvals:decide) already toasted; the drawer stays open
    } finally {
      setSaving(false);
    }
  };

  const inputClass = 'h-10 w-full rounded-md border bg-background px-3 text-sm';
  const sourceKey = offering.priceSource ? PRICE_SOURCE_KEYS[offering.priceSource] : null;

  return (
    <Drawer open onClose={onClose} title={offering.displayName}
      dataTestId="ai-offering-drawer" closeDisabled={saving}>
      <div className="space-y-5">
        <div className="space-y-1">
          <label className="text-sm font-medium" htmlFor="ai-offering-display-name">{t('aiModels.offering.displayName')}</label>
          <input id="ai-offering-display-name" data-testid="ai-offering-display-name" className={inputClass} maxLength={120}
            value={draft.displayName} placeholder={offering.displayName} disabled={saving}
            onChange={(e) => set({ displayName: e.target.value })} />
          <p className="text-xs text-muted-foreground">{t('aiModels.offering.displayNameHint', { modelId: offering.modelId })}</p>
        </div>

        <fieldset className="space-y-2" disabled={saving}>
          <legend className="text-sm font-medium">{t('aiModels.offering.pricesTitle')}</legend>
          {offering.pricesEditable ? (
            <>
              <p className="text-xs text-muted-foreground">{t('aiModels.offering.pricesHint')}</p>
              <div className="grid grid-cols-2 gap-2">
                {PRICE_FIELDS.map((f) => (
                  <label key={f.key} className="space-y-1 text-xs font-medium">
                    {t(/* i18n-dynamic */ f.label)}
                    <input data-testid={f.testId} className={inputClass} inputMode="decimal" value={draft.prices[f.key]}
                      onChange={(e) => set({ prices: { ...draft.prices, [f.key]: e.target.value } })} />
                  </label>
                ))}
              </div>
            </>
          ) : (
            <div data-testid="ai-offering-price-readonly" className="space-y-1 text-sm">
              <p>{sourceKey ? t(/* i18n-dynamic */ sourceKey) : t('aiModels.offering.priceSource.none')}</p>
              {offering.rates && <p className="text-muted-foreground">{rateText(offering.rates, t)}</p>}
            </div>
          )}
          {offering.fastRates && <p className="text-xs text-muted-foreground">{t('aiModels.models.fastRate', { rate: rateText(offering.fastRates, t) })}</p>}
        </fieldset>

        {support.effort.length > 0 && (
          <fieldset className="space-y-2" disabled={saving}>
            <legend className="text-sm font-medium">{t('aiModels.offering.allowedEffort')}</legend>
            <div className="flex flex-wrap gap-3">
              {EFFORT_LEVELS.filter((l) => support.effort.includes(l)).map((level) => (
                <label key={level} className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" data-testid={`ai-offering-allowed-effort-${level}`} checked={draft.efforts.includes(level)}
                    onChange={(e) => toggleEffort(level, e.target.checked)} />
                  {t(/* i18n-dynamic */ EFFORT_KEYS[level])}
                </label>
              ))}
            </div>
          </fieldset>
        )}

        <div className="grid gap-3 sm:grid-cols-3">
          {support.effort.length > 0 && (
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="ai-offering-default-effort">{t('aiModels.offering.defaultEffort')}</label>
              <select id="ai-offering-default-effort" data-testid="ai-offering-default-effort" className={inputClass} value={draft.defaultEffort}
                disabled={saving} onChange={(e) => set({ defaultEffort: e.target.value as '' | Effort })}>
                <option value="">{t('aiModels.offering.providerDefault')}</option>
                {effortOptions.map((l) => <option key={l} value={l}>{t(/* i18n-dynamic */ EFFORT_KEYS[l])}</option>)}
              </select>
            </div>
          )}
          {displayOptions.length > 0 && (
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="ai-offering-default-display">{t('aiModels.offering.defaultDisplay')}</label>
              <select id="ai-offering-default-display" data-testid="ai-offering-default-display" className={inputClass} value={draft.defaultDisplay}
                disabled={saving} onChange={(e) => set({ defaultDisplay: e.target.value as '' | Display })}>
                <option value="">{t('aiModels.offering.providerDefault')}</option>
                {displayOptions.map((x) => <option key={x} value={x}>{t(/* i18n-dynamic */ DISPLAY_KEYS[x])}</option>)}
              </select>
            </div>
          )}
          {support.speed.includes('fast') && (
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="ai-offering-default-speed">{t('aiModels.offering.defaultSpeed')}</label>
              <select id="ai-offering-default-speed" data-testid="ai-offering-default-speed" className={inputClass} value={draft.defaultSpeed}
                disabled={saving} onChange={(e) => set({ defaultSpeed: e.target.value as '' | Speed })}>
                <option value="">{t('aiModels.offering.providerDefault')}</option>
                {speedOptions.map((s) => (
                  <option key={s} value={s}>
                    {s === 'fast' && offering.fastRates
                      ? t('aiModels.offering.speed.fastWithRate', { rate: rateText(offering.fastRates, t) })
                      : t('aiModels.offering.speed.standard')}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {offering.fastRates !== null && support.speed.includes('fast') && (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5" data-testid="ai-offering-allow-fast" checked={draft.allowFast} disabled={saving}
              onChange={(e) => set({ allowFast: e.target.checked, defaultSpeed: e.target.checked ? draft.defaultSpeed : (draft.defaultSpeed === 'fast' ? '' : draft.defaultSpeed) })} />
            <span>
              {t('aiModels.offering.allowFast')}
              <span className="block text-xs text-muted-foreground">{t('aiModels.offering.allowFastHint')}</span>
            </span>
          </label>
        )}

        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5" data-testid="ai-offering-premium" checked={draft.premium || forced}
            disabled={saving || forced} onChange={(e) => set({ premium: e.target.checked })} />
          <span>
            {t('aiModels.offering.premium')}
            <span className="block text-xs text-muted-foreground">{forced ? t('aiModels.offering.premiumForced') : t('aiModels.offering.premiumHint')}</span>
          </span>
        </label>

        <div className="space-y-1">
          <label className="text-sm font-medium" htmlFor="ai-offering-refusal-fallback">{t('aiModels.offering.refusalFallback')}</label>
          <select id="ai-offering-refusal-fallback" data-testid="ai-offering-refusal-fallback" className={inputClass} value={draft.refusalFallback}
            disabled={saving} onChange={(e) => set({ refusalFallback: e.target.value })}>
            <option value="">{t('aiModels.offering.refusalNone')}</option>
            {fallbackCandidates.map((x) => <option key={x.id as string} value={x.id as string}>{x.displayName}</option>)}
          </select>
          <p className="text-xs text-muted-foreground">{t('aiModels.offering.refusalHint')}</p>
        </div>

        <div className="flex items-center justify-between gap-2 border-t pt-4">
          <div>
            {canVerify && (
              <button type="button" data-testid="ai-offering-verify" onClick={() => { void handleVerify(); }} disabled={saving || verifying}
                className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50">
                {verifying ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                {t('aiModels.offering.verify')}
              </button>
            )}
          </div>
          <div className="flex gap-2">
          <button type="button" data-testid="ai-offering-cancel" onClick={onClose} disabled={saving}
            className="rounded-md border px-4 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50">
            {t('common:actions.cancel')}
          </button>
          <button type="button" data-testid="ai-offering-save" onClick={() => { void handleSave(); }} disabled={!dirty || saving}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {saving ? t('common:states.saving') : t('common:actions.save')}
          </button>
          </div>
        </div>
      </div>
    </Drawer>
  );
}
