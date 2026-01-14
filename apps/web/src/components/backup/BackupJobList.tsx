import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clock,
  Filter,
  Loader2,
  PauseCircle,
  Search,
  XCircle
} from 'lucide-react';
import { cn } from '@/lib/utils';

type JobStatus = 'completed' | 'running' | 'failed' | 'queued';

type BackupJob = {
  id: string;
  device: string;
  config: string;
  type: string;
  status: JobStatus;
  started: string;
  duration: string;
  size: string;
  errors: string;
  progress?: number;
};

const jobs: BackupJob[] = [
  {
    id: 'job-1041',
    device: 'NYC-DB-14',
    config: 'Primary SQL S3',
    type: 'Database',
    status: 'running',
    started: '11:42 AM',
    duration: '6m 12s',
    size: '9.3 GB',
    errors: '-',
    progress: 62
  },
  {
    id: 'job-1040',
    device: 'DAL-FS-07',
    config: 'File Shares - Azure',
    type: 'File',
    status: 'failed',
    started: '10:58 AM',
    duration: '4m 07s',
    size: '-',
    errors: 'Auth token expired'
  },
  {
    id: 'job-1039',
    device: 'SFO-VM-03',
    config: 'VM Images Local',
    type: 'Image',
    status: 'completed',
    started: '10:10 AM',
    duration: '18m 40s',
    size: '38.1 GB',
    errors: '-'
  },
  {
    id: 'job-1038',
    device: 'CHI-NAS-02',
    config: 'Archive NAS S3',
    type: 'File',
    status: 'queued',
    started: '09:45 AM',
    duration: '-',
    size: '-',
    errors: '-'
  }
];

const statusConfig: Record<JobStatus, { label: string; icon: typeof CheckCircle2; className: string }> = {
  completed: {
    label: 'Completed',
    icon: CheckCircle2,
    className: 'text-success bg-success/10'
  },
  running: {
    label: 'Running',
    icon: Loader2,
    className: 'text-primary bg-primary/10'
  },
  failed: {
    label: 'Failed',
    icon: XCircle,
    className: 'text-destructive bg-destructive/10'
  },
  queued: {
    label: 'Queued',
    icon: Clock,
    className: 'text-muted-foreground bg-muted'
  }
};

export default function BackupJobList() {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold text-foreground">Backup Jobs</h2>
        <p className="text-sm text-muted-foreground">Track job execution status and troubleshoot errors.</p>
      </div>

      <div className="grid gap-3 rounded-lg border bg-card p-4 shadow-sm md:grid-cols-4">
        <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            className="w-full bg-transparent text-sm outline-none"
            placeholder="Search device..."
          />
        </div>
        <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <select className="w-full bg-transparent text-sm outline-none">
            <option>All status</option>
            <option>Running</option>
            <option>Failed</option>
            <option>Completed</option>
            <option>Queued</option>
          </select>
        </div>
        <div className="rounded-md border bg-background px-3 py-2 text-sm">
          <select className="w-full bg-transparent text-sm outline-none">
            <option>All configs</option>
            <option>Primary SQL S3</option>
            <option>File Shares - Azure</option>
            <option>VM Images Local</option>
          </select>
        </div>
        <div className="rounded-md border bg-background px-3 py-2 text-sm">
          <select className="w-full bg-transparent text-sm outline-none">
            <option>Last 24 hours</option>
            <option>Last 7 days</option>
            <option>Last 30 days</option>
          </select>
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border bg-card shadow-sm">
        <table className="w-full">
          <thead className="bg-muted/40 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Device</th>
              <th className="px-4 py-3">Config</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Started</th>
              <th className="px-4 py-3">Duration</th>
              <th className="px-4 py-3">Size</th>
              <th className="px-4 py-3">Errors</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {jobs.map((job) => {
              const status = statusConfig[job.status];
              const StatusIcon = status.icon;
              return (
                <tr key={job.id} className="text-sm text-foreground">
                  <td className="px-4 py-3 font-medium">{job.device}</td>
                  <td className="px-4 py-3 text-muted-foreground">{job.config}</td>
                  <td className="px-4 py-3 text-muted-foreground">{job.type}</td>
                  <td className="px-4 py-3">
                    <div className="space-y-2">
                      <span
                        className={cn(
                          'inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium',
                          status.className
                        )}
                      >
                        <StatusIcon
                          className={cn('h-3.5 w-3.5', job.status === 'running' && 'animate-spin')}
                        />
                        {status.label}
                      </span>
                      {job.status === 'running' && (
                        <div className="h-1.5 w-24 rounded-full bg-muted">
                          <div
                            className="h-1.5 rounded-full bg-primary"
                            style={{ width: `${job.progress ?? 0}%` }}
                          />
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{job.started}</td>
                  <td className="px-4 py-3 text-muted-foreground">{job.duration}</td>
                  <td className="px-4 py-3 text-muted-foreground">{job.size}</td>
                  <td className="px-4 py-3">
                    {job.status === 'failed' ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-destructive">
                        <AlertTriangle className="h-3.5 w-3.5" />
                        {job.errors}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">{job.errors}</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      {job.status === 'running' && (
                        <button className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent">
                          <PauseCircle className="h-3.5 w-3.5" />
                          Cancel
                        </button>
                      )}
                      <button className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/10">
                        View details
                        <ChevronRight className="h-3.5 w-3.5" />
                      </button>
                    </div>
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
