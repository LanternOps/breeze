import { useState, useCallback, useEffect } from 'react';
import {
  Activity,
  Settings2,
  Database,
  FileText,
  Clock,
  Terminal,
  FolderOpen,
  Monitor
} from 'lucide-react';
import { fetchWithAuth } from '@/stores/auth';

// Import actual components
import ProcessManager, { type Process, type ProcessStatus } from './ProcessManager';
import ServicesManager, { type WindowsService, type ServiceStatus, type StartupType } from './ServicesManager';
import EventViewer, { type EventFilter, type EventLog, type EventLogEntry, type EventLevel } from './EventViewer';
import ScheduledTasks, { type ScheduledTask, type TaskDetails, type TaskHistory, type TaskStatus } from './ScheduledTasks';
import RegistryEditor from './RegistryEditor';
import RemoteTerminal from './RemoteTerminal';
import FileManager from './FileManager';

type RemoteToolsPageProps = {
  deviceId: string;
  deviceName: string;
  deviceOs: 'windows' | 'macos' | 'linux' | 'darwin';
  onClose?: () => void;
  showClose?: boolean;
};

type ToolTab = 'processes' | 'services' | 'registry' | 'eventlog' | 'tasks' | 'terminal' | 'files';

const tabs: { id: ToolTab; label: string; icon: typeof Activity; windowsOnly?: boolean }[] = [
  { id: 'processes', label: 'Processes', icon: Activity },
  { id: 'services', label: 'Services', icon: Settings2, windowsOnly: true },
  { id: 'registry', label: 'Registry', icon: Database, windowsOnly: true },
  { id: 'eventlog', label: 'Event Log', icon: FileText, windowsOnly: true },
  { id: 'tasks', label: 'Scheduled Tasks', icon: Clock, windowsOnly: true },
  { id: 'terminal', label: 'Terminal', icon: Terminal },
  { id: 'files', label: 'File Browser', icon: FolderOpen }
];

type DeviceOs = 'windows' | 'macos' | 'linux';

type DeviceApiResponse = {
  hostname: string;
  displayName?: string | null;
  osType?: string | null;
};

type ApiProcess = {
  pid: number;
  name: string;
  user: string;
  cpuPercent: number;
  memoryMB?: number;
  memoryMb?: number;
  status?: string;
  commandLine?: string;
  startTime?: string;
  threads?: number;
  parentPid?: number | null;
  priority?: number;
};

type ApiService = {
  name: string;
  displayName: string;
  status: string;
  startType: string;
  account: string;
  description?: string;
  path?: string;
  dependencies?: string[];
};

type ApiEventLog = {
  name: string;
  displayName: string;
  recordCount?: number;
  lastWriteTime?: string;
};

type ApiEventEntry = {
  recordId: number;
  timeCreated: string;
  level: string;
  source: string;
  eventId: number;
  message: string;
  category: string;
  user: string | null;
  computer: string;
  rawXml?: string;
};

type ApiTask = {
  path: string;
  name: string;
  state?: string;
  lastRunTime?: string | null;
  lastRunResult?: number | null;
  nextRunTime?: string | null;
  author?: string;
  description?: string;
  triggers?: Array<{ type: string; enabled: boolean; schedule?: string }>;
  actions?: Array<{ type: string; path?: string; arguments?: string }>;
};

const normalizeDeviceOs = (value?: string | null): DeviceOs => {
  switch (value) {
    case 'windows':
      return 'windows';
    case 'macos':
    case 'darwin':
      return 'macos';
    case 'linux':
      return 'linux';
    default:
      return 'windows';
  }
};

const formatDeviceOs = (value: DeviceOs): string => {
  if (value === 'macos') return 'macOS';
  return value.charAt(0).toUpperCase() + value.slice(1);
};

const normalizeProcessStatus = (value?: string): ProcessStatus => {
  switch (value) {
    case 'running':
    case 'sleeping':
    case 'stopped':
    case 'zombie':
    case 'idle':
      return value;
    default:
      return 'running';
  }
};

const mapProcess = (proc: ApiProcess): Process => ({
  pid: proc.pid,
  name: proc.name,
  user: proc.user,
  cpuPercent: Number(proc.cpuPercent ?? 0),
  memoryMb: Number(proc.memoryMB ?? proc.memoryMb ?? 0),
  status: normalizeProcessStatus(proc.status),
  commandLine: proc.commandLine ?? '',
  startTime: proc.startTime,
  threads: proc.threads,
  parentPid: proc.parentPid ?? undefined,
  priority: proc.priority
});

const mapServiceStatus = (status: string): ServiceStatus => {
  switch (status) {
    case 'running':
      return 'Running';
    case 'stopped':
      return 'Stopped';
    case 'paused':
      return 'Paused';
    case 'starting':
      return 'Starting';
    case 'stopping':
      return 'Stopping';
    default:
      return 'Stopped';
  }
};

const mapStartupType = (value: string): StartupType => {
  switch (value) {
    case 'auto':
      return 'Automatic';
    case 'auto_delayed':
      return 'Automatic (Delayed)';
    case 'manual':
      return 'Manual';
    case 'disabled':
      return 'Disabled';
    default:
      return 'Manual';
  }
};

const mapService = (service: ApiService): WindowsService => ({
  name: service.name,
  displayName: service.displayName,
  status: mapServiceStatus(service.status),
  startupType: mapStartupType(service.startType),
  account: service.account,
  description: service.description,
  path: service.path,
  dependencies: service.dependencies
});

const mapEventLevel = (level?: string): EventLevel => {
  switch ((level ?? '').toLowerCase()) {
    case 'information':
      return 'Information';
    case 'warning':
      return 'Warning';
    case 'error':
      return 'Error';
    case 'critical':
      return 'Critical';
    case 'verbose':
      return 'Information';
    default:
      return 'Information';
  }
};

const mapEventLog = (log: ApiEventLog): EventLog => ({
  name: log.name,
  displayName: log.displayName,
  recordCount: log.recordCount,
  lastWriteTime: log.lastWriteTime
});

const mapEventEntry = (entry: ApiEventEntry, logName: string): EventLogEntry => ({
  recordId: String(entry.recordId),
  logName,
  level: mapEventLevel(entry.level),
  timeCreated: entry.timeCreated,
  source: entry.source,
  eventId: entry.eventId,
  message: entry.message,
  taskCategory: entry.category,
  userId: entry.user,
  computerName: entry.computer,
  rawXml: entry.rawXml
});

const normalizeTaskStatus = (state?: string): TaskStatus => {
  switch (state) {
    case 'ready':
    case 'running':
    case 'disabled':
    case 'queued':
      return state;
    default:
      return 'unknown';
  }
};

const formatTaskTriggerSummary = (trigger: { type: string; schedule?: string }): string => {
  if (trigger.schedule) {
    return `${trigger.type} at ${trigger.schedule}`;
  }
  return trigger.type;
};

const mapTaskSummary = (task: ApiTask): ScheduledTask => {
  const folder = task.path.split('\\').slice(0, -1).join('\\') || '\\';
  return {
    name: task.name,
    path: task.path,
    folder,
    status: normalizeTaskStatus(task.state),
    lastRun: task.lastRunTime ?? undefined,
    lastResult: task.lastRunResult ?? undefined,
    nextRun: task.nextRunTime ?? undefined,
    author: task.author,
    description: task.description,
    triggers: (task.triggers ?? []).map(formatTaskTriggerSummary)
  };
};

const mapTaskDetails = (task: ApiTask): TaskDetails => {
  const folder = task.path.split('\\').slice(0, -1).join('\\') || '\\';
  const triggers = (task.triggers ?? []).map(trigger => {
    const rawType = trigger.type ?? '';
    const normalizedType = rawType.toLowerCase();
    const type: TaskDetails['triggers'][number]['type'] =
      normalizedType === 'daily' ||
      normalizedType === 'weekly' ||
      normalizedType === 'monthly' ||
      normalizedType === 'boot' ||
      normalizedType === 'logon' ||
      normalizedType === 'idle' ||
      normalizedType === 'event'
        ? (normalizedType as TaskDetails['triggers'][number]['type'])
        : 'time';
    return {
      type,
      description: formatTaskTriggerSummary({ type: rawType || 'Schedule', schedule: trigger.schedule }),
      enabled: trigger.enabled,
      nextRun: task.nextRunTime ?? undefined
    };
  });

  const actions = (task.actions ?? []).map(action => {
    const rawType = action.type ?? '';
    const normalizedType = rawType.toLowerCase();
    const type: TaskDetails['actions'][number]['type'] =
      normalizedType === 'execute' || normalizedType === 'com_handler' || normalizedType === 'send_email' || normalizedType === 'show_message'
        ? (normalizedType as TaskDetails['actions'][number]['type'])
        : 'execute';
    const args = action.arguments ? ` ${action.arguments}` : '';
    return {
      type,
      path: action.path,
      arguments: action.arguments,
      description: action.path ? `Run ${action.path}${args}` : rawType || 'Execute'
    };
  });

  return {
    name: task.name,
    path: task.path,
    folder,
    status: normalizeTaskStatus(task.state),
    lastRun: task.lastRunTime ?? undefined,
    lastResult: task.lastRunResult ?? undefined,
    nextRun: task.nextRunTime ?? undefined,
    author: task.author,
    description: task.description,
    triggers,
    actions,
    conditions: {
      powerCondition: {
        disallowStartIfOnBatteries: false,
        stopIfGoingOnBatteries: false
      },
      networkCondition: {
        name: 'Any connection'
      }
    },
    settings: {
      allowDemandStart: true,
      stopIfGoingOnBatteries: false,
      runOnlyIfNetworkAvailable: true,
      executionTimeLimit: 'PT72H',
      deleteExpiredTaskAfter: 'Disabled',
      restartOnFailure: {
        count: 3,
        interval: 'PT1M'
      },
      multipleInstances: 'ignore_new'
    }
  };
};

export default function RemoteToolsPage({
  deviceId,
  deviceName,
  deviceOs,
  onClose,
  showClose = false
}: RemoteToolsPageProps) {
  const [activeTab, setActiveTab] = useState<ToolTab>('processes');
  const [resolvedDeviceName, setResolvedDeviceName] = useState(deviceName);
  const [resolvedDeviceOs, setResolvedDeviceOs] = useState<DeviceOs>(normalizeDeviceOs(deviceOs));

  // Process state
  const [processes, setProcesses] = useState<Process[]>([]);
  const [processLoading, setProcessLoading] = useState(false);

  // Services state
  const [services, setServices] = useState<WindowsService[]>([]);
  const [serviceLoading, setServiceLoading] = useState(false);

  // Event logs state
  const [eventLogs, setEventLogs] = useState<EventLog[]>([]);
  const [eventLoading, setEventLoading] = useState(false);

  // Scheduled tasks state
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [taskLoading, setTaskLoading] = useState(false);

  const isWindows = resolvedDeviceOs === 'windows';
  const availableTabs = tabs.filter(tab => !tab.windowsOnly || isWindows);
  const shouldShowClose = showClose || Boolean(onClose);
  const deviceOsLabel = formatDeviceOs(resolvedDeviceOs);

  const handleClose = useCallback(() => {
    if (onClose) {
      onClose();
      return;
    }
    if (typeof window !== 'undefined') {
      window.history.back();
    }
  }, [onClose]);

  useEffect(() => {
    setResolvedDeviceOs(normalizeDeviceOs(deviceOs));
  }, [deviceOs]);

  useEffect(() => {
    let mounted = true;

    const fetchDevice = async () => {
      try {
        const response = await fetchWithAuth(`/devices/${deviceId}`);
        if (!response.ok) return;
        const data: DeviceApiResponse = await response.json();
        if (!mounted) return;
        setResolvedDeviceName(data.displayName || data.hostname || deviceName);
        setResolvedDeviceOs(normalizeDeviceOs(data.osType));
      } catch (error) {
        console.error('Failed to load device info:', error);
      }
    };

    fetchDevice();
    return () => {
      mounted = false;
    };
  }, [deviceId, deviceName]);

  // Process API calls
  const fetchProcesses = useCallback(async () => {
    setProcessLoading(true);
    try {
      const res = await fetchWithAuth(`/system-tools/devices/${deviceId}/processes`);
      if (!res.ok) throw new Error('Failed to fetch processes');
      const json = await res.json();
      const data: ApiProcess[] = Array.isArray(json.data) ? json.data : [];
      setProcesses(data.map(mapProcess));
    } catch (err) {
      console.error('Failed to fetch processes:', err);
    } finally {
      setProcessLoading(false);
    }
  }, [deviceId]);

  const handleKillProcess = useCallback(async (pid: number) => {
    const res = await fetchWithAuth(`/system-tools/devices/${deviceId}/processes/${pid}/kill`, {
      method: 'POST'
    });
    if (!res.ok) {
      const json = await res.json();
      throw new Error(json.error || 'Failed to kill process');
    }
    await fetchProcesses();
  }, [deviceId, fetchProcesses]);

  // Services API calls
  const fetchServices = useCallback(async () => {
    setServiceLoading(true);
    try {
      const res = await fetchWithAuth(`/system-tools/devices/${deviceId}/services`);
      if (!res.ok) throw new Error('Failed to fetch services');
      const json = await res.json();
      const data: ApiService[] = Array.isArray(json.data) ? json.data : [];
      setServices(data.map(mapService));
    } catch (err) {
      console.error('Failed to fetch services:', err);
    } finally {
      setServiceLoading(false);
    }
  }, [deviceId]);

  const handleStartService = useCallback(async (name: string) => {
    const res = await fetchWithAuth(`/system-tools/devices/${deviceId}/services/${encodeURIComponent(name)}/start`, {
      method: 'POST'
    });
    if (!res.ok) {
      const json = await res.json();
      throw new Error(json.error || 'Failed to start service');
    }
    await fetchServices();
  }, [deviceId, fetchServices]);

  const handleStopService = useCallback(async (name: string) => {
    const res = await fetchWithAuth(`/system-tools/devices/${deviceId}/services/${encodeURIComponent(name)}/stop`, {
      method: 'POST'
    });
    if (!res.ok) {
      const json = await res.json();
      throw new Error(json.error || 'Failed to stop service');
    }
    await fetchServices();
  }, [deviceId, fetchServices]);

  const handleRestartService = useCallback(async (name: string) => {
    const res = await fetchWithAuth(`/system-tools/devices/${deviceId}/services/${encodeURIComponent(name)}/restart`, {
      method: 'POST'
    });
    if (!res.ok) {
      const json = await res.json();
      throw new Error(json.error || 'Failed to restart service');
    }
    await fetchServices();
  }, [deviceId, fetchServices]);

  // Event logs API calls
  const fetchEventLogs = useCallback(async () => {
    setEventLoading(true);
    try {
      const res = await fetchWithAuth(`/system-tools/devices/${deviceId}/eventlogs`);
      if (!res.ok) throw new Error('Failed to fetch event logs');
      const json = await res.json();
      const data: ApiEventLog[] = Array.isArray(json.data) ? json.data : [];
      setEventLogs(data.map(mapEventLog));
    } catch (err) {
      console.error('Failed to fetch event logs:', err);
    } finally {
      setEventLoading(false);
    }
  }, [deviceId]);

  const handleQueryEvents = useCallback(async (logName: string, filter: EventFilter) => {
    const params = new URLSearchParams();
    if (filter.levels?.length) params.set('level', filter.levels[0].toLowerCase());
    if (filter.sources?.length) params.set('source', filter.sources[0]);
    if (filter.startDate) params.set('startTime', filter.startDate);
    if (filter.endDate) params.set('endTime', filter.endDate);
    if (filter.eventId !== undefined) params.set('eventId', String(filter.eventId));

    const res = await fetchWithAuth(`/system-tools/devices/${deviceId}/eventlogs/${encodeURIComponent(logName)}/events?${params}`);
    if (!res.ok) {
      const json = await res.json();
      throw new Error(json.error || 'Failed to query events');
    }
    const json = await res.json();
    const data: ApiEventEntry[] = Array.isArray(json.data) ? json.data : [];
    return data.map(entry => mapEventEntry(entry, logName));
  }, [deviceId]);

  const handleGetEvent = useCallback(async (logName: string, recordId: string) => {
    const res = await fetchWithAuth(`/system-tools/devices/${deviceId}/eventlogs/${encodeURIComponent(logName)}/events/${encodeURIComponent(recordId)}`);
    if (!res.ok) {
      const json = await res.json();
      throw new Error(json.error || 'Failed to fetch event details');
    }
    const json = await res.json();
    return mapEventEntry(json.data as ApiEventEntry, logName);
  }, [deviceId]);

  // Scheduled tasks API calls
  const fetchTasks = useCallback(async () => {
    setTaskLoading(true);
    try {
      const res = await fetchWithAuth(`/system-tools/devices/${deviceId}/tasks`);
      if (!res.ok) throw new Error('Failed to fetch tasks');
      const json = await res.json();
      const data: ApiTask[] = Array.isArray(json.data) ? json.data : [];
      setTasks(data.map(mapTaskSummary));
    } catch (err) {
      console.error('Failed to fetch tasks:', err);
    } finally {
      setTaskLoading(false);
    }
  }, [deviceId]);

  const handleRunTask = useCallback(async (path: string) => {
    const res = await fetchWithAuth(`/system-tools/devices/${deviceId}/tasks/${encodeURIComponent(path)}/run`, {
      method: 'POST'
    });
    if (!res.ok) {
      const json = await res.json();
      throw new Error(json.error || 'Failed to run task');
    }
    await fetchTasks();
  }, [deviceId, fetchTasks]);

  const handleSelectTask = useCallback(async (path: string): Promise<TaskDetails> => {
    const res = await fetchWithAuth(`/system-tools/devices/${deviceId}/tasks/${encodeURIComponent(path)}`);
    if (!res.ok) {
      const json = await res.json();
      throw new Error(json.error || 'Failed to load task details');
    }
    const json = await res.json();
    return mapTaskDetails(json.data as ApiTask);
  }, [deviceId]);

  const handleGetTaskHistory = useCallback(async (): Promise<TaskHistory[]> => {
    return [];
  }, []);

  const handleEnableTask = useCallback(async (path: string) => {
    const res = await fetchWithAuth(`/system-tools/devices/${deviceId}/tasks/${encodeURIComponent(path)}/enable`, {
      method: 'POST'
    });
    if (!res.ok) {
      const json = await res.json();
      throw new Error(json.error || 'Failed to enable task');
    }
    await fetchTasks();
  }, [deviceId, fetchTasks]);

  const handleDisableTask = useCallback(async (path: string) => {
    const res = await fetchWithAuth(`/system-tools/devices/${deviceId}/tasks/${encodeURIComponent(path)}/disable`, {
      method: 'POST'
    });
    if (!res.ok) {
      const json = await res.json();
      throw new Error(json.error || 'Failed to disable task');
    }
    await fetchTasks();
  }, [deviceId, fetchTasks]);

  const handleGetRegistryKeys = useCallback(async (hive: string, path: string) => {
    const params = new URLSearchParams({ hive, path });
    const res = await fetchWithAuth(`/system-tools/devices/${deviceId}/registry/keys?${params}`);
    if (!res.ok) {
      const json = await res.json();
      throw new Error(json.error || 'Failed to load registry keys');
    }
    const json = await res.json();
    const data = Array.isArray(json.data) ? json.data : [];
    return data.map((entry: { name: string; path: string; subKeyCount?: number }) => {
      const normalizedPath = entry.path.startsWith(`${hive}\\`)
        ? entry.path.slice(hive.length + 1)
        : entry.path;
      return {
        name: entry.name,
        path: normalizedPath,
        hasChildren: (entry.subKeyCount ?? 0) > 0
      };
    });
  }, [deviceId]);

  const handleGetRegistryValues = useCallback(async (hive: string, path: string) => {
    const params = new URLSearchParams({ hive, path });
    const res = await fetchWithAuth(`/system-tools/devices/${deviceId}/registry/values?${params}`);
    if (!res.ok) {
      const json = await res.json();
      throw new Error(json.error || 'Failed to load registry values');
    }
    const json = await res.json();
    return Array.isArray(json.data) ? json.data : [];
  }, [deviceId]);

  const handleSetRegistryValue = useCallback(async (hive: string, path: string, name: string, type: string, data: unknown) => {
    const res = await fetchWithAuth(`/system-tools/devices/${deviceId}/registry/value`, {
      method: 'PUT',
      body: JSON.stringify({ hive, path, name, type, data })
    });
    if (!res.ok) {
      const json = await res.json();
      throw new Error(json.error || 'Failed to set registry value');
    }
  }, [deviceId]);

  const handleDeleteRegistryValue = useCallback(async (hive: string, path: string, name: string) => {
    const params = new URLSearchParams({ hive, path, name });
    const res = await fetchWithAuth(`/system-tools/devices/${deviceId}/registry/value?${params}`, {
      method: 'DELETE'
    });
    if (!res.ok) {
      const json = await res.json();
      throw new Error(json.error || 'Failed to delete registry value');
    }
  }, [deviceId]);

  const handleCreateRegistryKey = useCallback(async (hive: string, path: string) => {
    const res = await fetchWithAuth(`/system-tools/devices/${deviceId}/registry/key`, {
      method: 'POST',
      body: JSON.stringify({ hive, path })
    });
    if (!res.ok) {
      const json = await res.json();
      throw new Error(json.error || 'Failed to create registry key');
    }
  }, [deviceId]);

  const handleDeleteRegistryKey = useCallback(async (hive: string, path: string) => {
    const params = new URLSearchParams({ hive, path });
    const res = await fetchWithAuth(`/system-tools/devices/${deviceId}/registry/key?${params}`, {
      method: 'DELETE'
    });
    if (!res.ok) {
      const json = await res.json();
      throw new Error(json.error || 'Failed to delete registry key');
    }
  }, [deviceId]);

  // Load data on tab change
  useEffect(() => {
    switch (activeTab) {
      case 'processes':
        fetchProcesses();
        break;
      case 'services':
        if (isWindows) fetchServices();
        break;
      case 'eventlog':
        if (isWindows) fetchEventLogs();
        break;
      case 'tasks':
        if (isWindows) fetchTasks();
        break;
    }
  }, [activeTab, isWindows, fetchProcesses, fetchServices, fetchEventLogs, fetchTasks]);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b bg-card px-6 py-4">
        <div className="flex items-center gap-3">
          <Monitor className="h-5 w-5 text-primary" />
          <div>
            <h1 className="text-lg font-semibold">Remote Tools</h1>
            <p className="text-sm text-muted-foreground">
              {resolvedDeviceName} ({deviceOsLabel})
            </p>
          </div>
        </div>
        {shouldShowClose && (
          <button
            onClick={handleClose}
            className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted"
          >
            Close
          </button>
        )}
      </div>

      {/* Tab Navigation */}
      <div className="flex gap-1 border-b bg-muted/30 px-4">
        {availableTabs.map(tab => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium transition-colors ${
                isActive
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground'
              }`}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tool Content */}
      <div className="flex-1 overflow-auto p-6">
        {activeTab === 'processes' && (
          <ProcessManager
            deviceId={deviceId}
            deviceName={resolvedDeviceName}
            processes={processes}
            loading={processLoading}
            onRefresh={fetchProcesses}
            onKillProcess={handleKillProcess}
          />
        )}
        {activeTab === 'services' && isWindows && (
          <ServicesManager
            deviceId={deviceId}
            deviceName={resolvedDeviceName}
            deviceOs={resolvedDeviceOs}
            services={services}
            loading={serviceLoading}
            onRefresh={fetchServices}
            onStartService={handleStartService}
            onStopService={handleStopService}
            onRestartService={handleRestartService}
          />
        )}
        {activeTab === 'registry' && isWindows && (
          <RegistryEditor
            deviceId={deviceId}
            deviceName={resolvedDeviceName}
            onGetKeys={handleGetRegistryKeys}
            onGetValues={handleGetRegistryValues}
            onSetValue={handleSetRegistryValue}
            onDeleteValue={handleDeleteRegistryValue}
            onCreateKey={handleCreateRegistryKey}
            onDeleteKey={handleDeleteRegistryKey}
          />
        )}
        {activeTab === 'eventlog' && isWindows && (
          <EventViewer
            deviceId={deviceId}
            deviceName={resolvedDeviceName}
            logs={eventLogs}
            loading={eventLoading}
            onQueryEvents={handleQueryEvents}
            onGetEvent={handleGetEvent}
          />
        )}
        {activeTab === 'tasks' && isWindows && (
          <ScheduledTasks
            deviceId={deviceId}
            deviceName={resolvedDeviceName}
            tasks={tasks}
            loading={taskLoading}
            onRefresh={fetchTasks}
            onSelectTask={handleSelectTask}
            onGetHistory={handleGetTaskHistory}
            onRunTask={handleRunTask}
            onEnableTask={handleEnableTask}
            onDisableTask={handleDisableTask}
          />
        )}
        {activeTab === 'terminal' && (
          <RemoteTerminal
            deviceId={deviceId}
            deviceHostname={resolvedDeviceName}
          />
        )}
        {activeTab === 'files' && (
          <FileManager
            deviceId={deviceId}
            deviceHostname={resolvedDeviceName}
          />
        )}
      </div>
    </div>
  );
}
