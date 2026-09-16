import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Options for the Endpoint Management Review report (#5784 W03).
 *
 * `sites` is deliberately absent here, matching `HardwareLifecycleOptionsForm`:
 * a curated template creates an org-wide report and the technician's own site
 * grants already restrict what the generator may read. The generator still
 * honours a `sites` array in a persisted config.
 */
export type EndpointManagementOptions = {
  staleEnrolmentDays: number;
  trendDays: number;
  includeLicences: boolean;
};

export const DEFAULT_ENDPOINT_MANAGEMENT_OPTIONS: EndpointManagementOptions = {
  staleEnrolmentDays: 14,
  trendDays: 30,
  includeLicences: true,
};

/** Read the persisted config back into option state (edit page). Only real
 *  numbers pass — a stored string or a value from a hand-edited config falls
 *  back to the default rather than reaching the number inputs out of range. */
export function endpointManagementOptionsFromConfig(
  config: Record<string, unknown>,
): EndpointManagementOptions {
  const clamp = (value: unknown, fallback: number, min: number, max: number) =>
    Math.min(max, Math.max(min, Math.round(
      typeof value === 'number' && Number.isFinite(value) ? value : fallback,
    )));
  return {
    staleEnrolmentDays: clamp(config.staleEnrolmentDays, DEFAULT_ENDPOINT_MANAGEMENT_OPTIONS.staleEnrolmentDays, 1, 180),
    trendDays: clamp(config.trendDays, DEFAULT_ENDPOINT_MANAGEMENT_OPTIONS.trendDays, 1, 365),
    includeLicences: config.includeLicences !== false,
  };
}

type FieldProps = {
  value: EndpointManagementOptions;
  onChange: (value: EndpointManagementOptions) => void;
};

type Props = FieldProps & {
  busy?: boolean;
  submitLabel: string;
  onSubmit: () => void;
  onCancel: () => void;
};

/**
 * The endpoint-management-only options on their own, for composing alongside
 * another form's submit controls (the edit page pairs them with ReportBuilder).
 */
export function EndpointManagementOptionsFields({ value, onChange }: FieldProps) {
  const { t } = useTranslation('reports');
  // Draft text so a field can be cleared while typing; only a valid integer
  // reaches the parent (the edit page seeds `value` asynchronously, hence the sync).
  const [staleDraft, setStaleDraft] = useState(String(value.staleEnrolmentDays));
  useEffect(() => {
    setStaleDraft((current) => (
      Number.parseInt(current, 10) === value.staleEnrolmentDays ? current : String(value.staleEnrolmentDays)
    ));
  }, [value.staleEnrolmentDays]);
  const [trendDraft, setTrendDraft] = useState(String(value.trendDays));
  useEffect(() => {
    setTrendDraft((current) => (
      Number.parseInt(current, 10) === value.trendDays ? current : String(value.trendDays)
    ));
  }, [value.trendDays]);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block rounded-md border p-4">
          <span className="block text-sm font-medium">{t('reports.endpointManagementOptions.staleEnrolmentDays')}</span>
          <input
            data-testid="endpoint-management-stale-enrolment-days"
            type="number"
            min={1}
            max={180}
            step={1}
            value={staleDraft}
            onChange={(event) => {
              setStaleDraft(event.target.value);
              const next = Number.parseInt(event.target.value, 10);
              if (Number.isFinite(next)) onChange({ ...value, staleEnrolmentDays: Math.min(180, Math.max(1, next)) });
            }}
            onBlur={() => setStaleDraft(String(value.staleEnrolmentDays))}
            className="mt-2 w-28 rounded-md border bg-background px-3 py-2 text-sm"
          />
          <span className="mt-1 block text-xs text-muted-foreground">
            {t('reports.endpointManagementOptions.staleEnrolmentDaysHelp')}
          </span>
        </label>

        <label className="block rounded-md border p-4">
          <span className="block text-sm font-medium">{t('reports.endpointManagementOptions.trendDays')}</span>
          <input
            data-testid="endpoint-management-trend-days"
            type="number"
            min={1}
            max={365}
            step={1}
            value={trendDraft}
            onChange={(event) => {
              setTrendDraft(event.target.value);
              const next = Number.parseInt(event.target.value, 10);
              if (Number.isFinite(next)) onChange({ ...value, trendDays: Math.min(365, Math.max(1, next)) });
            }}
            onBlur={() => setTrendDraft(String(value.trendDays))}
            className="mt-2 w-28 rounded-md border bg-background px-3 py-2 text-sm"
          />
          <span className="mt-1 block text-xs text-muted-foreground">
            {t('reports.endpointManagementOptions.trendDaysHelp')}
          </span>
        </label>
      </div>

      <label className="flex items-start gap-3 rounded-md border p-4">
        <input
          data-testid="endpoint-management-include-licences"
          type="checkbox"
          checked={value.includeLicences}
          onChange={(event) => onChange({ ...value, includeLicences: event.target.checked })}
          className="mt-1 h-4 w-4"
        />
        <span>
          <span className="block text-sm font-medium">{t('reports.endpointManagementOptions.includeLicences')}</span>
          <span className="block text-xs text-muted-foreground">{t('reports.endpointManagementOptions.includeLicencesHelp')}</span>
        </span>
      </label>
    </div>
  );
}

export function EndpointManagementOptionsForm({
  value,
  onChange,
  busy = false,
  submitLabel,
  onSubmit,
  onCancel,
}: Props) {
  const { t } = useTranslation('reports');

  return (
    <div className="space-y-5">
      <EndpointManagementOptionsFields value={value} onChange={onChange} />
      <div className="flex justify-end gap-2">
        <button type="button" className="rounded-md border px-4 py-2 text-sm" onClick={onCancel}>
          {t('reports.endpointManagementOptions.cancel')}
        </button>
        <button
          type="button"
          data-testid="endpoint-management-create-report"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
          disabled={busy}
          onClick={onSubmit}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
