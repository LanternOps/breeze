import { CheckCircle, Clock, AlertTriangle, PlayCircle } from 'lucide-react';

export type DiscoveryJobStatus = 'scheduled' | 'running' | 'completed' | 'failed';

export type DiscoveryJob = {
  id: string;
  profileName: string;
  status: DiscoveryJobStatus;
  progress: number;
  hostsDiscovered: number;
  hostsTargeted: number;
  scheduledAt: string;
  startedAt?: string;
  finishedAt?: string;
};

type DiscoveryJobListProps = {
  jobs: DiscoveryJob[];
};

const statusConfig: Record<DiscoveryJobStatus, { label: string; color: string; icon: typeof Clock }> = {
  scheduled: { label: 'Scheduled', color: 'bg-blue-500/20 text-blue-700 border-blue-500/40', icon: Clock },
  running: { label: 'Running', color: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40', icon: PlayCircle },
  completed: { label: 'Completed', color: 'bg-green-500/20 text-green-700 border-green-500/40', icon: CheckCircle },
  failed: { label: 'Failed', color: 'bg-red-500/20 text-red-700 border-red-500/40', icon: AlertTriangle }
};

function formatTimestamp(value?: string) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export default function DiscoveryJobList({ jobs }: DiscoveryJobListProps) {
  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div>
        <h2 className="text-lg font-semibold">Discovery Jobs</h2>
        <p className="text-sm text-muted-foreground">Track running and scheduled scans.</p>
      </div>

      <div className="mt-6 overflow-hidden rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">Profile</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Progress</th>
              <th className="px-4 py-3">Hosts discovered</th>
              <th className="px-4 py-3">Scheduled</th>
              <th className="px-4 py-3">Started</th>
              <th className="px-4 py-3">Finished</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {jobs.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No discovery jobs yet.
                </td>
              </tr>
            ) : (
              jobs.map(job => {
                const status = statusConfig[job.status];
                const StatusIcon = status.icon;

                return (
                  <tr key={job.id} className="transition hover:bg-muted/40">
                    <td className="px-4 py-3 text-sm font-medium">{job.profileName}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium ${status.color}`}>
                        <StatusIcon className="h-3.5 w-3.5" />
                        {status.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <div className="flex items-center gap-3">
                        <div className="h-2 w-24 overflow-hidden rounded-full bg-muted">
                          <div
                            className={`h-full rounded-full ${
                              job.status === 'failed' ? 'bg-red-500' : job.status === 'completed' ? 'bg-green-500' : 'bg-yellow-500'
                            }`}
                            style={{ width: `${job.progress}%` }}
                          />
                        </div>
                        <span className="w-10 text-right text-xs">{job.progress}%</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {job.hostsDiscovered} / {job.hostsTargeted}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{formatTimestamp(job.scheduledAt)}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{formatTimestamp(job.startedAt)}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">{formatTimestamp(job.finishedAt)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
