import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Search,
  Calendar,
  Clock,
  Users,
  Play,
  Pencil,
  Trash2,
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  Loader2,
  CheckCircle,
  XCircle,
  Plus
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Report } from './ReportsList';

const getBrowserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

type ScheduleFrequency = 'daily' | 'weekly' | 'monthly';

type ReportSchedule = {
  id: string;
  reportId: string;
  reportName?: string;
  frequency: ScheduleFrequency;
  time: string;
  timezone?: string;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  lastRunStatus?: 'pending' | 'running' | 'completed' | 'failed';
  enabled: boolean;
  recipients: string[];
  createdAt: string;
  updatedAt: string;
};

type ReportScheduleRun = {
  id: string;
  scheduleId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startedAt?: string | null;
  completedAt?: string | null;
  outputUrl?: string | null;
  errorMessage?: string | null;
};

type ScheduleFormState = {
  reportId: string;
  frequency: ScheduleFrequency;
  time: string;
  recipients: string[];
};

const frequencyOptions: { value: ScheduleFrequency; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' }
];

const runStatusConfig: Record<
  ReportScheduleRun['status'],
  { label: string; color: string; icon: typeof CheckCircle }
> = {
  pending: { label: 'Pending', color: 'text-muted-foreground', icon: Clock },
  running: { label: 'Running', color: 'text-primary', icon: Loader2 },
  completed: { label: 'Completed', color: 'text-green-600', icon: CheckCircle },
  failed: { label: 'Failed', color: 'text-destructive', icon: XCircle }
};

function formatRelative(dateString?: string | null, timezone?: string): string {
  if (!dateString) return 'Never';
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString([], { timeZone: timezone });
}

function formatDateTime(dateString?: string | null, timezone?: string): string {
  if (!dateString) return '-';
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  return date.toLocaleString([], { timeZone: timezone });
}

function formatTime(time: string, timezone?: string): string {
  if (!time) return '';
  const [rawHour, rawMinute] = time.split(':');
  const hour = Number.parseInt(rawHour ?? '0', 10);
  const minute = Number.parseInt(rawMinute ?? '0', 10);
  if (Number.isNaN(hour) || Number.isNaN(minute)) return time;
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: timezone });
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

type RecipientManagerProps = {
  recipients: string[];
  onChange: (recipients: string[]) => void;
  label?: string;
};

function RecipientManager({ recipients, onChange, label = 'Recipients' }: RecipientManagerProps) {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleAdd = () => {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) return;
    if (!isValidEmail(trimmed)) {
      setError('Enter a valid email address.');
      return;
    }
    if (recipients.includes(trimmed)) {
      setError('Recipient already added.');
      return;
    }
    onChange([...recipients, trimmed]);
    setEmail('');
    setError(null);
  };

  const handleRemove = (target: string) => {
    onChange(recipients.filter(recipient => recipient !== target));
  };

  return (
    <div className="space-y-2">
      <label className="text-sm font-medium">{label}</label>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="flex-1">
          <input
            type="email"
            placeholder="name@company.com"
            value={email}
            onChange={event => {
              setEmail(event.target.value);
              if (error) setError(null);
            }}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
        </div>
        <button
          type="button"
          onClick={handleAdd}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md border bg-background px-4 text-sm font-medium hover:bg-muted"
        >
          <Plus className="h-4 w-4" />
          Add
        </button>
      </div>
      {recipients.length === 0 ? (
        <p className="text-xs text-muted-foreground">No recipients added yet.</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {recipients.map(recipient => (
            <span
              key={recipient}
              className="inline-flex items-center gap-2 rounded-full border bg-muted px-3 py-1 text-xs"
            >
              {recipient}
              <button
                type="button"
                onClick={() => handleRemove(recipient)}
                className="text-muted-foreground hover:text-foreground"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

type RunHistoryModalProps = {
  schedule: ReportSchedule;
  runs: ReportScheduleRun[];
  loading: boolean;
  onClose: () => void;
  reportName?: string;
  timezone?: string;
};

function RunHistoryModal({ schedule, runs, loading, onClose, reportName, timezone }: RunHistoryModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div className="w-full max-w-3xl rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Run History</h2>
            <p className="text-sm text-muted-foreground">
              {reportName ?? schedule.reportName ?? 'Scheduled report'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
          >
            Close
          </button>
        </div>

        <div className="mt-4 overflow-hidden rounded-md border">
          <table className="min-w-full divide-y">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">Started</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Completed</th>
                <th className="px-4 py-3 text-right">Output</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {loading ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    <Loader2 className="mx-auto h-5 w-5 animate-spin" />
                    <p className="mt-2">Loading run history...</p>
                  </td>
                </tr>
              ) : runs.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    No runs yet for this schedule.
                  </td>
                </tr>
              ) : (
                runs.map(run => {
                  const StatusIcon = runStatusConfig[run.status].icon;
                  return (
                    <tr key={run.id} className="hover:bg-muted/40">
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {formatDateTime(run.startedAt, timezone)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <StatusIcon
                            className={cn(
                              'h-4 w-4',
                              runStatusConfig[run.status].color,
                              run.status === 'running' && 'animate-spin'
                            )}
                          />
                          <span className={cn('text-sm', runStatusConfig[run.status].color)}>
                            {runStatusConfig[run.status].label}
                          </span>
                        </div>
                        {run.errorMessage && (
                          <p className="mt-1 text-xs text-destructive">{run.errorMessage}</p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {formatDateTime(run.completedAt, timezone)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {run.status === 'completed' && run.outputUrl ? (
                          <a
                            href={run.outputUrl}
                            className="inline-flex h-8 items-center gap-1 rounded-md border px-3 text-sm hover:bg-muted"
                          >
                            Download
                          </a>
                        ) : (
                          <span className="text-xs text-muted-foreground">-</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

type ScheduledReportsProps = {
  timezone?: string;
};

export default function ScheduledReports({ timezone }: ScheduledReportsProps = {}) {
  const effectiveTimezone = timezone || getBrowserTimezone();
  const [schedules, setSchedules] = useState<ReportSchedule[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [createError, setCreateError] = useState<string>();
  const [editError, setEditError] = useState<string>();
  const [query, setQuery] = useState('');
  const [frequencyFilter, setFrequencyFilter] = useState<ScheduleFrequency | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'enabled' | 'paused'>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set());
  const [editSchedule, setEditSchedule] = useState<ReportSchedule | null>(null);
  const [editForm, setEditForm] = useState<ScheduleFormState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ReportSchedule | null>(null);
  const [historyTarget, setHistoryTarget] = useState<ReportSchedule | null>(null);
  const [historyRuns, setHistoryRuns] = useState<ReportScheduleRun[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const [createForm, setCreateForm] = useState<ScheduleFormState>({
    reportId: '',
    frequency: 'daily',
    time: '09:00',
    recipients: []
  });

  const fetchSchedules = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetch('/api/reports/schedules');
      if (!response.ok) {
        throw new Error('Failed to fetch schedules');
      }
      const data = await response.json();
      setSchedules(data.data ?? data.schedules ?? data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchReports = useCallback(async () => {
    try {
      const response = await fetch('/api/reports');
      if (!response.ok) {
        return;
      }
      const data = await response.json();
      setReports(data.data ?? data.reports ?? data ?? []);
    } catch {
      // ignore report list failures
    }
  }, []);

  useEffect(() => {
    fetchSchedules();
    fetchReports();
  }, [fetchSchedules, fetchReports]);

  useEffect(() => {
    if (!createForm.reportId && reports.length > 0) {
      setCreateForm(prev => ({ ...prev, reportId: reports[0]?.id ?? '' }));
    }
  }, [createForm.reportId, reports]);

  const reportLookup = useMemo(() => {
    return new Map(reports.map(report => [report.id, report]));
  }, [reports]);

  const filteredSchedules = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return schedules.filter(schedule => {
      const reportName =
        schedule.reportName ?? reportLookup.get(schedule.reportId)?.name ?? 'Unknown Report';
      const matchesQuery =
        normalizedQuery.length === 0 ? true : reportName.toLowerCase().includes(normalizedQuery);
      const matchesFrequency =
        frequencyFilter === 'all' ? true : schedule.frequency === frequencyFilter;
      const matchesStatus =
        statusFilter === 'all'
          ? true
          : statusFilter === 'enabled'
            ? schedule.enabled
            : !schedule.enabled;

      return matchesQuery && matchesFrequency && matchesStatus;
    });
  }, [schedules, query, frequencyFilter, statusFilter, reportLookup]);

  const pageSize = 8;
  const totalPages = Math.ceil(filteredSchedules.length / pageSize);
  const startIndex = (currentPage - 1) * pageSize;
  const paginatedSchedules = filteredSchedules.slice(startIndex, startIndex + pageSize);

  const resetCreateForm = () => {
    setCreateForm(prev => ({
      reportId: reports[0]?.id ?? prev.reportId,
      frequency: 'daily',
      time: '09:00',
      recipients: []
    }));
  };

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    setCreateError(undefined);

    if (!createForm.reportId) {
      setCreateError('Select a report to schedule.');
      return;
    }
    if (createForm.recipients.length === 0) {
      setCreateError('Add at least one recipient.');
      return;
    }

    setCreateSubmitting(true);
    try {
      const response = await fetch('/api/reports/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createForm)
      });

      if (!response.ok) {
        throw new Error('Failed to create schedule');
      }

      resetCreateForm();
      setCreateError(undefined);
      await fetchSchedules();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create schedule');
    } finally {
      setCreateSubmitting(false);
    }
  };

  const handleToggle = async (schedule: ReportSchedule, enabled: boolean) => {
    setTogglingIds(prev => new Set([...prev, schedule.id]));
    try {
      const response = await fetch(`/api/reports/schedules/${schedule.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
      });
      if (!response.ok) {
        throw new Error(`Failed to ${enabled ? 'resume' : 'pause'} schedule`);
      }
      setSchedules(prev =>
        prev.map(item => (item.id === schedule.id ? { ...item, enabled } : item))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setTogglingIds(prev => {
        const next = new Set(prev);
        next.delete(schedule.id);
        return next;
      });
    }
  };

  const handleRunNow = async (schedule: ReportSchedule) => {
    setRunningIds(prev => new Set([...prev, schedule.id]));
    try {
      const response = await fetch(`/api/reports/schedules/${schedule.id}/run`, {
        method: 'POST'
      });
      if (!response.ok) {
        throw new Error('Failed to run schedule');
      }
      await fetchSchedules();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setRunningIds(prev => {
        const next = new Set(prev);
        next.delete(schedule.id);
        return next;
      });
    }
  };

  const openEditModal = (schedule: ReportSchedule) => {
    setEditSchedule(schedule);
    setEditForm({
      reportId: schedule.reportId,
      frequency: schedule.frequency,
      time: schedule.time,
      recipients: schedule.recipients ?? []
    });
    setEditError(undefined);
  };

  const handleUpdate = async (event: FormEvent) => {
    event.preventDefault();
    if (!editSchedule || !editForm) return;

    if (!editForm.reportId) {
      setEditError('Select a report to schedule.');
      return;
    }
    if (editForm.recipients.length === 0) {
      setEditError('Add at least one recipient.');
      return;
    }

    setEditSubmitting(true);
    try {
      const response = await fetch(`/api/reports/schedules/${editSchedule.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editForm)
      });
      if (!response.ok) {
        throw new Error('Failed to update schedule');
      }
      await fetchSchedules();
      setEditSchedule(null);
      setEditForm(null);
      setEditError(undefined);
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Failed to update schedule');
    } finally {
      setEditSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleteSubmitting(true);
    try {
      const response = await fetch(`/api/reports/schedules/${deleteTarget.id}`, {
        method: 'DELETE'
      });
      if (!response.ok) {
        throw new Error('Failed to delete schedule');
      }
      await fetchSchedules();
      setDeleteTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete schedule');
    } finally {
      setDeleteSubmitting(false);
    }
  };

  const handleViewHistory = async (schedule: ReportSchedule) => {
    setHistoryTarget(schedule);
    setHistoryRuns([]);
    setHistoryLoading(true);
    try {
      const response = await fetch(`/api/reports/schedules/${schedule.id}/runs`);
      if (response.ok) {
        const data = await response.json();
        setHistoryRuns(data.data ?? data.runs ?? data ?? []);
      }
    } catch {
      // ignore history failures
    } finally {
      setHistoryLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">Loading schedules...</p>
        </div>
      </div>
    );
  }

  if (error && schedules.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchSchedules}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Scheduled Reports</h1>
          <p className="text-muted-foreground">Deliver reports automatically on your preferred cadence.</p>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Create Schedule</h2>
            <p className="text-sm text-muted-foreground">Pick a report, cadence, and recipients.</p>
          </div>
        </div>

        <form onSubmit={handleCreate} className="mt-4 space-y-4">
          <div className="grid gap-4 md:grid-cols-4">
            <div className="md:col-span-2">
              <label className="text-sm font-medium">Report</label>
              <select
                value={createForm.reportId}
                onChange={event =>
                  setCreateForm(prev => ({ ...prev, reportId: event.target.value }))
                }
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {reports.length === 0 && <option value="">No reports available</option>}
                {reports.map(report => (
                  <option key={report.id} value={report.id}>
                    {report.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm font-medium">Frequency</label>
              <select
                value={createForm.frequency}
                onChange={event =>
                  setCreateForm(prev => ({
                    ...prev,
                    frequency: event.target.value as ScheduleFrequency
                  }))
                }
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {frequencyOptions.map(option => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm font-medium">Time</label>
              <input
                type="time"
                value={createForm.time}
                onChange={event => setCreateForm(prev => ({ ...prev, time: event.target.value }))}
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>

          <RecipientManager
            recipients={createForm.recipients}
            onChange={recipients => setCreateForm(prev => ({ ...prev, recipients }))}
          />

          {createError && <p className="text-sm text-destructive">{createError}</p>}

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={createSubmitting || reports.length === 0}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {createSubmitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Creating...
                </>
              ) : (
                'Create Schedule'
              )}
            </button>
          </div>
        </form>
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Schedules</h2>
            <p className="text-sm text-muted-foreground">
              {filteredSchedules.length} of {schedules.length} schedules
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center flex-wrap">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                placeholder="Search schedules..."
                value={query}
                onChange={event => {
                  setQuery(event.target.value);
                  setCurrentPage(1);
                }}
                className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-48"
              />
            </div>
            <select
              value={frequencyFilter}
              onChange={event => {
                setFrequencyFilter(event.target.value as ScheduleFrequency | 'all');
                setCurrentPage(1);
              }}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-36"
            >
              <option value="all">All Frequencies</option>
              {frequencyOptions.map(option => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <select
              value={statusFilter}
              onChange={event => {
                setStatusFilter(event.target.value as 'all' | 'enabled' | 'paused');
                setCurrentPage(1);
              }}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-32"
            >
              <option value="all">All Status</option>
              <option value="enabled">Active</option>
              <option value="paused">Paused</option>
            </select>
          </div>
        </div>

        <div className="mt-6 overflow-hidden rounded-md border">
          <table className="min-w-full divide-y">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">Report</th>
                <th className="px-4 py-3">Frequency</th>
                <th className="px-4 py-3">Next Run</th>
                <th className="px-4 py-3">Recipients</th>
                <th className="px-4 py-3">Last Run</th>
                <th className="px-4 py-3">Enabled</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {paginatedSchedules.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-6 text-center text-sm text-muted-foreground">
                    No schedules found. Try adjusting your search or filters.
                  </td>
                </tr>
              ) : (
                paginatedSchedules.map(schedule => {
                  const reportName =
                    schedule.reportName ??
                    reportLookup.get(schedule.reportId)?.name ??
                    'Unknown Report';

                  return (
                    <tr key={schedule.id} className="transition hover:bg-muted/40">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <Calendar className="h-4 w-4 text-muted-foreground" />
                          <div>
                            <p className="text-sm font-medium">{reportName}</p>
                            <p className="text-xs text-muted-foreground">
                              {reportLookup.get(schedule.reportId)?.type ?? 'Custom report'}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium text-muted-foreground">
                          <Clock className="h-3 w-3" />
                          {frequencyOptions.find(option => option.value === schedule.frequency)?.label ?? schedule.frequency}
                        </span>
                        <p className="mt-1 text-xs text-muted-foreground">at {formatTime(schedule.time, effectiveTimezone)}</p>
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {schedule.nextRunAt ? (
                          <div className="flex items-center gap-1">
                            <Calendar className="h-3 w-3" />
                            {formatDateTime(schedule.nextRunAt, effectiveTimezone)}
                          </div>
                        ) : (
                          <span className="text-muted-foreground/60">Not scheduled</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Users className="h-4 w-4" />
                          {schedule.recipients?.length ?? 0}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        {formatRelative(schedule.lastRunAt, effectiveTimezone)}
                        <button
                          type="button"
                          onClick={() => handleViewHistory(schedule)}
                          className="mt-1 block text-xs text-primary hover:underline"
                        >
                          View history
                        </button>
                      </td>
                      <td className="px-4 py-3">
                        <label className="relative inline-flex cursor-pointer items-center">
                          <input
                            type="checkbox"
                            checked={schedule.enabled}
                            onChange={event => handleToggle(schedule, event.target.checked)}
                            disabled={togglingIds.has(schedule.id)}
                            className="peer sr-only"
                          />
                          <div className="h-6 w-11 rounded-full bg-muted peer-checked:bg-primary peer-focus:ring-2 peer-focus:ring-ring after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-all peer-checked:after:translate-x-full peer-disabled:opacity-60" />
                        </label>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => handleRunNow(schedule)}
                            disabled={!schedule.enabled || runningIds.has(schedule.id)}
                            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
                            title="Run now"
                          >
                            {runningIds.has(schedule.id) ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <Play className="h-4 w-4" />
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => openEditModal(schedule)}
                            className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
                            title="Edit"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          <div className="relative">
                            <button
                              type="button"
                              onClick={() =>
                                setMenuOpenId(menuOpenId === schedule.id ? null : schedule.id)
                              }
                              className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
                            >
                              <MoreHorizontal className="h-4 w-4" />
                            </button>
                            {menuOpenId === schedule.id && (
                              <div className="absolute right-0 top-full z-10 mt-1 w-40 rounded-md border bg-card shadow-lg">
                                <button
                                  type="button"
                                  onClick={() => {
                                    handleViewHistory(schedule);
                                    setMenuOpenId(null);
                                  }}
                                  className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted"
                                >
                                  <Clock className="h-4 w-4" />
                                  Run History
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setDeleteTarget(schedule);
                                    setMenuOpenId(null);
                                  }}
                                  className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-destructive hover:bg-muted"
                                >
                                  <Trash2 className="h-4 w-4" />
                                  Delete
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div className="mt-4 flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              Showing {startIndex + 1} to {Math.min(startIndex + pageSize, filteredSchedules.length)} of{' '}
              {filteredSchedules.length}
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setCurrentPage(page => Math.max(1, page - 1))}
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
                onClick={() => setCurrentPage(page => Math.min(totalPages, page + 1))}
                disabled={currentPage === totalPages}
                className="flex h-9 w-9 items-center justify-center rounded-md border hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      {editSchedule && editForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-2xl rounded-lg border bg-card p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">Edit Schedule</h2>
                <p className="text-sm text-muted-foreground">{editSchedule.reportName ?? 'Scheduled report'}</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setEditSchedule(null);
                  setEditForm(null);
                  setEditError(undefined);
                }}
                className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
              >
                Close
              </button>
            </div>

            <form onSubmit={handleUpdate} className="mt-4 space-y-4">
              <div className="grid gap-4 md:grid-cols-4">
                <div className="md:col-span-2">
                  <label className="text-sm font-medium">Report</label>
                  <select
                    value={editForm.reportId}
                    onChange={event =>
                      setEditForm(prev => (prev ? { ...prev, reportId: event.target.value } : prev))
                    }
                    className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    {reports.length === 0 && <option value="">No reports available</option>}
                    {reports.map(report => (
                      <option key={report.id} value={report.id}>
                        {report.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-sm font-medium">Frequency</label>
                  <select
                    value={editForm.frequency}
                    onChange={event =>
                      setEditForm(prev =>
                        prev
                          ? { ...prev, frequency: event.target.value as ScheduleFrequency }
                          : prev
                      )
                    }
                    className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    {frequencyOptions.map(option => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-sm font-medium">Time</label>
                  <input
                    type="time"
                    value={editForm.time}
                    onChange={event =>
                      setEditForm(prev => (prev ? { ...prev, time: event.target.value } : prev))
                    }
                    className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              </div>

              <RecipientManager
                recipients={editForm.recipients}
                onChange={recipients =>
                  setEditForm(prev => (prev ? { ...prev, recipients } : prev))
                }
                label="Recipients"
              />

              {editError && <p className="text-sm text-destructive">{editError}</p>}

              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setEditSchedule(null);
                    setEditForm(null);
                    setEditError(undefined);
                  }}
                  className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={editSubmitting}
                  className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {editSubmitting ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Delete Schedule</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Are you sure you want to delete{' '}
              <span className="font-medium">
                {deleteTarget.reportName ??
                  reportLookup.get(deleteTarget.reportId)?.name ??
                  'this schedule'}
              </span>
              ? This action cannot be undone.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleteSubmitting}
                className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {deleteSubmitting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {historyTarget && (
        <RunHistoryModal
          schedule={historyTarget}
          runs={historyRuns}
          loading={historyLoading}
          onClose={() => setHistoryTarget(null)}
          reportName={reportLookup.get(historyTarget.reportId)?.name}
          timezone={effectiveTimezone}
        />
      )}
    </div>
  );
}
