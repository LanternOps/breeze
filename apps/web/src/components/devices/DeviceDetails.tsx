import { useState, useEffect } from 'react';
import {
  Monitor,
  Cpu,
  MemoryStick,
  HardDrive,
  Clock,
  AlertTriangle,
  Terminal,
  Package,
  Activity,
  FileText,
  ScrollText,
  Network,
  CheckCircle,
  Info,
  Server,
  Shield,
  ShieldCheck,
  User,
  Layers,
  Timer,
  Usb,
} from 'lucide-react';
import { formatUptime } from '../../lib/utils';
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
import DeviceLogsTab from './DeviceLogsTab';
import DeviceNetworkConnections from './DeviceNetworkConnections';
import DeviceFilesystemTab from './DeviceFilesystemTab';
import DeviceManagementTab from './DeviceManagementTab';
import DeviceEffectiveConfigTab from './DeviceEffectiveConfigTab';
import DeviceIpHistoryTab from './DeviceIpHistoryTab';
import DeviceBootPerformanceTab from './DeviceBootPerformanceTab';
import DevicePlaybookHistory from './DevicePlaybookHistory';
import DevicePeripheralsTab from './DevicePeripheralsTab';
import DeviceWarrantyCard from './DeviceWarrantyCard';
import MacOSPermissionsBanner from './MacOSPermissionsBanner';
import { navigateTo } from '@/lib/navigation';
import { OverflowTabs } from '../shared/OverflowTabs';
import BackupVerificationTab from '../backup/BackupVerificationTab';

type Tab =
  | 'overview'
  | 'details'
  | 'hardware'
  | 'software'
  | 'patches'
  | 'security'
  | 'management'
  | 'effective-config'
  | 'alerts'
  | 'scripts'
  | 'performance'
  | 'eventlog'
  | 'activities'
  | 'connections'
  | 'filesystem'
  | 'ip-history'
  | 'boot-performance'
  | 'playbooks'
  | 'peripherals'
  | 'backup-verification';

type DeviceDetailsProps = {
  device: Device;
  timezone?: string;
  onBack?: () => void;
  onAction?: (action: string, device: Device) => void;
};

const statusColors: Record<DeviceStatus, string> = {
  online: 'bg-success/15 text-success border-success/30',
  offline: 'bg-destructive/15 text-destructive border-destructive/30',
  maintenance: 'bg-warning/15 text-warning border-warning/30',
  decommissioned: 'bg-muted text-muted-foreground border-border',
  quarantined: 'bg-warning/15 text-warning border-warning/30'
};

const statusLabels: Record<DeviceStatus, string> = {
  online: 'Online',
  offline: 'Offline',
  maintenance: 'Maintenance',
  decommissioned: 'Decommissioned',
  quarantined: 'Quarantined'
};

const osLabels: Record<OSType, string> = {
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux'
};

function formatOsVersion(os: OSType, osVersion: string): string {
  if (!osVersion) return osLabels[os];
  let v = osVersion;
  // Strip redundant "Microsoft Windows" prefix since osLabels already shows "Windows"
  v = v.replace(/^Microsoft Windows\s*/i, '');
  // Strip kernel name prefix (e.g. "darwin 26.3.1" → "26.3.1")
  v = v.replace(/^(darwin|linux)\s*/i, '');
  // Strip build/version numbers (e.g. "10.0.26200.7623 Build 26200.7623")
  v = v.replace(/\s*\d+\.\d+\.\d+[\d.]*\s*(Build\s*[\d.]+)?/i, '').trim();
  return v ? `${osLabels[os]} ${v}` : osLabels[os];
}

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

const VALID_TABS: Tab[] = [
  'overview', 'details', 'hardware', 'software', 'patches', 'security',
  'management', 'effective-config', 'alerts', 'scripts', 'performance',
  'eventlog', 'activities', 'connections', 'filesystem', 'ip-history',
  'boot-performance', 'playbooks', 'peripherals', 'backup-verification',
];

function getTabFromHash(): Tab {
  if (typeof window === 'undefined') return 'overview';
  const hash = window.location.hash.replace('#', '');
  if (VALID_TABS.includes(hash as Tab)) return hash as Tab;
  return 'overview';
}

export default function DeviceDetails({ device, timezone, onBack, onAction }: DeviceDetailsProps) {
  const [activeTab, setActiveTab] = useState<Tab>(getTabFromHash);

  useEffect(() => {
    const onHashChange = () => setActiveTab(getTabFromHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const switchTab = (tab: Tab) => {
    window.location.hash = tab;
    setActiveTab(tab);
  };

  // Use provided timezone or browser default
  const effectiveTimezone = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  const tabs: { id: Tab; label: string; icon: React.ReactNode; separator?: boolean; title?: string }[] = [
    // --- Summary ---
    { id: 'overview', label: 'Overview', icon: <Monitor className="h-4 w-4" /> },
    { id: 'details', label: 'Details', icon: <Info className="h-4 w-4" />, title: 'OS, network, and system details' },
    // --- Monitoring ---
    { id: 'performance', label: 'Performance', icon: <Activity className="h-4 w-4" />, separator: true, title: 'CPU, RAM, and disk usage over time' },
    { id: 'alerts', label: 'Alerts', icon: <AlertTriangle className="h-4 w-4" />, title: 'Alert history for this device' },
    { id: 'eventlog', label: 'Event Log', icon: <FileText className="h-4 w-4" />, title: 'Windows/macOS system event logs' },
    // --- Inventory ---
    { id: 'hardware', label: 'Hardware', icon: <Cpu className="h-4 w-4" />, separator: true },
    { id: 'software', label: 'Software', icon: <Package className="h-4 w-4" /> },
    { id: 'patches', label: 'Patches', icon: <CheckCircle className="h-4 w-4" />, title: 'OS update and patch status' },
    { id: 'peripherals', label: 'Peripherals', icon: <Usb className="h-4 w-4" />, title: 'USB, Bluetooth, and connected devices' },
    // --- Management ---
    { id: 'scripts', label: 'Scripts', icon: <Terminal className="h-4 w-4" />, separator: true, title: 'Script execution history' },
    { id: 'management', label: 'Management', icon: <Server className="h-4 w-4" />, title: 'Agent settings and device management' },
    { id: 'effective-config', label: 'Config', icon: <Layers className="h-4 w-4" />, title: 'Resolved configuration from all assigned policies' },
    { id: 'security', label: 'Security', icon: <Shield className="h-4 w-4" /> },
    { id: 'playbooks', label: 'Playbooks', icon: <Activity className="h-4 w-4" />, title: 'Automated remediation playbook runs' },
    // --- History & Network ---
    { id: 'activities', label: 'Activities', icon: <ScrollText className="h-4 w-4" />, separator: true, title: 'Audit log for this device' },
    { id: 'connections', label: 'Connections', icon: <Network className="h-4 w-4" />, title: 'Active network connections' },
    { id: 'ip-history', label: 'IP History', icon: <Network className="h-4 w-4" />, title: 'Historical public and private IP addresses' },
    { id: 'filesystem', label: 'Disk Cleanup', icon: <HardDrive className="h-4 w-4" />, title: 'Disk usage analysis and cleanup' },
    { id: 'boot-performance', label: 'Boot Perf', icon: <Timer className="h-4 w-4" />, title: 'Startup time and boot process analysis' },
    { id: 'backup-verification', label: 'Backup Verification', icon: <ShieldCheck className="h-4 w-4" />, title: 'Backup integrity and recovery readiness' }
  ];

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-lg bg-muted">
              <Monitor className="h-7 w-7 text-muted-foreground" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-3 min-w-0">
                <h1 className="truncate text-xl font-semibold tracking-tight" title={device.displayName || device.hostname}>{device.displayName || device.hostname}</h1>
                <span className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-1 text-xs font-medium ${statusColors[device.status]}`}>
                  {statusLabels[device.status]}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                <span>{formatOsVersion(device.os, device.osVersion)}</span>
                <span>Agent v{device.agentVersion}</span>
                <span>{device.siteName}</span>
              </div>
            </div>
          </div>
          <DeviceActions device={device} onAction={onAction} />
        </div>
      </div>

      <MacOSPermissionsBanner deviceId={device.id} osType={device.os} />

      <OverflowTabs tabs={tabs} activeTab={activeTab} onTabChange={(id) => switchTab(id as Tab)} />

      {activeTab === 'overview' && (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-6">
            <div className="flex flex-wrap gap-x-8 gap-y-3 rounded-lg border bg-card px-5 py-4">
              <div>
                <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Cpu className="h-3.5 w-3.5" />
                  CPU
                </div>
                <p className="mt-1 text-lg font-semibold tabular-nums">{device.cpuPercent.toFixed(1)}%</p>
              </div>
              <div>
                <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <MemoryStick className="h-3.5 w-3.5" />
                  RAM
                </div>
                <p className="mt-1 text-lg font-semibold tabular-nums">{device.ramPercent.toFixed(1)}%</p>
              </div>
              <div>
                <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Clock className="h-3.5 w-3.5" />
                  Last Seen
                </div>
                <p className="mt-1 text-lg font-semibold">{formatLastSeen(device.lastSeen, effectiveTimezone)}</p>
              </div>
              <div>
                <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Clock className="h-3.5 w-3.5" />
                  Uptime
                </div>
                <p className="mt-1 text-lg font-semibold">{formatUptime(device.uptimeSeconds)}</p>
              </div>
              <div>
                <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <User className="h-3.5 w-3.5" />
                  Logged-in User
                </div>
                <p className="mt-1 text-lg font-semibold truncate" title={device.lastUser || undefined}>{device.lastUser || '—'}</p>
              </div>
            </div>

            <DevicePerformanceGraphs deviceId={device.id} compact />

            <DeviceWarrantyCard deviceId={device.id} compact />
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
        <DevicePatchStatusTab deviceId={device.id} timezone={effectiveTimezone} osType={device.os} />
      )}

      {activeTab === 'filesystem' && (
        <DeviceFilesystemTab
          deviceId={device.id}
          osType={device.os}
          onOpenFiles={() => {
            if (onAction) {
              onAction('files', device);
              return;
            }
            void navigateTo(`/remote/files/${device.id}`);
          }}
        />
      )}

      {activeTab === 'security' && (
        <DeviceSecurityTab deviceId={device.id} timezone={effectiveTimezone} />
      )}

      {activeTab === 'peripherals' && (
        <DevicePeripheralsTab deviceId={device.id} timezone={effectiveTimezone} />
      )}

      {activeTab === 'management' && (
        <DeviceManagementTab deviceId={device.id} />
      )}

      {activeTab === 'effective-config' && (
        <DeviceEffectiveConfigTab deviceId={device.id} />
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

      {activeTab === 'boot-performance' && (
        <DeviceBootPerformanceTab deviceId={device.id} timezone={effectiveTimezone} />
      )}

      {activeTab === 'eventlog' && (
        <DeviceLogsTab deviceId={device.id} timezone={effectiveTimezone} osType={device.os} />
      )}

      {activeTab === 'activities' && (
        <DeviceEventLogViewer deviceId={device.id} timezone={effectiveTimezone} />
      )}

      {activeTab === 'connections' && (
        <DeviceNetworkConnections deviceId={device.id} />
      )}

      {activeTab === 'ip-history' && (
        <DeviceIpHistoryTab deviceId={device.id} />
      )}

      {activeTab === 'playbooks' && (
        <DevicePlaybookHistory deviceId={device.id} timezone={effectiveTimezone} />
      )}

      {activeTab === 'backup-verification' && (
        <BackupVerificationTab deviceId={device.id} />
      )}
    </div>
  );
}
