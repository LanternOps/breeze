import { useState } from 'react';
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

  const isWindows = deviceOs === 'windows';

  const availableTabs = tabs.filter(tab => !tab.windowsOnly || isWindows);

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
          <ProcessManagerPlaceholder deviceId={deviceId} deviceName={deviceName} />
        )}
        {activeTab === 'services' && isWindows && (
          <ServicesManagerPlaceholder deviceId={deviceId} deviceName={deviceName} />
        )}
        {activeTab === 'registry' && isWindows && (
          <RegistryEditorPlaceholder deviceId={deviceId} deviceName={deviceName} />
        )}
        {activeTab === 'eventlog' && isWindows && (
          <EventViewerPlaceholder deviceId={deviceId} deviceName={deviceName} />
        )}
        {activeTab === 'tasks' && isWindows && (
          <ScheduledTasksPlaceholder deviceId={deviceId} deviceName={deviceName} />
        )}
        {activeTab === 'terminal' && (
          <TerminalPlaceholder deviceId={deviceId} deviceName={deviceName} />
        )}
        {activeTab === 'files' && (
          <FileManagerPlaceholder deviceId={deviceId} deviceName={deviceName} />
        )}
      </div>
    </div>
  );
}

// Placeholder components - will be replaced with actual imports once created
function ProcessManagerPlaceholder({ deviceId, deviceName }: { deviceId: string; deviceName: string }) {
  return (
    <div className="rounded-lg border bg-card p-6">
      <h2 className="mb-4 text-lg font-semibold">Process Manager</h2>
      <p className="text-sm text-muted-foreground">
        View and manage running processes on {deviceName}
      </p>
      <p className="mt-2 text-xs text-muted-foreground">Device ID: {deviceId}</p>
      <div className="mt-4 rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
        ProcessManager component will be loaded here
      </div>
    </div>
  );
}

function ServicesManagerPlaceholder({ deviceId, deviceName }: { deviceId: string; deviceName: string }) {
  return (
    <div className="rounded-lg border bg-card p-6">
      <h2 className="mb-4 text-lg font-semibold">Services Manager</h2>
      <p className="text-sm text-muted-foreground">
        Manage Windows services on {deviceName}
      </p>
      <p className="mt-2 text-xs text-muted-foreground">Device ID: {deviceId}</p>
      <div className="mt-4 rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
        ServicesManager component will be loaded here
      </div>
    </div>
  );
}

function RegistryEditorPlaceholder({ deviceId, deviceName }: { deviceId: string; deviceName: string }) {
  return (
    <div className="rounded-lg border bg-card p-6">
      <h2 className="mb-4 text-lg font-semibold">Registry Editor</h2>
      <p className="text-sm text-muted-foreground">
        Browse and edit Windows Registry on {deviceName}
      </p>
      <p className="mt-2 text-xs text-muted-foreground">Device ID: {deviceId}</p>
      <div className="mt-4 rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
        RegistryEditor component will be loaded here
      </div>
    </div>
  );
}

function EventViewerPlaceholder({ deviceId, deviceName }: { deviceId: string; deviceName: string }) {
  return (
    <div className="rounded-lg border bg-card p-6">
      <h2 className="mb-4 text-lg font-semibold">Event Viewer</h2>
      <p className="text-sm text-muted-foreground">
        Browse Windows Event Logs on {deviceName}
      </p>
      <p className="mt-2 text-xs text-muted-foreground">Device ID: {deviceId}</p>
      <div className="mt-4 rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
        EventViewer component will be loaded here
      </div>
    </div>
  );
}

function ScheduledTasksPlaceholder({ deviceId, deviceName }: { deviceId: string; deviceName: string }) {
  return (
    <div className="rounded-lg border bg-card p-6">
      <h2 className="mb-4 text-lg font-semibold">Scheduled Tasks</h2>
      <p className="text-sm text-muted-foreground">
        Manage Windows Task Scheduler on {deviceName}
      </p>
      <p className="mt-2 text-xs text-muted-foreground">Device ID: {deviceId}</p>
      <div className="mt-4 rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
        ScheduledTasks component will be loaded here
      </div>
    </div>
  );
}

function TerminalPlaceholder({ deviceId, deviceName }: { deviceId: string; deviceName: string }) {
  return (
    <div className="rounded-lg border bg-card p-6">
      <h2 className="mb-4 text-lg font-semibold">Remote Terminal</h2>
      <p className="text-sm text-muted-foreground">
        Execute commands on {deviceName}
      </p>
      <p className="mt-2 text-xs text-muted-foreground">Device ID: {deviceId}</p>
      <div className="mt-4 rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
        RemoteTerminal component will be loaded here
      </div>
    </div>
  );
}

function FileManagerPlaceholder({ deviceId, deviceName }: { deviceId: string; deviceName: string }) {
  return (
    <div className="rounded-lg border bg-card p-6">
      <h2 className="mb-4 text-lg font-semibold">File Browser</h2>
      <p className="text-sm text-muted-foreground">
        Browse and transfer files on {deviceName}
      </p>
      <p className="mt-2 text-xs text-muted-foreground">Device ID: {deviceId}</p>
      <div className="mt-4 rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
        FileManager component will be loaded here
      </div>
    </div>
  );
}
