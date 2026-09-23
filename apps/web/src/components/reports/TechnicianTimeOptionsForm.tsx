import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReportPeriodInput } from '@breeze/shared';
import {
  DEFAULT_REPORT_PERIOD,
  ReportPeriodField,
  isReportPeriodValid,
  reportPeriodFromConfig,
} from './ReportPeriodField';

/**
 * Options for Technician time & billability (#3198 R2). Same export shape as
 * `IdentityAccessOptionsForm.tsx`, plus a `*ConfigFromOptions` mapper.
 *
 * Capacity is a uniform per-technician assumption (spec §3.3 R2, Open
 * Decision 3 = A: no per-tech capacity table) and the help text says so. The
 * server schema is `z.number().min(1).max(80)` with NO `.int()`, so 37.5 is a
 * legal, lossless value: the input steps by 0.5 and out-of-range values are
 * clamped, never rounded.
 */
export type TechnicianTimeGroupBy = 'technician' | 'organization' | 'work_type';

export type TechnicianTimeOptions = {
  period: ReportPeriodInput;
  groupBy: TechnicianTimeGroupBy;
  weeklyCapacityHours: number;
};

const GROUP_BY_VALUES: readonly TechnicianTimeGroupBy[] = ['technician', 'organization', 'work_type'];
const MIN_CAPACITY_HOURS = 1;
const MAX_CAPACITY_HOURS = 80;

export const DEFAULT_TECHNICIAN_TIME_OPTIONS: TechnicianTimeOptions = {
  period: DEFAULT_REPORT_PERIOD,
  groupBy: 'technician',
  weeklyCapacityHours: 40,
};

function clampCapacity(hours: number): number {
  return Math.min(MAX_CAPACITY_HOURS, Math.max(MIN_CAPACITY_HOURS, hours));
}

function isGroupBy(value: unknown): value is TechnicianTimeGroupBy {
  return typeof value === 'string' && (GROUP_BY_VALUES as readonly string[]).includes(value);
}

export function technicianTimeOptionsFromConfig(config: Record<string, unknown>): TechnicianTimeOptions {
  const capacity = config.weeklyCapacityHours;
  return {
    period: reportPeriodFromConfig(config.period),
    groupBy: isGroupBy(config.groupBy) ? config.groupBy : DEFAULT_TECHNICIAN_TIME_OPTIONS.groupBy,
    weeklyCapacityHours: typeof capacity === 'number' && Number.isFinite(capacity)
      ? clampCapacity(capacity)
      : DEFAULT_TECHNICIAN_TIME_OPTIONS.weeklyCapacityHours,
  };
}

/** Exactly the keys `technicianTimeConfigSchema` accepts. */
export function technicianTimeConfigFromOptions(options: TechnicianTimeOptions): Record<string, unknown> {
  return {
    period: options.period,
    groupBy: options.groupBy,
    weeklyCapacityHours: options.weeklyCapacityHours,
  };
}

export function isTechnicianTimeOptionsValid(options: TechnicianTimeOptions): boolean {
  return isReportPeriodValid(options.period);
}

type FieldProps = { value: TechnicianTimeOptions; onChange: (value: TechnicianTimeOptions) => void };
type Props = FieldProps & { busy?: boolean; submitLabel: string; onSubmit: () => void; onCancel: () => void };

export function TechnicianTimeOptionsFields({ value, onChange }: FieldProps) {
  const { t } = useTranslation('reports');
  // Draft text so the field can be cleared or partially typed ("37."); only a
  // clamped number reaches the parent (the edit page seeds `value` async).
  const [capacityDraft, setCapacityDraft] = useState(String(value.weeklyCapacityHours));

  useEffect(() => {
    setCapacityDraft((current) => (
      Number.parseFloat(current) === value.weeklyCapacityHours ? current : String(value.weeklyCapacityHours)
    ));
  }, [value.weeklyCapacityHours]);

  return (
    <div className="space-y-4">
      <ReportPeriodField
        idPrefix="technician-time"
        value={value.period}
        onChange={(period) => onChange({ ...value, period })}
      />

      <label className="block rounded-md border p-4">
        <span className="block text-sm font-medium">{t('reports.technicianTimeOptions.groupBy')}</span>
        <select
          data-testid="technician-time-group-by"
          value={value.groupBy}
          onChange={(event) => {
            const next = event.target.value;
            if (isGroupBy(next)) onChange({ ...value, groupBy: next });
          }}
          className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm"
        >
          {GROUP_BY_VALUES.map((option) => (
            <option key={option} value={option}>
              {t(/* i18n-dynamic */ `reports.technicianTimeOptions.groupByValues.${option}`)}
            </option>
          ))}
        </select>
        {value.groupBy === 'organization' && (
          <span data-testid="technician-time-org-axis-note" className="mt-2 block text-xs text-muted-foreground">
            {t('reports.technicianTimeOptions.orgAxisNote')}
          </span>
        )}
      </label>

      <label className="block rounded-md border p-4">
        <span className="block text-sm font-medium">{t('reports.technicianTimeOptions.capacityHours')}</span>
        <input
          data-testid="technician-time-capacity-hours"
          type="number"
          min={MIN_CAPACITY_HOURS}
          max={MAX_CAPACITY_HOURS}
          step={0.5}
          value={capacityDraft}
          onChange={(event) => {
            setCapacityDraft(event.target.value);
            const next = Number.parseFloat(event.target.value);
            if (Number.isFinite(next)) {
              onChange({ ...value, weeklyCapacityHours: clampCapacity(next) });
            }
          }}
          onBlur={() => setCapacityDraft(String(value.weeklyCapacityHours))}
          className="mt-2 w-28 rounded-md border bg-background px-3 py-2 text-sm"
        />
        <span data-testid="technician-time-capacity-help" className="mt-1 block text-xs text-muted-foreground">
          {t('reports.technicianTimeOptions.capacityHoursHelp')}
        </span>
      </label>
    </div>
  );
}

export function TechnicianTimeOptionsForm({ value, onChange, busy = false, submitLabel, onSubmit, onCancel }: Props) {
  const { t } = useTranslation('reports');
  return (
    <div className="space-y-5">
      <TechnicianTimeOptionsFields value={value} onChange={onChange} />
      <div className="flex justify-end gap-2">
        <button type="button" className="rounded-md border px-4 py-2 text-sm" onClick={onCancel}>
          {t('reports.technicianTimeOptions.cancel')}
        </button>
        <button
          type="button"
          data-testid="technician-time-create-report"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
          disabled={busy || !isTechnicianTimeOptionsValid(value)}
          onClick={onSubmit}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
