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
import { cn } from '@/lib/utils';

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
};

type SortField = 'pid' | 'name' | 'user' | 'cpuPercent' | 'memoryMb' | 'status';
type SortOrder = 'asc' | 'desc';

const statusColors: Record<ProcessStatus, string> = {
  running: 'bg-green-500/20 text-green-700 border-green-500/40',
  sleeping: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40',
  stopped: 'bg-gray-500/20 text-gray-700 border-gray-500/40',
  zombie: 'bg-red-500/20 text-red-700 border-red-500/40',
  idle: 'bg-blue-500/20 text-blue-700 border-blue-500/40'
};

const statusLabels: Record<ProcessStatus, string> = {
  running: 'Running',
  sleeping: 'Sleeping',
  stopped: 'Stopped',
  zombie: 'Zombie',
  idle: 'Idle'
};

// Mock data for development/demo
const mockProcesses: Process[] = [
  { pid: 1, name: 'systemd', user: 'root', cpuPercent: 0.1, memoryMb: 12.5, status: 'running', commandLine: '/sbin/init', threads: 1, parentPid: 0, priority: 20 },
  { pid: 245, name: 'sshd', user: 'root', cpuPercent: 0.0, memoryMb: 8.2, status: 'sleeping', commandLine: '/usr/sbin/sshd -D', threads: 1, parentPid: 1, priority: 20 },
  { pid: 892, name: 'nginx', user: 'www-data', cpuPercent: 2.5, memoryMb: 45.8, status: 'running', commandLine: 'nginx: master process /usr/sbin/nginx', threads: 4, parentPid: 1, priority: 20 },
  { pid: 1024, name: 'node', user: 'app', cpuPercent: 15.3, memoryMb: 256.4, status: 'running', commandLine: 'node /app/server.js --port 3000', threads: 12, parentPid: 1, priority: 20 },
  { pid: 1156, name: 'postgres', user: 'postgres', cpuPercent: 8.2, memoryMb: 128.0, status: 'running', commandLine: '/usr/lib/postgresql/14/bin/postgres -D /var/lib/postgresql/14/main', threads: 8, parentPid: 1, priority: 20 },
  { pid: 1398, name: 'redis-server', user: 'redis', cpuPercent: 1.5, memoryMb: 32.6, status: 'running', commandLine: '/usr/bin/redis-server 127.0.0.1:6379', threads: 4, parentPid: 1, priority: 20 },
  { pid: 2001, name: 'cron', user: 'root', cpuPercent: 0.0, memoryMb: 4.1, status: 'sleeping', commandLine: '/usr/sbin/cron -f', threads: 1, parentPid: 1, priority: 20 },
  { pid: 2456, name: 'python3', user: 'app', cpuPercent: 45.8, memoryMb: 512.0, status: 'running', commandLine: 'python3 /app/worker.py --workers 4', threads: 5, parentPid: 1, priority: 20 },
  { pid: 3012, name: 'defunct_proc', user: 'nobody', cpuPercent: 0.0, memoryMb: 0.0, status: 'zombie', commandLine: '[defunct]', threads: 0, parentPid: 2456, priority: 20 },
  { pid: 3245, name: 'java', user: 'app', cpuPercent: 22.4, memoryMb: 1024.0, status: 'running', commandLine: 'java -Xmx2g -jar /app/service.jar', threads: 45, parentPid: 1, priority: 20 },
  { pid: 4001, name: 'rsyslogd', user: 'syslog', cpuPercent: 0.1, memoryMb: 6.8, status: 'sleeping', commandLine: '/usr/sbin/rsyslogd -n', threads: 4, parentPid: 1, priority: 20 },
  { pid: 4512, name: 'dockerd', user: 'root', cpuPercent: 3.2, memoryMb: 89.5, status: 'running', commandLine: '/usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock', threads: 18, parentPid: 1, priority: 20 },
  { pid: 5123, name: 'containerd', user: 'root', cpuPercent: 1.8, memoryMb: 56.2, status: 'running', commandLine: '/usr/bin/containerd', threads: 12, parentPid: 1, priority: 20 },
  { pid: 6001, name: 'sleep', user: 'app', cpuPercent: 0.0, memoryMb: 1.2, status: 'stopped', commandLine: 'sleep 3600', threads: 1, parentPid: 2456, priority: 20 },
  { pid: 7890, name: 'top', user: 'admin', cpuPercent: 0.5, memoryMb: 3.4, status: 'running', commandLine: 'top -b -n 1', threads: 1, parentPid: 245, priority: 20 }
];

function formatMemory(mb: number): string {
  if (mb < 1) return (mb * 1024).toFixed(0) + ' KB';
  if (mb < 1024) return mb.toFixed(1) + ' MB';
  return (mb / 1024).toFixed(2) + ' GB';
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
  onKillProcess
}: ProcessManagerProps) {
  const [internalProcesses, setInternalProcesses] = useState<Process[]>(mockProcesses);
  const [internalLoading, setInternalLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [sortField, setSortField] = useState<SortField>('cpuPercent');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
  const [selectedPid, setSelectedPid] = useState<number | null>(null);
  const [expandedPid, setExpandedPid] = useState<number | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [showKillModal, setShowKillModal] = useState(false);
  const [killingPid, setKillingPid] = useState<number | null>(null);
  const [killError, setKillError] = useState<string | null>(null);

  // Use external data if provided, otherwise use internal mock data
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
      totalCpu: Math.min(totalCpu, 100).toFixed(1),
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
    } else {
      // Simulate API call for demo
      setInternalLoading(true);
      await new Promise(resolve => setTimeout(resolve, 800));
      // Randomize CPU/Memory slightly for demo
      setInternalProcesses(prev =>
        prev.map(p => ({
          ...p,
          cpuPercent: Math.max(0, p.cpuPercent + (Math.random() - 0.5) * 5),
          memoryMb: Math.max(0, p.memoryMb + (Math.random() - 0.5) * 10)
        }))
      );
      setInternalLoading(false);
    }
  }, [onRefresh]);

  // Handle kill process
  const handleKillProcess = useCallback(async (pid: number) => {
    setKillingPid(pid);
    setKillError(null);

    try {
      if (onKillProcess) {
        await onKillProcess(pid);
      } else {
        // Simulate API call for demo
        await new Promise(resolve => setTimeout(resolve, 1000));
        setInternalProcesses(prev => prev.filter(p => p.pid !== pid));
      }
      setShowKillModal(false);
      setSelectedPid(null);
      setExpandedPid(null);
    } catch (error) {
      setKillError(error instanceof Error ? error.message : 'Failed to kill process');
    } finally {
      setKillingPid(null);
    }
  }, [onKillProcess]);

  // Auto-refresh effect
  useEffect(() => {
    if (!autoRefresh) return;

    const interval = setInterval(() => {
      handleRefresh();
    }, 5000);

    return () => clearInterval(interval);
  }, [autoRefresh, handleRefresh]);

  // Row click handler
  const handleRowClick = useCallback((proc: Process) => {
    if (expandedPid === proc.pid) {
      setExpandedPid(null);
    } else {
      setExpandedPid(proc.pid);
    }
    setSelectedPid(proc.pid);
  }, [expandedPid]);

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
    <div className="rounded-lg border bg-card shadow-sm">
      {/* Header */}
      <div className="border-b bg-muted/40 px-4 py-3">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <Activity className="h-5 w-5 text-muted-foreground" />
            <div>
              <h2 className="text-lg font-semibold">Process Manager</h2>
              <p className="text-sm text-muted-foreground">{deviceName}</p>
            </div>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            {/* Search */}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                placeholder="Search by name or PID..."
                value={query}
                onChange={e => setQuery(e.target.value)}
                className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-56"
              />
            </div>

            {/* Auto-refresh toggle */}
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={e => setAutoRefresh(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300"
              />
              <span className="whitespace-nowrap">Auto-refresh</span>
            </label>

            {/* Refresh button */}
            <button
              type="button"
              onClick={handleRefresh}
              disabled={loading}
              className="flex h-10 items-center gap-2 rounded-md border bg-background px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
              Refresh
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
            <p className="text-sm text-muted-foreground">Processes</p>
            <p className="text-lg font-semibold">{resourceSummary.totalProcesses}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-500/10">
            <Cpu className="h-5 w-5 text-green-500" />
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Total CPU</p>
            <p className="text-lg font-semibold">{resourceSummary.totalCpu}%</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-purple-500/10">
            <HardDrive className="h-5 w-5 text-purple-500" />
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Total Memory</p>
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
                  Process Name
                  <SortIndicator field="name" />
                </th>
                <th
                  className="cursor-pointer px-4 py-3 hover:text-foreground"
                  onClick={() => handleSort('user')}
                >
                  User
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
                  Memory
                  <SortIndicator field="memoryMb" />
                </th>
                <th
                  className="cursor-pointer px-4 py-3 hover:text-foreground"
                  onClick={() => handleSort('status')}
                >
                  Status
                  <SortIndicator field="status" />
                </th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {loading && filteredProcesses.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center">
                    <Loader2 className="mx-auto h-6 w-6 animate-spin text-muted-foreground" />
                  </td>
                </tr>
              ) : filteredProcesses.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    No processes found. Try adjusting your search.
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
                                  : 'bg-green-500'
                              )}
                              style={{ width: Math.min(proc.cpuPercent, 100) + '%' }}
                            />
                          </div>
                          <span className="w-12 text-right text-sm">
                            {proc.cpuPercent.toFixed(1)}%
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
                          {statusLabels[proc.status]}
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
                          title="Kill Process"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                    {/* Expanded Details Row */}
                    {expandedPid === proc.pid && (
                      <tr key={proc.pid + '-details'} className="bg-muted/10">
                        <td colSpan={8} className="px-4 py-4">
                          <div className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
                            <div>
                              <p className="text-muted-foreground">Command Line</p>
                              <p className="mt-1 break-all font-mono text-xs">
                                {proc.commandLine}
                              </p>
                            </div>
                            <div>
                              <p className="text-muted-foreground">Parent PID</p>
                              <p className="mt-1 font-mono">{proc.parentPid ?? '-'}</p>
                            </div>
                            <div>
                              <p className="text-muted-foreground">Threads</p>
                              <p className="mt-1">{proc.threads ?? '-'}</p>
                            </div>
                            <div>
                              <p className="text-muted-foreground">Priority</p>
                              <p className="mt-1">{proc.priority ?? '-'}</p>
                            </div>
                            {proc.startTime && (
                              <div>
                                <p className="text-muted-foreground">Start Time</p>
                                <p className="mt-1">{formatStartTime(proc.startTime)}</p>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
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
          Showing {filteredProcesses.length} of {processes.length} processes
        </p>
      </div>

      {/* Kill Confirmation Modal */}
      {showKillModal && processToKill && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-xl">
            <div className="flex items-center gap-3 text-red-500">
              <AlertTriangle className="h-6 w-6" />
              <h3 className="text-lg font-semibold">Kill Process</h3>
            </div>
            <p className="mt-4 text-sm text-muted-foreground">
              Are you sure you want to kill this process? This action cannot be undone.
            </p>
            <div className="mt-4 rounded-md border bg-muted/40 p-3">
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <span className="text-muted-foreground">PID:</span>{' '}
                  <span className="font-mono">{processToKill.pid}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">Name:</span>{' '}
                  <span className="font-medium">{processToKill.name}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">User:</span>{' '}
                  <span>{processToKill.user}</span>
                </div>
                <div>
                  <span className="text-muted-foreground">CPU:</span>{' '}
                  <span>{processToKill.cpuPercent.toFixed(1)}%</span>
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
                Cancel
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
                    Killing...
                  </>
                ) : (
                  <>
                    <X className="h-4 w-4" />
                    Kill Process
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
