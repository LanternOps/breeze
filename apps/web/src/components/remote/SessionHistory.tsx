import { useMemo, useState, useEffect, useCallback } from 'react';
import {
  Search,
  ChevronLeft,
  ChevronRight,
  Eye,
  Terminal,
  Monitor,
  FolderSync,
  Clock,
  User,
  Calendar,
  Filter,
  Download,
  Loader2
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '@/stores/auth';

const DATE_LOCALE = 'en-US';
const DATE_TIME_ZONE = 'UTC';
const FALLBACK_LABEL = '-';

export type SessionType = 'terminal' | 'desktop' | 'file_transfer';
export type SessionStatus = 'pending' | 'connecting' | 'active' | 'disconnected' | 'failed';

export type RemoteSession = {
  id: string;
  deviceId: string;
  deviceHostname: string;
  deviceOsType: string;
  userId: string;
  userName: string;
  userEmail: string;
  type: SessionType;
  status: SessionStatus;
  startedAt?: string;
  endedAt?: string;
  durationSeconds?: number;
  bytesTransferred?: number;
  recordingUrl?: string;
  createdAt: string;
};

export type RemoteSessionApi = Omit<
  RemoteSession,
  'deviceHostname' | 'deviceOsType' | 'userName' | 'userEmail' | 'bytesTransferred'
> & {
  deviceHostname?: string;
  deviceOsType?: string;
  userName?: string;
  userEmail?: string;
  bytesTransferred?: number | null;
  device?: { hostname?: string; osType?: string };
  user?: { name?: string; email?: string };
};

export type SessionHistoryProps = {
  sessions?: RemoteSession[];
  loading?: boolean;
  onViewDetails?: (session: RemoteSession) => void;
  onExport?: () => void;
  pageSize?: number;
  limit?: number;
  className?: string;
};

const sessionTypeConfig: Record<SessionType, { label: string; icon: typeof Terminal; color: string }> = {
  terminal: { label: 'Terminal', icon: Terminal, color: 'text-green-600 bg-green-500/10' },
  desktop: { label: 'Desktop', icon: Monitor, color: 'text-blue-600 bg-blue-500/10' },
  file_transfer: { label: 'File Transfer', icon: FolderSync, color: 'text-purple-600 bg-purple-500/10' }
};

const sessionStatusConfig: Record<SessionStatus, { label: string; color: string }> = {
  pending: { label: 'Pending', color: 'bg-gray-500/20 text-gray-700 border-gray-500/40' },
  connecting: { label: 'Connecting', color: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40' },
  active: { label: 'Active', color: 'bg-green-500/20 text-green-700 border-green-500/40' },
  disconnected: { label: 'Disconnected', color: 'bg-gray-500/20 text-gray-700 border-gray-500/40' },
  failed: { label: 'Failed', color: 'bg-red-500/20 text-red-700 border-red-500/40' }
};

// Format duration
function formatDuration(seconds?: number): string {
  if (seconds === undefined || seconds === null) return '-';
  if (seconds < 1) return '<1s';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

// Format bytes
function formatBytes(bytes?: number): string {
  if (bytes === undefined || bytes === null || bytes === 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// Format date/time
function isSameUtcDate(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear()
    && a.getUTCMonth() === b.getUTCMonth()
    && a.getUTCDate() === b.getUTCDate();
}

function formatDateTime(dateString?: string): string {
  if (!dateString) return '-';
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;

  const now = new Date();
  const isToday = isSameUtcDate(date, now);

  if (isToday) {
    return `Today ${date.toLocaleTimeString(DATE_LOCALE, {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: DATE_TIME_ZONE
    })}`;
  }

  const yesterday = new Date(now);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const isYesterday = isSameUtcDate(date, yesterday);

  if (isYesterday) {
    return `Yesterday ${date.toLocaleTimeString(DATE_LOCALE, {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: DATE_TIME_ZONE
    })}`;
  }

  return date.toLocaleString(DATE_LOCALE, {
    month: 'short',
    day: 'numeric',
    year: date.getUTCFullYear() !== now.getUTCFullYear() ? 'numeric' : undefined,
    hour: '2-digit',
    minute: '2-digit',
    timeZone: DATE_TIME_ZONE
  });
}

export function normalizeRemoteSession(session: RemoteSessionApi): RemoteSession {
  return {
    id: session.id,
    deviceId: session.deviceId,
    deviceHostname: session.deviceHostname ?? session.device?.hostname ?? FALLBACK_LABEL,
    deviceOsType: session.deviceOsType ?? session.device?.osType ?? FALLBACK_LABEL,
    userId: session.userId,
    userName: session.userName ?? session.user?.name ?? FALLBACK_LABEL,
    userEmail: session.userEmail ?? session.user?.email ?? FALLBACK_LABEL,
    type: session.type,
    status: session.status,
    startedAt: session.startedAt ?? undefined,
    endedAt: session.endedAt ?? undefined,
    durationSeconds: session.durationSeconds ?? undefined,
    bytesTransferred: session.bytesTransferred ?? undefined,
    recordingUrl: session.recordingUrl ?? undefined,
    createdAt: session.createdAt
  };
}

export default function SessionHistory({
  sessions: propSessions,
  loading = false,
  onViewDetails,
  onExport,
  pageSize = 10,
  limit,
  className
}: SessionHistoryProps) {
  const [sessions, setSessions] = useState<RemoteSession[]>(propSessions ?? []);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [userFilter, setUserFilter] = useState<string>('all');
  const [dateFilter, setDateFilter] = useState<string>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [isLoading, setIsLoading] = useState(loading || !propSessions);

  // Get unique users for filter
  const uniqueUsers = useMemo(() => {
    const users = new Map<string, { name: string; email: string }>();
    for (const session of sessions) {
      if (!users.has(session.userId)) {
        users.set(session.userId, { name: session.userName, email: session.userEmail });
      }
    }
    return Array.from(users.entries()).map(([id, data]) => ({ id, ...data }));
  }, [sessions]);

  // Filter sessions
  const filteredSessions = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const now = new Date();

    return sessions.filter(session => {
      const matchesQuery = normalizedQuery.length === 0
        ? true
        : session.deviceHostname.toLowerCase().includes(normalizedQuery) ||
          session.userName.toLowerCase().includes(normalizedQuery) ||
          session.userEmail.toLowerCase().includes(normalizedQuery);

      const matchesType = typeFilter === 'all' ? true : session.type === typeFilter;

      const matchesUser = userFilter === 'all' ? true : session.userId === userFilter;

      let matchesDate = true;
      if (dateFilter !== 'all') {
        const sessionDate = new Date(session.createdAt);
        const diffMs = now.getTime() - sessionDate.getTime();
        const diffDays = diffMs / (1000 * 60 * 60 * 24);

        switch (dateFilter) {
          case 'today':
            matchesDate = isSameUtcDate(sessionDate, now);
            break;
          case 'yesterday': {
            const yesterday = new Date(now);
            yesterday.setUTCDate(yesterday.getUTCDate() - 1);
            matchesDate = isSameUtcDate(sessionDate, yesterday);
            break;
          }
          case 'week':
            matchesDate = diffDays <= 7;
            break;
          case 'month':
            matchesDate = diffDays <= 30;
            break;
        }
      }

      return matchesQuery && matchesType && matchesUser && matchesDate;
    });
  }, [sessions, query, typeFilter, userFilter, dateFilter]);

  // Pagination
  const totalPages = Math.ceil(filteredSessions.length / pageSize);
  const startIndex = (currentPage - 1) * pageSize;
  const paginatedSessions = filteredSessions.slice(startIndex, startIndex + pageSize);

  // Stats
  const stats = useMemo(() => {
    const filtered = filteredSessions;
    const totalDuration = filtered.reduce((sum, s) => sum + (s.durationSeconds || 0), 0);
    const avgDuration = filtered.length > 0 ? totalDuration / filtered.length : 0;
    const totalBytes = filtered.reduce((sum, s) => sum + (s.bytesTransferred || 0), 0);
    const byType = {
      terminal: filtered.filter(s => s.type === 'terminal').length,
      desktop: filtered.filter(s => s.type === 'desktop').length,
      file_transfer: filtered.filter(s => s.type === 'file_transfer').length
    };

    return {
      total: filtered.length,
      totalDuration,
      avgDuration: Math.round(avgDuration),
      totalBytes,
      byType
    };
  }, [filteredSessions]);

  // Fetch sessions from API
  const fetchSessions = useCallback(async () => {
    setIsLoading(true);
    try {
      const params = new URLSearchParams();
      if (typeFilter !== 'all') params.set('type', typeFilter);
      if (userFilter !== 'all') params.set('userId', userFilter);
      params.set('limit', String(limit ?? 100));

      const response = await fetchWithAuth(`/remote/sessions/history?${params.toString()}`);

      if (response.ok) {
        const data = await response.json();
        const normalized = (data.data ?? []).map((session: RemoteSessionApi) => normalizeRemoteSession(session));
        setSessions(normalized);
      }
    } catch (error) {
      console.error('Failed to fetch sessions:', error);
    } finally {
      setIsLoading(false);
    }
  }, [typeFilter, userFilter, limit]);

  // Use prop sessions if provided
  useEffect(() => {
    if (propSessions) {
      setSessions(propSessions);
      setIsLoading(loading);
      return;
    }
    void fetchSessions();
  }, [propSessions, loading, fetchSessions]);

  return (
    <div className={cn('rounded-lg border bg-card shadow-sm', className)}>
      {/* Header with stats */}
      <div className="border-b p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Session History</h2>
            <p className="text-sm text-muted-foreground">
              Remote access audit log
            </p>
          </div>
          {onExport && (
            <button
              type="button"
              onClick={onExport}
              className="flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
            >
              <Download className="h-4 w-4" />
              Export
            </button>
          )}
        </div>

        {/* Stats Cards */}
        <div className="mt-4 grid gap-4 sm:grid-cols-4">
          <div className="rounded-lg border bg-muted/30 p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Clock className="h-4 w-4" />
              Total Sessions
            </div>
            <p className="mt-1 text-2xl font-bold">{stats.total}</p>
          </div>
          <div className="rounded-lg border bg-muted/30 p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Clock className="h-4 w-4" />
              Total Duration
            </div>
            <p className="mt-1 text-2xl font-bold">{formatDuration(stats.totalDuration)}</p>
          </div>
          <div className="rounded-lg border bg-muted/30 p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Clock className="h-4 w-4" />
              Avg Duration
            </div>
            <p className="mt-1 text-2xl font-bold">{formatDuration(stats.avgDuration)}</p>
          </div>
          <div className="rounded-lg border bg-muted/30 p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <FolderSync className="h-4 w-4" />
              Data Transferred
            </div>
            <p className="mt-1 text-2xl font-bold">{formatBytes(stats.totalBytes)}</p>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="border-b p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              placeholder="Search by device or user..."
              value={query}
              onChange={event => {
                setQuery(event.target.value);
                setCurrentPage(1);
              }}
              className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <select
            value={typeFilter}
            onChange={event => {
              setTypeFilter(event.target.value);
              setCurrentPage(1);
            }}
            className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="all">All Types</option>
            <option value="terminal">Terminal</option>
            <option value="desktop">Desktop</option>
            <option value="file_transfer">File Transfer</option>
          </select>

          <select
            value={userFilter}
            onChange={event => {
              setUserFilter(event.target.value);
              setCurrentPage(1);
            }}
            className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="all">All Users</option>
            {uniqueUsers.map(user => (
              <option key={user.id} value={user.id}>{user.name}</option>
            ))}
          </select>

          <select
            value={dateFilter}
            onChange={event => {
              setDateFilter(event.target.value);
              setCurrentPage(1);
            }}
            className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="all">All Time</option>
            <option value="today">Today</option>
            <option value="yesterday">Yesterday</option>
            <option value="week">Last 7 Days</option>
            <option value="month">Last 30 Days</option>
          </select>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Device</th>
              <th className="px-4 py-3">User</th>
              <th className="px-4 py-3">Started</th>
              <th className="px-4 py-3">Duration</th>
              <th className="px-4 py-3">Data</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {isLoading ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center">
                  <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
                </td>
              </tr>
            ) : paginatedSessions.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  No sessions found. Try adjusting your filters.
                </td>
              </tr>
            ) : (
              paginatedSessions.map(session => {
                const TypeIcon = sessionTypeConfig[session.type].icon;

                return (
                  <tr
                    key={session.id}
                    className="transition hover:bg-muted/40 cursor-pointer"
                    onClick={() => onViewDetails?.(session)}
                  >
                    <td className="px-4 py-3">
                      <div className={cn(
                        'inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium',
                        sessionTypeConfig[session.type].color
                      )}>
                        <TypeIcon className="h-3 w-3" />
                        {sessionTypeConfig[session.type].label}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div>
                        <p className="text-sm font-medium">{session.deviceHostname}</p>
                        <p className="text-xs text-muted-foreground capitalize">{session.deviceOsType}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div>
                        <p className="text-sm font-medium">{session.userName}</p>
                        <p className="text-xs text-muted-foreground">{session.userEmail}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {formatDateTime(session.startedAt || session.createdAt)}
                    </td>
                    <td className="px-4 py-3 text-sm">
                      {formatDuration(session.durationSeconds)}
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {formatBytes(session.bytesTransferred)}
                    </td>
                    <td className="px-4 py-3">
                      <span className={cn(
                        'inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium',
                        sessionStatusConfig[session.status].color
                      )}>
                        {sessionStatusConfig[session.status].label}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onViewDetails?.(session);
                          }}
                          className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
                          title="View details"
                        >
                          <Eye className="h-4 w-4" />
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

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between border-t px-4 py-3">
          <p className="text-sm text-muted-foreground">
            Showing {startIndex + 1} to {Math.min(startIndex + pageSize, filteredSessions.length)} of {filteredSessions.length}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="flex h-9 w-9 items-center justify-center rounded-md border hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-sm">
              Page {currentPage} of {totalPages}
            </span>
            <button
              type="button"
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              className="flex h-9 w-9 items-center justify-center rounded-md border hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
