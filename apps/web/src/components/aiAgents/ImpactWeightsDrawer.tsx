import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { Drawer } from '../shared/Drawer';
import { fetchWithAuth } from '../../stores/auth';
import { runAction } from '@/lib/runAction';
import { DEFAULT_IMPACT_WEIGHTS, IMPACT_WEIGHT_KEYS, IMPACT_WEIGHT_MAX_SECONDS } from '@breeze/shared';
import type { ImpactWeightOverrides, ImpactWeights } from '@breeze/shared';

export interface ImpactWeightsDrawerProps {
  open: boolean;
  effective: ImpactWeights;
  overrides: ImpactWeightOverrides | null;
  onClose: () => void;
  /** Called after a successful save/reset so the page can refetch the DTO. */
  onSaved: () => void;
}

// Literal-key label lookups (not dynamic t()), same idiom as ImpactPage's
// windowLabel/weightLabel — the keyUsage guard can then verify every label
// statically without needing an `i18n-dynamic` marker.
function weightLabel(t: (key: string) => string, key: (typeof IMPACT_WEIGHT_KEYS)[number]): string {
  switch (key) {
    case 'alertJudged':
      return t('aiAgentsPage.impact.weightLabels.alertJudged');
    case 'noiseFlagged':
      return t('aiAgentsPage.impact.weightLabels.noiseFlagged');
    case 'ticketTriaged':
      return t('aiAgentsPage.impact.weightLabels.ticketTriaged');
    case 'draftSent':
      return t('aiAgentsPage.impact.weightLabels.draftSent');
    case 'fixExecuted':
      return t('aiAgentsPage.impact.weightLabels.fixExecuted');
    case 'narrativeDelivered':
      return t('aiAgentsPage.impact.weightLabels.narrativeDelivered');
    default:
      return key;
  }
}

/** Clamp to the server's accepted range — `impactWeightsSchema` rejects
 *  anything outside [0, IMPACT_WEIGHT_MAX_SECONDS], so a value typed past the
 *  edge must be visibly corrected here rather than 400ing silently at Save. */
function clamp(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  return Math.min(IMPACT_WEIGHT_MAX_SECONDS, Math.max(0, Math.round(raw)));
}

/**
 * Weights drawer (Task 11, #4193). Six number inputs seeded from the
 * effective (defaults merged with any stored override) weights. Save PUTs
 * every key whose CURRENT value differs from `DEFAULT_IMPACT_WEIGHTS` — the
 * PUT route REPLACES the whole `partners.ai_impact_weights` jsonb column
 * (`saveImpactWeights` -> `set({ aiImpactWeights: normalized })`, it does
 * not merge), so the body must always be the operator's complete override
 * set, not just the fields touched in this session. Diffing against
 * `effective` (defaults merged with any PRE-EXISTING override) instead of
 * against the defaults would drop every override the operator didn't touch
 * in this drawer visit back to its default the moment any single field is
 * edited — and would silently wipe every stored override on a no-edit Save,
 * since `diff(effective, effective)` is always `{}`. Reset DELETEs
 * unconditionally, dropping any stored override back to the defaults.
 */
export default function ImpactWeightsDrawer({
  open,
  effective,
  overrides,
  onClose,
  onSaved,
}: ImpactWeightsDrawerProps) {
  const { t } = useTranslation('settings');
  const [values, setValues] = useState<ImpactWeights>(effective);
  const [busy, setBusy] = useState<'save' | 'reset' | null>(null);

  // Reseed from `effective` only on the closed->open transition. A background
  // poll on the page can refresh `effective` while the drawer stays open (the
  // page re-renders with a new object on every refetch); reseeding on every
  // such change would silently discard an in-progress edit.
  useEffect(() => {
    if (open) setValues(effective);
    // Deliberately NOT depending on `effective` — see the comment above.
    // (No react-hooks plugin is registered in this project's ESLint config, so
    // there is no exhaustive-deps rule to suppress here.)
  }, [open]);

  const handleChange = (key: (typeof IMPACT_WEIGHT_KEYS)[number], raw: string) => {
    setValues((prev) => ({ ...prev, [key]: clamp(Number(raw)) }));
  };

  /**
   * The full override set to send: every key whose current value differs
   * from its DEFAULT (not from `effective` — see the drawer's docstring).
   * A key equal to its default is omitted, which is correct too: sending
   * `{}` overall means "no overrides at all" and matches what Reset does,
   * while omitting just one key resets that one field to default while
   * preserving the rest of the sent object's keys.
   */
  function diffFromDefault(): ImpactWeightOverrides {
    const changed: ImpactWeightOverrides = {};
    for (const key of IMPACT_WEIGHT_KEYS) {
      if (values[key] !== DEFAULT_IMPACT_WEIGHTS[key]) changed[key] = values[key];
    }
    return changed;
  }

  const handleSave = async () => {
    if (busy) return;
    setBusy('save');
    try {
      await runAction({
        request: () =>
          fetchWithAuth('/api/ai/agents/impact/weights', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(diffFromDefault()),
          }),
        errorFallback: t('aiAgentsPage.impact.weightsDrawer.errors.save'),
        successMessage: t('aiAgentsPage.impact.weightsDrawer.toasts.saved'),
      });
    } catch {
      // runAction already toasted (ActionError) or a network failure already
      // toasted its own generic error — nothing left to do but stop spinning.
      setBusy(null);
      return;
    }
    setBusy(null);
    onSaved();
  };

  const handleReset = async () => {
    if (busy) return;
    setBusy('reset');
    try {
      await runAction({
        request: () => fetchWithAuth('/api/ai/agents/impact/weights', { method: 'DELETE' }),
        errorFallback: t('aiAgentsPage.impact.weightsDrawer.errors.reset'),
        successMessage: t('aiAgentsPage.impact.weightsDrawer.toasts.reset'),
      });
    } catch {
      setBusy(null);
      return;
    }
    setBusy(null);
    onSaved();
  };

  if (!open) return null;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={t('aiAgentsPage.impact.weightsDrawer.title')}
      dataTestId="ai-impact-weights-drawer"
      closeDisabled={busy !== null}
    >
      <div className="flex-1 space-y-4 overflow-y-auto p-5">
        <p className="text-sm text-muted-foreground">
          {t('aiAgentsPage.impact.weightsDrawer.description')}
        </p>
        {IMPACT_WEIGHT_KEYS.map((key) => (
          <label key={key} className="block">
            <span className="text-sm text-muted-foreground">{weightLabel(t, key)}</span>
            {overrides?.[key] !== undefined && (
              <span
                data-testid={`ai-impact-weight-${key}-customized`}
                className="ml-2 text-xs text-amber-600 dark:text-amber-400"
              >
                {t('aiAgentsPage.impact.weightsDrawer.customized')}
              </span>
            )}
            <input
              type="number"
              min={0}
              max={IMPACT_WEIGHT_MAX_SECONDS}
              step={1}
              data-testid={`ai-impact-weight-${key}`}
              value={values[key]}
              onChange={(e) => handleChange(key, e.target.value)}
              disabled={busy !== null}
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            />
          </label>
        ))}
      </div>
      <div className="flex items-center justify-end gap-2 border-t px-5 py-4">
        <button
          type="button"
          data-testid="ai-impact-weights-reset"
          onClick={() => void handleReset()}
          disabled={busy !== null}
          className="rounded-md border px-3 py-2 text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === 'reset'
            ? t('aiAgentsPage.impact.weightsDrawer.resetting')
            : t('aiAgentsPage.impact.weightsDrawer.reset')}
        </button>
        <button
          type="button"
          data-testid="ai-impact-weights-save"
          onClick={() => void handleSave()}
          disabled={busy !== null}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy === 'save'
            ? t('aiAgentsPage.impact.weightsDrawer.saving')
            : t('aiAgentsPage.impact.weightsDrawer.save')}
        </button>
      </div>
    </Drawer>
  );
}
