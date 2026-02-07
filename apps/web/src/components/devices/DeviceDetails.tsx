import { useState } from 'react';
import {
  Monitor,
  Cpu,
  MemoryStick,
  Clock,
  AlertTriangle,
  Terminal,
  Package,
  Activity,
  FileText,
  Network,
  CheckCircle,
  Info,
  Shield
} from 'lucide-react';
import type { Device, DeviceStatus, OSType } from './DeviceList';
import DeviceActions from './DeviceActions';
import DeviceInfoTab from './DeviceInfoTab';
import DeviceHardwareInventory from './DeviceHardwareInventory';
import DeviceSoftwareInventory from './DeviceSoftwareInventory';
import DevicePatchStatusTab from './DevicePatchStatusTab';
import DeviceSecurityTab from './DeviceSecurityTab';
import DeviceAlertHistory from './DeviceAlertHistory';
import DeviceScriptHistory from './DeviceScriptHistory';
import DevicePerformanceGraphs from './DevicePerformanceGraphs';
import DeviceEventLogViewer from './DeviceEventLogViewer';
import DeviceNetworkConnections from './DeviceNetworkConnections';

type Tab =
  | 'overview'
  | 'details'
  | 'hardware'
  | 'software'
  | 'patches'
  | 'security'
  | 'alerts'
  | 'scripts'
  | 'performance'
  | 'eventlog'
  | 'connections';

type DeviceDetailsProps = {
  device: Device;
  timezone?: string;
  onBack?: () => void;
  onAction?: (action: string, device: Device) => void;
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

function formatLastSeen(dateString: string, timezone?: string): string {
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
  return date.toLocaleDateString([], timezone ? { timeZone: timezone } : undefined);
}

export default function DeviceDetails({ device, timezone, onBack, onAction }: DeviceDetailsProps) {
  const [activeTab, setActiveTab] = useState<Tab>('overview');

  // Use provided timezone or browser default
  const effectiveTimezone = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'overview', label: 'Overview', icon: <Monitor className="h-4 w-4" /> },
    { id: 'details', label: 'Device Details', icon: <Info className="h-4 w-4" /> },
    { id: 'hardware', label: 'Hardware Inventory', icon: <Cpu className="h-4 w-4" /> },
    { id: 'software', label: 'Software Inventory', icon: <Package className="h-4 w-4" /> },
    { id: 'patches', label: 'Patch Status', icon: <CheckCircle className="h-4 w-4" /> },
    { id: 'security', label: 'Security', icon: <Shield className="h-4 w-4" /> },
    { id: 'alerts', label: 'Alert History', icon: <AlertTriangle className="h-4 w-4" /> },
    { id: 'scripts', label: 'Script History', icon: <Terminal className="h-4 w-4" /> },
    { id: 'performance', label: 'Performance', icon: <Activity className="h-4 w-4" /> },
    { id: 'eventlog', label: 'Event Logs', icon: <FileText className="h-4 w-4" /> },
    { id: 'connections', label: 'Network Connections', icon: <Network className="h-4 w-4" /> }
  ];

  return (
    <div className="space-y-6">
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

      {activeTab === 'overview' && (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-6">
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="rounded-lg border bg-card p-4 shadow-sm">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Cpu className="h-4 w-4" />
                  CPU
                </div>
                <p className="mt-2 text-2xl font-bold">{device.cpuPercent.toFixed(1)}%</p>
              </div>
              <div className="rounded-lg border bg-card p-4 shadow-sm">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <MemoryStick className="h-4 w-4" />
                  RAM
                </div>
                <p className="mt-2 text-2xl font-bold">{device.ramPercent.toFixed(1)}%</p>
              </div>
              <div className="rounded-lg border bg-card p-4 shadow-sm">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Clock className="h-4 w-4" />
                  Last Seen
                </div>
                <p className="mt-2 text-2xl font-bold">{formatLastSeen(device.lastSeen, effectiveTimezone)}</p>
              </div>
            </div>

            <DevicePerformanceGraphs deviceId={device.id} compact />
          </div>

          <DeviceAlertHistory deviceId={device.id} timezone={effectiveTimezone} showFilters={false} limit={4} />
        </div>
      )}

      {activeTab === 'details' && (
        <DeviceInfoTab deviceId={device.id} />
      )}

      {activeTab === 'hardware' && (
        <DeviceHardwareInventory deviceId={device.id} />
      )}

      {activeTab === 'software' && (
        <DeviceSoftwareInventory deviceId={device.id} timezone={effectiveTimezone} />
      )}

      {activeTab === 'patches' && (
        <DevicePatchStatusTab deviceId={device.id} timezone={effectiveTimezone} />
      )}

      {activeTab === 'security' && (
        <DeviceSecurityTab deviceId={device.id} timezone={effectiveTimezone} />
      )}

      {activeTab === 'alerts' && (
        <DeviceAlertHistory deviceId={device.id} timezone={effectiveTimezone} />
      )}

      {activeTab === 'scripts' && (
        <DeviceScriptHistory deviceId={device.id} timezone={effectiveTimezone} />
      )}

      {activeTab === 'performance' && (
        <DevicePerformanceGraphs deviceId={device.id} />
      )}

      {activeTab === 'eventlog' && (
        <DeviceEventLogViewer deviceId={device.id} timezone={effectiveTimezone} />
      )}

      {activeTab === 'connections' && (
        <DeviceNetworkConnections deviceId={device.id} />
      )}
    </div>
  );
}
