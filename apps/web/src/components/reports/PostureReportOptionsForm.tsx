import { useTranslation } from 'react-i18next';

type FieldProps = {
  backupRequired: boolean;
  onBackupRequiredChange: (value: boolean) => void;
};

type Props = FieldProps & {
  busy?: boolean;
  submitLabel: string;
  onSubmit: () => void;
  onCancel: () => void;
};

/**
 * The posture-only option on its own, for composing alongside another form's
 * submit controls (the edit page pairs it with ReportBuilder).
 */
export function PostureBackupRequiredField({ backupRequired, onBackupRequiredChange }: FieldProps) {
  const { t } = useTranslation('reports');

  return (
    <label className="flex items-start gap-3 rounded-md border p-4">
      <input
        data-testid="posture-backup-required"
        type="checkbox"
        checked={backupRequired}
        onChange={(event) => onBackupRequiredChange(event.target.checked)}
        className="mt-1 h-4 w-4"
      />
      <span>
        <span className="block text-sm font-medium">
          {t('reports.postureOptions.requireBackupCoverage')}
        </span>
        <span className="block text-xs text-muted-foreground">
          {t('reports.postureOptions.requireBackupCoverageHelp')}
        </span>
      </span>
    </label>
  );
}

export function PostureReportOptionsForm({
  backupRequired,
  busy = false,
  submitLabel,
  onBackupRequiredChange,
  onSubmit,
  onCancel,
}: Props) {
  const { t } = useTranslation('reports');

  return (
    <div className="space-y-5">
      <PostureBackupRequiredField
        backupRequired={backupRequired}
        onBackupRequiredChange={onBackupRequiredChange}
      />
      <div className="flex justify-end gap-2">
        <button type="button" className="rounded-md border px-4 py-2 text-sm" onClick={onCancel}>
          {t('reports.postureOptions.cancel')}
        </button>
        <button
          data-testid="posture-options-submit"
          type="button"
          disabled={busy}
          className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-60"
          onClick={onSubmit}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
