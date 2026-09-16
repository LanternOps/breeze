import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Options for the Threat Detection Review report (#5784 W02). Four exports in
 * the same shape as `HardwareLifecycleOptionsForm.tsx`, so `ReportEditPage`
 * and `ReportTemplates` wire it identically.
 *
 * `sites` is deliberately NOT surfaced here: like the lifecycle form, the
 * curated report runs org-wide and the server narrows by the reader's own site
 * authority. A site picker would need a sites fetch this form does not have,
 * and the two options below are what actually change the artifact.
 */
export type ThreatDetectionOptions = {
  includeCarriedIn: boolean;
  topIncidents: number;
};

export const DEFAULT_THREAT_DETECTION_OPTIONS: ThreatDetectionOptions = {
  includeCarriedIn: true,
  topIncidents: 100,
};

const MIN_TOP_INCIDENTS = 1;
const MAX_TOP_INCIDENTS = 1000;

/** Read the persisted config back into option state (edit page). Mirrors the
 *  server's `threatDetectionConfigSchema` bounds, so a hand-edited or legacy
 *  config can never seed the input with a value the API would reject. */
export function threatDetectionOptionsFromConfig(
  config: Record<string, unknown>,
): ThreatDetectionOptions {
  const raw = config.topIncidents;
  const topIncidents = typeof raw === 'number' && Number.isFinite(raw)
    ? Math.min(MAX_TOP_INCIDENTS, Math.max(MIN_TOP_INCIDENTS, Math.round(raw)))
    : DEFAULT_THREAT_DETECTION_OPTIONS.topIncidents;
  return {
    // "On unless explicitly false" — a legacy non-boolean value reads as on
    // rather than silently reverting the reader's setting.
    includeCarriedIn: config.includeCarriedIn !== false,
    topIncidents,
  };
}

type FieldProps = {
  value: ThreatDetectionOptions;
  onChange: (value: ThreatDetectionOptions) => void;
};

type Props = FieldProps & {
  busy?: boolean;
  submitLabel: string;
  onSubmit: () => void;
  onCancel: () => void;
};

/** The options on their own, for composing beside another form's controls. */
export function ThreatDetectionOptionsFields({ value, onChange }: FieldProps) {
  const { t } = useTranslation('reports');
  // Draft text so the field can be cleared while typing; only a valid integer
  // reaches the parent (the edit page seeds `value` asynchronously).
  const [topDraft, setTopDraft] = useState(String(value.topIncidents));
  useEffect(() => {
    setTopDraft((current) => (
      Number.parseInt(current, 10) === value.topIncidents ? current : String(value.topIncidents)
    ));
  }, [value.topIncidents]);

  return (
    <div className="space-y-4">
      <label className="block rounded-md border p-4">
        <span className="block text-sm font-medium">{t('reports.threatDetectionOptions.topIncidents')}</span>
        <input
          data-testid="threat-detection-top-incidents"
          type="number"
          min={MIN_TOP_INCIDENTS}
          max={MAX_TOP_INCIDENTS}
          step={1}
          value={topDraft}
          onChange={(event) => {
            setTopDraft(event.target.value);
            const next = Number.parseInt(event.target.value, 10);
            if (Number.isFinite(next)) {
              onChange({
                ...value,
                topIncidents: Math.min(MAX_TOP_INCIDENTS, Math.max(MIN_TOP_INCIDENTS, next)),
              });
            }
          }}
          onBlur={() => setTopDraft(String(value.topIncidents))}
          className="mt-2 w-28 rounded-md border bg-background px-3 py-2 text-sm"
        />
        <span className="mt-1 block text-xs text-muted-foreground">
          {t('reports.threatDetectionOptions.topIncidentsHelp')}
        </span>
      </label>

      <label className="flex items-start gap-3 rounded-md border p-4">
        <input
          data-testid="threat-detection-include-carried-in"
          type="checkbox"
          checked={value.includeCarriedIn}
          onChange={(event) => onChange({ ...value, includeCarriedIn: event.target.checked })}
          className="mt-1 h-4 w-4"
        />
        <span>
          <span className="block text-sm font-medium">{t('reports.threatDetectionOptions.includeCarriedIn')}</span>
          <span className="block text-xs text-muted-foreground">{t('reports.threatDetectionOptions.includeCarriedInHelp')}</span>
        </span>
      </label>

      <p className="text-xs text-muted-foreground">
        {t('reports.threatDetectionOptions.coverageNote')}
      </p>
    </div>
  );
}

export function ThreatDetectionOptionsForm({
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
      <ThreatDetectionOptionsFields value={value} onChange={onChange} />
      <div className="flex justify-end gap-2">
        <button type="button" className="rounded-md border px-4 py-2 text-sm" onClick={onCancel}>
          {t('reports.threatDetectionOptions.cancel')}
        </button>
        <button
          type="button"
          data-testid="threat-detection-create-report"
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
