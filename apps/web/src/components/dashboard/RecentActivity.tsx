import { useEffect, useState } from 'react';
import { FileCode, User, Settings, Monitor, AlertCircle, Activity } from 'lucide-react';
import { getErrorMessage, getErrorTitle } from '@/lib/errorMessages';
import { fetchWithAuth } from '../../stores/auth';

interface AuditLogEntry {
  id: string;
  userId?: string;
  userName?: string;
  user?: {
    id: string;
    name: string;
    email: string;
  };
  action: string;
  resourceType?: string;
  targetType?: string;
  resourceId?: string;
  target?: string;
  targetName?: string;
  timestamp: string;
  createdAt?: string;
  details?: Record<string, unknown>;
}

const typeIcons: Record<string, typeof Monitor> = {
  script: FileCode,
  device: Monitor,
  user: User,
  settings: Settings,
  organization: Settings,
  site: Monitor,
  alert: Activity,
  default: Activity
};

function formatTimeAgo(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
  return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
}

export default function RecentActivity() {
  const [activities, setActivities] = useState<AuditLogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    const fetchActivities = async () => {
      try {
        setIsLoading(true);
        setError(null);

        const response = await fetchWithAuth('/audit-logs/logs?limit=5');

        if (!response.ok) {
          throw response;
        }

        const data = await response.json();
        const logsArray = data.logs ?? data.auditLogs ?? data.data ?? (Array.isArray(data) ? data : []);
        setActivities(logsArray);
      } catch (err) {
        setError(err);
      } finally {
        setIsLoading(false);
      }
    };

    fetchActivities();
  }, [retryCount]);

  const retry = () => {
    setRetryCount(c => c + 1);
    setError(null);
  };

  if (isLoading) {
    return (
      <div className="border-t pt-6 mt-2">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Recent Activity</h3>
          <a href="/audit" className="text-xs font-medium text-primary hover:text-primary/80 transition-colors">
            View audit log
          </a>
        </div>
        <div className="space-y-0">
          {[1, 2, 3, 4, 5].map(i => (
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

  if (error) {
    return (
      <div className="border-t pt-6 mt-2">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Recent Activity</h3>
          <a href="/audit" className="text-xs font-medium text-primary hover:text-primary/80 transition-colors">
            View audit log
          </a>
        </div>
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <div className="rounded-full bg-destructive/10 p-3 mb-3">
            <AlertCircle className="h-5 w-5 text-destructive" />
          </div>
          <p className="text-sm font-medium text-foreground mb-1">{getErrorTitle(error)}</p>
          <p className="text-xs text-muted-foreground mb-3">{getErrorMessage(error)}</p>
          <button onClick={retry} className="text-xs font-medium text-primary hover:underline">
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="border-t pt-6 mt-2">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Recent Activity</h3>
        <a href="/audit" className="text-sm text-primary hover:underline">
          View audit log
        </a>
      </div>
      <div className="overflow-x-auto">
        {activities.length === 0 ? (
          <div className="flex flex-col items-center py-8 text-center">
            <div className="rounded-full bg-muted p-3 mb-3">
              <Activity className="h-5 w-5 text-muted-foreground" />
            </div>
            <p className="text-sm text-muted-foreground">No activity yet</p>
            <p className="text-xs text-muted-foreground/70 mt-1">Actions like device enrollment, script runs, and config changes will appear here.</p>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="pb-3">User</th>
                <th className="pb-3">Action</th>
                <th className="pb-3">Target</th>
                <th className="pb-3">Time</th>
              </tr>
            </thead>
            <tbody>
              {activities.map((activity) => {
                const targetType = (activity.resourceType || activity.targetType || 'default').toLowerCase();
                const Icon = typeIcons[targetType] || typeIcons.default;
                const userName = activity.user?.name || activity.userName || 'System';
                const target = activity.target || activity.targetName || activity.resourceId || '-';
                const timestamp = activity.timestamp || activity.createdAt || '';

                return (
                  <tr key={activity.id} className="border-b border-border/50 last:border-b-0">
                    <td className="py-3 text-sm">{userName}</td>
                    <td className="py-3 text-sm text-muted-foreground">
                      {activity.action}
                    </td>
                    <td className="py-3">
                      <div className="flex items-center gap-2 text-sm">
                        <Icon className="h-4 w-4 text-muted-foreground" />
                        <span>{target}</span>
                      </div>
                    </td>
                    <td className="py-3 text-sm text-muted-foreground">
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
