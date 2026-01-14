import { CheckCircle2, Clock, HardDrive, History, PlayCircle, ShieldAlert } from 'lucide-react';
import { cn } from '@/lib/utils';

const statusConfig = {
  healthy: {
    label: 'Healthy',
    className: 'text-success bg-success/10',
    icon: CheckCircle2
  },
  warning: {
    label: 'Needs Attention',
    className: 'text-warning bg-warning/10',
    icon: ShieldAlert
  }
};

export default function DeviceBackupStatus() {
  const status = statusConfig.healthy;
  const StatusIcon = status.icon;

  return (
    <div className="rounded-lg border bg-card p-5 shadow-sm space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-foreground">NYC-DB-14</h3>
          <p className="text-sm text-muted-foreground">Primary SQL backup policy</p>
        </div>
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium',
            status.className
          )}
        >
          <StatusIcon className="h-3.5 w-3.5" />
          {status.label}
        </span>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-md border border-dashed bg-muted/30 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Clock className="h-4 w-4 text-primary" />
            Last backup
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Today at 02:05 AM - Completed</p>
        </div>
        <div className="rounded-md border border-dashed bg-muted/30 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <History className="h-4 w-4 text-primary" />
            Next scheduled
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Today at 10:00 PM</p>
        </div>
        <div className="rounded-md border border-dashed bg-muted/30 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <HardDrive className="h-4 w-4 text-primary" />
            Storage used
          </div>
          <p className="mt-2 text-xs text-muted-foreground">182 GB - 14 restore points</p>
        </div>
        <div className="rounded-md border border-dashed bg-muted/30 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <ShieldAlert className="h-4 w-4 text-primary" />
            Protection tier
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Gold - Encrypted - 30-day retention</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <button className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
          <PlayCircle className="h-4 w-4" />
          Run quick backup
        </button>
        <button className="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-accent">
          View history
        </button>
      </div>
    </div>
  );
}
