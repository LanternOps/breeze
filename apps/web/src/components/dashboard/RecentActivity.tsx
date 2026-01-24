import { useEffect, useState } from 'react';
import { FileCode, User, Settings, Monitor, Loader2, XCircle, Activity } from 'lucide-react';
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
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchActivities = async () => {
      try {
        setIsLoading(true);
        setError(null);

        const response = await fetchWithAuth('/audit-logs/logs?limit=5');

        if (!response.ok) {
          throw new Error('Failed to fetch activity log');
        }

        const data = await response.json();
        const logsArray = data.logs ?? data.auditLogs ?? data.data ?? (Array.isArray(data) ? data : []);
        setActivities(logsArray);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load activity');
      } finally {
        setIsLoading(false);
      }
    };

    fetchActivities();
  }, []);

  if (isLoading) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-semibold">Recent Activity</h3>
          <a href="/audit" className="text-sm text-primary hover:underline">
            View audit log
          </a>
        </div>
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-semibold">Recent Activity</h3>
          <a href="/audit" className="text-sm text-primary hover:underline">
            View audit log
          </a>
        </div>
        <div className="flex h-48 items-center justify-center">
          <div className="flex items-center gap-2 text-destructive">
            <XCircle className="h-5 w-5" />
            <span className="text-sm">{error}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="font-semibold">Recent Activity</h3>
        <a href="/audit" className="text-sm text-primary hover:underline">
          View audit log
        </a>
      </div>
      <div className="overflow-x-auto">
        {activities.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
            No recent activity
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b text-left text-sm text-muted-foreground">
                <th className="pb-3 font-medium">User</th>
                <th className="pb-3 font-medium">Action</th>
                <th className="pb-3 font-medium">Target</th>
                <th className="pb-3 font-medium">Time</th>
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
                  <tr key={activity.id} className="border-b last:border-0">
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
