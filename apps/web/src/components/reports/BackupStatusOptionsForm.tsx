import { useTranslation } from 'react-i18next';

export type BackupStatusOptions = {
  includeDevicesWithoutBackup: boolean;
  sources: Array<'breeze' | 'provider'>;
};

export const DEFAULT_BACKUP_STATUS_OPTIONS: BackupStatusOptions = {
  includeDevicesWithoutBackup: true,
  sources: ['breeze', 'provider'],
};

const KNOWN_SOURCES = new Set(['breeze', 'provider']);

function isValidSourcesArray(value: unknown): value is Array<'breeze' | 'provider'> {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string' && KNOWN_SOURCES.has(v));
}

/** Read the persisted config back into option state (edit page). */
export function backupStatusOptionsFromConfig(config: Record<string, unknown>): BackupStatusOptions {
  return {
    includeDevicesWithoutBackup: config.includeDevicesWithoutBackup !== false,
    sources: isValidSourcesArray(config.sources) ? config.sources : DEFAULT_BACKUP_STATUS_OPTIONS.sources,
  };
}

type FieldProps = {
  value: BackupStatusOptions;
  onChange: (value: BackupStatusOptions) => void;
};

type Props = FieldProps & {
  busy?: boolean;
  submitLabel: string;
  onSubmit: () => void;
  onCancel: () => void;
};

function toggleSource(current: Array<'breeze' | 'provider'>, source: 'breeze' | 'provider'): Array<'breeze' | 'provider'> {
  const has = current.includes(source);
  // Never allow the last remaining source to be unchecked — an empty
  // selection would silently produce a zero-row report with no visible
  // reason why (the API schema also rejects it with .min(1), but the form
  // should never let the user reach that 400 in the first place).
  if (has && current.length === 1) return current;
  return has ? current.filter((s) => s !== source) : [...current, source];
}

/**
 * The backup-status-only options on their own, for composing alongside
 * another form's submit controls (the edit page pairs them with
 * ReportBuilder) — mirrors `HardwareLifecycleOptionsFields`.
 */
export function BackupStatusOptionsFields({ value, onChange }: FieldProps) {
  const { t } = useTranslation('reports');

  return (
    <div className="space-y-4">
      <label className="flex items-start gap-3 rounded-md border p-4">
        <input
          data-testid="backup-status-include-without-backup"
          type="checkbox"
          checked={value.includeDevicesWithoutBackup}
          onChange={(event) => onChange({ ...value, includeDevicesWithoutBackup: event.target.checked })}
          className="mt-1 h-4 w-4"
        />
        <span>
          <span className="block text-sm font-medium">{t('reports.backupStatusOptions.includeDevicesWithoutBackup')}</span>
          <span className="block text-xs text-muted-foreground">{t('reports.backupStatusOptions.includeDevicesWithoutBackupHelp')}</span>
        </span>
      </label>

      <div className="rounded-md border p-4">
        <span className="block text-sm font-medium">{t('reports.backupStatusOptions.sources')}</span>
        <span className="mt-1 block text-xs text-muted-foreground">{t('reports.backupStatusOptions.sourcesHelp')}</span>
        <div className="mt-3 space-y-2">
          <label className="flex items-center gap-3">
            <input
              data-testid="backup-status-source-breeze"
              type="checkbox"
              checked={value.sources.includes('breeze')}
              onChange={() => onChange({ ...value, sources: toggleSource(value.sources, 'breeze') })}
              className="h-4 w-4"
            />
            <span className="text-sm">{t('reports.backupStatusOptions.sourceBreeze')}</span>
          </label>
          <label className="flex items-center gap-3">
            <input
              data-testid="backup-status-source-provider"
              type="checkbox"
              checked={value.sources.includes('provider')}
              onChange={() => onChange({ ...value, sources: toggleSource(value.sources, 'provider') })}
              className="h-4 w-4"
            />
            <span className="text-sm">{t('reports.backupStatusOptions.sourceProvider')}</span>
          </label>
        </div>
      </div>
    </div>
  );
}

export function BackupStatusOptionsForm({
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
      <BackupStatusOptionsFields value={value} onChange={onChange} />
      <div className="flex justify-end gap-2">
        <button type="button" className="rounded-md border px-4 py-2 text-sm" onClick={onCancel}>
          {t('reports.backupStatusOptions.cancel')}
        </button>
        <button
          type="button"
          data-testid="backup-status-create-report"
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
