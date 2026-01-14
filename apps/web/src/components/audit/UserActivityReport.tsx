import { useMemo, useState } from 'react';
import { Activity, Download, TrendingUp, User, Users } from 'lucide-react';
import { cn } from '@/lib/utils';

type ActivityEntry = {
  id: string;
  userId: string;
  userName: string;
  timestamp: string;
  action: string;
  resource: string;
  ipAddress: string;
};

const mockUsers = [
  { id: 'all', name: 'All users' },
  { id: 'user_1', name: 'Ariana Fields' },
  { id: 'user_2', name: 'Miguel Rogers' },
  { id: 'user_3', name: 'Priya Nair' },
  { id: 'user_4', name: 'Kai Mendoza' },
  { id: 'user_5', name: 'Grace Liu' }
];

const mockActivity: ActivityEntry[] = [
  {
    id: 'act_1',
    userId: 'user_1',
    userName: 'Ariana Fields',
    timestamp: '2024-05-28T14:12:45Z',
    action: 'login',
    resource: 'Admin Portal',
    ipAddress: '174.20.31.10'
  },
  {
    id: 'act_2',
    userId: 'user_1',
    userName: 'Ariana Fields',
    timestamp: '2024-05-28T13:46:12Z',
    action: 'update',
    resource: 'Endpoint Policy - West Region',
    ipAddress: '174.20.31.10'
  },
  {
    id: 'act_3',
    userId: 'user_2',
    userName: 'Miguel Rogers',
    timestamp: '2024-05-28T12:05:09Z',
    action: 'access',
    resource: 'Customer Records',
    ipAddress: '10.10.12.44'
  },
  {
    id: 'act_4',
    userId: 'user_3',
    userName: 'Priya Nair',
    timestamp: '2024-05-27T21:28:33Z',
    action: 'export',
    resource: 'Alerts Report',
    ipAddress: '172.16.11.90'
  },
  {
    id: 'act_5',
    userId: 'user_4',
    userName: 'Kai Mendoza',
    timestamp: '2024-05-27T16:44:02Z',
    action: 'create',
    resource: 'New Device Group - VIP',
    ipAddress: '10.10.12.33'
  },
  {
    id: 'act_6',
    userId: 'user_5',
    userName: 'Grace Liu',
    timestamp: '2024-05-27T12:40:18Z',
    action: 'access',
    resource: 'Payroll Records',
    ipAddress: '192.168.1.22'
  },
  {
    id: 'act_7',
    userId: 'user_5',
    userName: 'Grace Liu',
    timestamp: '2024-05-27T09:18:04Z',
    action: 'export',
    resource: 'Device Inventory',
    ipAddress: '192.168.1.22'
  }
];

const formatTimestamp = (value: string) => new Date(value).toLocaleString();

export default function UserActivityReport() {
  const [selectedUserId, setSelectedUserId] = useState('all');

  const selectedUserLabel =
    mockUsers.find(user => user.id === selectedUserId)?.name ?? 'All users';

  const filteredActivity = useMemo(() => {
    if (selectedUserId === 'all') return mockActivity;
    return mockActivity.filter(entry => entry.userId === selectedUserId);
  }, [selectedUserId]);

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

  return (
    <div className="space-y-6 rounded-lg border bg-card p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">User Activity Report</h2>
          <p className="text-sm text-muted-foreground">Review activity trends and export history.</p>
        </div>
        <button
          type="button"
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
            {mockUsers.map(user => (
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
            {sortedTimeline.map((entry, index) => (
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
            ))}
          </div>
        </div>

        <div className="rounded-lg border bg-background p-4">
          <h3 className="text-sm font-semibold">Actions by Type</h3>
          <div className="mt-4 space-y-3">
            {Object.entries(stats).map(([action, count]) => (
              <div key={action} className="flex items-center justify-between text-sm">
                <span className="capitalize text-muted-foreground">{action}</span>
                <span className="font-medium text-foreground">{count}</span>
              </div>
            ))}
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
              {sortedTimeline.slice(0, 5).map(entry => (
                <tr key={entry.id}>
                  <td className="px-3 py-2 text-muted-foreground">{formatTimestamp(entry.timestamp)}</td>
                  <td className="px-3 py-2 capitalize text-foreground">{entry.action}</td>
                  <td className="px-3 py-2 text-foreground">{entry.resource}</td>
                  <td className="px-3 py-2 text-muted-foreground">{entry.ipAddress}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
