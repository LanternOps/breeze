import { useTranslation } from 'react-i18next';
import type { ReportPeriodInput } from '@breeze/shared';
import {
  DEFAULT_REPORT_PERIOD,
  ReportPeriodField,
  isReportPeriodValid,
  reportPeriodFromConfig,
} from './ReportPeriodField';

/**
 * Options for AI usage by client (#7608 W10). Same export shape as
 * `TicketSlaOptionsForm.tsx`: Options type, DEFAULT_*, *OptionsFromConfig,
 * *ConfigFromOptions, *Fields, *Form.
 *
 * Group-by has an "Automatic" choice (`null`) that OMITS the key: the server
 * schema has no default and the generator picks by owner scope (organization
 * for an all-organizations report, model for one organization). Freezing a
 * value at modal-open time would go stale the moment the owner scope changed.
 *
 * The period note is rendered, not buried in the PDF footer: charges bill by
 * UTC calendar month, so a period in the owner's timezone can differ from the
 * invoice for usage near a month edge (the generator prints the same sentence).
 */
export type AiUsageByClientAxis = 'organization' | 'model';

export type AiUsageByClientOptions = {
  period: ReportPeriodInput;
  /** null = Automatic: the key is omitted and the generator decides by scope. */
  groupBy: AiUsageByClientAxis | null;
};

const GROUP_BY_VALUES: readonly AiUsageByClientAxis[] = ['organization', 'model'];

export const DEFAULT_AI_USAGE_BY_CLIENT_OPTIONS: AiUsageByClientOptions = {
  period: DEFAULT_REPORT_PERIOD,
  groupBy: null,
};

function isAxis(value: unknown): value is AiUsageByClientAxis {
  return typeof value === 'string' && (GROUP_BY_VALUES as readonly string[]).includes(value);
}

export function aiUsageByClientOptionsFromConfig(config: Record<string, unknown>): AiUsageByClientOptions {
  return {
    period: reportPeriodFromConfig(config.period),
    groupBy: isAxis(config.groupBy) ? config.groupBy : null,
  };
}

/** The config the create POST / edit PUT carries: exactly the keys
 *  `aiUsageByClientConfigSchema` accepts, and no `groupBy` for Automatic. */
export function aiUsageByClientConfigFromOptions(options: AiUsageByClientOptions): Record<string, unknown> {
  return {
    period: options.period,
    ...(options.groupBy ? { groupBy: options.groupBy } : {}),
  };
}

export function isAiUsageByClientOptionsValid(options: AiUsageByClientOptions): boolean {
  return isReportPeriodValid(options.period);
}

type FieldProps = { value: AiUsageByClientOptions; onChange: (value: AiUsageByClientOptions) => void };
type Props = FieldProps & { busy?: boolean; submitLabel: string; onSubmit: () => void; onCancel: () => void };

export function AiUsageByClientOptionsFields({ value, onChange }: FieldProps) {
  const { t } = useTranslation('reports');
  return (
    <div className="space-y-4">
      <ReportPeriodField
        idPrefix="ai-usage-by-client"
        value={value.period}
        onChange={(period) => onChange({ ...value, period })}
      />
      <p
        data-testid="ai-usage-by-client-period-note"
        className="rounded-md border border-dashed p-3 text-xs text-muted-foreground"
      >
        {t('reports.aiUsageByClientOptions.periodNote')}
      </p>

      <label className="block rounded-md border p-4">
        <span className="block text-sm font-medium">{t('reports.aiUsageByClientOptions.groupBy')}</span>
        <select
          data-testid="ai-usage-by-client-group-by"
          value={value.groupBy ?? ''}
          onChange={(event) => {
            const next = event.target.value;
            onChange({ ...value, groupBy: isAxis(next) ? next : null });
          }}
          className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm"
        >
          <option value="">{t('reports.aiUsageByClientOptions.groupByAutomatic')}</option>
          {GROUP_BY_VALUES.map((option) => (
            <option key={option} value={option}>
              {t(/* i18n-dynamic */ `reports.aiUsageByClientOptions.groupByValues.${option}`)}
            </option>
          ))}
        </select>
      </label>

      <p data-testid="ai-usage-by-client-unpriced-note" className="text-xs text-muted-foreground">
        {t('reports.aiUsageByClientOptions.unpricedNote')}
      </p>
    </div>
  );
}

export function AiUsageByClientOptionsForm({ value, onChange, busy = false, submitLabel, onSubmit, onCancel }: Props) {
  const { t } = useTranslation('reports');
  return (
    <div className="space-y-5">
      <AiUsageByClientOptionsFields value={value} onChange={onChange} />
      <div className="flex justify-end gap-2">
        <button type="button" className="rounded-md border px-4 py-2 text-sm" onClick={onCancel}>
          {t('reports.aiUsageByClientOptions.cancel')}
        </button>
        <button
          type="button"
          data-testid="ai-usage-by-client-create-report"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
          disabled={busy || !isAiUsageByClientOptionsValid(value)}
          onClick={onSubmit}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
