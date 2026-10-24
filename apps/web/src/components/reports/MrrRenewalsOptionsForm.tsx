import { useTranslation } from 'react-i18next';

/**
 * Options for MRR & renewals. Same export shape as `ArAgingOptionsForm.tsx`.
 *
 * The report is measured on the day it runs: the server REFUSES `asOf` and
 * `period` (`mrrRenewalsConfigSchema`), so this form never has them and the
 * config mapper never emits them. Both fields are closed choices, so the form
 * is always valid.
 */
export type MrrRenewalsGroupBy = 'organization' | 'contract';
export type MrrRenewalsHorizonDays = 30 | 60 | 90 | 180;

export type MrrRenewalsOptions = {
  groupBy: MrrRenewalsGroupBy;
  renewalHorizonDays: MrrRenewalsHorizonDays;
};

const GROUP_BY_VALUES: readonly MrrRenewalsGroupBy[] = ['organization', 'contract'];
const HORIZON_VALUES: readonly MrrRenewalsHorizonDays[] = [30, 60, 90, 180];

export const DEFAULT_MRR_RENEWALS_OPTIONS: MrrRenewalsOptions = {
  groupBy: 'organization',
  renewalHorizonDays: 90,
};

function isGroupBy(value: unknown): value is MrrRenewalsGroupBy {
  return typeof value === 'string' && (GROUP_BY_VALUES as readonly string[]).includes(value);
}

function isHorizon(value: unknown): value is MrrRenewalsHorizonDays {
  return typeof value === 'number' && (HORIZON_VALUES as readonly number[]).includes(value);
}

/** The object the create POST / edit PUT carries as `config`. Never `asOf` or `period`. */
export function mrrRenewalsConfigFromOptions(options: MrrRenewalsOptions): Record<string, unknown> {
  return {
    groupBy: options.groupBy,
    renewalHorizonDays: options.renewalHorizonDays,
  };
}

export function mrrRenewalsOptionsFromConfig(config: Record<string, unknown>): MrrRenewalsOptions {
  return {
    groupBy: isGroupBy(config.groupBy) ? config.groupBy : DEFAULT_MRR_RENEWALS_OPTIONS.groupBy,
    renewalHorizonDays: isHorizon(config.renewalHorizonDays)
      ? config.renewalHorizonDays
      : DEFAULT_MRR_RENEWALS_OPTIONS.renewalHorizonDays,
  };
}

// Both fields are closed choices; kept so the form has the same export shape
// (and the edit page the same gate) as every other business options form.
export function isMrrRenewalsOptionsValid(_options: MrrRenewalsOptions): boolean {
  return true;
}

type FieldProps = { value: MrrRenewalsOptions; onChange: (value: MrrRenewalsOptions) => void };
type Props = FieldProps & { busy?: boolean; submitLabel: string; onSubmit: () => void; onCancel: () => void };

export function MrrRenewalsOptionsFields({ value, onChange }: FieldProps) {
  const { t } = useTranslation('reports');
  return (
    <div className="space-y-4">
      <p data-testid="mrr-renewals-run-time-note" className="text-xs text-muted-foreground">
        {t('reports.mrrRenewalsOptions.runTimeNote')}
      </p>

      <label className="block rounded-md border p-4">
        <span className="block text-sm font-medium">{t('reports.mrrRenewalsOptions.groupBy')}</span>
        <select
          data-testid="mrr-renewals-group-by"
          value={value.groupBy}
          onChange={(event) => {
            const next = event.target.value;
            if (isGroupBy(next)) onChange({ ...value, groupBy: next });
          }}
          className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm"
        >
          {GROUP_BY_VALUES.map((option) => (
            <option key={option} value={option}>
              {t(/* i18n-dynamic */ `reports.mrrRenewalsOptions.groupByValues.${option}`)}
            </option>
          ))}
        </select>
      </label>

      <label className="block rounded-md border p-4">
        <span className="block text-sm font-medium">{t('reports.mrrRenewalsOptions.renewalHorizon')}</span>
        <select
          data-testid="mrr-renewals-horizon"
          value={String(value.renewalHorizonDays)}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (isHorizon(next)) onChange({ ...value, renewalHorizonDays: next });
          }}
          className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm"
        >
          {HORIZON_VALUES.map((days) => (
            <option key={days} value={String(days)}>
              {t('reports.mrrRenewalsOptions.renewalHorizonOption', { days })}
            </option>
          ))}
        </select>
        <span className="mt-1 block text-xs text-muted-foreground">
          {t('reports.mrrRenewalsOptions.renewalHorizonHelp')}
        </span>
      </label>
    </div>
  );
}

export function MrrRenewalsOptionsForm({ value, onChange, busy = false, submitLabel, onSubmit, onCancel }: Props) {
  const { t } = useTranslation('reports');
  return (
    <div className="space-y-5">
      <MrrRenewalsOptionsFields value={value} onChange={onChange} />
      <div className="flex justify-end gap-2">
        <button type="button" className="rounded-md border px-4 py-2 text-sm" onClick={onCancel}>
          {t('reports.mrrRenewalsOptions.cancel')}
        </button>
        <button
          type="button"
          data-testid="mrr-renewals-create-report"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
          disabled={busy || !isMrrRenewalsOptionsValid(value)}
          onClick={onSubmit}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
