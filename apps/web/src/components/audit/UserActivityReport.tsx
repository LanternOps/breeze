import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, Download, TrendingUp, User, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';

type ActivityEntry = {
  id: string;
  userId: string;
  userName: string;
  timestamp: string;
  action: string;
  resource: string;
  ipAddress: string;
};

type UserOption = {
  id: string;
  name: string;
};

const formatTimestamp = (value: string) => new Date(value).toLocaleString();

export default function UserActivityReport() {
  const [users, setUsers] = useState<UserOption[]>([{ id: 'all', name: 'All users' }]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [selectedUserId, setSelectedUserId] = useState('all');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const [usersRes, activityRes] = await Promise.all([
        fetchWithAuth('/users?limit=100'),
        fetchWithAuth('/audit-logs?limit=100')
      ]);

      if (usersRes.status === 401 || activityRes.status === 401) {
        window.location.href = '/login';
        return;
      }

      if (!usersRes.ok) {
        throw new Error('Failed to fetch users');
      }

      if (!activityRes.ok) {
        throw new Error('Failed to fetch activity');
      }

      const usersData = await usersRes.json();
      const activityData = await activityRes.json();

      const usersList = [
        { id: 'all', name: 'All users' },
        ...(usersData.users || []).map((u: { id: string; name: string }) => ({
          id: u.id,
          name: u.name
        }))
      ];
      setUsers(usersList);

      const activityList = (activityData.entries || activityData.logs || []).map((entry: ActivityEntry & { user?: { id: string; name: string } }) => ({
        id: entry.id,
        userId: entry.userId || entry.user?.id || '',
        userName: entry.userName || entry.user?.name || 'Unknown',
        timestamp: entry.timestamp,
        action: entry.action,
        resource: entry.resource,
        ipAddress: entry.ipAddress
      }));
      setActivity(activityList);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const selectedUserLabel =
    users.find(user => user.id === selectedUserId)?.name ?? 'All users';

  const filteredActivity = useMemo(() => {
    if (selectedUserId === 'all') return activity;
    return activity.filter(entry => entry.userId === selectedUserId);
  }, [activity, selectedUserId]);

  const stats = useMemo(() => {
    const counts: Record<string, number> = {};
    filteredActivity.forEach(entry => {
      counts[entry.action] = (counts[entry.action] ?? 0) + 1;
    });
    return counts;
  }, [filteredActivity]);

  const totalActions = filteredActivity.length;
  const topAction = useMemo(() => {
    return Object.entries(stats).reduce(
      (acc, [action, count]) => {
        if (count > acc.count) return { action, count };
        return acc;
      },
      { action: 'n/a', count: 0 }
    );
  }, [stats]);
  const sortedTimeline = [...filteredActivity].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  const handleExportActivity = async () => {
    try {
      const params = selectedUserId !== 'all' ? `?userId=${selectedUserId}` : '';
      const response = await fetchWithAuth(`/audit-logs/export${params}`);

      if (response.status === 401) {
        window.location.href = '/login';
        return;
      }

      if (response.ok) {
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `user-activity-${new Date().toISOString().split('T')[0]}.csv`;
        a.click();
        window.URL.revokeObjectURL(url);
      }
    } catch {
      // Handle error silently or show notification
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-6 rounded-lg border bg-card p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">User Activity Report</h2>
            <p className="text-sm text-muted-foreground">Review activity trends and export history.</p>
          </div>
        </div>
        <div className="flex h-48 items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6 rounded-lg border bg-card p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">User Activity Report</h2>
            <p className="text-sm text-muted-foreground">Review activity trends and export history.</p>
          </div>
        </div>
        <div className="flex h-48 flex-col items-center justify-center gap-2 text-muted-foreground">
          <p>{error}</p>
          <button
            type="button"
            onClick={fetchData}
            className="text-sm text-primary hover:underline"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 rounded-lg border bg-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">User Activity Report</h2>
          <p className="text-sm text-muted-foreground">Review activity trends and export history.</p>
        </div>
        <button
          type="button"
          onClick={handleExportActivity}
          className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Download className="h-4 w-4" />
          Export Activity
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="inline-flex h-10 items-center gap-2 rounded-md border bg-background px-3 text-sm">
          <Users className="h-4 w-4 text-muted-foreground" />
          <select
            value={selectedUserId}
            onChange={event => setSelectedUserId(event.target.value)}
            className="bg-transparent text-sm font-medium text-foreground outline-none"
          >
            {users.map(user => (
              <option key={user.id} value={user.id}>
                {user.name}
              </option>
            ))}
          </select>
        </div>
        <span className="text-sm text-muted-foreground">
          {selectedUserLabel} activity
        </span>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-lg border bg-background p-4">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Activity className="h-4 w-4 text-muted-foreground" />
            Total Actions
          </div>
          <p className="mt-3 text-2xl font-semibold">{totalActions}</p>
        </div>
        <div className="rounded-lg border bg-background p-4">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
            Top Action
          </div>
          <p className="mt-3 text-2xl font-semibold capitalize">
            {topAction.action}
          </p>
          <p className="text-sm text-muted-foreground">
            {topAction.count} occurrences
          </p>
        </div>
        <div className="rounded-lg border bg-background p-4">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <User className="h-4 w-4 text-muted-foreground" />
            Distinct Actions
          </div>
          <p className="mt-3 text-2xl font-semibold">{Object.keys(stats).length}</p>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="rounded-lg border bg-background p-4">
          <h3 className="text-sm font-semibold">Activity Timeline</h3>
          <div className="mt-4 space-y-4">
            {sortedTimeline.length === 0 ? (
              <p className="text-sm text-muted-foreground">No activity found.</p>
            ) : (
              sortedTimeline.slice(0, 10).map((entry, index) => (
                <div key={entry.id} className="flex items-start gap-4">
                  <div
                    className={cn(
                      'mt-1 h-3 w-3 rounded-full border-2 border-primary bg-background',
                      index === 0 && 'bg-primary'
                    )}
                  />
                  <div className="flex-1 border-l border-dashed border-muted pl-4">
                    <p className="text-xs text-muted-foreground">{formatTimestamp(entry.timestamp)}</p>
                    <p className="text-sm font-medium text-foreground capitalize">
                      {entry.action} - {entry.resource}
                    </p>
                    <p className="text-xs text-muted-foreground">{entry.ipAddress}</p>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="rounded-lg border bg-background p-4">
          <h3 className="text-sm font-semibold">Actions by Type</h3>
          <div className="mt-4 space-y-3">
            {Object.keys(stats).length === 0 ? (
              <p className="text-sm text-muted-foreground">No actions recorded.</p>
            ) : (
              Object.entries(stats).map(([action, count]) => (
                <div key={action} className="flex items-center justify-between text-sm">
                  <span className="capitalize text-muted-foreground">{action}</span>
                  <span className="font-medium text-foreground">{count}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <div className="rounded-lg border bg-background p-4">
        <h3 className="text-sm font-semibold">Recent Actions</h3>
        <div className="mt-4 overflow-hidden rounded-md border">
          <table className="min-w-full divide-y text-sm">
            <thead className="bg-muted/40">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase">Time</th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase">Action</th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase">Resource</th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase">IP</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {sortedTimeline.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-4 text-center text-muted-foreground">
                    No recent actions found.
                  </td>
                </tr>
              ) : (
                sortedTimeline.slice(0, 5).map(entry => (
                  <tr key={entry.id}>
                    <td className="px-3 py-2 text-muted-foreground">{formatTimestamp(entry.timestamp)}</td>
                    <td className="px-3 py-2 capitalize text-foreground">{entry.action}</td>
                    <td className="px-3 py-2 text-foreground">{entry.resource}</td>
                    <td className="px-3 py-2 text-muted-foreground">{entry.ipAddress}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
