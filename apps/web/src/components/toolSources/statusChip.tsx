import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { ToolSourceDto } from './api';

/** The source's discovery status. `error` carries the reason in its title so
 *  the failure is inspectable from the list, not only the detail page. */
export function StatusChip({
  status,
  lastError,
}: {
  status: ToolSourceDto['status'];
  lastError: string | null;
}) {
  const { t } = useTranslation('toolSources');
  const tone =
    status === 'active'
      ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
      : status === 'error'
      ? 'bg-destructive/10 text-destructive'
      : 'bg-muted text-muted-foreground';
  return (
    <span
      data-testid={`tool-source-status-${status}`}
      title={status === 'error' && lastError ? lastError : undefined}
      className={cn('inline-flex rounded-full px-2 py-0.5 text-xs font-medium', tone)}
    >
      {/* i18n-dynamic: `status` is the API's three-value union, each key a
          literal in the toolSources catalog. */}
      {t(/* i18n-dynamic */ `detail.status.${status}`)}
    </span>
  );
}

/** Locale-formatted discovery timestamp, or null when discovery never ran. */
export function formatDiscoveredAt(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString();
}
