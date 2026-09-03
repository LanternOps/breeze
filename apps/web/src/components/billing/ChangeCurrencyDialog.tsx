import { useTranslation } from 'react-i18next';
import { Dialog } from '../shared/Dialog';
import { currencyLabel, currencyOptions } from '@/lib/currencies';

/**
 * Shared change-currency dialog for DRAFT quotes and invoices (#4416).
 *
 * Ports the pattern ContractDetail's currency restamp dialog established
 * (#3778) for the two draft-only document types that share one server
 * contract: `POST /(quotes|invoices)/:id/currency` (multi-currency wave 2,
 * #3774) accepts `{ currencyCode, clearLines? | reprice? }` and 409s
 * `CURRENCY_LOCKED` when priced lines exist and neither is set. Unlike the
 * contract op (ACTIVE contracts only, blockers keyed by row id), the draft op
 * has no structured blocker payload — just a human-readable message — so this
 * dialog surfaces `error` as a single inline string rather than an id list.
 *
 * All copy is pre-translated by the caller (quote/invoice-specific i18n
 * namespaces) so the static i18n key-usage check can verify every key at its
 * real call site instead of through a dynamic prefix.
 */
export type CurrencyChangeMode = 'clear' | 'reprice';

export interface ChangeCurrencyDialogCopy {
  title: string;
  description: string;
  currencyLabel: string;
  modeLegend: string;
  modeClearLabel: string;
  modeClearHint: string;
  modeRepriceLabel: string;
  modeRepriceHint: string;
  confirmLabel: string;
  submitLabel: string;
  cancelLabel: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  busy: boolean;
  currentCurrency: string;
  targetCurrency: string;
  onTargetCurrencyChange: (code: string) => void;
  mode: CurrencyChangeMode | null;
  onModeChange: (mode: CurrencyChangeMode) => void;
  confirmed: boolean;
  onConfirmedChange: (confirmed: boolean) => void;
  /** Inline 409/CURRENCY_LOCKED message. runAction already toasts it; this
   *  keeps it visible in the (still-open) dialog too. */
  error: string | null;
  onSubmit: () => void;
  submittable: boolean;
  copy: ChangeCurrencyDialogCopy;
  /** data-testid prefix, e.g. "quote-currency" / "invoice-currency" — mirrors
   *  the "contract-currency-*" ids ContractDetail's dialog established. */
  testIdPrefix: string;
}

export default function ChangeCurrencyDialog({
  open, onClose, busy, currentCurrency, targetCurrency, onTargetCurrencyChange,
  mode, onModeChange, confirmed, onConfirmedChange, error, onSubmit, submittable,
  copy, testIdPrefix,
}: Props) {
  const { i18n } = useTranslation('billing');
  return (
    <Dialog open={open} onClose={onClose} title={copy.title} maxWidth="lg" className="p-6">
      <div className="space-y-4" data-testid={`${testIdPrefix}-dialog`}>
        <div>
          <h3 className="text-base font-semibold">{copy.title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{copy.description}</p>
        </div>

        <div>
          <label className="text-sm font-medium" htmlFor={`${testIdPrefix}-select`}>
            {copy.currencyLabel}
          </label>
          <select
            id={`${testIdPrefix}-select`}
            value={targetCurrency}
            onChange={(e) => onTargetCurrencyChange(e.target.value)}
            data-testid={`${testIdPrefix}-select`}
            className="mt-1 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
          >
            {currencyOptions(currentCurrency).map((code) => (
              <option key={code} value={code}>{currencyLabel(code, i18n.language)}</option>
            ))}
          </select>
        </div>

        {/* clearLines and reprice are mutually exclusive server-side, so the UI
            models them as one radio group rather than two checkboxes that could
            be sent together. */}
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{copy.modeLegend}</legend>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio" name={`${testIdPrefix}-mode`} value="clear"
              checked={mode === 'clear'}
              onChange={() => onModeChange('clear')}
              data-testid={`${testIdPrefix}-mode-clear`}
              className="mt-1"
            />
            <span>
              <span className="font-medium">{copy.modeClearLabel}</span>
              <span className="block text-muted-foreground">{copy.modeClearHint}</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="radio" name={`${testIdPrefix}-mode`} value="reprice"
              checked={mode === 'reprice'}
              onChange={() => onModeChange('reprice')}
              data-testid={`${testIdPrefix}-mode-reprice`}
              className="mt-1"
            />
            <span>
              <span className="font-medium">{copy.modeRepriceLabel}</span>
              <span className="block text-muted-foreground">{copy.modeRepriceHint}</span>
            </span>
          </label>
        </fieldset>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => onConfirmedChange(e.target.checked)}
            data-testid={`${testIdPrefix}-confirm-check`}
            className="mt-1"
          />
          <span>{copy.confirmLabel}</span>
        </label>

        {error && (
          <div
            className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
            data-testid={`${testIdPrefix}-error`}
            role="alert"
          >
            {error}
          </div>
        )}

        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
          >
            {copy.cancelLabel}
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={busy || !submittable}
            data-testid={`${testIdPrefix}-submit`}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {copy.submitLabel}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
