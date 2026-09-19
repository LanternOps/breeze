import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

export type HardwareLifecycleOptions = {
  replaceAgeYears: number;
  serverReplaceAgeYears: number;
  includeManualAssets: boolean;
  includeOtherEquipment: boolean;
};

export const DEFAULT_HARDWARE_LIFECYCLE_OPTIONS: HardwareLifecycleOptions = {
  replaceAgeYears: 4,
  serverReplaceAgeYears: 5,
  includeManualAssets: true,
  includeOtherEquipment: true,
};

/** Read the persisted config back into option state (edit page). */
export function hardwareLifecycleOptionsFromConfig(config: Record<string, unknown>): HardwareLifecycleOptions {
  const clampYears = (value: unknown, fallback: number) =>
    Math.min(15, Math.max(1, Math.round(typeof value === 'number' && Number.isFinite(value) ? value : fallback)));
  return {
    replaceAgeYears: clampYears(config.replaceAgeYears, DEFAULT_HARDWARE_LIFECYCLE_OPTIONS.replaceAgeYears),
    serverReplaceAgeYears: clampYears(config.serverReplaceAgeYears, DEFAULT_HARDWARE_LIFECYCLE_OPTIONS.serverReplaceAgeYears),
    includeManualAssets: config.includeManualAssets !== false,
    includeOtherEquipment: config.includeOtherEquipment !== false,
  };
}

type FieldProps = {
  value: HardwareLifecycleOptions;
  onChange: (value: HardwareLifecycleOptions) => void;
};

type Props = FieldProps & {
  busy?: boolean;
  submitLabel: string;
  onSubmit: () => void;
  onCancel: () => void;
};

/**
 * The lifecycle-only options on their own, for composing alongside another
 * form's submit controls (the edit page pairs them with ReportBuilder).
 */
export function HardwareLifecycleOptionsFields({ value, onChange }: FieldProps) {
  const { t } = useTranslation('reports');
  // Draft text so the field can be cleared while typing; only a valid integer
  // reaches the parent (the edit page seeds `value` asynchronously, hence the sync).
  const [yearsDraft, setYearsDraft] = useState(String(value.replaceAgeYears));
  useEffect(() => {
    setYearsDraft((current) => (Number.parseInt(current, 10) === value.replaceAgeYears ? current : String(value.replaceAgeYears)));
  }, [value.replaceAgeYears]);
  const [serverYearsDraft, setServerYearsDraft] = useState(String(value.serverReplaceAgeYears));
  useEffect(() => {
    setServerYearsDraft((current) => (Number.parseInt(current, 10) === value.serverReplaceAgeYears ? current : String(value.serverReplaceAgeYears)));
  }, [value.serverReplaceAgeYears]);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block rounded-md border p-4">
          <span className="block text-sm font-medium">{t('reports.lifecycleOptions.replaceAgeYears')}</span>
          <input
            data-testid="lifecycle-replace-age-years"
            type="number"
            min={1}
            max={15}
            step={1}
            value={yearsDraft}
            onChange={(event) => {
              setYearsDraft(event.target.value);
              const next = Number.parseInt(event.target.value, 10);
              if (Number.isFinite(next)) onChange({ ...value, replaceAgeYears: Math.min(15, Math.max(1, next)) });
            }}
            onBlur={() => setYearsDraft(String(value.replaceAgeYears))}
            className="mt-2 w-28 rounded-md border bg-background px-3 py-2 text-sm"
          />
          <span className="mt-1 block text-xs text-muted-foreground">
            {t('reports.lifecycleOptions.replaceAgeYearsHelp')}
          </span>
        </label>

        <label className="block rounded-md border p-4">
          <span className="block text-sm font-medium">{t('reports.lifecycleOptions.serverReplaceAgeYears')}</span>
          <input
            data-testid="lifecycle-server-replace-age-years"
            type="number"
            min={1}
            max={15}
            step={1}
            value={serverYearsDraft}
            onChange={(event) => {
              setServerYearsDraft(event.target.value);
              const next = Number.parseInt(event.target.value, 10);
              if (Number.isFinite(next)) onChange({ ...value, serverReplaceAgeYears: Math.min(15, Math.max(1, next)) });
            }}
            onBlur={() => setServerYearsDraft(String(value.serverReplaceAgeYears))}
            className="mt-2 w-28 rounded-md border bg-background px-3 py-2 text-sm"
          />
          <span className="mt-1 block text-xs text-muted-foreground">
            {t('reports.lifecycleOptions.serverReplaceAgeYearsHelp')}
          </span>
        </label>
      </div>

      <label className="flex items-start gap-3 rounded-md border p-4">
        <input
          data-testid="lifecycle-include-manual-assets"
          type="checkbox"
          checked={value.includeManualAssets}
          onChange={(event) => onChange({ ...value, includeManualAssets: event.target.checked })}
          className="mt-1 h-4 w-4"
        />
        <span>
          <span className="block text-sm font-medium">{t('reports.lifecycleOptions.includeManualAssets')}</span>
          <span className="block text-xs text-muted-foreground">{t('reports.lifecycleOptions.includeManualAssetsHelp')}</span>
        </span>
      </label>

      <label className="flex items-start gap-3 rounded-md border p-4">
        <input
          data-testid="lifecycle-include-other-equipment"
          type="checkbox"
          checked={value.includeOtherEquipment}
          onChange={(event) => onChange({ ...value, includeOtherEquipment: event.target.checked })}
          className="mt-1 h-4 w-4"
        />
        <span>
          <span className="block text-sm font-medium">{t('reports.lifecycleOptions.includeOtherEquipment')}</span>
          <span className="block text-xs text-muted-foreground">{t('reports.lifecycleOptions.includeOtherEquipmentHelp')}</span>
        </span>
      </label>
    </div>
  );
}

export function HardwareLifecycleOptionsForm({
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
      <HardwareLifecycleOptionsFields value={value} onChange={onChange} />
      <div className="flex justify-end gap-2">
        <button type="button" className="rounded-md border px-4 py-2 text-sm" onClick={onCancel}>
          {t('reports.lifecycleOptions.cancel')}
        </button>
        <button
          type="button"
          data-testid="lifecycle-create-report"
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
