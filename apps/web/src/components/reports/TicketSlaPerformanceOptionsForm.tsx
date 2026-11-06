import { useTranslation } from 'react-i18next';
import type { ReportPeriodInput } from '@breeze/shared';
import {
  DEFAULT_REPORT_PERIOD,
  ReportPeriodField,
  isReportPeriodValid,
  reportPeriodFromConfig,
} from './ReportPeriodField';

/**
 * Options for SLA performance (#11018). Same export shape as
 * `TicketSlaOptionsForm.tsx`. The mapper writes no default key: a stored config
 * holds only what the user chose, and the generator applies the defaults.
 *
 * Subjects are off by default because a delivered run is visible to every portal
 * user of the org, while a portal user may otherwise read only their own tickets.
 */
export type TicketSlaPerformanceOptions = {
  period: ReportPeriodInput;
  includeSubjects: boolean;
};

export const DEFAULT_TICKET_SLA_PERFORMANCE_OPTIONS: TicketSlaPerformanceOptions = {
  period: DEFAULT_REPORT_PERIOD,
  includeSubjects: false,
};

export function ticketSlaPerformanceOptionsFromConfig(config: Record<string, unknown>): TicketSlaPerformanceOptions {
  return {
    period: reportPeriodFromConfig(config.period),
    // Off unless literally true: a legacy non-boolean never opts in to exposure.
    includeSubjects: config.includeSubjects === true,
  };
}

export function ticketSlaPerformanceConfigFromOptions(options: TicketSlaPerformanceOptions): Record<string, unknown> {
  return {
    ...(options.period.kind === DEFAULT_REPORT_PERIOD.kind ? {} : { period: options.period }),
    ...(options.includeSubjects ? { includeSubjects: true } : {}),
  };
}

export function isTicketSlaPerformanceOptionsValid(options: TicketSlaPerformanceOptions): boolean {
  return isReportPeriodValid(options.period);
}

type FieldProps = { value: TicketSlaPerformanceOptions; onChange: (value: TicketSlaPerformanceOptions) => void };
type Props = FieldProps & { busy?: boolean; submitLabel: string; onSubmit: () => void; onCancel: () => void };

export function TicketSlaPerformanceOptionsFields({ value, onChange }: FieldProps) {
  const { t } = useTranslation('reports');
  return (
    <div className="space-y-4">
      <ReportPeriodField
        idPrefix="sla-performance"
        value={value.period}
        onChange={(period) => onChange({ ...value, period })}
      />

      <label className="flex items-start gap-3 rounded-md border p-4">
        <input
          data-testid="sla-performance-include-subjects"
          type="checkbox"
          checked={value.includeSubjects}
          onChange={(event) => onChange({ ...value, includeSubjects: event.target.checked })}
          className="mt-1 h-4 w-4"
        />
        <span>
          <span className="block text-sm font-medium">{t('reports.ticketSlaPerformanceOptions.includeSubjects')}</span>
          <span data-testid="sla-performance-subjects-help" className="block text-xs text-muted-foreground">
            {t('reports.ticketSlaPerformanceOptions.includeSubjectsHelp')}
          </span>
        </span>
      </label>
    </div>
  );
}

export function TicketSlaPerformanceOptionsForm({ value, onChange, busy = false, submitLabel, onSubmit, onCancel }: Props) {
  const { t } = useTranslation('reports');
  return (
    <div className="space-y-5">
      <TicketSlaPerformanceOptionsFields value={value} onChange={onChange} />
      <div className="flex justify-end gap-2">
        <button type="button" className="rounded-md border px-4 py-2 text-sm" onClick={onCancel}>
          {t('reports.ticketSlaPerformanceOptions.cancel')}
        </button>
        <button
          type="button"
          data-testid="sla-performance-create-report"
          disabled={busy || !isTicketSlaPerformanceOptionsValid(value)}
          onClick={onSubmit}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
