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

// Import actual components
import ProcessManager, { type Process } from './ProcessManager';
import ServicesManager, { type WindowsService } from './ServicesManager';
import EventViewer, { type EventLog, type EventLogEntry } from './EventViewer';
import ScheduledTasks, { type ScheduledTask } from './ScheduledTasks';
import RegistryEditor from './RegistryEditor';
import RemoteTerminal from './RemoteTerminal';
import FileManager from './FileManager';

type RemoteToolsPageProps = {
  deviceId: string;
  deviceName: string;
  deviceOs: 'windows' | 'linux' | 'darwin';
  onClose?: () => void;
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

export default function RemoteToolsPage({
  deviceId,
  deviceName,
  deviceOs,
  onClose
}: RemoteToolsPageProps) {
  const [activeTab, setActiveTab] = useState<ToolTab>('processes');

  // Process state
  const [processes, setProcesses] = useState<Process[]>([]);
  const [processLoading, setProcessLoading] = useState(false);

  // Services state
  const [services, setServices] = useState<WindowsService[]>([]);
  const [serviceLoading, setServiceLoading] = useState(false);

  // Event logs state
  const [eventLogs, setEventLogs] = useState<EventLog[]>([]);
  const [events, setEvents] = useState<EventLogEntry[]>([]);
  const [eventLoading, setEventLoading] = useState(false);

  // Scheduled tasks state
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [taskLoading, setTaskLoading] = useState(false);

  const isWindows = deviceOs === 'windows';
  const availableTabs = tabs.filter(tab => !tab.windowsOnly || isWindows);

  // Process API calls
  const fetchProcesses = useCallback(async () => {
    setProcessLoading(true);
    try {
      const res = await fetch(`/api/v1/system-tools/devices/${deviceId}/processes`);
      if (!res.ok) throw new Error('Failed to fetch processes');
      const json = await res.json();
      setProcesses(json.data || []);
    } catch (err) {
      console.error('Failed to fetch processes:', err);
    } finally {
      setProcessLoading(false);
    }
  }, [deviceId]);

  const handleKillProcess = useCallback(async (pid: number) => {
    const res = await fetch(`/api/v1/system-tools/devices/${deviceId}/processes/${pid}/kill`, {
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
      const res = await fetch(`/api/v1/system-tools/devices/${deviceId}/services`);
      if (!res.ok) throw new Error('Failed to fetch services');
      const json = await res.json();
      setServices(json.data || []);
    } catch (err) {
      console.error('Failed to fetch services:', err);
    } finally {
      setServiceLoading(false);
    }
  }, [deviceId]);

  const handleStartService = useCallback(async (name: string) => {
    const res = await fetch(`/api/v1/system-tools/devices/${deviceId}/services/${encodeURIComponent(name)}/start`, {
      method: 'POST'
    });
    if (!res.ok) {
      const json = await res.json();
      throw new Error(json.error || 'Failed to start service');
    }
    await fetchServices();
  }, [deviceId, fetchServices]);

  const handleStopService = useCallback(async (name: string) => {
    const res = await fetch(`/api/v1/system-tools/devices/${deviceId}/services/${encodeURIComponent(name)}/stop`, {
      method: 'POST'
    });
    if (!res.ok) {
      const json = await res.json();
      throw new Error(json.error || 'Failed to stop service');
    }
    await fetchServices();
  }, [deviceId, fetchServices]);

  const handleRestartService = useCallback(async (name: string) => {
    const res = await fetch(`/api/v1/system-tools/devices/${deviceId}/services/${encodeURIComponent(name)}/restart`, {
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
      const res = await fetch(`/api/v1/system-tools/devices/${deviceId}/eventlogs`);
      if (!res.ok) throw new Error('Failed to fetch event logs');
      const json = await res.json();
      setEventLogs(json.data || []);
    } catch (err) {
      console.error('Failed to fetch event logs:', err);
    } finally {
      setEventLoading(false);
    }
  }, [deviceId]);

  const handleQueryEvents = useCallback(async (logName: string, filter: { level?: string; source?: string }) => {
    const params = new URLSearchParams();
    if (filter.level) params.set('level', filter.level);
    if (filter.source) params.set('source', filter.source);

    const res = await fetch(`/api/v1/system-tools/devices/${deviceId}/eventlogs/${encodeURIComponent(logName)}/events?${params}`);
    if (!res.ok) {
      const json = await res.json();
      throw new Error(json.error || 'Failed to query events');
    }
    const json = await res.json();
    return json.data || [];
  }, [deviceId]);

  // Scheduled tasks API calls
  const fetchTasks = useCallback(async () => {
    setTaskLoading(true);
    try {
      const res = await fetch(`/api/v1/system-tools/devices/${deviceId}/tasks`);
      if (!res.ok) throw new Error('Failed to fetch tasks');
      const json = await res.json();
      setTasks(json.data || []);
    } catch (err) {
      console.error('Failed to fetch tasks:', err);
    } finally {
      setTaskLoading(false);
    }
  }, [deviceId]);

  const handleRunTask = useCallback(async (path: string) => {
    const res = await fetch(`/api/v1/system-tools/devices/${deviceId}/tasks/${encodeURIComponent(path)}/run`, {
      method: 'POST'
    });
    if (!res.ok) {
      const json = await res.json();
      throw new Error(json.error || 'Failed to run task');
    }
    await fetchTasks();
  }, [deviceId, fetchTasks]);

  const handleEnableTask = useCallback(async (path: string) => {
    const res = await fetch(`/api/v1/system-tools/devices/${deviceId}/tasks/${encodeURIComponent(path)}/enable`, {
      method: 'POST'
    });
    if (!res.ok) {
      const json = await res.json();
      throw new Error(json.error || 'Failed to enable task');
    }
    await fetchTasks();
  }, [deviceId, fetchTasks]);

  const handleDisableTask = useCallback(async (path: string) => {
    const res = await fetch(`/api/v1/system-tools/devices/${deviceId}/tasks/${encodeURIComponent(path)}/disable`, {
      method: 'POST'
    });
    if (!res.ok) {
      const json = await res.json();
      throw new Error(json.error || 'Failed to disable task');
    }
    await fetchTasks();
  }, [deviceId, fetchTasks]);

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
              {deviceName} ({deviceOs})
            </p>
          </div>
        </div>
        {onClose && (
          <button
            onClick={onClose}
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
            deviceName={deviceName}
            processes={processes}
            loading={processLoading}
            onRefresh={fetchProcesses}
            onKillProcess={handleKillProcess}
          />
        )}
        {activeTab === 'services' && isWindows && (
          <ServicesManager
            deviceId={deviceId}
            deviceName={deviceName}
            deviceOs={deviceOs}
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
            deviceName={deviceName}
          />
        )}
        {activeTab === 'eventlog' && isWindows && (
          <EventViewer
            deviceId={deviceId}
            deviceName={deviceName}
            logs={eventLogs}
            events={events}
            loading={eventLoading}
            onQueryEvents={handleQueryEvents}
          />
        )}
        {activeTab === 'tasks' && isWindows && (
          <ScheduledTasks
            deviceId={deviceId}
            deviceName={deviceName}
            tasks={tasks}
            loading={taskLoading}
            onRefresh={fetchTasks}
            onRunTask={handleRunTask}
            onEnableTask={handleEnableTask}
            onDisableTask={handleDisableTask}
          />
        )}
        {activeTab === 'terminal' && (
          <RemoteTerminal
            deviceId={deviceId}
            deviceName={deviceName}
          />
        )}
        {activeTab === 'files' && (
          <FileManager
            deviceId={deviceId}
            deviceName={deviceName}
          />
        )}
      </div>
    </div>
  );
}
