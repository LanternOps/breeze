import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { Drawer } from '../shared/Drawer';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { fetchWithAuth } from '../../stores/auth';
import { runAction } from '@/lib/runAction';
import { formatNumber } from '@/lib/i18n/format';
import { badgeClass } from './statusBadge';
import {
  DEFAULT_IMPACT_WEIGHTS,
  IMPACT_WEIGHT_KEYS,
  IMPACT_WEIGHT_MAX_SECONDS,
  estimateSecondsSaved,
} from '@breeze/shared';
import type {
  AiAgentImpactCounters,
  ImpactWeightOverrides,
  ImpactWeights,
} from '@breeze/shared';

/** The single unit this editor speaks — see the drawer's docstring below. */
const IMPACT_WEIGHT_MAX_MINUTES = IMPACT_WEIGHT_MAX_SECONDS / 60;

/**
 * Draft values held while the drawer is open — MINUTES (as TEXT, not the wire
 * unit and not a `number`). A `number` state forces every keystroke through
 * `<input type="number">`'s DOM value, which the HTML spec sanitizes to ""
 * for an in-progress entry like "2." (no digit after the decimal point yet —
 * confirmed: real browsers and jsdom both do this via the number-input value
 * sanitization algorithm). `Number("")` is 0, so a `number` state re-render
 * would snap the box to "0" mid-keystroke, silently discarding the "2" the
 * operator had already typed the moment they typed the ".". Holding the
 * draft as a string instead lets the box show exactly what the browser
 * reports, and defers "what does this mean as a number" to the two real
 * boundaries: the live preview and Save (see `minutesToSeconds`, `clampMinutes`).
 */
type DraftMinutesText = Record<(typeof IMPACT_WEIGHT_KEYS)[number], string>;

export interface ImpactWeightsDrawerProps {
  open: boolean;
  effective: ImpactWeights;
  overrides: ImpactWeightOverrides | null;
  /** This window's raw outcome counters, for the live re-pricing preview. */
  counters: AiAgentImpactCounters;
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

/** Default minutes text per field, for the "Default N min" helper caption —
 *  computed once at module scope since `DEFAULT_IMPACT_WEIGHTS` is a constant. */
const DEFAULT_MINUTES_TEXT: Record<(typeof IMPACT_WEIGHT_KEYS)[number], string> = Object.fromEntries(
  IMPACT_WEIGHT_KEYS.map((key) => [
    key,
    formatNumber(DEFAULT_IMPACT_WEIGHTS[key] / 60, { maximumFractionDigits: 2 }),
  ]),
) as Record<(typeof IMPACT_WEIGHT_KEYS)[number], string>;

/** Wire unit -> editor unit. Rounded to a hundredth of a minute (0.6s) purely
 *  for a readable seed value — `minutesToSeconds` below undoes float noise on
 *  the way back out, so this rounding never changes what gets saved. */
function secondsToMinutes(seconds: number): number {
  return Math.round((seconds / 60) * 100) / 100;
}

/** Editor unit -> wire unit. Clamps to the server's accepted range —
 *  `impactWeightsSchema` rejects anything outside [0, IMPACT_WEIGHT_MAX_SECONDS]
 *  and requires an integer, so a value typed past the edge or mid-second must
 *  be visibly corrected here rather than 400ing silently at Save. */
function minutesToSeconds(minutes: number): number {
  if (!Number.isFinite(minutes)) return 0;
  return Math.min(IMPACT_WEIGHT_MAX_SECONDS, Math.max(0, Math.round(minutes * 60)));
}

/** Clamp a typed minutes value to the editor's own range. Decimals (e.g. the
 *  0.5-minute step, or anything finer typed by hand) are preserved here —
 *  only `minutesToSeconds` rounds, at the API boundary. */
function clampMinutes(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  return Math.min(IMPACT_WEIGHT_MAX_MINUTES, Math.max(0, raw));
}

function seedFromEffective(effective: ImpactWeights): DraftMinutesText {
  const seeded = {} as DraftMinutesText;
  for (const key of IMPACT_WEIGHT_KEYS) seeded[key] = String(secondsToMinutes(effective[key]));
  return seeded;
}

/** Draft text -> number, for the two real boundaries (preview, Save/diff) and
 *  for the blur-time clamp below. Not `Number.isFinite`-guarded here — every
 *  caller already routes the result through `clampMinutes` or
 *  `minutesToSeconds`, which both treat a non-finite input (NaN from empty or
 *  garbage text) as 0. */
function parseDraftMinutes(raw: string): number {
  return Number(raw);
}

/**
 * Weights drawer (Task 11, #4193). Six number inputs seeded from the
 * effective (defaults merged with any stored override) weights.
 *
 * MINUTES is the one unit this editor, the page's disclosure, and the PDF
 * export all speak — the wire contract (`ai_impact_weights`, the PUT/DELETE
 * routes, `DEFAULT_IMPACT_WEIGHTS`) stays in SECONDS unchanged. `values`
 * therefore holds draft MINUTES, converted to seconds only at the two API
 * boundaries: `diffFromDefault` (Save) and the live preview below.
 *
 * Save PUTs every key whose CURRENT value (converted to seconds) differs
 * from `DEFAULT_IMPACT_WEIGHTS` — the PUT route REPLACES the whole
 * `partners.ai_impact_weights` jsonb column (`saveImpactWeights` ->
 * `set({ aiImpactWeights: normalized })`, it does not merge), so the body
 * must always be the operator's complete override set, not just the fields
 * touched in this session. Diffing against `effective` (defaults merged with
 * any PRE-EXISTING override) instead of against the defaults would drop
 * every override the operator didn't touch in this drawer visit back to its
 * default the moment any single field is edited — and would silently wipe
 * every stored override on a no-edit Save, since `diff(effective, effective)`
 * is always `{}`. Reset DELETEs unconditionally, dropping any stored
 * override back to the defaults — confirmed first, since it silently
 * discards every customization in one click.
 */
export default function ImpactWeightsDrawer({
  open,
  effective,
  overrides,
  counters,
  onClose,
  onSaved,
}: ImpactWeightsDrawerProps) {
  const { t } = useTranslation('settings');
  const [values, setValues] = useState<DraftMinutesText>(() => seedFromEffective(effective));
  const [busy, setBusy] = useState<'save' | 'reset' | null>(null);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);

  // Reseed from `effective` only on the closed->open transition. A background
  // poll on the page can refresh `effective` while the drawer stays open (the
  // page re-renders with a new object on every refetch); reseeding on every
  // such change would silently discard an in-progress edit.
  useEffect(() => {
    if (open) setValues(seedFromEffective(effective));
    // Deliberately NOT depending on `effective` — see the comment above.
    // (No react-hooks plugin is registered in this project's ESLint config, so
    // there is no exhaustive-deps rule to suppress here.)
  }, [open]);

  // Stores exactly what the input reports, unclamped and unrounded — an
  // intermediate typed state like "2." or "" is preserved as-is rather than
  // coerced through `Number()` (see `DraftMinutesText`'s docstring).
  const handleChange = (key: (typeof IMPACT_WEIGHT_KEYS)[number], raw: string) => {
    setValues((prev) => ({ ...prev, [key]: raw }));
  };

  // Clamp on BLUR, not on every keystroke: this is the one point where it's
  // safe to normalize the box's text without fighting an in-progress edit.
  const handleBlur = (key: (typeof IMPACT_WEIGHT_KEYS)[number]) => {
    setValues((prev) => ({ ...prev, [key]: String(clampMinutes(parseDraftMinutes(prev[key]))) }));
  };

  /**
   * The full override set to send: every key whose current value (converted
   * to seconds) differs from its DEFAULT (not from `effective` — see the
   * drawer's docstring). A key equal to its default is omitted, which is
   * correct too: sending `{}` overall means "no overrides at all" and
   * matches what Reset does, while omitting just one key resets that one
   * field to default while preserving the rest of the sent object's keys.
   */
  function diffFromDefault(): ImpactWeightOverrides {
    const changed: ImpactWeightOverrides = {};
    for (const key of IMPACT_WEIGHT_KEYS) {
      const seconds = minutesToSeconds(parseDraftMinutes(values[key]));
      if (seconds !== DEFAULT_IMPACT_WEIGHTS[key]) changed[key] = seconds;
    }
    return changed;
  }

  // Live re-pricing preview: the SAME counters this window already carries,
  // priced first at the weights currently in effect, then at the operator's
  // in-progress draft — so the estimate updates as each field changes,
  // without re-running the nightly rollup.
  const draftWeights = useMemo<ImpactWeights>(() => {
    const result = {} as ImpactWeights;
    for (const key of IMPACT_WEIGHT_KEYS) result[key] = minutesToSeconds(parseDraftMinutes(values[key]));
    return result;
  }, [values]);
  const currentEstSecondsSaved = useMemo(
    () => estimateSecondsSaved(counters, effective),
    [counters, effective],
  );
  const draftEstSecondsSaved = useMemo(
    () => estimateSecondsSaved(counters, draftWeights),
    [counters, draftWeights],
  );
  const formatHours = (seconds: number) =>
    t('aiAgentsPage.impact.tiles.estTimeSavedValue', {
      hours: formatNumber(seconds / 3600, { maximumFractionDigits: 1 }),
      // i18next plural-family selector (`_one`/`_other`) — see the drawer for
      // this exact key's other three call sites in ImpactPage.tsx.
      count: seconds / 3600,
    });

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
    let succeeded = false;
    try {
      await runAction({
        request: () => fetchWithAuth('/api/ai/agents/impact/weights', { method: 'DELETE' }),
        errorFallback: t('aiAgentsPage.impact.weightsDrawer.errors.reset'),
        successMessage: t('aiAgentsPage.impact.weightsDrawer.toasts.reset'),
      });
      succeeded = true;
    } catch {
      // runAction already toasted — fall through to the shared cleanup below.
    } finally {
      // Closed here, AFTER `busy` clears, not synchronously on click: Dialog
      // restores focus to whatever element was active when it opened (the
      // Reset button) as soon as it closes. Closing it back when that button
      // is still `disabled={busy !== null}` sends focus nowhere — it lands on
      // `document.body`. Waiting for the request to settle first means the
      // button is enabled again by the time Dialog's cleanup effect runs.
      setBusy(null);
      setResetConfirmOpen(false);
    }
    if (succeeded) onSaved();
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
        <p
          className="text-xs text-muted-foreground"
          data-testid="ai-impact-weights-range-hint"
        >
          {t('aiAgentsPage.impact.weightsDrawer.rangeHint', {
            min: 0,
            max: IMPACT_WEIGHT_MAX_MINUTES,
          })}
        </p>
        {IMPACT_WEIGHT_KEYS.map((key) => (
          <label key={key} className="block">
            <span className="text-sm text-muted-foreground">{weightLabel(t, key)}</span>
            {overrides?.[key] !== undefined && (
              <span
                data-testid={`ai-impact-weight-${key}-customized`}
                className={`ml-2 ${badgeClass('accent', { size: 'sm' })}`}
              >
                {t('aiAgentsPage.impact.weightsDrawer.customized')}
              </span>
            )}
            <div className="relative mt-1">
              <input
                type="number"
                min={0}
                max={IMPACT_WEIGHT_MAX_MINUTES}
                step={0.5}
                inputMode="decimal"
                data-testid={`ai-impact-weight-${key}`}
                aria-describedby={`ai-impact-weight-${key}-unit`}
                value={values[key]}
                onChange={(e) => handleChange(key, e.target.value)}
                onBlur={() => handleBlur(key)}
                disabled={busy !== null}
                // The native number-input spinner (Chrome/Safari's up/down
                // stepper) sits inside the same right-hand padding as the
                // "min" suffix and visually collides with it — step buttons
                // aren't needed here (the 0.5 step is set for keyboard
                // arrow-key nudging, not for the spinner), so the spinner is
                // hidden outright rather than repositioning the suffix.
                className="w-full rounded-md border bg-background px-3 py-2 pr-12 text-sm [appearance:textfield] disabled:cursor-not-allowed disabled:opacity-50 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
              <span
                id={`ai-impact-weight-${key}-unit`}
                data-testid={`ai-impact-weight-${key}-unit`}
                className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground"
              >
                {t('aiAgentsPage.impact.weightsDrawer.unitSuffix')}
              </span>
            </div>
            <p
              className="mt-1 text-xs text-muted-foreground"
              data-testid={`ai-impact-weight-${key}-default`}
            >
              {t('aiAgentsPage.impact.weightsDrawer.defaultValue', {
                minutes: DEFAULT_MINUTES_TEXT[key],
              })}
            </p>
          </label>
        ))}
      </div>
      <div className="border-t px-5 py-4">
        <p
          data-testid="ai-impact-weights-preview"
          className="mb-3 text-sm text-muted-foreground"
        >
          {/* Both sides price the SAME counters (see the comment above) — if
              every priced counter is zero, the estimate is 0 regardless of
              the weights, and "0 hours -> 0 hours" reads as broken math
              rather than as "there's nothing to preview yet". */}
          {currentEstSecondsSaved === 0 && draftEstSecondsSaved === 0
            ? t('aiAgentsPage.impact.weightsDrawer.noOutcomesPreview')
            : t('aiAgentsPage.impact.weightsDrawer.preview', {
                from: formatHours(currentEstSecondsSaved),
                to: formatHours(draftEstSecondsSaved),
              })}
        </p>
        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            data-testid="ai-impact-weights-reset"
            onClick={() => setResetConfirmOpen(true)}
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
      </div>
      <ConfirmDialog
        open={resetConfirmOpen}
        onClose={() => setResetConfirmOpen(false)}
        onConfirm={() => void handleReset()}
        isLoading={busy === 'reset'}
        title={t('aiAgentsPage.impact.weightsDrawer.resetConfirm.title')}
        message={t('aiAgentsPage.impact.weightsDrawer.resetConfirm.message')}
        confirmLabel={t('aiAgentsPage.impact.weightsDrawer.reset')}
        confirmTestId="ai-impact-weights-reset-confirm"
        variant="warning"
      />
    </Drawer>
  );
}
