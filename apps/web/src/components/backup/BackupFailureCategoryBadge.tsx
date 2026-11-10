import { useTranslation } from 'react-i18next';
import type { BackupFailureCategory } from '@breeze/shared';
import { cn } from '@/lib/utils';
import '../../lib/i18n';

const TROUBLESHOOTING_URL = 'https://docs.breezermm.com/backup/troubleshooting/#reading-a-failed-backups-category';

// Not an alarm in itself: a cancel is a choice, and unreadable files leave a
// restorable run, so neither wears the red of a run that produced nothing.
const CATEGORY_TONE: Record<BackupFailureCategory, string> = {
  device_offline: 'border-destructive/30 bg-destructive/10 text-destructive',
  timeout: 'border-destructive/30 bg-destructive/10 text-destructive',
  storage: 'border-destructive/30 bg-destructive/10 text-destructive',
  agent: 'border-destructive/30 bg-destructive/10 text-destructive',
  configuration: 'border-destructive/30 bg-destructive/10 text-destructive',
  source_access: 'border-warning/40 bg-warning/10 text-warning',
  cancelled: 'border-border bg-muted text-muted-foreground',
  unknown: 'border-destructive/30 bg-destructive/10 text-destructive',
};

/** The muted "what this means and where to read more" lines under a category. */
export function BackupFailureCategoryHint({
  category,
  className,
}: {
  category: BackupFailureCategory;
  className?: string;
}) {
  const { t } = useTranslation('backup');
  return (
    <p className={cn('text-xs text-muted-foreground', className)}>
      {t(/* i18n-dynamic */ `failureCategory.${category}.hint`)}{' '}
      <a href={TROUBLESHOOTING_URL} target="_blank" rel="noopener noreferrer" className="underline">
        {t('failureCategory.troubleshootingLink')}
      </a>
    </p>
  );
}

// #11027: the plain-language reason next to a job's raw error text. The category
// comes from the API, so it is absent on an older API during a rolling deploy.
export default function BackupFailureCategoryBadge({
  category,
  showHint = false,
}: {
  category: BackupFailureCategory | null | undefined;
  showHint?: boolean;
}) {
  const { t } = useTranslation('backup');
  if (!category) return null;

  const badge = (
    <span
      data-testid="backup-failure-category"
      data-category={category}
      title={t(/* i18n-dynamic */ `failureCategory.${category}.hint`)}
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium',
        CATEGORY_TONE[category],
      )}
    >
      {t(/* i18n-dynamic */ `failureCategory.${category}.label`)}
    </span>
  );
  if (!showHint) return badge;

  return (
    <div>
      {badge}
      <BackupFailureCategoryHint category={category} className="mt-1" />
    </div>
  );
}
