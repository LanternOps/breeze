import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { Organization } from '@/stores/orgStore';
import { FALLBACK_STATUS_CLASS, statusColors, statusLabelKeys } from '@/lib/orgStatus';

// Status colours come from the shared org status map (lib/orgStatus), so the
// pill in this header is the same pill as on the org list and record page.
export function OrgStatusBadge({ status }: { status: string }) {
  const { t } = useTranslation('common');
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium capitalize',
        statusColors[status as Organization['status']] ?? FALLBACK_STATUS_CLASS
      )}
    >
      {t(/* i18n-dynamic */ `layout.org.status.${status}`, { defaultValue: status })}
    </span>
  );
}

/** Dot colour per status; every status not listed is muted. Active has no dot. */
export const STATUS_DOT_CLASS = { trial: 'bg-warning', suspended: 'bg-destructive' } as const;

/** Row-level status marker: nothing for active, a small coloured dot otherwise. */
export function OrgStatusDot({ status }: { status: string }) {
  const { t } = useTranslation('settings');
  if (status === 'active') return null;
  const labelKey = statusLabelKeys[status as Organization['status']];
  const label = labelKey ? t(/* i18n-dynamic */ labelKey) : status;
  const colour = STATUS_DOT_CLASS[status as keyof typeof STATUS_DOT_CLASS] ?? 'bg-muted-foreground';
  return (
    <span
      role="img"
      data-testid="org-status-dot"
      data-status={status}
      title={label}
      aria-label={label}
      className={cn('inline-block h-[7px] w-[7px] shrink-0 rounded-full', colour)}
    />
  );
}
