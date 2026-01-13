import { FileCode, Terminal, User, Settings, Monitor } from 'lucide-react';

const activities = [
  {
    id: 1,
    user: 'John Doe',
    action: 'executed script',
    target: 'Windows Update Check',
    targetType: 'script',
    time: '2 minutes ago'
  },
  {
    id: 2,
    user: 'Jane Smith',
    action: 'started remote session',
    target: 'SERVER-01',
    targetType: 'device',
    time: '15 minutes ago'
  },
  {
    id: 3,
    user: 'System',
    action: 'enrolled new device',
    target: 'WS-099',
    targetType: 'device',
    time: '32 minutes ago'
  },
  {
    id: 4,
    user: 'Mike Johnson',
    action: 'updated alert rule',
    target: 'High CPU Warning',
    targetType: 'settings',
    time: '1 hour ago'
  },
  {
    id: 5,
    user: 'Jane Smith',
    action: 'created user',
    target: 'sarah@acme.com',
    targetType: 'user',
    time: '2 hours ago'
  }
];

const typeIcons = {
  script: FileCode,
  device: Monitor,
  user: User,
  settings: Settings
};

export default function RecentActivity() {
  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="font-semibold">Recent Activity</h3>
        <a href="/audit" className="text-sm text-primary hover:underline">
          View audit log
        </a>
      </div>
      <div className="overflow-x-auto">
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
              const Icon = typeIcons[activity.targetType as keyof typeof typeIcons];
              return (
                <tr key={activity.id} className="border-b last:border-0">
                  <td className="py-3 text-sm">{activity.user}</td>
                  <td className="py-3 text-sm text-muted-foreground">
                    {activity.action}
                  </td>
                  <td className="py-3">
                    <div className="flex items-center gap-2 text-sm">
                      <Icon className="h-4 w-4 text-muted-foreground" />
                      <span>{activity.target}</span>
                    </div>
                  </td>
                  <td className="py-3 text-sm text-muted-foreground">
                    {activity.time}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
