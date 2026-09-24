import { useTranslation } from 'react-i18next';
import { isRealCalendarDate, periodSchema, type ReportPeriodInput, type ReportPeriodKind } from '@breeze/shared';

/**
 * The reporting period, shared by the two business report types that take one
 * (#3198 W03: Ticket SLA attainment, Technician time & billability). One
 * component rather than copies: both server config schemas take the same
 * `periodSchema`, and hand-rolled pickers would drift the moment one gained a
 * kind.
 *
 * Validity is decided by the SAME `periodSchema` the API parses with, never a
 * local regex — so the form cannot accept `2026-02-31` or a start after its end
 * and then meet a 400 on save.
 *
 * `last_full_month` is the default because that is the period an MSP owner
 * actually reports on — "last 30 days" straddles two invoices and two SLA
 * windows, which makes every month-over-month comparison meaningless.
 */
const PERIOD_KINDS: readonly ReportPeriodKind[] = ['last_full_month', 'last_30_days', 'last_quarter', 'custom'];

export const DEFAULT_REPORT_PERIOD: ReportPeriodInput = { kind: 'last_full_month' };

/** Strip anything but the keys the schema owns; a preset never carries
 *  boundaries, so a stale start/end cannot ride along on it. */
function normalizePeriod(period: ReportPeriodInput): ReportPeriodInput {
  if (period.kind !== 'custom') return { kind: period.kind };
  return {
    kind: 'custom',
    ...(period.start ? { start: period.start } : {}),
    ...(period.end ? { end: period.end } : {}),
  };
}

export function isReportPeriodValid(period: ReportPeriodInput): boolean {
  return periodSchema.safeParse(period).success;
}

type PeriodIssue = 'missing' | 'invalid' | 'order';

/** Why a custom window is not submittable, for the inline message. */
function periodIssue(period: ReportPeriodInput): PeriodIssue | null {
  if (isReportPeriodValid(period)) return null;
  if (period.kind !== 'custom') return 'invalid';
  if (!period.start || !period.end) return 'missing';
  if (!isRealCalendarDate(period.start) || !isRealCalendarDate(period.end)) return 'invalid';
  return 'order';
}

/** Read a persisted `config.period` back into form state. Anything the server
 *  schema would reject degrades to the default rather than seeding a value
 *  that 400s on the next save. */
export function reportPeriodFromConfig(raw: unknown): ReportPeriodInput {
  const parsed = periodSchema.safeParse(raw);
  return parsed.success ? normalizePeriod(parsed.data) : DEFAULT_REPORT_PERIOD;
}

export function ReportPeriodField({
  value,
  onChange,
  idPrefix = 'report',
}: {
  value: ReportPeriodInput;
  onChange: (value: ReportPeriodInput) => void;
  idPrefix?: string;
}) {
  const { t } = useTranslation('reports');
  const issue = periodIssue(value);
  const setBoundary = (key: 'start' | 'end', raw: string) => {
    const next: ReportPeriodInput = { ...value, kind: 'custom' };
    if (raw) next[key] = raw;
    else delete next[key];
    onChange(normalizePeriod(next));
  };

  return (
    <div className="rounded-md border p-4">
      <label className="block">
        <span className="block text-sm font-medium">{t('reports.reportPeriod.label')}</span>
        <select
          id={`${idPrefix}-period-kind`}
          data-testid="report-period-kind"
          value={value.kind}
          onChange={(event) => {
            const kind = event.target.value as ReportPeriodKind;
            // Switching away from custom DROPS the boundaries rather than
            // carrying them: a stale start/end riding along on a preset is
            // exactly the ignored-but-present field that later reads as "the
            // report covered August" when it covered last quarter.
            onChange(normalizePeriod({ ...value, kind }));
          }}
          className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm"
        >
          {PERIOD_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {t(/* i18n-dynamic */ `reports.reportPeriod.kinds.${kind}`)}
            </option>
          ))}
        </select>
      </label>
      {value.kind === 'custom' && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="block text-xs text-muted-foreground">{t('reports.reportPeriod.start')}</span>
            <input
              type="date"
              data-testid="report-period-start"
              value={value.start ?? ''}
              onChange={(event) => setBoundary('start', event.target.value)}
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="block text-xs text-muted-foreground">{t('reports.reportPeriod.end')}</span>
            <input
              type="date"
              data-testid="report-period-end"
              value={value.end ?? ''}
              onChange={(event) => setBoundary('end', event.target.value)}
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm"
            />
          </label>
        </div>
      )}
      {issue && (
        <p data-testid="report-period-error" role="alert" className="mt-2 text-xs text-destructive">
          {t(/* i18n-dynamic */ `reports.reportPeriod.errors.${issue}`)}
        </p>
      )}
      <p className="mt-2 text-xs text-muted-foreground">{t('reports.reportPeriod.help')}</p>
    </div>
  );
}
