import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { CURRENCY_CODES, isZeroDecimal, type ClientProfitabilityGroupBy, type ReportPeriodInput } from '@breeze/shared';
import { currencyLabel, currencyOptions } from '@/lib/currencies';
import { usePartnerCurrency } from '@/lib/usePartnerCurrency';
import {
  DEFAULT_REPORT_PERIOD,
  ReportPeriodField,
  isReportPeriodValid,
  reportPeriodFromConfig,
} from './ReportPeriodField';

/**
 * Options for client profitability (#9828). Same export shape as
 * `AiUsageByClientOptionsForm.tsx`.
 *
 * Nothing optional is stored as a default: `groupBy: null` (the scope default)
 * OMITS the key — the server picks organization at partner scope and source at
 * org scope — and a disabled labor rate OMITS `laborCostPerHour`. The labor
 * rate is one blended rate for every technician, so every figure built on it
 * is an estimate (the generator labels it).
 *
 * Currency: the rate's currency defaults to the partner's billing currency
 * (`usePartnerCurrency`), USD while that is loading or unknown. It is never
 * inferred from report data. An existing config keeps the currency it stored.
 */
export type ClientProfitabilityOptions = {
  period: ReportPeriodInput;
  /** null = scope default: the key is omitted. */
  groupBy: ClientProfitabilityGroupBy | null;
  laborCostEnabled: boolean;
  laborCostAmount: string;
  laborCostCurrency: string;
};

const GROUP_BY_VALUES: readonly ClientProfitabilityGroupBy[] = ['organization', 'source'];
const AMOUNT_PATTERN = /^\d{1,7}(\.\d{1,2})?$/;
const WHOLE_AMOUNT_PATTERN = /^\d+(\.0{1,2})?$/;

export const DEFAULT_CLIENT_PROFITABILITY_OPTIONS: ClientProfitabilityOptions = {
  period: DEFAULT_REPORT_PERIOD,
  groupBy: null,
  laborCostEnabled: false,
  laborCostAmount: '',
  laborCostCurrency: 'USD',
};

function isGroupBy(value: unknown): value is ClientProfitabilityGroupBy {
  return typeof value === 'string' && (GROUP_BY_VALUES as readonly string[]).includes(value);
}

export function clientProfitabilityOptionsFromConfig(config: Record<string, unknown>): ClientProfitabilityOptions {
  const rate = config.laborCostPerHour as { amount?: unknown; currencyCode?: unknown } | null | undefined;
  const hasRate = !!rate && typeof rate === 'object' && typeof rate.amount === 'string' && typeof rate.currencyCode === 'string';
  return {
    period: reportPeriodFromConfig(config.period),
    groupBy: isGroupBy(config.groupBy) ? config.groupBy : null,
    laborCostEnabled: hasRate,
    laborCostAmount: hasRate ? (rate!.amount as string) : DEFAULT_CLIENT_PROFITABILITY_OPTIONS.laborCostAmount,
    // A stored code outside the supported list never passes through (the
    // server would refuse it); the user sees the default and can change it.
    laborCostCurrency: hasRate && isKnownCurrency(rate!.currencyCode as string)
      ? (rate!.currencyCode as string)
      : DEFAULT_CLIENT_PROFITABILITY_OPTIONS.laborCostCurrency,
  };
}

function isKnownCurrency(code: string): boolean {
  return (CURRENCY_CODES as readonly string[]).includes(code);
}

/** The config the create POST / edit PUT carries: exactly the keys
 *  `clientProfitabilityConfigSchema` accepts, with no `groupBy` for the scope
 *  default and no `laborCostPerHour` while the estimate is off. */
export function clientProfitabilityConfigFromOptions(options: ClientProfitabilityOptions): Record<string, unknown> {
  return {
    period: options.period,
    ...(options.groupBy ? { groupBy: options.groupBy } : {}),
    ...(options.laborCostEnabled
      ? { laborCostPerHour: { amount: options.laborCostAmount, currencyCode: options.laborCostCurrency } }
      : {}),
  };
}

function isLaborAmountValid(amount: string, currency: string): boolean {
  if (!AMOUNT_PATTERN.test(amount)) return false;
  if (!(Number(amount) > 0)) return false;
  if (isZeroDecimal(currency) && !WHOLE_AMOUNT_PATTERN.test(amount)) return false;
  return true;
}

export function isClientProfitabilityOptionsValid(options: ClientProfitabilityOptions): boolean {
  if (!isReportPeriodValid(options.period)) return false;
  return !options.laborCostEnabled || isLaborAmountValid(options.laborCostAmount, options.laborCostCurrency);
}

type FieldProps = { value: ClientProfitabilityOptions; onChange: (value: ClientProfitabilityOptions) => void };
type Props = FieldProps & { busy?: boolean; submitLabel: string; onSubmit: () => void; onCancel: () => void };

export function ClientProfitabilityOptionsFields({ value, onChange }: FieldProps) {
  const { t, i18n } = useTranslation('reports');
  const { currency: partnerCurrency } = usePartnerCurrency();
  const amountInvalid = value.laborCostEnabled && !isLaborAmountValid(value.laborCostAmount, value.laborCostCurrency);
  // The rate's currency follows the partner currency when it resolves AFTER
  // the estimate was switched on — unless the user picked a currency, or the
  // report already stored a rate (a stored currency always wins).
  const seedable = useRef(!value.laborCostEnabled);
  const currencyTouched = useRef(false);
  useEffect(() => {
    if (!seedable.current || currencyTouched.current || !value.laborCostEnabled || !partnerCurrency) return;
    if (value.laborCostCurrency !== partnerCurrency) onChange({ ...value, laborCostCurrency: partnerCurrency });
  }, [partnerCurrency, value, onChange]);
  return (
    <div className="space-y-4">
      <ReportPeriodField
        idPrefix="client-profitability"
        value={value.period}
        onChange={(period) => onChange({ ...value, period })}
      />

      <label className="block rounded-md border p-4">
        <span className="block text-sm font-medium">{t('reports.clientProfitabilityOptions.groupBy')}</span>
        <select
          data-testid="client-profitability-group-by"
          value={value.groupBy ?? ''}
          onChange={(event) => {
            const next = event.target.value;
            onChange({ ...value, groupBy: isGroupBy(next) ? next : null });
          }}
          className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm"
        >
          <option value="">{t('reports.clientProfitabilityOptions.groupByDefault')}</option>
          {GROUP_BY_VALUES.map((option) => (
            <option key={option} value={option}>
              {t(/* i18n-dynamic */ `reports.clientProfitabilityOptions.groupByValues.${option}`)}
            </option>
          ))}
        </select>
        <span className="mt-1 block text-xs text-muted-foreground">
          {t('reports.clientProfitabilityOptions.groupByHelp')}
        </span>
      </label>

      <div className="rounded-md border p-4">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            data-testid="client-profitability-labor-enabled"
            checked={value.laborCostEnabled}
            onChange={(event) => {
              const next = event.target.checked;
              onChange({
                ...value,
                laborCostEnabled: next,
                // Seed the currency from the partner's billing currency on the
                // way in; never overwrite one the config already stored.
                laborCostCurrency: next && !value.laborCostAmount && partnerCurrency
                  ? partnerCurrency
                  : value.laborCostCurrency,
              });
            }}
          />
          {t('reports.clientProfitabilityOptions.laborEnabled')}
        </label>
        {value.laborCostEnabled && (
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="block font-medium">{t('reports.clientProfitabilityOptions.laborAmount')}</span>
              <input
                type="text"
                inputMode="decimal"
                data-testid="client-profitability-labor-amount"
                value={value.laborCostAmount}
                aria-invalid={amountInvalid}
                onChange={(event) => onChange({ ...value, laborCostAmount: event.target.value })}
                className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
              />
            </label>
            <label className="block text-sm">
              <span className="block font-medium">{t('reports.clientProfitabilityOptions.laborCurrency')}</span>
              <select
                data-testid="client-profitability-labor-currency"
                value={value.laborCostCurrency}
                onChange={(event) => {
                  currencyTouched.current = true;
                  onChange({ ...value, laborCostCurrency: event.target.value });
                }}
                className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
              >
                {currencyOptions(value.laborCostCurrency).map((code) => (
                  <option key={code} value={code}>{currencyLabel(code, i18n.language)}</option>
                ))}
              </select>
            </label>
          </div>
        )}
        <p className="mt-2 text-xs text-muted-foreground">{t('reports.clientProfitabilityOptions.laborHelp')}</p>
      </div>
    </div>
  );
}

export function ClientProfitabilityOptionsForm({ value, onChange, busy = false, submitLabel, onSubmit, onCancel }: Props) {
  const { t } = useTranslation('reports');
  return (
    <div className="space-y-5">
      <ClientProfitabilityOptionsFields value={value} onChange={onChange} />
      <div className="flex justify-end gap-2">
        <button type="button" className="rounded-md border px-4 py-2 text-sm" onClick={onCancel}>
          {t('reports.clientProfitabilityOptions.cancel')}
        </button>
        <button
          type="button"
          data-testid="client-profitability-create-report"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
          disabled={busy || !isClientProfitabilityOptionsValid(value)}
          onClick={onSubmit}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
