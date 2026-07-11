import { useState, useCallback, useEffect, useMemo } from 'react';
import {
  Search,
  RefreshCw,
  X,
  ChevronUp,
  ChevronDown,
  AlertTriangle,
  Cpu,
  HardDrive,
  Activity,
  Loader2,
  ChevronRight
} from 'lucide-react';
import { cn, widthPercentClass } from '@/lib/utils';
import { formatNumber, formatPercent } from '@/lib/i18n/format';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';

export type ProcessStatus = 'running' | 'sleeping' | 'stopped' | 'zombie' | 'idle';

export type Process = {
  pid: number;
  name: string;
  user: string;
  cpuPercent: number;
  memoryMb: number;
  status: ProcessStatus;
  commandLine: string;
  startTime?: string;
  threads?: number;
  parentPid?: number;
  priority?: number;
};

export type ProcessManagerProps = {
  deviceId: string;
  deviceName?: string;
  processes?: Process[];
  loading?: boolean;
  onRefresh?: () => void;
  onKillProcess?: (pid: number) => Promise<void>;
  onGetProcess?: (pid: number) => Promise<Process>;
};

type SortField = 'pid' | 'name' | 'user' | 'cpuPercent' | 'memoryMb' | 'status';
type SortOrder = 'asc' | 'desc';

const statusColors: Record<ProcessStatus, string> = {
  running: 'bg-success/15 text-success border-success/30',
  sleeping: 'bg-warning/15 text-warning border-warning/30',
  stopped: 'bg-muted text-muted-foreground border-border',
  zombie: 'bg-destructive/15 text-destructive border-destructive/30',
  idle: 'bg-blue-500/20 text-blue-700 border-blue-500/40'
};

const statusLabelKeys: Record<ProcessStatus, string> = {
  running: 'processManager.status.running',
  sleeping: 'processManager.status.sleeping',
  stopped: 'processManager.status.stopped',
  zombie: 'processManager.status.zombie',
  idle: 'processManager.status.idle'
};

function formatMemory(mb: number): string {
  if (mb < 1) return formatNumber(mb * 1024, { maximumFractionDigits: 0 }) + ' KB';
  if (mb < 1024) return formatNumber(mb, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' MB';
  return formatNumber(mb / 1024, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' GB';
}

function formatStartTime(dateString?: string): string {
  if (!dateString) return '-';
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

export default function ProcessManager({
  deviceId,
  deviceName = 'Device',
  processes: externalProcesses,
  loading: externalLoading,
  onRefresh,
  onKillProcess,
  onGetProcess
}: ProcessManagerProps) {
  const { t } = useTranslation('remote');
  const [internalProcesses, setInternalProcesses] = useState<Process[]>([]);
  const [internalLoading, setInternalLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [sortField, setSortField] = useState<SortField>('cpuPercent');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [selectedPid, setSelectedPid] = useState<number | null>(null);
  const [expandedPid, setExpandedPid] = useState<number | null>(null);
  const [processDetails, setProcessDetails] = useState<Record<number, Process>>({});
  const [detailLoading, setDetailLoading] = useState<number | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [showKillModal, setShowKillModal] = useState(false);
  const [killingPid, setKillingPid] = useState<number | null>(null);
  const [killError, setKillError] = useState<string | null>(null);

  // Use external data if provided, otherwise use internal state
  const processes = externalProcesses ?? internalProcesses;
  const loading = externalLoading ?? internalLoading;

  // Filter and sort processes
  const filteredProcesses = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    const filtered = processes.filter(proc => {
      if (normalizedQuery.length === 0) return true;
      return (
        proc.name.toLowerCase().includes(normalizedQuery) ||
        proc.pid.toString().includes(normalizedQuery) ||
        proc.user.toLowerCase().includes(normalizedQuery) ||
        proc.commandLine.toLowerCase().includes(normalizedQuery)
      );
    });

    return filtered.sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'pid':
          comparison = a.pid - b.pid;
          break;
        case 'name':
          comparison = a.name.localeCompare(b.name);
          break;
        case 'user':
          comparison = a.user.localeCompare(b.user);
          break;
        case 'cpuPercent':
          comparison = a.cpuPercent - b.cpuPercent;
          break;
        case 'memoryMb':
          comparison = a.memoryMb - b.memoryMb;
          break;
        case 'status':
          comparison = a.status.localeCompare(b.status);
          break;
      }
      return sortOrder === 'asc' ? comparison : -comparison;
    });
  }, [processes, query, sortField, sortOrder]);

  // Calculate resource summary
  const resourceSummary = useMemo(() => {
    const totalCpu = processes.reduce((sum, p) => sum + p.cpuPercent, 0);
    const totalMemory = processes.reduce((sum, p) => sum + p.memoryMb, 0);
    return {
      totalProcesses: processes.length,
      totalCpu: formatNumber(Math.min(totalCpu, 100), { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
      totalMemory: formatMemory(totalMemory)
    };
  }, [processes]);

  // Handle sort toggle
  const handleSort = useCallback((field: SortField) => {
    if (sortField === field) {
      setSortOrder(prev => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortOrder('desc');
    }
  }, [sortField]);

  // Handle refresh
  const handleRefresh = useCallback(async () => {
    if (onRefresh) {
      onRefresh();
    }
    // No-op when onRefresh is not provided; process data comes from external props
  }, [onRefresh]);

  // Handle kill process
  const handleKillProcess = useCallback(async (pid: number) => {
    setKillingPid(pid);
    setKillError(null);

    try {
      if (onKillProcess) {
        await onKillProcess(pid);
      } else {
        throw new Error(t('processManager.errors.handlerNotConfigured'));
      }
      setShowKillModal(false);
      setSelectedPid(null);
      setExpandedPid(null);
    } catch (error) {
      setKillError(error instanceof Error ? error.message : t('processManager.errors.killFailed'));
    } finally {
      setKillingPid(null);
    }
  }, [onKillProcess, t]);

  // Auto-refresh effect
  useEffect(() => {
    if (!autoRefresh) return;

    const interval = setInterval(() => {
      handleRefresh();
    }, 5000);

    return () => clearInterval(interval);
  }, [autoRefresh, handleRefresh]);

  // Row click handler — fetches full process details on expand
  const handleRowClick = useCallback((proc: Process) => {
    if (expandedPid === proc.pid) {
      setExpandedPid(null);
    } else {
      setExpandedPid(proc.pid);
      if (onGetProcess && !processDetails[proc.pid]) {
        setDetailLoading(proc.pid);
        onGetProcess(proc.pid)
          .then(detail => setProcessDetails(prev => ({ ...prev, [proc.pid]: detail })))
          .catch((err) => {
            console.error(`Failed to fetch process details for PID ${proc.pid}:`, err);
          })
          .finally(() => setDetailLoading(null));
      }
    }
    setSelectedPid(proc.pid);
  }, [expandedPid, onGetProcess, processDetails]);

  // Sort indicator component
  const SortIndicator = ({ field }: { field: SortField }) => {
    if (sortField !== field) return null;
    return sortOrder === 'asc' ? (
      <ChevronUp className="h-3 w-3 inline ml-1" />
    ) : (
      <ChevronDown className="h-3 w-3 inline ml-1" />
    );
  };

  const processToKill = processes.find(p => p.pid === selectedPid);

  return (
    <div className="rounded-lg border bg-card shadow-xs">
      {/* Header */}
      <div className="border-b bg-muted/40 px-4 py-3">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <Activity className="h-5 w-5 text-muted-foreground" />
            <div>
              <h2 className="text-lg font-semibold">{t('processManager.title')}</h2>
              <p className="text-sm text-muted-foreground">{deviceName}</p>
            </div>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            {/* Search */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                placeholder={t('processManager.searchPlaceholder')}
                value={query}
                onChange={e => setQuery(e.target.value)}
                className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring sm:w-56"
              />
            </div>

            {/* Auto-refresh toggle */}
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={e => setAutoRefresh(e.target.checked)}
                className="h-4 w-4 rounded border-border"
              />
              <span className="whitespace-nowrap">{t('processManager.autoRefresh')}</span>
            </label>

            {/* Refresh button */}
            <button
              type="button"
              onClick={handleRefresh}
              disabled={loading}
              className="flex h-10 items-center gap-2 rounded-md border bg-background px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
              {t('common:actions.refresh')}
            </button>
          </div>
        </div>
      </div>

      {/* Resource Summary */}
      <div className="grid grid-cols-3 gap-4 border-b px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-500/10">
            <Activity className="h-5 w-5 text-blue-500" />
          </div>
          <div>
            <p className="text-sm text-muted-foreground">{t('processManager.processes')}</p>
            <p className="text-lg font-semibold">{resourceSummary.totalProcesses}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-500/10">
            <Cpu className="h-5 w-5 text-green-500" />
          </div>
          <div>
            <p className="text-sm text-muted-foreground">{t('processManager.totalCpu')}</p>
            <p className="text-lg font-semibold">{resourceSummary.totalCpu}%</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-500/10">
            <HardDrive className="h-5 w-5 text-purple-500" />
          </div>
          <div>
            <p className="text-sm text-muted-foreground">{t('processManager.processMemory')}</p>
            <p className="text-lg font-semibold">{resourceSummary.totalMemory}</p>
          </div>
        </div>
      </div>

      {/* Process Table */}
      <div className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="w-8 px-4 py-3" />
                <th
                  className="cursor-pointer px-4 py-3 hover:text-foreground"
                  onClick={() => handleSort('pid')}
                >
                  PID
                  <SortIndicator field="pid" />
                </th>
                <th
                  className="cursor-pointer px-4 py-3 hover:text-foreground"
                  onClick={() => handleSort('name')}
                >
                  {t('processManager.columns.processName')}
                  <SortIndicator field="name" />
                </th>
                <th
                  className="cursor-pointer px-4 py-3 hover:text-foreground"
                  onClick={() => handleSort('user')}
                >
                  {t('common:labels.user')}
                  <SortIndicator field="user" />
                </th>
                <th
                  className="cursor-pointer px-4 py-3 text-right hover:text-foreground"
                  onClick={() => handleSort('cpuPercent')}
                >
                  CPU %
                  <SortIndicator field="cpuPercent" />
                </th>
                <th
                  className="cursor-pointer px-4 py-3 text-right hover:text-foreground"
                  onClick={() => handleSort('memoryMb')}
                >
                  {t('processManager.columns.memory')}
                  <SortIndicator field="memoryMb" />
                </th>
                <th
                  className="cursor-pointer px-4 py-3 hover:text-foreground"
                  onClick={() => handleSort('status')}
                >
                  {t('common:labels.status')}
                  <SortIndicator field="status" />
                </th>
                <th className="px-4 py-3">{t('common:labels.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {loading && filteredProcesses.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center">
                    <Loader2 className="mx-auto h-6 w-6 animate-spin text-muted-foreground" />
                  </td>
                </tr>
              ) : processes.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    {t('processManager.noData')}
                  </td>
                </tr>
              ) : filteredProcesses.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    {t('processManager.noMatches')}
                  </td>
                </tr>
              ) : (
                filteredProcesses.map(proc => (
                  <>
                    <tr
                      key={proc.pid}
                      onClick={() => handleRowClick(proc)}
                      className={cn(
                        'cursor-pointer transition hover:bg-muted/40',
                        selectedPid === proc.pid && 'bg-primary/5',
                        expandedPid === proc.pid && 'bg-muted/20'
                      )}
                    >
                      <td className="px-4 py-3">
                        <ChevronRight
                          className={cn(
                            'h-4 w-4 text-muted-foreground transition-transform',
                            expandedPid === proc.pid && 'rotate-90'
                          )}
                        />
                      </td>
                      <td className="px-4 py-3 text-sm font-mono">{proc.pid}</td>
                      <td className="px-4 py-3 text-sm font-medium">{proc.name}</td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">{proc.user}</td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <div className="h-2 w-12 overflow-hidden rounded-full bg-muted">
                            <div
                              className={cn(
                                'h-full rounded-full transition-all',
                                proc.cpuPercent > 80
                                  ? 'bg-red-500'
                                  : proc.cpuPercent > 50
                                  ? 'bg-yellow-500'
                                  : 'bg-green-500',
                                widthPercentClass(Math.min(proc.cpuPercent, 100))
                              )}
                            />
                          </div>
                          <span className="w-12 text-right text-sm">
                            {formatPercent(proc.cpuPercent / 100, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right text-sm">
                        {formatMemory(proc.memoryMb)}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={cn(
                            'inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium',
                            statusColors[proc.status]
                          )}
                        >
                          {t(statusLabelKeys[proc.status])}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={e => {
                            e.stopPropagation();
                            setSelectedPid(proc.pid);
                            setShowKillModal(true);
                          }}
                          className="flex h-8 w-8 items-center justify-center rounded-md text-red-500 hover:bg-red-500/10"
                          title={t('processManager.killProcess')}
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                    {/* Expanded Details Row */}
                    {expandedPid === proc.pid && (() => {
                      const detail = processDetails[proc.pid];
                      const isLoading = detailLoading === proc.pid;
                      return (
                      <tr key={proc.pid + '-details'} className="bg-muted/10">
                        <td colSpan={8} className="px-4 py-4">
                          {isLoading ? (
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                              <Loader2 className="h-4 w-4 animate-spin" />
                              {t('processManager.loadingDetails')}
                            </div>
                          ) : (
                          <div className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
                            <div>
                              <p className="text-muted-foreground">{t('processManager.details.commandLine')}</p>
                              <p className="mt-1 break-all font-mono text-xs">
                                {detail?.commandLine || proc.commandLine || '-'}
                              </p>
                            </div>
                            <div>
                              <p className="text-muted-foreground">{t('processManager.details.parentPid')}</p>
                              <p className="mt-1 font-mono">{detail?.parentPid ?? proc.parentPid ?? '-'}</p>
                            </div>
                            <div>
                              <p className="text-muted-foreground">{t('processManager.details.threads')}</p>
                              <p className="mt-1">{detail?.threads ?? proc.threads ?? '-'}</p>
                            </div>
                            <div>
                              <p className="text-muted-foreground">{t('processManager.details.priority')}</p>
                              <p className="mt-1">{detail?.priority ?? proc.priority ?? '-'}</p>
                            </div>
                            {(detail?.startTime || proc.startTime) && (
                              <div>
                                <p className="text-muted-foreground">{t('processManager.details.startTime')}</p>
                                <p className="mt-1">{formatStartTime(detail?.startTime || proc.startTime)}</p>
                              </div>
                            )}
                          </div>
                          )}
                        </td>
                      </tr>
                      );
                    })()}
                  </>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Results count */}
      <div className="border-t px-4 py-3">
        <p className="text-sm text-muted-foreground">
          {t('processManager.showing', { shown: filteredProcesses.length, total: processes.length })}
        </p>
      </div>

      {/* Kill Confirmation Modal */}
      {showKillModal && processToKill && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-xl">
            <div className="flex items-center gap-3 text-red-500">
              <AlertTriangle className="h-6 w-6" />
              <h3 className="text-lg font-semibold">{t('processManager.killProcess')}</h3>
            </div>
            <p className="mt-4 text-sm text-muted-foreground">
              {t('processManager.killConfirm')}
            </p>
            <div className="mt-4 rounded-md border bg-muted/40 p-3">
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <span className="text-muted-foreground">{t('processManager.pid')}:</span>{' '}
                  <span className="font-mono">{processToKill.pid}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">{t('common:labels.name')}:</span>{' '}
                  <span className="font-medium">{processToKill.name}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">{t('common:labels.user')}:</span>{' '}
                  <span>{processToKill.user}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">{t('processManager.cpu')}:</span>{' '}
                  <span>{formatPercent(processToKill.cpuPercent / 100, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</span>
                </div>
              </div>
            </div>
            {killError && (
              <div className="mt-4 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-600">
                {killError}
              </div>
            )}
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => {
                  setShowKillModal(false);
                  setKillError(null);
                }}
                disabled={killingPid !== null}
                className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
              >
                {t('common:actions.cancel')}
              </button>
              <button
                type="button"
                onClick={() => handleKillProcess(processToKill.pid)}
                disabled={killingPid !== null}
                className="flex items-center gap-2 rounded-md bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50"
              >
                {killingPid !== null ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t('processManager.killing')}
                  </>
                ) : (
                  <>
                    <X className="h-4 w-4" />
                    {t('processManager.killProcess')}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
