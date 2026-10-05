import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Pencil, RefreshCw, Sparkles, Star } from 'lucide-react';
import {
  EFFORT_LEVELS,
  PROMPT_PROFILES,
  THINKING_DISPLAYS,
  type EffortLevel,
  type ModelLifecycle,
  type ModelRates,
  type OptionRates,
  type OptionSupport,
  type PromptProfile,
  type ThinkingDisplay,
} from '@breeze/shared';
import { fetchWithAuth } from '@/stores/auth';
import { runAction, ActionError } from '@/lib/runAction';
import { showToast } from '../shared/Toast';
import { Drawer } from '../shared/Drawer';
import PromptVariantsCard from './PromptVariantsCard';
// Initializes the shared i18next singleton before any island renders translated text.
import '../../lib/i18n';
import { useStableT } from '@/lib/i18n/useStableT';

type ThinkingMode = 'adaptive' | 'budget' | 'none' | 'unknown';

/** Mirror of the API's AdminPlatformModelDto (apps/api/src/routes/admin/aiModels.ts). */
export interface AdminPlatformModel {
  id: string;
  modelId: string;
  displayName: string;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  derived: { thinkingMode: ThinkingMode; effortLevels: EffortLevel[]; supportsTools: boolean; supportsVision: boolean };
  rates: ModelRates | null;
  optionRates: OptionRates | null;
  optionSupport: OptionSupport;
  minPlan: string | null;
  promptProfile: PromptProfile;
  platformOffered: boolean;
  isPlatformDefault: boolean;
  lifecycle: ModelLifecycle;
  firstSeenAt: string;
  lastSeenAt: string | null;
  updatedAt: string;
}

const RATE_KEYS = ['inputCentsPerM', 'outputCentsPerM', 'cacheReadCentsPerM', 'cacheWriteCentsPerM'] as const;
type RateKey = (typeof RATE_KEYS)[number];
type RateDraft = Record<RateKey, string>;

interface Draft {
  rates: RateDraft;
  fastRates: RateDraft;
  effort: EffortLevel[];
  thinkingDisplay: ThinkingDisplay[];
  fast: boolean;
  inferenceGeo: string;
  minPlan: string;
  promptProfile: PromptProfile;
  platformOffered: boolean;
  isPlatformDefault: boolean;
}

/** The API and DB store cents per million tokens; the drawer edits dollars (the table's unit). Convert only here. */
function centsToDollarsText(cents: number): string {
  return String(Number((cents / 100).toFixed(4)));
}

function dollarsToCents(dollars: number): number {
  return Number((dollars * 100).toFixed(4));
}

/** More than 10× apart in either direction (a drop to zero counts). */
const PRICE_JUMP_FACTOR = 10;
function isLargePriceChange(storedCents: number, nextCents: number): boolean {
  if (storedCents === nextCents) return false;
  if (storedCents === 0) return true; // 0 → anything is an unbounded jump
  return nextCents > storedCents * PRICE_JUMP_FACTOR || nextCents < storedCents / PRICE_JUMP_FACTOR;
}

function ratesToDraft(rates: ModelRates | null | undefined): RateDraft {
  const field = (key: RateKey) => (rates ? centsToDollarsText(rates[key]) : '');
  return {
    inputCentsPerM: field('inputCentsPerM'),
    outputCentsPerM: field('outputCentsPerM'),
    cacheReadCentsPerM: field('cacheReadCentsPerM'),
    cacheWriteCentsPerM: field('cacheWriteCentsPerM'),
  };
}

/** All four blank → null (unpriced); all four valid → rates; anything else → 'invalid'. */
function draftToRates(draft: RateDraft): ModelRates | null | 'invalid' {
  const raw = RATE_KEYS.map((key) => draft[key].trim());
  if (raw.every((value) => value === '')) return null;
  const numbers = raw.map((value) => dollarsToCents(Number(value)));
  if (raw.some((value) => value === '') || numbers.some((n) => !Number.isFinite(n) || n < 0)) return 'invalid';
  const [inputCentsPerM, outputCentsPerM, cacheReadCentsPerM, cacheWriteCentsPerM] = numbers as [number, number, number, number];
  return { inputCentsPerM, outputCentsPerM, cacheReadCentsPerM, cacheWriteCentsPerM };
}

interface PriceChange {
  group: 'standard' | 'fast';
  key: RateKey;
  storedCents: number;
  /** null = the whole group was cleared (model becomes unpriced for it). */
  nextCents: number | null;
}

/** Fields whose new price is >10× away from the stored one. Invalid/blank drafts yield none (save rejects those first). */
function findLargePriceChanges(model: AdminPlatformModel, draft: Draft): PriceChange[] {
  const groups = [
    { group: 'standard' as const, stored: model.rates, next: draftToRates(draft.rates) },
    { group: 'fast' as const, stored: model.optionRates?.['speed:fast'] ?? null, next: draftToRates(draft.fastRates) },
  ];
  return groups.flatMap(({ group, stored, next }): PriceChange[] => {
    if (!stored || next === 'invalid') return [];
    if (next === null) return RATE_KEYS.map((key) => ({ group, key, storedCents: stored[key], nextCents: null }));
    return RATE_KEYS.filter((key) => isLargePriceChange(stored[key], next[key]))
      .map((key) => ({ group, key, storedCents: stored[key], nextCents: next[key] }));
  });
}

function draftFrom(model: AdminPlatformModel): Draft {
  return {
    rates: ratesToDraft(model.rates),
    fastRates: ratesToDraft(model.optionRates?.['speed:fast']),
    effort: [...model.optionSupport.effort],
    thinkingDisplay: [...model.optionSupport.thinkingDisplay],
    fast: model.optionSupport.speed.includes('fast'),
    inferenceGeo: model.optionSupport.inferenceGeo.join(', '),
    minPlan: model.minPlan ?? '',
    promptProfile: model.promptProfile,
    platformOffered: model.platformOffered,
    isPlatformDefault: model.isPlatformDefault,
  };
}

function withValue<T>(list: T[], value: T, on: boolean): T[] {
  if (on) return list.includes(value) ? list : [...list, value];
  return list.filter((item) => item !== value);
}

/** Dollars with at least 2 and at most 4 decimals, so sub-cent-precision prices aren't rounded away. */
function dollarsPerM(cents: number): string {
  const dollars = Number((cents / 100).toFixed(4));
  const decimals = Math.min(4, Math.max(2, (String(dollars).split('.')[1] ?? '').length));
  return `$${dollars.toFixed(decimals)}`;
}

function displayChoices(mode: ThinkingMode): readonly ThinkingDisplay[] {
  if (mode === 'adaptive') return THINKING_DISPLAYS;
  if (mode === 'budget') return ['omitted', 'summarized'];
  return [];
}

export default function AiModels() {
  const { t } = useTranslation('admin');
  const stableT = useStableT(t); // effect-safe translator; JSX keeps `t`
  const [models, setModels] = useState<AdminPlatformModel[]>([]);
  const [planOptions, setPlanOptions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [requiresPlatformAdmin, setRequiresPlatformAdmin] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState<AdminPlatformModel | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmingPrices, setConfirmingPrices] = useState(false);

  const fetchModels = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetchWithAuth('/admin/ai-models');
      if (!response.ok) {
        if (response.status === 403) {
          setRequiresPlatformAdmin(true);
          setModels([]);
          return;
        }
        throw new Error(stableT('admin.aiModels.errors.load'));
      }
      setRequiresPlatformAdmin(false);
      const data = (await response.json()) as { models?: AdminPlatformModel[]; planOptions?: string[] };
      setModels(Array.isArray(data.models) ? data.models : []);
      setPlanOptions(Array.isArray(data.planOptions) ? data.planOptions : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : stableT('admin.aiModels.errors.load'));
    } finally {
      setLoading(false);
    }
  }, [stableT]);

  useEffect(() => {
    void fetchModels();
  }, [fetchModels]);

  const largePriceChanges = editing && draft ? findLargePriceChanges(editing, draft) : [];

  const openEditor = (model: AdminPlatformModel) => {
    setConfirmingPrices(false);
    setEditing(model);
    setDraft(draftFrom(model));
  };

  const closeEditor = () => {
    if (saving) return;
    setEditing(null);
    setDraft(null);
  };

  const updateDraft = (patch: Partial<Draft>) => {
    setConfirmingPrices(false);
    setDraft((current) => (current ? { ...current, ...patch } : current));
  };

  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await runAction({
        request: () => fetchWithAuth('/admin/ai-models/refresh', { method: 'POST' }),
        successMessage: t('admin.aiModels.notice.refreshQueued'),
        errorFallback: t('admin.aiModels.errors.refresh'),
      });
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('admin.aiModels.errors.refresh') });
    } finally {
      setRefreshing(false);
    }
  };

  const handleSave = async (confirmedPriceChange = false) => {
    if (!editing || !draft || saving) return;
    const rates = draftToRates(draft.rates);
    const fastRates = draftToRates(draft.fastRates);
    if (rates === 'invalid' || fastRates === 'invalid') {
      showToast({ type: 'error', message: t('admin.aiModels.errors.invalidRates') });
      return;
    }
    if (!confirmedPriceChange && largePriceChanges.length > 0) {
      setConfirmingPrices(true);
      return;
    }
    setConfirmingPrices(false);
    const patch = {
      rates,
      optionRates: fastRates ? { 'speed:fast': fastRates } : null,
      optionSupport: {
        effort: EFFORT_LEVELS.filter((level) => draft.effort.includes(level)),
        thinkingDisplay: THINKING_DISPLAYS.filter((display) => draft.thinkingDisplay.includes(display)),
        speed: draft.fast ? ['standard', 'fast'] : ['standard'],
        inferenceGeo: draft.inferenceGeo.split(',').map((geo) => geo.trim().toLowerCase()).filter(Boolean),
      },
      minPlan: draft.minPlan === '' ? null : draft.minPlan,
      promptProfile: draft.promptProfile,
      platformOffered: draft.platformOffered,
      isPlatformDefault: draft.isPlatformDefault,
    };
    setSaving(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/admin/ai-models/${editing.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        }),
        successMessage: t('admin.aiModels.notice.saved'),
        errorFallback: t('admin.aiModels.errors.save'),
      });
      setEditing(null);
      setDraft(null);
      await fetchModels();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('admin.aiModels.errors.save') });
    } finally {
      setSaving(false);
    }
  };

  if (requiresPlatformAdmin) {
    return (
      <div data-testid="ai-models-requires-platform-admin" className="rounded-lg border bg-white p-6 text-sm text-gray-600">
        {t('admin.aiModels.requiresPlatformAdmin')}
      </div>
    );
  }

  const locked = editing?.isPlatformDefault === true;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Sparkles className="h-5 w-5" aria-hidden="true" />
            {t('admin.aiModels.title')}
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-gray-600">{t('admin.aiModels.subtitle')}</p>
        </div>
        <button
          type="button"
          data-testid="ai-models-refresh"
          onClick={() => void handleRefresh()}
          disabled={refreshing}
          className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm disabled:opacity-50"
        >
          {refreshing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
          {t('admin.aiModels.refresh')}
        </button>
      </div>

      {error && (
        <div data-testid="ai-models-error" role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div data-testid="ai-models-loading" className="flex justify-center p-8">
          <Loader2 className="h-6 w-6 animate-spin text-gray-400" aria-hidden="true" />
        </div>
      ) : models.length === 0 ? (
        <div data-testid="ai-models-empty" className="rounded-lg border bg-white p-6 text-sm text-gray-600">
          {t('admin.aiModels.empty')}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-white">
          <table data-testid="ai-models-table" className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
              <tr>
                <th className="px-3 py-2">{t('admin.aiModels.columns.model')}</th>
                <th className="px-3 py-2">{t('admin.aiModels.columns.status')}</th>
                <th className="px-3 py-2">{t('admin.aiModels.columns.thinking')}</th>
                <th className="px-3 py-2">{t('admin.aiModels.columns.price')}</th>
                <th className="px-3 py-2">{t('admin.aiModels.columns.offered')}</th>
                <th className="px-3 py-2">{t('admin.aiModels.columns.default')}</th>
                <th className="px-3 py-2 text-right">{t('admin.aiModels.columns.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {models.map((model) => {
                const isNew = !model.platformOffered && model.rates === null && model.lastSeenAt !== null;
                return (
                  <tr key={model.id} data-testid={`ai-models-row-${model.id}`} className="border-t">
                    <td className="px-3 py-2">
                      <div className="font-medium">{model.displayName}</div>
                      <div className="font-mono text-xs text-gray-500">{model.modelId}</div>
                    </td>
                    <td className="px-3 py-2">
                      <span data-testid={`ai-models-row-${model.id}-lifecycle`}>
                        {t(/* i18n-dynamic */ `admin.aiModels.lifecycle.${model.lifecycle}`)}
                      </span>
                      {isNew && (
                        <span data-testid={`ai-models-row-${model.id}-new`} className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
                          {t('admin.aiModels.newBadge')}
                        </span>
                      )}
                      {model.lastSeenAt === null && (
                        <div className="text-xs text-gray-500">{t('admin.aiModels.notSeen')}</div>
                      )}
                    </td>
                    <td className="px-3 py-2">{t(/* i18n-dynamic */ `admin.aiModels.thinkingMode.${model.derived.thinkingMode}`)}</td>
                    <td className="px-3 py-2" data-testid={`ai-models-row-${model.id}-price`}>
                      {model.rates
                        ? `${dollarsPerM(model.rates.inputCentsPerM)} / ${dollarsPerM(model.rates.outputCentsPerM)}`
                        : t('admin.aiModels.unpriced')}
                    </td>
                    <td className="px-3 py-2">{model.platformOffered ? t('admin.aiModels.yes') : t('admin.aiModels.no')}</td>
                    <td className="px-3 py-2">
                      {model.isPlatformDefault && (
                        <Star data-testid={`ai-models-row-${model.id}-default`} aria-label={t('admin.aiModels.columns.default')} className="h-4 w-4 text-amber-500" />
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        data-testid={`ai-models-row-${model.id}-edit`}
                        onClick={() => openEditor(model)}
                        className="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs"
                      >
                        <Pencil className="h-3 w-3" aria-hidden="true" />
                        {t('admin.aiModels.edit')}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <PromptVariantsCard />

      <Drawer
        open={editing !== null}
        onClose={closeEditor}
        title={editing ? t('admin.aiModels.drawer.title', { name: editing.displayName }) : ''}
        width="max-w-lg"
        dataTestId="ai-models-drawer"
        closeDisabled={saving}
      >
        {editing && draft && (
          <div className="space-y-5 overflow-y-auto p-5 text-sm">
            <fieldset className="space-y-2">
              <legend className="font-medium">{t('admin.aiModels.drawer.prices')}</legend>
              <div className="grid grid-cols-2 gap-2">
                {RATE_KEYS.map((key) => (
                  <label key={key} className="space-y-1">
                    <span className="text-xs text-gray-600">{t(/* i18n-dynamic */ `admin.aiModels.drawer.${key}`)}</span>
                    <input
                      data-testid={`ai-models-rate-${key}`}
                      type="number"
                      min={0}
                      step="any"
                      value={draft.rates[key]}
                      onChange={(e) => updateDraft({ rates: { ...draft.rates, [key]: e.target.value } })}
                      className="w-full rounded border px-2 py-1"
                    />
                    {editing.rates && (
                      <span className="block text-xs text-gray-500" data-testid={`ai-models-rate-${key}-stored`}>
                        {t('admin.aiModels.drawer.storedPrice', { value: dollarsPerM(editing.rates[key]) })}
                      </span>
                    )}
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset className="space-y-2">
              <legend className="font-medium">{t('admin.aiModels.drawer.fastPrices')}</legend>
              <p className="text-xs text-gray-500">{t('admin.aiModels.drawer.fastPricesHint')}</p>
              <div className="grid grid-cols-2 gap-2">
                {RATE_KEYS.map((key) => (
                  <label key={key} className="space-y-1">
                    <span className="text-xs text-gray-600">{t(/* i18n-dynamic */ `admin.aiModels.drawer.${key}`)}</span>
                    <input
                      data-testid={`ai-models-fast-rate-${key}`}
                      type="number"
                      min={0}
                      step="any"
                      value={draft.fastRates[key]}
                      onChange={(e) => updateDraft({ fastRates: { ...draft.fastRates, [key]: e.target.value } })}
                      className="w-full rounded border px-2 py-1"
                    />
                    {editing.optionRates?.['speed:fast'] && (
                      <span className="block text-xs text-gray-500" data-testid={`ai-models-fast-rate-${key}-stored`}>
                        {t('admin.aiModels.drawer.storedPrice', { value: dollarsPerM(editing.optionRates['speed:fast'][key]) })}
                      </span>
                    )}
                  </label>
                ))}
              </div>
            </fieldset>

            {editing.derived.thinkingMode === 'adaptive' && (
              <fieldset className="space-y-1">
                <legend className="font-medium">{t('admin.aiModels.drawer.effort')}</legend>
                <div className="flex flex-wrap gap-3">
                  {editing.derived.effortLevels.map((level) => (
                    <label key={level} className="inline-flex items-center gap-1">
                      <input
                        data-testid={`ai-models-effort-${level}`}
                        type="checkbox"
                        checked={draft.effort.includes(level)}
                        onChange={(e) => updateDraft({ effort: withValue(draft.effort, level, e.target.checked) })}
                      />
                      {level}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}

            {displayChoices(editing.derived.thinkingMode).length > 0 && (
              <fieldset className="space-y-1">
                <legend className="font-medium">{t('admin.aiModels.drawer.thinkingDisplay')}</legend>
                <div className="flex flex-wrap gap-3">
                  {displayChoices(editing.derived.thinkingMode).map((display) => (
                    <label key={display} className="inline-flex items-center gap-1">
                      <input
                        data-testid={`ai-models-display-${display}`}
                        type="checkbox"
                        checked={draft.thinkingDisplay.includes(display)}
                        onChange={(e) => updateDraft({ thinkingDisplay: withValue(draft.thinkingDisplay, display, e.target.checked) })}
                      />
                      {t(/* i18n-dynamic */ `admin.aiModels.thinkingDisplay.${display}`)}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}

            <label className="flex items-center gap-2">
              <input data-testid="ai-models-fast" type="checkbox" checked={draft.fast} onChange={(e) => updateDraft({ fast: e.target.checked })} />
              {t('admin.aiModels.drawer.fast')}
            </label>

            <label className="block space-y-1">
              <span className="font-medium">{t('admin.aiModels.drawer.inferenceGeo')}</span>
              <input
                data-testid="ai-models-geo"
                type="text"
                value={draft.inferenceGeo}
                onChange={(e) => updateDraft({ inferenceGeo: e.target.value })}
                className="w-full rounded border px-2 py-1"
              />
              <span className="block text-xs text-gray-500">{t('admin.aiModels.drawer.inferenceGeoHint')}</span>
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1">
                <span className="font-medium">{t('admin.aiModels.drawer.minPlan')}</span>
                <select data-testid="ai-models-min-plan" value={draft.minPlan} onChange={(e) => updateDraft({ minPlan: e.target.value })} className="w-full rounded border px-2 py-1">
                  <option value="">{t('admin.aiModels.drawer.allPlans')}</option>
                  {planOptions.map((plan) => <option key={plan} value={plan}>{plan}</option>)}
                </select>
              </label>
              <label className="space-y-1">
                <span className="font-medium">{t('admin.aiModels.drawer.promptProfile')}</span>
                <select
                  data-testid="ai-models-prompt-profile"
                  value={draft.promptProfile}
                  onChange={(e) => updateDraft({ promptProfile: e.target.value as PromptProfile })}
                  className="w-full rounded border px-2 py-1"
                >
                  {PROMPT_PROFILES.map((profile) => (
                    <option key={profile} value={profile}>{t(/* i18n-dynamic */ `admin.aiModels.promptProfile.${profile}`)}</option>
                  ))}
                </select>
              </label>
            </div>

            <label className="flex items-start gap-2">
              <input
                data-testid="ai-models-offered"
                type="checkbox"
                checked={draft.platformOffered}
                disabled={locked}
                onChange={(e) => updateDraft({ platformOffered: e.target.checked })}
              />
              <span>
                {t('admin.aiModels.drawer.offered')}
                <span className="block text-xs text-gray-500">{t('admin.aiModels.drawer.offeredHint')}</span>
              </span>
            </label>

            <label className="flex items-start gap-2">
              <input
                data-testid="ai-models-default"
                type="checkbox"
                checked={draft.isPlatformDefault}
                disabled={locked}
                onChange={(e) => updateDraft({ isPlatformDefault: e.target.checked })}
              />
              <span>
                {t('admin.aiModels.drawer.isDefault')}
                <span className="block text-xs text-gray-500">
                  {locked ? t('admin.aiModels.drawer.defaultLocked') : t('admin.aiModels.drawer.defaultHint')}
                </span>
              </span>
            </label>

            {confirmingPrices && largePriceChanges.length > 0 && (
              <div role="alertdialog" aria-labelledby="ai-models-price-confirm-title" data-testid="ai-models-price-confirm"
                className="space-y-2 rounded border border-amber-400 bg-amber-50 p-3">
                <p id="ai-models-price-confirm-title" className="font-medium">{t('admin.aiModels.drawer.priceChangeTitle')}</p>
                <p className="text-xs text-gray-700">{t('admin.aiModels.drawer.priceChangeIntro')}</p>
                <ul className="space-y-1 text-xs">
                  {largePriceChanges.map((change) => (
                    <li key={`${change.group}-${change.key}`} data-testid={`ai-models-price-confirm-${change.group}-${change.key}`}>
                      {t('admin.aiModels.drawer.priceChangeRow', {
                        group: change.group === 'fast' ? t('admin.aiModels.drawer.priceGroupFast') : t('admin.aiModels.drawer.priceGroupStandard'),
                        field: t(/* i18n-dynamic */ `admin.aiModels.drawer.${change.key}`),
                        stored: dollarsPerM(change.storedCents),
                        next: change.nextCents === null ? t('admin.aiModels.unpriced') : dollarsPerM(change.nextCents),
                      })}
                    </li>
                  ))}
                </ul>
                <div className="flex justify-end gap-2">
                  <button type="button" data-testid="ai-models-price-confirm-back" onClick={() => setConfirmingPrices(false)} disabled={saving} className="rounded border px-3 py-1.5">
                    {t('admin.aiModels.drawer.priceChangeBack')}
                  </button>
                  <button type="button" data-testid="ai-models-price-confirm-save" onClick={() => void handleSave(true)} disabled={saving} className="rounded bg-amber-600 px-3 py-1.5 text-white disabled:opacity-50">
                    {t('admin.aiModels.drawer.priceChangeConfirm')}
                  </button>
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2 border-t pt-4">
              <button type="button" data-testid="ai-models-cancel" onClick={closeEditor} disabled={saving} className="rounded border px-3 py-1.5">
                {t('admin.aiModels.drawer.cancel')}
              </button>
              <button
                type="button"
                data-testid="ai-models-save"
                onClick={() => void handleSave()}
                disabled={saving}
                className="inline-flex items-center gap-2 rounded bg-blue-600 px-3 py-1.5 text-white disabled:opacity-50"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                {t('admin.aiModels.drawer.save')}
              </button>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}
