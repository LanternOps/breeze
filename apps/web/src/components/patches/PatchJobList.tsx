import { useMemo, useState } from 'react';
import { Search, ChevronLeft, ChevronRight, PlayCircle, AlertTriangle, CheckCircle, PauseCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

export type PatchJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'paused';

export type PatchJob = {
  id: string;
  name: string;
  status: PatchJobStatus;
  startedAt: string;
  completedAt?: string;
  devicesTotal: number;
  devicesPatched: number;
  devicesFailed: number;
};

type PatchJobListProps = {
  jobs: PatchJob[];
  pageSize?: number;
  onSelect?: (job: PatchJob) => void;
};

const statusConfig: Record<PatchJobStatus, { label: string; color: string; icon: typeof PlayCircle }> = {
  queued: { label: 'Queued', color: 'bg-blue-500/20 text-blue-700 border-blue-500/40', icon: PlayCircle },
  running: { label: 'Running', color: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40', icon: PlayCircle },
  completed: { label: 'Completed', color: 'bg-green-500/20 text-green-700 border-green-500/40', icon: CheckCircle },
  failed: { label: 'Failed', color: 'bg-red-500/20 text-red-700 border-red-500/40', icon: AlertTriangle },
  paused: { label: 'Paused', color: 'bg-gray-500/20 text-gray-700 border-gray-500/40', icon: PauseCircle }
};

function formatDate(dateString?: string): string {
  if (!dateString) return '—';
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleDateString();
}

export default function PatchJobList({ jobs, pageSize = 8, onSelect }: PatchJobListProps) {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [currentPage, setCurrentPage] = useState(1);

  const filteredJobs = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return jobs.filter(job => {
      const matchesQuery =
        normalizedQuery.length === 0
          ? true
          : job.name.toLowerCase().includes(normalizedQuery) || job.id.toLowerCase().includes(normalizedQuery);
      const matchesStatus = statusFilter === 'all' ? true : job.status === statusFilter;
      return matchesQuery && matchesStatus;
    });
  }, [jobs, query, statusFilter]);

  const totalPages = Math.ceil(filteredJobs.length / pageSize);
  const startIndex = (currentPage - 1) * pageSize;
  const paginatedJobs = filteredJobs.slice(startIndex, startIndex + pageSize);

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Deployment Jobs</h2>
          <p className="text-sm text-muted-foreground">
            {filteredJobs.length} of {jobs.length} jobs
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center flex-wrap">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              placeholder="Search jobs..."
              value={query}
              onChange={event => {
                setQuery(event.target.value);
                setCurrentPage(1);
              }}
              className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-48"
            />
          </div>
          <select
            value={statusFilter}
            onChange={event => {
              setStatusFilter(event.target.value);
              setCurrentPage(1);
            }}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-36"
          >
            <option value="all">All Status</option>
            <option value="queued">Queued</option>
            <option value="running">Running</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="paused">Paused</option>
          </select>
        </div>
      </div>

      <div className="mt-6 overflow-hidden rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">Job</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Progress</th>
              <th className="px-4 py-3">Devices</th>
              <th className="px-4 py-3">Started</th>
              <th className="px-4 py-3">Completed</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {paginatedJobs.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No jobs found. Try adjusting your search.
                </td>
              </tr>
            ) : (
              paginatedJobs.map(job => {
                const status = statusConfig[job.status];
                const StatusIcon = status.icon;
                const progress = job.devicesTotal > 0 ? Math.round((job.devicesPatched / job.devicesTotal) * 100) : 0;

                return (
                  <tr key={job.id} className="text-sm">
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => onSelect?.(job)}
                        className="text-left text-sm font-medium text-foreground hover:text-primary"
                      >
                        {job.name}
                      </button>
                      <div className="text-xs text-muted-foreground">{job.id}</div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={cn('inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium', status.color)}>
                        <StatusIcon className="h-3.5 w-3.5" />
                        {status.label}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-24 rounded-full bg-muted">
                          <div className="h-2 rounded-full bg-primary" style={{ width: `${progress}%` }} />
                        </div>
                        <span className="text-xs text-muted-foreground">{progress}%</span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {job.devicesPatched}/{job.devicesTotal} patched
                      {job.devicesFailed > 0 && (
                        <span className="ml-2 text-xs text-destructive">{job.devicesFailed} failed</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDate(job.startedAt)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDate(job.completedAt)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Page {currentPage} of {totalPages}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))}
              disabled={currentPage === 1}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border disabled:opacity-50"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))}
              disabled={currentPage === totalPages}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md border disabled:opacity-50"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
