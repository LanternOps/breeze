import { useState, useMemo, useCallback } from 'react';
import {
  Search,
  RefreshCw,
  Play,
  Square,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  Loader2,
  Monitor,
  ChevronLeft
} from 'lucide-react';
import { cn } from '@/lib/utils';

export type ServiceStatus = 'Running' | 'Stopped' | 'Paused' | 'Starting' | 'Stopping';
export type StartupType = 'Automatic' | 'Manual' | 'Disabled' | 'Automatic (Delayed)';

export type WindowsService = {
  name: string;
  displayName: string;
  status: ServiceStatus;
  startupType: StartupType;
  account: string;
  description?: string;
  path?: string;
  dependencies?: string[];
  dependentServices?: string[];
};

export type ServicesManagerProps = {
  deviceId: string;
  deviceName?: string;
  deviceOs?: 'windows' | 'macos' | 'linux';
  services?: WindowsService[];
  loading?: boolean;
  onRefresh?: () => void;
  onStartService?: (name: string) => Promise<void>;
  onStopService?: (name: string) => Promise<void>;
  onRestartService?: (name: string) => Promise<void>;
  onChangeStartupType?: (name: string, startupType: string) => Promise<void>;
};

type SortField = 'name' | 'displayName' | 'status' | 'startupType' | 'account';
type SortDirection = 'asc' | 'desc';

// Mock data with common Windows services
const mockServices: WindowsService[] = [
  {
    name: 'wuauserv',
    displayName: 'Windows Update',
    status: 'Running',
    startupType: 'Automatic (Delayed)',
    account: 'LocalSystem',
    description: 'Enables the detection, download, and installation of updates for Windows and other programs.',
    path: 'C:\\Windows\\System32\\svchost.exe -k netsvcs -p',
    dependencies: ['rpcss'],
    dependentServices: []
  },
  {
    name: 'Spooler',
    displayName: 'Print Spooler',
    status: 'Running',
    startupType: 'Automatic',
    account: 'LocalSystem',
    description: 'Loads files to memory for later printing.',
    path: 'C:\\Windows\\System32\\spoolsv.exe',
    dependencies: ['RPCSS', 'http'],
    dependentServices: ['Fax']
  },
  {
    name: 'BITS',
    displayName: 'Background Intelligent Transfer Service',
    status: 'Running',
    startupType: 'Automatic (Delayed)',
    account: 'LocalSystem',
    description: 'Transfers files in the background using idle network bandwidth.',
    path: 'C:\\Windows\\System32\\svchost.exe -k netsvcs -p',
    dependencies: ['RpcSs'],
    dependentServices: ['QWAVE']
  },
  {
    name: 'W32Time',
    displayName: 'Windows Time',
    status: 'Running',
    startupType: 'Automatic',
    account: 'LocalService',
    description: 'Maintains date and time synchronization on all clients and servers in the network.',
    path: 'C:\\Windows\\System32\\svchost.exe -k LocalService',
    dependencies: [],
    dependentServices: []
  },
  {
    name: 'Dnscache',
    displayName: 'DNS Client',
    status: 'Running',
    startupType: 'Automatic',
    account: 'Network Service',
    description: 'Caches Domain Name System (DNS) names and registers the full computer name.',
    path: 'C:\\Windows\\System32\\svchost.exe -k NetworkService -p',
    dependencies: ['nsi'],
    dependentServices: []
  },
  {
    name: 'TermService',
    displayName: 'Remote Desktop Services',
    status: 'Running',
    startupType: 'Manual',
    account: 'NetworkService',
    description: 'Allows users to connect interactively to a remote computer.',
    path: 'C:\\Windows\\System32\\svchost.exe -k termsvcs',
    dependencies: ['RpcSs'],
    dependentServices: ['UmRdpService', 'SessionEnv']
  },
  {
    name: 'WinDefend',
    displayName: 'Microsoft Defender Antivirus Service',
    status: 'Running',
    startupType: 'Automatic',
    account: 'LocalSystem',
    description: 'Helps protect users from malware and other potentially unwanted software.',
    path: 'C:\\ProgramData\\Microsoft\\Windows Defender\\Platform\\MsMpEng.exe',
    dependencies: ['RpcSs'],
    dependentServices: []
  },
  {
    name: 'WSearch',
    displayName: 'Windows Search',
    status: 'Running',
    startupType: 'Automatic (Delayed)',
    account: 'LocalSystem',
    description: 'Provides content indexing, property caching, and search results for files, e-mail, and other content.',
    path: 'C:\\Windows\\System32\\SearchIndexer.exe /Embedding',
    dependencies: ['RPCSS'],
    dependentServices: []
  },
  {
    name: 'Themes',
    displayName: 'Themes',
    status: 'Running',
    startupType: 'Automatic',
    account: 'LocalSystem',
    description: 'Provides user experience theme management.',
    path: 'C:\\Windows\\System32\\svchost.exe -k netsvcs -p',
    dependencies: [],
    dependentServices: []
  },
  {
    name: 'EventLog',
    displayName: 'Windows Event Log',
    status: 'Running',
    startupType: 'Automatic',
    account: 'LocalService',
    description: 'Manages events and event logs. Supports logging, querying, subscribing to, and archiving events.',
    path: 'C:\\Windows\\System32\\svchost.exe -k LocalServiceNetworkRestricted -p',
    dependencies: [],
    dependentServices: ['Wecsvc']
  },
  {
    name: 'Schedule',
    displayName: 'Task Scheduler',
    status: 'Running',
    startupType: 'Automatic',
    account: 'LocalSystem',
    description: 'Enables a user to configure and schedule automated tasks on this computer.',
    path: 'C:\\Windows\\System32\\svchost.exe -k netsvcs -p',
    dependencies: ['RPCSS', 'SystemEventsBroker'],
    dependentServices: []
  },
  {
    name: 'LanmanWorkstation',
    displayName: 'Workstation',
    status: 'Running',
    startupType: 'Automatic',
    account: 'NetworkService',
    description: 'Creates and maintains client network connections to remote servers using the SMB protocol.',
    path: 'C:\\Windows\\System32\\svchost.exe -k NetworkService -p',
    dependencies: ['Bowser', 'MRxSmb20', 'NSI'],
    dependentServices: ['SessionEnv', 'Netlogon', 'Browser']
  },
  {
    name: 'RemoteRegistry',
    displayName: 'Remote Registry',
    status: 'Stopped',
    startupType: 'Disabled',
    account: 'LocalService',
    description: 'Enables remote users to modify registry settings on this computer.',
    path: 'C:\\Windows\\System32\\svchost.exe -k localService -p',
    dependencies: ['RPCSS'],
    dependentServices: []
  },
  {
    name: 'Fax',
    displayName: 'Fax',
    status: 'Stopped',
    startupType: 'Manual',
    account: 'LocalService',
    description: 'Enables you to send and receive faxes.',
    path: 'C:\\Windows\\System32\\fxssvc.exe',
    dependencies: ['Spooler', 'RpcSs', 'TapiSrv'],
    dependentServices: []
  },
  {
    name: 'TapiSrv',
    displayName: 'Telephony',
    status: 'Stopped',
    startupType: 'Manual',
    account: 'NetworkService',
    description: 'Provides Telephony API (TAPI) support for programs that control telephony devices.',
    path: 'C:\\Windows\\System32\\svchost.exe -k tapisrv',
    dependencies: ['PlugPlay', 'RpcSs'],
    dependentServices: ['Fax', 'RasAuto', 'RasMan']
  }
];

const statusColors: Record<ServiceStatus, string> = {
  Running: 'bg-green-500/20 text-green-700 border-green-500/40',
  Stopped: 'bg-red-500/20 text-red-700 border-red-500/40',
  Paused: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40',
  Starting: 'bg-blue-500/20 text-blue-700 border-blue-500/40',
  Stopping: 'bg-blue-500/20 text-blue-700 border-blue-500/40'
};

const startupTypeColors: Record<StartupType, string> = {
  Automatic: 'bg-green-500/20 text-green-700 border-green-500/40',
  'Automatic (Delayed)': 'bg-green-500/20 text-green-700 border-green-500/40',
  Manual: 'bg-gray-500/20 text-gray-700 border-gray-500/40',
  Disabled: 'bg-red-500/20 text-red-700 border-red-500/40'
};

const startupTypeOptions: StartupType[] = ['Automatic', 'Automatic (Delayed)', 'Manual', 'Disabled'];

export default function ServicesManager({
  deviceId,
  deviceName = 'Unknown Device',
  deviceOs = 'windows',
  services = mockServices,
  loading = false,
  onRefresh,
  onStartService,
  onStopService,
  onRestartService,
  onChangeStartupType
}: ServicesManagerProps) {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'Running' | 'Stopped'>('all');
  const [sortField, setSortField] = useState<SortField>('displayName');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [expandedService, setExpandedService] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<{
    type: 'start' | 'stop' | 'restart';
    serviceName: string;
    serviceDisplayName: string;
  } | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 10;

  // Filter and sort services
  const filteredServices = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    let result = services.filter(service => {
      const matchesQuery =
        normalizedQuery.length === 0 ||
        service.name.toLowerCase().includes(normalizedQuery) ||
        service.displayName.toLowerCase().includes(normalizedQuery);

      const matchesStatus =
        statusFilter === 'all' || service.status === statusFilter;

      return matchesQuery && matchesStatus;
    });

    // Sort
    result = [...result].sort((a, b) => {
      let comparison = 0;
      const aValue = a[sortField];
      const bValue = b[sortField];

      if (typeof aValue === 'string' && typeof bValue === 'string') {
        comparison = aValue.localeCompare(bValue);
      }

      return sortDirection === 'asc' ? comparison : -comparison;
    });

    return result;
  }, [services, query, statusFilter, sortField, sortDirection]);

  // Pagination
  const totalPages = Math.ceil(filteredServices.length / pageSize);
  const startIndex = (currentPage - 1) * pageSize;
  const paginatedServices = filteredServices.slice(startIndex, startIndex + pageSize);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(prev => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const handleAction = useCallback(
    async (type: 'start' | 'stop' | 'restart', serviceName: string) => {
      setActionLoading(serviceName);
      setConfirmAction(null);

      try {
        if (type === 'start' && onStartService) {
          await onStartService(serviceName);
        } else if (type === 'stop' && onStopService) {
          await onStopService(serviceName);
        } else if (type === 'restart' && onRestartService) {
          await onRestartService(serviceName);
        }
      } catch (error) {
        console.error(`Failed to ${type} service:`, error);
      } finally {
        setActionLoading(null);
      }
    },
    [onStartService, onStopService, onRestartService]
  );

  const handleStartupTypeChange = useCallback(
    async (serviceName: string, newStartupType: string) => {
      if (!onChangeStartupType) return;

      setActionLoading(serviceName);
      try {
        await onChangeStartupType(serviceName, newStartupType);
      } catch (error) {
        console.error('Failed to change startup type:', error);
      } finally {
        setActionLoading(null);
      }
    },
    [onChangeStartupType]
  );

  const toggleExpanded = (serviceName: string) => {
    setExpandedService(prev => (prev === serviceName ? null : serviceName));
  };

  const SortableHeader = ({
    field,
    children
  }: {
    field: SortField;
    children: React.ReactNode;
  }) => (
    <th
      className="px-4 py-3 cursor-pointer hover:bg-muted/60 select-none"
      onClick={() => handleSort(field)}
    >
      <div className="flex items-center gap-1">
        {children}
        {sortField === field && (
          <ChevronDown
            className={cn('h-4 w-4 transition-transform', sortDirection === 'desc' && 'rotate-180')}
          />
        )}
      </div>
    </th>
  );

  // Show Windows-only alert for non-Windows devices
  if (deviceOs !== 'windows') {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center gap-3 rounded-md border border-yellow-500/40 bg-yellow-500/10 p-4">
          <AlertTriangle className="h-5 w-5 text-yellow-600" />
          <div>
            <h3 className="font-medium text-yellow-700">Windows Only Feature</h3>
            <p className="text-sm text-yellow-600">
              The Services Manager is only available for Windows devices. {deviceName} is running{' '}
              {deviceOs === 'macos' ? 'macOS' : 'Linux'}.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Monitor className="h-5 w-5 text-muted-foreground" />
          <div>
            <h2 className="text-lg font-semibold">Services Manager</h2>
            <p className="text-sm text-muted-foreground">
              {filteredServices.length} of {services.length} services on {deviceName}
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              placeholder="Search services..."
              value={query}
              onChange={e => {
                setQuery(e.target.value);
                setCurrentPage(1);
              }}
              className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-56"
            />
          </div>

          {/* Status Filter */}
          <select
            value={statusFilter}
            onChange={e => {
              setStatusFilter(e.target.value as 'all' | 'Running' | 'Stopped');
              setCurrentPage(1);
            }}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-32"
          >
            <option value="all">All Status</option>
            <option value="Running">Running</option>
            <option value="Stopped">Stopped</option>
          </select>

          {/* Refresh Button */}
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="flex h-10 items-center justify-center gap-2 rounded-md border bg-background px-4 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>
      </div>

      {/* Confirmation Dialog */}
      {confirmAction && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-lg">
            <h3 className="text-lg font-semibold">Confirm Action</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Are you sure you want to{' '}
              <span className="font-medium">
                {confirmAction.type === 'start'
                  ? 'start'
                  : confirmAction.type === 'stop'
                    ? 'stop'
                    : 'restart'}
              </span>{' '}
              the service <span className="font-medium">{confirmAction.serviceDisplayName}</span>?
            </p>
            <div className="mt-4 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setConfirmAction(null)}
                className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => handleAction(confirmAction.type, confirmAction.serviceName)}
                className={cn(
                  'rounded-md px-4 py-2 text-sm font-medium text-white',
                  confirmAction.type === 'stop'
                    ? 'bg-red-600 hover:bg-red-700'
                    : 'bg-blue-600 hover:bg-blue-700'
                )}
              >
                {confirmAction.type === 'start'
                  ? 'Start Service'
                  : confirmAction.type === 'stop'
                    ? 'Stop Service'
                    : 'Restart Service'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="mt-6 overflow-hidden rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="w-8 px-4 py-3"></th>
              <SortableHeader field="name">Name</SortableHeader>
              <SortableHeader field="displayName">Display Name</SortableHeader>
              <SortableHeader field="status">Status</SortableHeader>
              <SortableHeader field="startupType">Startup</SortableHeader>
              <SortableHeader field="account">Account</SortableHeader>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center">
                  <Loader2 className="mx-auto h-6 w-6 animate-spin text-muted-foreground" />
                  <p className="mt-2 text-sm text-muted-foreground">Loading services...</p>
                </td>
              </tr>
            ) : paginatedServices.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No services found. Try adjusting your search or filters.
                </td>
              </tr>
            ) : (
              paginatedServices.map(service => (
                <>
                  <tr
                    key={service.name}
                    onClick={() => toggleExpanded(service.name)}
                    className="cursor-pointer transition hover:bg-muted/40"
                  >
                    <td className="px-4 py-3">
                      <ChevronRight
                        className={cn(
                          'h-4 w-4 text-muted-foreground transition-transform',
                          expandedService === service.name && 'rotate-90'
                        )}
                      />
                    </td>
                    <td className="px-4 py-3 text-sm font-mono">{service.name}</td>
                    <td className="px-4 py-3 text-sm font-medium">{service.displayName}</td>
                    <td className="px-4 py-3 text-sm">
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium',
                          statusColors[service.status]
                        )}
                      >
                        {service.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm">
                      <span
                        className={cn(
                          'inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium',
                          startupTypeColors[service.startupType]
                        )}
                      >
                        {service.startupType}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">{service.account}</td>
                    <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                      <div className="flex items-center gap-1">
                        {actionLoading === service.name ? (
                          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                        ) : (
                          <>
                            {/* Start Button */}
                            <button
                              type="button"
                              onClick={() =>
                                setConfirmAction({
                                  type: 'start',
                                  serviceName: service.name,
                                  serviceDisplayName: service.displayName
                                })
                              }
                              disabled={service.status === 'Running' || service.startupType === 'Disabled'}
                              title="Start Service"
                              className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted disabled:cursor-not-allowed disabled:opacity-30"
                            >
                              <Play className="h-4 w-4 text-green-600" />
                            </button>

                            {/* Stop Button */}
                            <button
                              type="button"
                              onClick={() =>
                                setConfirmAction({
                                  type: 'stop',
                                  serviceName: service.name,
                                  serviceDisplayName: service.displayName
                                })
                              }
                              disabled={service.status === 'Stopped'}
                              title="Stop Service"
                              className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted disabled:cursor-not-allowed disabled:opacity-30"
                            >
                              <Square className="h-4 w-4 text-red-600" />
                            </button>

                            {/* Restart Button */}
                            <button
                              type="button"
                              onClick={() =>
                                setConfirmAction({
                                  type: 'restart',
                                  serviceName: service.name,
                                  serviceDisplayName: service.displayName
                                })
                              }
                              disabled={service.status === 'Stopped' || service.startupType === 'Disabled'}
                              title="Restart Service"
                              className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted disabled:cursor-not-allowed disabled:opacity-30"
                            >
                              <RefreshCw className="h-4 w-4 text-blue-600" />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>

                  {/* Expanded Details Panel */}
                  {expandedService === service.name && (
                    <tr key={`${service.name}-details`} className="bg-muted/20">
                      <td colSpan={7} className="px-4 py-4">
                        <div className="grid gap-4 sm:grid-cols-2">
                          {/* Description */}
                          <div>
                            <h4 className="text-xs font-semibold uppercase text-muted-foreground">
                              Description
                            </h4>
                            <p className="mt-1 text-sm">
                              {service.description || 'No description available'}
                            </p>
                          </div>

                          {/* Executable Path */}
                          <div>
                            <h4 className="text-xs font-semibold uppercase text-muted-foreground">
                              Executable Path
                            </h4>
                            <p className="mt-1 break-all font-mono text-xs">
                              {service.path || 'N/A'}
                            </p>
                          </div>

                          {/* Dependencies */}
                          <div>
                            <h4 className="text-xs font-semibold uppercase text-muted-foreground">
                              Dependencies
                            </h4>
                            <div className="mt-1">
                              {service.dependencies && service.dependencies.length > 0 ? (
                                <div className="flex flex-wrap gap-1">
                                  {service.dependencies.map(dep => (
                                    <span
                                      key={dep}
                                      className="rounded bg-muted px-2 py-0.5 text-xs"
                                    >
                                      {dep}
                                    </span>
                                  ))}
                                </div>
                              ) : (
                                <span className="text-sm text-muted-foreground">None</span>
                              )}
                            </div>
                          </div>

                          {/* Dependent Services */}
                          <div>
                            <h4 className="text-xs font-semibold uppercase text-muted-foreground">
                              Dependent Services
                            </h4>
                            <div className="mt-1">
                              {service.dependentServices && service.dependentServices.length > 0 ? (
                                <div className="flex flex-wrap gap-1">
                                  {service.dependentServices.map(dep => (
                                    <span
                                      key={dep}
                                      className="rounded bg-muted px-2 py-0.5 text-xs"
                                    >
                                      {dep}
                                    </span>
                                  ))}
                                </div>
                              ) : (
                                <span className="text-sm text-muted-foreground">None</span>
                              )}
                            </div>
                          </div>

                          {/* Change Startup Type */}
                          <div className="sm:col-span-2">
                            <h4 className="text-xs font-semibold uppercase text-muted-foreground">
                              Change Startup Type
                            </h4>
                            <div className="mt-2 flex items-center gap-2">
                              <select
                                value={service.startupType}
                                onChange={e => handleStartupTypeChange(service.name, e.target.value)}
                                disabled={actionLoading === service.name}
                                className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {startupTypeOptions.map(option => (
                                  <option key={option} value={option}>
                                    {option}
                                  </option>
                                ))}
                              </select>
                              {actionLoading === service.name && (
                                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                              )}
                            </div>
                          </div>
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

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Showing {startIndex + 1} to {Math.min(startIndex + pageSize, filteredServices.length)} of{' '}
            {filteredServices.length}
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
