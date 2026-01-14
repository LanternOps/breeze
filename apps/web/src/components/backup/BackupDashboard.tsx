import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Database,
  HardDrive,
  PlayCircle,
  ShieldAlert,
  TrendingUp,
  XCircle
} from 'lucide-react';
import { cn } from '@/lib/utils';

const stats = [
  {
    name: 'Total Backups',
    value: '4,286',
    change: '+6.4%',
    changeType: 'positive',
    icon: Database
  },
  {
    name: 'Success Rate',
    value: '98.2%',
    change: '+0.6%',
    changeType: 'positive',
    icon: CheckCircle2
  },
  {
    name: 'Storage Used',
    value: '42.7 TB',
    change: '+1.8 TB',
    changeType: 'neutral',
    icon: HardDrive
  },
  {
    name: 'Devices Covered',
    value: '1,142',
    change: '-3',
    changeType: 'negative',
    icon: ShieldAlert
  }
];

const recentJobs = [
  {
    id: 'job-0924',
    device: 'NYC-DB-14',
    config: 'Primary SQL S3',
    status: 'success',
    started: '12 min ago',
    duration: '6m 21s',
    size: '12.4 GB'
  },
  {
    id: 'job-0923',
    device: 'DAL-FS-07',
    config: 'File Shares - Azure',
    status: 'running',
    started: '18 min ago',
    duration: '3m 10s',
    size: '6.8 GB'
  },
  {
    id: 'job-0922',
    device: 'SFO-VM-03',
    config: 'VM Images Local',
    status: 'failed',
    started: '42 min ago',
    duration: '2m 19s',
    size: '-'
  },
  {
    id: 'job-0921',
    device: 'CHI-NAS-02',
    config: 'NAS Archive S3',
    status: 'warning',
    started: '1 hr ago',
    duration: '14m 07s',
    size: '41.2 GB'
  }
];

const overdueDevices = [
  {
    name: 'SEA-WKS-11',
    lastBackup: '5 days ago',
    schedule: 'Daily',
    owner: 'Engineering'
  },
  {
    name: 'NYC-DB-18',
    lastBackup: '3 days ago',
    schedule: 'Daily',
    owner: 'Finance'
  },
  {
    name: 'DAL-FS-22',
    lastBackup: '7 days ago',
    schedule: 'Weekly',
    owner: 'HR'
  },
  {
    name: 'SFO-VM-09',
    lastBackup: '9 days ago',
    schedule: 'Weekly',
    owner: 'Operations'
  }
];

const storageProviders = [
  {
    name: 'AWS S3',
    used: '18.2 TB',
    total: '25 TB',
    percent: 73,
    color: 'bg-emerald-500'
  },
  {
    name: 'Azure Blob',
    used: '11.4 TB',
    total: '16 TB',
    percent: 71,
    color: 'bg-sky-500'
  },
  {
    name: 'Local Vault',
    used: '9.1 TB',
    total: '12 TB',
    percent: 76,
    color: 'bg-amber-500'
  },
  {
    name: 'Wasabi',
    used: '4.0 TB',
    total: '8 TB',
    percent: 50,
    color: 'bg-violet-500'
  }
];

const statusConfig = {
  success: {
    icon: CheckCircle2,
    label: 'Success',
    className: 'text-success bg-success/10'
  },
  running: {
    icon: Activity,
    label: 'Running',
    className: 'text-primary bg-primary/10'
  },
  failed: {
    icon: XCircle,
    label: 'Failed',
    className: 'text-destructive bg-destructive/10'
  },
  warning: {
    icon: AlertTriangle,
    label: 'Warning',
    className: 'text-warning bg-warning/10'
  }
};

export default function BackupDashboard() {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-foreground">Backup Overview</h2>
          <p className="text-sm text-muted-foreground">
            Monitor protection coverage, storage trends, and recent activity.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="inline-flex items-center gap-2 rounded-md border bg-card px-4 py-2 text-sm font-medium shadow-sm hover:bg-accent">
            <PlayCircle className="h-4 w-4" />
            Run all backups
          </button>
          <button className="inline-flex items-center gap-2 rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground shadow-sm hover:bg-destructive/90">
            <AlertTriangle className="h-4 w-4" />
            View failed
          </button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => (
          <div key={stat.name} className="rounded-lg border bg-card p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <stat.icon className="h-5 w-5 text-muted-foreground" />
              <span
                className={cn(
                  'text-xs font-medium',
                  stat.changeType === 'positive' && 'text-success',
                  stat.changeType === 'negative' && 'text-destructive',
                  stat.changeType === 'neutral' && 'text-muted-foreground'
                )}
              >
                {stat.change}
              </span>
            </div>
            <div className="mt-4">
              <div className="text-2xl font-semibold text-foreground">{stat.value}</div>
              <div className="text-sm text-muted-foreground">{stat.name}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="rounded-lg border bg-card p-5 shadow-sm lg:col-span-2">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold text-foreground">Recent Jobs</h3>
              <p className="text-sm text-muted-foreground">Latest backup activity across sites.</p>
            </div>
            <button className="text-sm font-medium text-primary hover:text-primary/80">
              View all
            </button>
          </div>
          <div className="mt-4 space-y-3">
            {recentJobs.map((job) => {
              const status = statusConfig[job.status as keyof typeof statusConfig];
              const StatusIcon = status.icon;
              return (
                <div
                  key={job.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-dashed bg-muted/30 px-4 py-3"
                >
                  <div className="flex items-center gap-3">
                    <span className={cn('flex h-9 w-9 items-center justify-center rounded-full', status.className)}>
                      <StatusIcon className="h-4 w-4" />
                    </span>
                    <div>
                      <p className="text-sm font-semibold text-foreground">{job.device}</p>
                      <p className="text-xs text-muted-foreground">{job.config}</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <Clock className="h-3.5 w-3.5" /> {job.started}
                    </span>
                    <span>Duration: {job.duration}</span>
                    <span>Size: {job.size}</span>
                    <span className="text-foreground">{status.label}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-lg border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold text-foreground">Storage by Provider</h3>
              <p className="text-sm text-muted-foreground">Current usage and capacity.</p>
            </div>
            <TrendingUp className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="mt-4 space-y-4">
            {storageProviders.map((provider) => (
              <div key={provider.name} className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium text-foreground">{provider.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {provider.used} / {provider.total}
                  </span>
                </div>
                <div className="h-2 w-full rounded-full bg-muted">
                  <div
                    className={cn('h-2 rounded-full', provider.color)}
                    style={{ width: `${provider.percent}%` }}
                  />
                </div>
              </div>
            ))}
            <div className="rounded-md border border-dashed bg-muted/40 p-3 text-xs text-muted-foreground">
              Chart placeholder: integrate provider usage history.
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="rounded-lg border bg-card p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold text-foreground">Devices Needing Backup</h3>
              <p className="text-sm text-muted-foreground">Overdue based on schedule.</p>
            </div>
            <AlertTriangle className="h-5 w-5 text-warning" />
          </div>
          <div className="mt-4 space-y-3">
            {overdueDevices.map((device) => (
              <div
                key={device.name}
                className="flex items-center justify-between gap-3 rounded-md border border-dashed bg-muted/30 px-4 py-3"
              >
                <div>
                  <p className="text-sm font-semibold text-foreground">{device.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {device.owner} - {device.schedule}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-xs text-muted-foreground">Last backup</p>
                  <p className="text-sm font-medium text-destructive">{device.lastBackup}</p>
                </div>
              </div>
            ))}
          </div>
          <button className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-md border bg-card px-4 py-2 text-sm font-medium hover:bg-accent">
            <PlayCircle className="h-4 w-4" />
            Run overdue backups
          </button>
        </div>

        <div className="rounded-lg border bg-card p-5 shadow-sm lg:col-span-2">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-semibold text-foreground">Attention Needed</h3>
              <p className="text-sm text-muted-foreground">
                Alerts for backup performance and coverage.
              </p>
            </div>
            <button className="text-sm font-medium text-primary hover:text-primary/80">
              Resolve all
            </button>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            <div className="rounded-md border border-dashed bg-muted/30 p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <AlertTriangle className="h-4 w-4 text-warning" />
                6 configs with failed tests
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Last connection check exceeded threshold.
              </p>
            </div>
            <div className="rounded-md border border-dashed bg-muted/30 p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <XCircle className="h-4 w-4 text-destructive" />
                12 devices without recovery points
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Devices have not completed a backup in 10+ days.
              </p>
            </div>
            <div className="rounded-md border border-dashed bg-muted/30 p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <HardDrive className="h-4 w-4 text-amber-500" />
                Local vault usage 92%
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Consider migrating archive sets to cloud storage.
              </p>
            </div>
            <div className="rounded-md border border-dashed bg-muted/30 p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <CheckCircle2 className="h-4 w-4 text-success" />
                98.2% success rate
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Best performance in the last 30 days.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
