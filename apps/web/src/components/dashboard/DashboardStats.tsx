import { Monitor, CheckCircle, AlertTriangle, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

const stats = [
  {
    name: 'Total Devices',
    value: '1,247',
    icon: Monitor,
    change: '+12%',
    changeType: 'positive'
  },
  {
    name: 'Online',
    value: '1,189',
    icon: CheckCircle,
    change: '95.3%',
    changeType: 'positive'
  },
  {
    name: 'Warnings',
    value: '23',
    icon: AlertTriangle,
    change: '-5%',
    changeType: 'positive'
  },
  {
    name: 'Critical',
    value: '4',
    icon: XCircle,
    change: '+2',
    changeType: 'negative'
  }
];

export default function DashboardStats() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {stats.map((stat) => (
        <div
          key={stat.name}
          className="rounded-lg border bg-card p-6 shadow-sm"
        >
          <div className="flex items-center justify-between">
            <stat.icon
              className={cn(
                'h-5 w-5',
                stat.name === 'Online' && 'text-success',
                stat.name === 'Warnings' && 'text-warning',
                stat.name === 'Critical' && 'text-destructive'
              )}
            />
            <span
              className={cn(
                'text-xs font-medium',
                stat.changeType === 'positive'
                  ? 'text-success'
                  : 'text-destructive'
              )}
            >
              {stat.change}
            </span>
          </div>
          <div className="mt-4">
            <div className="text-2xl font-bold">{stat.value}</div>
            <div className="text-sm text-muted-foreground">{stat.name}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
