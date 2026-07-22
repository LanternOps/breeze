import { FileCode, User, Settings, Monitor, AlertCircle, Activity } from 'lucide-react';
import { getErrorMessage, getErrorTitle } from '@/lib/errorMessages';
import { formatTimeAgo } from '@/lib/formatTime';
import { formatAuditAction } from '@/lib/auditFormat';
import { useTranslation } from 'react-i18next';
import type { DashboardQueryState } from '../../hooks/useDashboardQuery';
import type { AuditLogEntry } from './types';

const typeIcons: Record<string, typeof Monitor> = {
  script: FileCode,
  device: Monitor,
  user: User,
  settings: Settings,
  organization: Settings,
  site: Monitor,
  alert: Activity,
  default: Activity,
};

/**
 * Recent audit-log activity. Presentational — data comes from the page's
 * shared query so it tracks the same org scope and refresh cycle as every
 * other widget (the old self-fetching version ignored org changes).
 */
export default function RecentActivity({
  activity,
  onRetry,
}: {
  activity: DashboardQueryState<AuditLogEntry[]>;
  onRetry: () => void;
}) {
  const { t } = useTranslation('common');

  // Hidden without audit-read access — the genuine-empty copy ("activity
  // will appear here") would be misleading on a 403.
  if (activity.unavailable) return null;

  const header = (
    <div className="mb-4 flex items-center justify-between">
      <h3 data-testid="dashboard-recent-activity-heading" className="text-sm font-semibold">
        {t('dashboard.activity.title')}
      </h3>
      <a href="/audit" className="text-xs font-medium text-primary transition-colors hover:text-primary/80">
        {t('dashboard.activity.viewAuditLog')}
      </a>
    </div>
  );

  if (activity.isLoading) {
    return (
      <div className="mt-2 border-t pt-6">
        {header}
        <div className="space-y-0">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="flex items-center gap-4 border-b border-border/50 py-3 last:border-b-0">
              <div className="skeleton h-3.5 w-20" />
              <div className="skeleton h-3.5 w-24" />
              <div className="skeleton h-3.5 w-32" />
              <div className="skeleton h-3.5 w-16" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (activity.error && !activity.data) {
    return (
      <div className="mt-2 border-t pt-6">
        {header}
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <div className="mb-3 rounded-full bg-destructive/10 p-3">
            <AlertCircle className="h-5 w-5 text-destructive" />
          </div>
          <p className="mb-1 text-sm font-medium text-foreground">{getErrorTitle(activity.error)}</p>
          <p className="mb-3 text-xs text-muted-foreground">{getErrorMessage(activity.error)}</p>
          <button onClick={onRetry} className="text-xs font-medium text-primary hover:underline">
            {t('actions.retry')}
          </button>
        </div>
      </div>
    );
  }

  const activities = activity.data ?? [];

  return (
    <div className="mt-2 border-t pt-6">
      {header}
      <div className="overflow-x-auto">
        {activities.length === 0 ? (
          <div className="flex flex-col items-center py-8 text-center">
            <div className="mb-3 rounded-full bg-muted p-3">
              <Activity className="h-5 w-5 text-muted-foreground" />
            </div>
            <p className="text-sm text-muted-foreground">{t('dashboard.activity.empty')}</p>
            <p className="mt-1 text-xs text-muted-foreground/70">{t('dashboard.activity.emptyDescription')}</p>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="pb-3">{t('labels.user')}</th>
                <th className="pb-3">{t('dashboard.activity.action')}</th>
                <th className="pb-3">{t('dashboard.activity.target')}</th>
                <th className="pb-3">{t('dashboard.activity.time')}</th>
              </tr>
            </thead>
            <tbody>
              {activities.map((entry) => {
                const resourceType = entry.resource?.type || entry.resourceType || entry.targetType;
                const targetType = (resourceType || 'default').toLowerCase();
                const Icon = typeIcons[targetType] || typeIcons.default;
                const userName = entry.user?.name || entry.userName || t('shared.scope.system');
                const targetName = entry.resource?.name || entry.target || entry.targetName;
                const target = targetName && targetName.trim() ? targetName : (resourceType ?? '-');
                const timestamp = entry.timestamp || entry.createdAt || '';

                return (
                  <tr
                    key={entry.id}
                    className="border-b border-border/50 transition-colors last:border-b-0 hover:bg-muted/30"
                  >
                    <td className="py-3 text-sm">{userName}</td>
                    <td className="py-3 text-sm text-muted-foreground">{formatAuditAction(entry.action)}</td>
                    <td className="py-3">
                      <div className="flex items-center gap-2 text-sm">
                        <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                        <span>{target}</span>
                      </div>
                    </td>
                    <td className="py-3 text-sm tabular-nums text-muted-foreground">
                      {timestamp ? formatTimeAgo(timestamp) : '-'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
