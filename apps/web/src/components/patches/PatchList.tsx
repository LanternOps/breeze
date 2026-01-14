import { useMemo, useState } from 'react';
import {
  Search,
  ChevronLeft,
  ChevronRight,
  CheckCircle,
  XCircle,
  Clock,
  Eye,
  Download,
  Loader2
} from 'lucide-react';
import { cn } from '@/lib/utils';

export type PatchSeverity = 'critical' | 'important' | 'moderate' | 'low';
export type PatchApprovalStatus = 'pending' | 'approved' | 'declined' | 'deferred';

export type Patch = {
  id: string;
  title: string;
  severity: PatchSeverity;
  source: string;
  os: string;
  releaseDate: string;
  approvalStatus: PatchApprovalStatus;
  description?: string;
};

type PatchListProps = {
  patches: Patch[];
  onReview?: (patch: Patch) => void;
  onDeploy?: (patch: Patch) => void;
  onView?: (patch: Patch) => void;
  pageSize?: number;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
};

const severityConfig: Record<PatchSeverity, { label: string; color: string }> = {
  critical: { label: 'Critical', color: 'bg-red-500/20 text-red-700 border-red-500/40' },
  important: { label: 'Important', color: 'bg-orange-500/20 text-orange-700 border-orange-500/40' },
  moderate: { label: 'Moderate', color: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40' },
  low: { label: 'Low', color: 'bg-blue-500/20 text-blue-700 border-blue-500/40' }
};

const approvalConfig: Record<PatchApprovalStatus, { label: string; color: string; icon: typeof CheckCircle }> = {
  pending: { label: 'Pending', color: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40', icon: Clock },
  approved: { label: 'Approved', color: 'bg-green-500/20 text-green-700 border-green-500/40', icon: CheckCircle },
  declined: { label: 'Declined', color: 'bg-red-500/20 text-red-700 border-red-500/40', icon: XCircle },
  deferred: { label: 'Deferred', color: 'bg-blue-500/20 text-blue-700 border-blue-500/40', icon: Clock }
};

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleDateString();
}

export default function PatchList({
  patches,
  onReview,
  onDeploy,
  onView,
  pageSize = 8,
  loading,
  error,
  onRetry
}: PatchListProps) {
  const [query, setQuery] = useState('');
  const [severityFilter, setSeverityFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [osFilter, setOsFilter] = useState<string>('all');
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [currentPage, setCurrentPage] = useState(1);

  const availableSources = useMemo(() => {
    const sources = new Set(patches.map(patch => patch.source));
    return Array.from(sources).sort();
  }, [patches]);

  const availableOs = useMemo(() => {
    const osList = new Set(patches.map(patch => patch.os));
    return Array.from(osList).sort();
  }, [patches]);

  const filteredPatches = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return patches.filter(patch => {
      const matchesQuery =
        normalizedQuery.length === 0
          ? true
          : patch.title.toLowerCase().includes(normalizedQuery) ||
            patch.description?.toLowerCase().includes(normalizedQuery);
      const matchesSeverity = severityFilter === 'all' ? true : patch.severity === severityFilter;
      const matchesStatus = statusFilter === 'all' ? true : patch.approvalStatus === statusFilter;
      const matchesOs = osFilter === 'all' ? true : patch.os === osFilter;
      const matchesSource = sourceFilter === 'all' ? true : patch.source === sourceFilter;

      return matchesQuery && matchesSeverity && matchesStatus && matchesOs && matchesSource;
    });
  }, [patches, query, severityFilter, statusFilter, osFilter, sourceFilter]);

  const totalPages = Math.ceil(filteredPatches.length / pageSize);
  const startIndex = (currentPage - 1) * pageSize;
  const paginatedPatches = filteredPatches.slice(startIndex, startIndex + pageSize);

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Patches</h2>
          <p className="text-sm text-muted-foreground">
            {filteredPatches.length} of {patches.length} patches
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center flex-wrap">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              placeholder="Search patches..."
              value={query}
              onChange={event => {
                setQuery(event.target.value);
                setCurrentPage(1);
              }}
              className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-48"
            />
          </div>
          <select
            value={severityFilter}
            onChange={event => {
              setSeverityFilter(event.target.value);
              setCurrentPage(1);
            }}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-36"
          >
            <option value="all">All Severities</option>
            <option value="critical">Critical</option>
            <option value="important">Important</option>
            <option value="moderate">Moderate</option>
            <option value="low">Low</option>
          </select>
          <select
            value={statusFilter}
            onChange={event => {
              setStatusFilter(event.target.value);
              setCurrentPage(1);
            }}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-36"
          >
            <option value="all">All Status</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="declined">Declined</option>
            <option value="deferred">Deferred</option>
          </select>
          <select
            value={sourceFilter}
            onChange={event => {
              setSourceFilter(event.target.value);
              setCurrentPage(1);
            }}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-40"
          >
            <option value="all">All Sources</option>
            {availableSources.map(source => (
              <option key={source} value={source}>
                {source}
              </option>
            ))}
          </select>
          <select
            value={osFilter}
            onChange={event => {
              setOsFilter(event.target.value);
              setCurrentPage(1);
            }}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-32"
          >
            <option value="all">All OS</option>
            {availableOs.map(os => (
              <option key={os} value={os}>
                {os}
              </option>
            ))}
          </select>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="text-center">
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-muted-foreground" />
            <p className="mt-4 text-sm text-muted-foreground">Loading patches...</p>
          </div>
        </div>
      ) : error && patches.length === 0 ? (
        <div className="mt-6 rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
          <p className="text-sm text-destructive">{error}</p>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              Try again
            </button>
          )}
        </div>
      ) : (
        <div className="mt-6 overflow-hidden rounded-md border">
          <table className="min-w-full divide-y">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">Patch</th>
                <th className="px-4 py-3">Severity</th>
                <th className="px-4 py-3">Source</th>
                <th className="px-4 py-3">OS</th>
                <th className="px-4 py-3">Release</th>
                <th className="px-4 py-3">Approval</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {paginatedPatches.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-sm text-muted-foreground">
                    No patches found. Try adjusting your search or filters.
                  </td>
                </tr>
              ) : (
                paginatedPatches.map(patch => {
                  const severity = severityConfig[patch.severity];
                  const approval = approvalConfig[patch.approvalStatus];
                  const ApprovalIcon = approval.icon;

                  return (
                    <tr key={patch.id} className="text-sm">
                      <td className="px-4 py-3">
                        <div className="font-medium text-foreground">{patch.title}</div>
                        {patch.description && (
                          <div className="text-xs text-muted-foreground">{patch.description}</div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={cn('inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium', severity.color)}>
                          {severity.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{patch.source}</td>
                      <td className="px-4 py-3 text-muted-foreground">{patch.os}</td>
                      <td className="px-4 py-3 text-muted-foreground">{formatDate(patch.releaseDate)}</td>
                      <td className="px-4 py-3">
                        <span className={cn('inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium', approval.color)}>
                          <ApprovalIcon className="h-3.5 w-3.5" />
                          {approval.label}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-2">
                          {patch.approvalStatus === 'approved' ? (
                            <button
                              type="button"
                              onClick={() => onDeploy?.(patch)}
                              className="inline-flex h-8 items-center gap-1 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90"
                            >
                              <Download className="h-3.5 w-3.5" />
                              Deploy
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => onReview?.(patch)}
                              className="inline-flex h-8 items-center gap-1 rounded-md border px-3 text-xs font-medium hover:bg-muted"
                            >
                              <Eye className="h-3.5 w-3.5" />
                              Review
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => onView?.(patch)}
                            className="inline-flex h-8 items-center gap-1 rounded-md border px-3 text-xs font-medium text-muted-foreground hover:text-foreground"
                          >
                            Details
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}

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
