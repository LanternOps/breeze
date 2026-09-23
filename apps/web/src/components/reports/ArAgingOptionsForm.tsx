import { useTranslation } from 'react-i18next';
import { isRealCalendarDate } from '@breeze/shared';

/**
 * Options for AR aging (#3198 R3). Same export shape as
 * `IdentityAccessOptionsForm.tsx`, plus a `*ConfigFromOptions` mapper — here it
 * matters, because `asOf` must be OMITTED (not `null`) when unset.
 *
 * AR aging takes NO period: its window is "open balances as of a moment", not a
 * range (spec §3.3 R3). The as-of date moves only the aging reference date —
 * balances are the current ones, so it does not reconstruct history or undo
 * payments recorded after it (`CURRENT_BALANCE_NOTE`,
 * `apps/api/src/services/businessReports/arAgingReport.ts`). The help copy says
 * exactly that and nothing more.
 */
export type ArAgingGroupBy = 'organization' | 'currency';

export type ArAgingOptions = {
  /** null = "as of the day the report runs", evaluated server-side in the
   *  owner's resolved timezone. Deliberately NOT pre-filled with today: a
   *  monthly schedule pre-filled at creation would age against the same frozen
   *  day for the rest of its life. */
  asOf: string | null;
  groupBy: ArAgingGroupBy;
  includePaidInPeriod: boolean;
};

const GROUP_BY_VALUES: readonly ArAgingGroupBy[] = ['organization', 'currency'];

export const DEFAULT_AR_AGING_OPTIONS: ArAgingOptions = {
  asOf: null,
  groupBy: 'organization',
  includePaidInPeriod: false,
};

function isGroupBy(value: unknown): value is ArAgingGroupBy {
  return typeof value === 'string' && (GROUP_BY_VALUES as readonly string[]).includes(value);
}

/** The object the create POST / edit PUT carries as `config`. `asOf` is
 *  OMITTED when unset — the server schema types it as an optional date. */
export function arAgingConfigFromOptions(options: ArAgingOptions): Record<string, unknown> {
  return {
    ...(options.asOf ? { asOf: options.asOf } : {}),
    groupBy: options.groupBy,
    includePaidInPeriod: options.includePaidInPeriod,
  };
}

export function arAgingOptionsFromConfig(config: Record<string, unknown>): ArAgingOptions {
  const asOf = config.asOf;
  return {
    asOf: typeof asOf === 'string' && isRealCalendarDate(asOf) ? asOf : null,
    groupBy: isGroupBy(config.groupBy) ? config.groupBy : DEFAULT_AR_AGING_OPTIONS.groupBy,
    includePaidInPeriod: config.includePaidInPeriod === true,
  };
}

export function isArAgingOptionsValid(options: ArAgingOptions): boolean {
  return options.asOf === null || isRealCalendarDate(options.asOf);
}

type FieldProps = { value: ArAgingOptions; onChange: (value: ArAgingOptions) => void };
type Props = FieldProps & { busy?: boolean; submitLabel: string; onSubmit: () => void; onCancel: () => void };

export function ArAgingOptionsFields({ value, onChange }: FieldProps) {
  const { t } = useTranslation('reports');
  const asOfInvalid = !isArAgingOptionsValid(value);
  return (
    <div className="space-y-4">
      <label className="block rounded-md border p-4">
        <span className="block text-sm font-medium">{t('reports.arAgingOptions.asOf')}</span>
        <input
          data-testid="ar-aging-as-of"
          type="date"
          value={value.asOf ?? ''}
          onChange={(event) => onChange({ ...value, asOf: event.target.value || null })}
          className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm"
        />
        <span data-testid="ar-aging-as-of-help" className="mt-1 block text-xs text-muted-foreground">
          {t('reports.arAgingOptions.asOfHelp')}
        </span>
        {asOfInvalid && (
          <span data-testid="ar-aging-as-of-error" role="alert" className="mt-1 block text-xs text-destructive">
            {t('reports.arAgingOptions.asOfInvalid')}
          </span>
        )}
      </label>

      <label className="block rounded-md border p-4">
        <span className="block text-sm font-medium">{t('reports.arAgingOptions.groupBy')}</span>
        <select
          data-testid="ar-aging-group-by"
          value={value.groupBy}
          onChange={(event) => {
            const next = event.target.value;
            if (isGroupBy(next)) onChange({ ...value, groupBy: next });
          }}
          className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm"
        >
          {GROUP_BY_VALUES.map((option) => (
            <option key={option} value={option}>
              {t(/* i18n-dynamic */ `reports.arAgingOptions.groupByValues.${option}`)}
            </option>
          ))}
        </select>
        {value.groupBy === 'currency' && (
          <span data-testid="ar-aging-currency-note" className="mt-2 block text-xs text-muted-foreground">
            {t('reports.arAgingOptions.currencyNote')}
          </span>
        )}
      </label>

      <label className="flex items-start gap-3 rounded-md border p-4">
        <input
          data-testid="ar-aging-include-paid"
          type="checkbox"
          checked={value.includePaidInPeriod}
          onChange={(event) => onChange({ ...value, includePaidInPeriod: event.target.checked })}
          className="mt-1 h-4 w-4"
        />
        <span>
          <span data-testid="ar-aging-include-paid-label" className="block text-sm font-medium">
            {t('reports.arAgingOptions.includePaidInPeriod')}
          </span>
          <span data-testid="ar-aging-include-paid-help" className="block text-xs text-muted-foreground">
            {t('reports.arAgingOptions.includePaidInPeriodHelp')}
          </span>
        </span>
      </label>
    </div>
  );
}

export function ArAgingOptionsForm({ value, onChange, busy = false, submitLabel, onSubmit, onCancel }: Props) {
  const { t } = useTranslation('reports');
  return (
    <div className="space-y-5">
      <ArAgingOptionsFields value={value} onChange={onChange} />
      <div className="flex justify-end gap-2">
        <button type="button" className="rounded-md border px-4 py-2 text-sm" onClick={onCancel}>
          {t('reports.arAgingOptions.cancel')}
        </button>
        <button
          type="button"
          data-testid="ar-aging-create-report"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
          disabled={busy || !isArAgingOptionsValid(value)}
          onClick={onSubmit}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
