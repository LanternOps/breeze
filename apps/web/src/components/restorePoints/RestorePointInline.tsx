import { useTranslation } from 'react-i18next';
import RestorePointBadge, { type RestorePointBadgeOutcome } from './RestorePointBadge';

/**
 * The small labelled block the result pages render under a result summary
 * (the way `rebootRequired` is shown). Present only when there is an outcome,
 * so results from agents that predate #4609 render exactly as before. The
 * label and copy live here and in the badge; the pages add none of their own.
 */
export default function RestorePointInline({
  outcome,
}: {
  outcome: RestorePointBadgeOutcome | null | undefined;
}) {
  const { t } = useTranslation('restorePoints');
  if (!outcome) return null;
  return (
    <div data-testid="restore-point-inline" className="rounded-md border bg-card p-3">
      <p className="mb-1 text-xs font-medium text-muted-foreground">{t('list.title')}</p>
      <RestorePointBadge outcome={outcome} />
    </div>
  );
}
