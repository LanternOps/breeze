import { useState } from 'react';
import {
  Monitor,
  Cpu,
  HardDrive,
  MemoryStick,
  Clock,
  AlertTriangle,
  Play,
  Terminal,
  RotateCcw,
  Settings,
  Package,
  Activity,
  History
} from 'lucide-react';
import type { Device, DeviceStatus, OSType } from './DeviceList';
import DeviceMetricsChart from './DeviceMetricsChart';
import DeviceActions from './DeviceActions';

type Tab = 'overview' | 'hardware' | 'software' | 'metrics' | 'commands';

type DeviceDetailsProps = {
  device: Device;
  onBack?: () => void;
  onAction?: (action: string, device: Device) => void;
};

type HardwareInfo = {
  cpuModel: string;
  cpuCores: number;
  totalRam: string;
  diskTotal: string;
  diskUsed: string;
  networkAdapters: { name: string; ip: string; mac: string }[];
};

type SoftwareInfo = {
  installedApps: { name: string; version: string; publisher: string }[];
  services: { name: string; status: 'running' | 'stopped'; startType: string }[];
  updates: { name: string; installedOn: string }[];
};

type Alert = {
  id: string;
  type: 'warning' | 'error' | 'info';
  message: string;
  timestamp: string;
};

type CommandHistory = {
  id: string;
  command: string;
  status: 'success' | 'failed' | 'running';
  startedAt: string;
  completedAt?: string;
  output?: string;
};

const statusColors: Record<DeviceStatus, string> = {
  online: 'bg-green-500/20 text-green-700 border-green-500/40',
  offline: 'bg-red-500/20 text-red-700 border-red-500/40',
  maintenance: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40'
};

const statusLabels: Record<DeviceStatus, string> = {
  online: 'Online',
  offline: 'Offline',
  maintenance: 'Maintenance'
};

const osLabels: Record<OSType, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux'
};

// Mock data - replace with actual API data
const mockHardware: HardwareInfo = {
  cpuModel: 'Intel Core i7-10700K @ 3.80GHz',
  cpuCores: 8,
  totalRam: '32 GB',
  diskTotal: '512 GB',
  diskUsed: '234 GB',
  networkAdapters: [
    { name: 'Ethernet', ip: '192.168.1.100', mac: '00:1A:2B:3C:4D:5E' },
    { name: 'Wi-Fi', ip: '192.168.1.101', mac: '00:1A:2B:3C:4D:5F' }
  ]
};

const mockSoftware: SoftwareInfo = {
  installedApps: [
    { name: 'Google Chrome', version: '120.0.6099.130', publisher: 'Google LLC' },
    { name: 'Microsoft Office', version: '16.0.17126.20132', publisher: 'Microsoft Corporation' },
    { name: 'Visual Studio Code', version: '1.85.1', publisher: 'Microsoft Corporation' },
    { name: 'Slack', version: '4.35.126', publisher: 'Slack Technologies' }
  ],
  services: [
    { name: 'Windows Update', status: 'running', startType: 'Automatic' },
    { name: 'Print Spooler', status: 'running', startType: 'Automatic' },
    { name: 'Remote Desktop Services', status: 'stopped', startType: 'Manual' }
  ],
  updates: [
    { name: '2024-01 Cumulative Update for Windows 11', installedOn: '2024-01-10' },
    { name: 'Security Update KB5034123', installedOn: '2024-01-09' }
  ]
};

const mockAlerts: Alert[] = [
  { id: '1', type: 'warning', message: 'CPU usage exceeded 90% for 5 minutes', timestamp: '2024-01-15T10:30:00Z' },
  { id: '2', type: 'info', message: 'Agent updated to version 2.5.1', timestamp: '2024-01-14T08:15:00Z' }
];

const mockCommands: CommandHistory[] = [
  { id: '1', command: 'Get-Process | Sort-Object CPU -Descending', status: 'success', startedAt: '2024-01-15T09:00:00Z', completedAt: '2024-01-15T09:00:02Z' },
  { id: '2', command: 'Restart-Service Spooler', status: 'success', startedAt: '2024-01-14T14:30:00Z', completedAt: '2024-01-14T14:30:05Z' }
];

export default function DeviceDetails({ device, onBack, onAction }: DeviceDetailsProps) {
  const [activeTab, setActiveTab] = useState<Tab>('overview');

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'overview', label: 'Overview', icon: <Monitor className="h-4 w-4" /> },
    { id: 'hardware', label: 'Hardware', icon: <Cpu className="h-4 w-4" /> },
    { id: 'software', label: 'Software', icon: <Package className="h-4 w-4" /> },
    { id: 'metrics', label: 'Metrics', icon: <Activity className="h-4 w-4" /> },
    { id: 'commands', label: 'Commands', icon: <Terminal className="h-4 w-4" /> }
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-lg bg-muted">
              <Monitor className="h-7 w-7 text-muted-foreground" />
            </div>
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-2xl font-bold">{device.hostname}</h1>
                <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${statusColors[device.status]}`}>
                  {statusLabels[device.status]}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                <span>{osLabels[device.os]} {device.osVersion}</span>
                <span>Agent v{device.agentVersion}</span>
                <span>{device.siteName}</span>
              </div>
            </div>
          </div>
          <DeviceActions device={device} onAction={onAction} />
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b">
        <nav className="-mb-px flex gap-4 overflow-x-auto">
          {tabs.map(tab => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium transition ${
                activeTab === tab.id
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:border-muted-foreground hover:text-foreground'
              }`}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab Content */}
      {activeTab === 'overview' && (
        <div className="grid gap-6 lg:grid-cols-3">
          {/* Key Stats */}
          <div className="lg:col-span-2 space-y-6">
            <div className="grid gap-4 sm:grid-cols-4">
              <div className="rounded-lg border bg-card p-4 shadow-sm">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Cpu className="h-4 w-4" />
                  CPU
                </div>
                <p className="mt-2 text-2xl font-bold">{device.cpuPercent}%</p>
              </div>
              <div className="rounded-lg border bg-card p-4 shadow-sm">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <MemoryStick className="h-4 w-4" />
                  RAM
                </div>
                <p className="mt-2 text-2xl font-bold">{device.ramPercent}%</p>
              </div>
              <div className="rounded-lg border bg-card p-4 shadow-sm">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <HardDrive className="h-4 w-4" />
                  Disk
                </div>
                <p className="mt-2 text-2xl font-bold">46%</p>
              </div>
              <div className="rounded-lg border bg-card p-4 shadow-sm">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Clock className="h-4 w-4" />
                  Uptime
                </div>
                <p className="mt-2 text-2xl font-bold">14d</p>
              </div>
            </div>

            {/* Mini Metrics Chart */}
            <DeviceMetricsChart compact />
          </div>

          {/* Recent Alerts */}
          <div className="rounded-lg border bg-card p-4 shadow-sm">
            <h3 className="font-semibold">Recent Alerts</h3>
            <div className="mt-4 space-y-3">
              {mockAlerts.length === 0 ? (
                <p className="text-sm text-muted-foreground">No recent alerts</p>
              ) : (
                mockAlerts.map(alert => (
                  <div key={alert.id} className="flex items-start gap-3 rounded-md border p-3">
                    <AlertTriangle className={`h-4 w-4 flex-shrink-0 ${
                      alert.type === 'error' ? 'text-red-500' :
                      alert.type === 'warning' ? 'text-yellow-500' : 'text-blue-500'
                    }`} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm">{alert.message}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {new Date(alert.timestamp).toLocaleString()}
                      </p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'hardware' && (
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <h3 className="font-semibold">Processor</h3>
            <dl className="mt-4 space-y-3">
              <div className="flex justify-between text-sm">
                <dt className="text-muted-foreground">Model</dt>
                <dd className="font-medium">{mockHardware.cpuModel}</dd>
              </div>
              <div className="flex justify-between text-sm">
                <dt className="text-muted-foreground">Cores</dt>
                <dd className="font-medium">{mockHardware.cpuCores}</dd>
              </div>
              <div className="flex justify-between text-sm">
                <dt className="text-muted-foreground">Current Usage</dt>
                <dd className="font-medium">{device.cpuPercent}%</dd>
              </div>
            </dl>
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <h3 className="font-semibold">Memory</h3>
            <dl className="mt-4 space-y-3">
              <div className="flex justify-between text-sm">
                <dt className="text-muted-foreground">Total RAM</dt>
                <dd className="font-medium">{mockHardware.totalRam}</dd>
              </div>
              <div className="flex justify-between text-sm">
                <dt className="text-muted-foreground">Current Usage</dt>
                <dd className="font-medium">{device.ramPercent}%</dd>
              </div>
            </dl>
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <h3 className="font-semibold">Storage</h3>
            <dl className="mt-4 space-y-3">
              <div className="flex justify-between text-sm">
                <dt className="text-muted-foreground">Total Capacity</dt>
                <dd className="font-medium">{mockHardware.diskTotal}</dd>
              </div>
              <div className="flex justify-between text-sm">
                <dt className="text-muted-foreground">Used</dt>
                <dd className="font-medium">{mockHardware.diskUsed}</dd>
              </div>
              <div className="mt-2">
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div className="h-full w-[46%] rounded-full bg-primary" />
                </div>
              </div>
            </dl>
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <h3 className="font-semibold">Network Adapters</h3>
            <div className="mt-4 space-y-4">
              {mockHardware.networkAdapters.map((adapter, index) => (
                <div key={index} className="rounded-md border p-3">
                  <p className="font-medium">{adapter.name}</p>
                  <dl className="mt-2 space-y-1">
                    <div className="flex justify-between text-sm">
                      <dt className="text-muted-foreground">IP Address</dt>
                      <dd className="font-mono text-xs">{adapter.ip}</dd>
                    </div>
                    <div className="flex justify-between text-sm">
                      <dt className="text-muted-foreground">MAC Address</dt>
                      <dd className="font-mono text-xs">{adapter.mac}</dd>
                    </div>
                  </dl>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'software' && (
        <div className="space-y-6">
          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <h3 className="font-semibold">Installed Applications</h3>
            <div className="mt-4 overflow-hidden rounded-md border">
              <table className="min-w-full divide-y">
                <thead className="bg-muted/40">
                  <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3">Name</th>
                    <th className="px-4 py-3">Version</th>
                    <th className="px-4 py-3">Publisher</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {mockSoftware.installedApps.map((app, index) => (
                    <tr key={index} className="hover:bg-muted/40">
                      <td className="px-4 py-3 text-sm font-medium">{app.name}</td>
                      <td className="px-4 py-3 text-sm font-mono">{app.version}</td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">{app.publisher}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <h3 className="font-semibold">Services</h3>
            <div className="mt-4 overflow-hidden rounded-md border">
              <table className="min-w-full divide-y">
                <thead className="bg-muted/40">
                  <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3">Name</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Startup Type</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {mockSoftware.services.map((service, index) => (
                    <tr key={index} className="hover:bg-muted/40">
                      <td className="px-4 py-3 text-sm font-medium">{service.name}</td>
                      <td className="px-4 py-3 text-sm">
                        <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${
                          service.status === 'running'
                            ? 'bg-green-500/20 text-green-700 border-green-500/40'
                            : 'bg-gray-500/20 text-gray-700 border-gray-500/40'
                        }`}>
                          {service.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">{service.startType}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <h3 className="font-semibold">Recent Updates</h3>
            <div className="mt-4 space-y-3">
              {mockSoftware.updates.map((update, index) => (
                <div key={index} className="flex items-center justify-between rounded-md border p-3">
                  <span className="text-sm">{update.name}</span>
                  <span className="text-sm text-muted-foreground">{update.installedOn}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {activeTab === 'metrics' && (
        <DeviceMetricsChart />
      )}

      {activeTab === 'commands' && (
        <div className="space-y-6">
          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">Command History</h3>
              <button
                type="button"
                onClick={() => onAction?.('run-script', device)}
                className="flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
              >
                <Play className="h-4 w-4" />
                Run Command
              </button>
            </div>
            <div className="mt-4 space-y-4">
              {mockCommands.map(cmd => (
                <div key={cmd.id} className="rounded-md border p-4">
                  <div className="flex items-start justify-between">
                    <code className="rounded bg-muted px-2 py-1 text-sm">{cmd.command}</code>
                    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${
                      cmd.status === 'success'
                        ? 'bg-green-500/20 text-green-700 border-green-500/40'
                        : cmd.status === 'failed'
                        ? 'bg-red-500/20 text-red-700 border-red-500/40'
                        : 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40'
                    }`}>
                      {cmd.status}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center gap-4 text-xs text-muted-foreground">
                    <span>Started: {new Date(cmd.startedAt).toLocaleString()}</span>
                    {cmd.completedAt && (
                      <span>Completed: {new Date(cmd.completedAt).toLocaleString()}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
