import type { AiCoverage } from '@breeze/shared';
import { useTranslation } from 'react-i18next';
import { EMPTY_RATE, showUsdOnlyWarning, validateAiUsage, type AiModelChoice, type AiRateDraft, type AiUsageValue } from './aiUsagePricing';

const inputClass = 'w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring';
const buttonClass = 'rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';

export interface AiUsagePricingFieldsProps {
  value: AiUsageValue;
  currencyCode: string;
  choices: AiModelChoice[];
  onChange: (next: AiUsageValue) => void;
  disabled?: boolean;
  /** The model-choices GET failed; the picker degrades to free text. */
  choicesUnavailable?: boolean;
}

/** AI usage terms for one billing profile: coverage, markup on Breeze's cost,
 * and an optional per-model price list. Controlled; the drawer's single Save
 * persists it, so this component never talks to the network. */
export default function AiUsagePricingFields({ value, currencyCode, choices, onChange, disabled = false, choicesUnavailable = false }: AiUsagePricingFieldsProps) {
  const { t } = useTranslation('billing');
  const billable = value.aiCoverage === 'billable';
  const validation = validateAiUsage(value);
  const setCoverage = (aiCoverage: AiCoverage) =>
    onChange(aiCoverage === 'billable' ? { ...value, aiCoverage } : { aiCoverage, aiMarkupPercent: null, aiRates: [] });
  const setRate = (index: number, update: Partial<AiRateDraft>) =>
    onChange({ ...value, aiRates: value.aiRates.map((rate, i) => (i === index ? { ...rate, ...update } : rate)) });
  const priceFields = [
    { key: 'inputPricePerM', testId: 'input', label: t('rates.ai.inputPrice') },
    { key: 'outputPricePerM', testId: 'output', label: t('rates.ai.outputPrice') },
    { key: 'cacheReadPricePerM', testId: 'cache-read', label: t('rates.ai.cacheReadPrice') },
    { key: 'cacheWritePricePerM', testId: 'cache-write', label: t('rates.ai.cacheWritePrice') },
  ] as const;

  return <fieldset className="space-y-3 border-t pt-4" disabled={disabled} data-testid="billing-ai-section">
    <legend className="pt-4 text-sm font-semibold">{t('rates.ai.sectionTitle')}</legend>
    <p className="text-xs text-muted-foreground">{t('rates.ai.sectionHelp')}</p>
    <label className="block text-sm">{t('rates.ai.coverage')}
      <select className={inputClass} data-testid="billing-ai-coverage" disabled={disabled} value={value.aiCoverage} onChange={event => setCoverage(event.target.value as AiCoverage)}>
        <option value="billable">{t('rates.ai.coverageBillable')}</option>
        <option value="included">{t('rates.ai.coverageIncluded')}</option>
        <option value="non_billable">{t('rates.ai.coverageNotBilled')}</option>
      </select>
    </label>
    {billable && <>
      <label className="block text-sm">{t('rates.ai.markup')}
        <input className={inputClass} data-testid="billing-ai-markup" disabled={disabled} inputMode="decimal" autoComplete="off" value={value.aiMarkupPercent ?? ''}
          aria-invalid={validation.markupInvalid} onChange={event => onChange({ ...value, aiMarkupPercent: event.target.value === '' ? null : event.target.value })} />
      </label>
      <p className="text-xs text-muted-foreground">{t('rates.ai.markupHelp')}</p>
      {validation.markupInvalid && <p role="alert" className="text-xs text-destructive" data-testid="billing-ai-markup-error">{t('rates.ai.markupInvalid')}</p>}
      <div className="space-y-3" data-testid="billing-ai-pricelist">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium">{t('rates.ai.priceListTitle')}</h3>
          <button type="button" className={buttonClass} data-testid="billing-ai-rate-add" disabled={disabled} onClick={() => onChange({ ...value, aiRates: [...value.aiRates, { ...EMPTY_RATE }] })}>{t('rates.ai.addRate')}</button>
        </div>
        <p className="text-xs text-muted-foreground">{t('rates.ai.priceListHelp', { currency: currencyCode })}</p>
        {choicesUnavailable && <p className="text-xs text-muted-foreground" data-testid="billing-ai-choices-unavailable">{t('rates.ai.choicesUnavailable')}</p>}
        <datalist id="billing-ai-model-options" data-testid="billing-ai-model-options">
          {choices.map(choice => <option key={choice.modelId} value={choice.modelId} label={choice.label} data-testid={`billing-ai-model-option-${choice.modelId}`} />)}
        </datalist>
        {value.aiRates.length === 0 && <p className="text-xs text-muted-foreground">{t('rates.ai.priceListEmpty')}</p>}
        {value.aiRates.map((rate, index) => <div key={index} className="space-y-2 rounded-md border p-3" data-testid={`billing-ai-rate-row-${index}`}>
          <label className="block text-sm">{t('rates.ai.modelId')}
            <input className={inputClass} list="billing-ai-model-options" maxLength={200} autoComplete="off" placeholder={t('rates.ai.modelPlaceholder')}
              data-testid={`billing-ai-rate-model-${index}`} disabled={disabled} value={rate.modelId} onChange={event => setRate(index, { modelId: event.target.value })} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            {priceFields.map(field => <label key={field.key} className="text-sm">{field.label}
              <input className={inputClass} inputMode="decimal" autoComplete="off" data-testid={`billing-ai-rate-${field.testId}-${index}`} disabled={disabled}
                value={rate[field.key]} onChange={event => setRate(index, { [field.key]: event.target.value })} />
            </label>)}
          </div>
          {validation.rows[index]?.duplicate
            ? <p role="alert" className="text-xs text-destructive" data-testid={`billing-ai-rate-error-${index}`}>{t('rates.ai.rowDuplicate')}</p>
            : validation.rows[index]?.invalid && <p role="alert" className="text-xs text-destructive" data-testid={`billing-ai-rate-error-${index}`}>{t('rates.ai.rowInvalid')}</p>}
          <div className="flex justify-end"><button type="button" className={buttonClass} data-testid={`billing-ai-rate-remove-${index}`} disabled={disabled}
            onClick={() => onChange({ ...value, aiRates: value.aiRates.filter((_, i) => i !== index) })}>{t('rates.ai.removeRate')}</button></div>
        </div>)}
      </div>
      {showUsdOnlyWarning(value, currencyCode) && <p role="status" className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm" data-testid="billing-ai-currency-warning">{t('rates.ai.usdOnlyWarning', { currency: currencyCode })}</p>}
    </>}
  </fieldset>;
}
