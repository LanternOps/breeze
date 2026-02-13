import { useState, useMemo } from 'react';
import { Search, XCircle, AlertTriangle } from 'lucide-react';
import { formatRelativeTime, formatToolName } from '../../lib/utils';
import type { ToolExecution, SecurityEvent } from './AiRiskDashboard';

interface Props {
  executions: ToolExecution[];
  securityEvents: SecurityEvent[];
  loading: boolean;
}

interface LogEntry {
  id: string;
  timestamp: string;
  tool: string;
  status: 'failed' | 'rejected' | 'denied';
  errorMessage: string | null;
  sessionId: string | null;
  source: 'execution' | 'security';
}

type StatusFilter = 'all' | 'failed' | 'rejected' | 'denied';

export function RejectionDenialLog({ executions, securityEvents, loading }: Props) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const entries = useMemo(() => {
    const result: LogEntry[] = [];

    // Failed/rejected from tool executions
    for (const exec of executions) {
      if (exec.status === 'failed' || exec.status === 'rejected') {
        result.push({
          id: exec.id,
          timestamp: exec.createdAt,
          tool: exec.toolName,
          status: exec.status as 'failed' | 'rejected',
          errorMessage: exec.errorMessage,
          sessionId: exec.sessionId,
          source: 'execution',
        });
      }
    }

    // Denied events from security events
    for (const evt of securityEvents) {
      if (evt.action.includes('denied') || evt.action.includes('blocked') || evt.result === 'denied') {
        result.push({
          id: evt.id,
          timestamp: evt.timestamp,
          tool: evt.action.replace('ai.tool.', '').replace('ai.security.', ''),
          status: 'denied',
          errorMessage: evt.errorMessage,
          sessionId: evt.resourceId,
          source: 'security',
        });
      }
    }

    result.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return result;
  }, [executions, securityEvents]);

  const filtered = useMemo(() => {
    let result = entries;
    if (statusFilter !== 'all') {
      result = result.filter((e) => e.status === statusFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (e) =>
          e.tool.toLowerCase().includes(q) ||
          e.errorMessage?.toLowerCase().includes(q) ||
          e.sessionId?.toLowerCase().includes(q)
      );
    }
    return result;
  }, [entries, statusFilter, search]);

  const statusBadge: Record<string, string> = {
    failed: 'bg-red-500/15 text-red-700 border-red-500/30',
    rejected: 'bg-amber-500/15 text-amber-700 border-amber-500/30',
    denied: 'bg-red-500/15 text-red-700 border-red-500/30',
  };

  const filters: { label: string; value: StatusFilter }[] = [
    { label: 'All', value: 'all' },
    { label: 'Failed', value: 'failed' },
    { label: 'Rejected', value: 'rejected' },
    { label: 'Denied', value: 'denied' },
  ];

  return (
    <div>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-lg font-semibold">Rejections & Denials</h2>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search..."
              className="h-8 rounded-lg border bg-card pl-8 pr-3 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div className="flex gap-1">
            {filters.map((f) => (
              <button
                key={f.value}
                onClick={() => setStatusFilter(f.value)}
                className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
                  statusFilter === f.value
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-lg border bg-muted/30" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground shadow-sm">
          No rejections or denials found.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border shadow-sm">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/30">
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                  Timestamp
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                  Tool
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                  Status
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                  Error
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                  Session
                </th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((entry) => (
                <tr key={entry.id} className="border-b last:border-b-0 hover:bg-muted/20">
                  <td className="whitespace-nowrap px-4 py-2.5 text-xs text-muted-foreground">
                    {formatRelativeTime(new Date(entry.timestamp))}
                  </td>
                  <td className="px-4 py-2.5 text-xs font-medium">
                    {formatToolName(entry.tool)}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${
                        statusBadge[entry.status]
                      }`}
                    >
                      {entry.status === 'failed' ? (
                        <XCircle className="h-3 w-3" />
                      ) : (
                        <AlertTriangle className="h-3 w-3" />
                      )}
                      {entry.status}
                    </span>
                  </td>
                  <td className="max-w-xs truncate px-4 py-2.5 text-xs text-muted-foreground">
                    {entry.errorMessage ?? '—'}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">
                    {entry.sessionId ? entry.sessionId.slice(0, 8) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
