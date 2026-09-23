import { useTranslation } from 'react-i18next';
import type { ReportPeriodInput } from '@breeze/shared';
import {
  DEFAULT_REPORT_PERIOD,
  ReportPeriodField,
  isReportPeriodValid,
  reportPeriodFromConfig,
} from './ReportPeriodField';

/**
 * Options for Ticket SLA attainment (#3198 R1). Same export shape as
 * `IdentityAccessOptionsForm.tsx` (Options type, DEFAULT_*, *OptionsFromConfig,
 * *Fields, *Form) plus a `*ConfigFromOptions` mapper, so `ReportTemplates` and
 * `ReportEditPage` wire it identically and neither blindly spreads form state
 * into a config the server schema would refuse.
 *
 * Group-by has an "Automatic" choice (`null`) that OMITS the key: the server
 * schema has no default and the generator picks by owner scope (organization
 * for an all-organizations report, priority for one organization). Freezing a
 * value at modal-open time would go stale the moment the owner scope changed.
 *
 * The approximation note is rendered, not buried in the PDF footer: attainment
 * is RECOMPUTED from timestamps, and `sla_paused_minutes` is a lifetime total,
 * so pause time after first response slightly flatters response attainment
 * (spec §3.3 R1, Open Decision 2 = A).
 */
export type TicketSlaGroupBy = 'organization' | 'priority' | 'technician' | 'category';

export type TicketSlaOptions = {
  period: ReportPeriodInput;
  /** null = Automatic: the key is omitted and the generator decides by scope. */
  groupBy: TicketSlaGroupBy | null;
  includeNoSla: boolean;
};

const GROUP_BY_VALUES: readonly TicketSlaGroupBy[] = ['organization', 'priority', 'technician', 'category'];

export const DEFAULT_TICKET_SLA_OPTIONS: TicketSlaOptions = {
  period: DEFAULT_REPORT_PERIOD,
  groupBy: null,
  includeNoSla: true,
};

function isGroupBy(value: unknown): value is TicketSlaGroupBy {
  return typeof value === 'string' && (GROUP_BY_VALUES as readonly string[]).includes(value);
}

export function ticketSlaOptionsFromConfig(config: Record<string, unknown>): TicketSlaOptions {
  return {
    period: reportPeriodFromConfig(config.period),
    groupBy: isGroupBy(config.groupBy) ? config.groupBy : null,
    // "On unless explicitly false" — a legacy non-boolean reads as on rather
    // than silently dropping the no-SLA count a reader relies on.
    includeNoSla: config.includeNoSla !== false,
  };
}

/** The config the create POST / edit PUT carries: exactly the keys
 *  `ticketSlaConfigSchema` accepts, and no `groupBy` for Automatic. */
export function ticketSlaConfigFromOptions(options: TicketSlaOptions): Record<string, unknown> {
  return {
    period: options.period,
    ...(options.groupBy ? { groupBy: options.groupBy } : {}),
    includeNoSla: options.includeNoSla,
  };
}

export function isTicketSlaOptionsValid(options: TicketSlaOptions): boolean {
  return isReportPeriodValid(options.period);
}

type FieldProps = { value: TicketSlaOptions; onChange: (value: TicketSlaOptions) => void };
type Props = FieldProps & { busy?: boolean; submitLabel: string; onSubmit: () => void; onCancel: () => void };

export function TicketSlaOptionsFields({ value, onChange }: FieldProps) {
  const { t } = useTranslation('reports');
  return (
    <div className="space-y-4">
      <p
        data-testid="ticket-sla-approximation-note"
        className="rounded-md border border-dashed p-3 text-xs text-muted-foreground"
      >
        {t('reports.ticketSlaOptions.approximationNote')}
      </p>

      <ReportPeriodField
        idPrefix="ticket-sla"
        value={value.period}
        onChange={(period) => onChange({ ...value, period })}
      />

      <label className="block rounded-md border p-4">
        <span className="block text-sm font-medium">{t('reports.ticketSlaOptions.groupBy')}</span>
        <select
          data-testid="ticket-sla-group-by"
          value={value.groupBy ?? ''}
          onChange={(event) => {
            const next = event.target.value;
            onChange({ ...value, groupBy: isGroupBy(next) ? next : null });
          }}
          className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm"
        >
          <option value="">{t('reports.ticketSlaOptions.groupByAutomatic')}</option>
          {GROUP_BY_VALUES.map((option) => (
            <option key={option} value={option}>
              {t(/* i18n-dynamic */ `reports.ticketSlaOptions.groupByValues.${option}`)}
            </option>
          ))}
        </select>
        {value.groupBy === 'technician' && (
          <span data-testid="ticket-sla-technician-note" className="mt-2 block text-xs text-muted-foreground">
            {t('reports.ticketSlaOptions.technicianNote')}
          </span>
        )}
      </label>

      <label className="flex items-start gap-3 rounded-md border p-4">
        <input
          data-testid="ticket-sla-include-no-sla"
          type="checkbox"
          checked={value.includeNoSla}
          onChange={(event) => onChange({ ...value, includeNoSla: event.target.checked })}
          className="mt-1 h-4 w-4"
        />
        <span>
          <span className="block text-sm font-medium">{t('reports.ticketSlaOptions.includeNoSla')}</span>
          <span className="block text-xs text-muted-foreground">{t('reports.ticketSlaOptions.includeNoSlaHelp')}</span>
        </span>
      </label>
    </div>
  );
}

export function TicketSlaOptionsForm({ value, onChange, busy = false, submitLabel, onSubmit, onCancel }: Props) {
  const { t } = useTranslation('reports');
  return (
    <div className="space-y-5">
      <TicketSlaOptionsFields value={value} onChange={onChange} />
      <div className="flex justify-end gap-2">
        <button type="button" className="rounded-md border px-4 py-2 text-sm" onClick={onCancel}>
          {t('reports.ticketSlaOptions.cancel')}
        </button>
        <button
          type="button"
          data-testid="ticket-sla-create-report"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
          disabled={busy || !isTicketSlaOptionsValid(value)}
          onClick={onSubmit}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
