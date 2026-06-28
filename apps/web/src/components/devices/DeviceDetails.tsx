import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Monitor,
  Cpu,
  Database,
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
  Bug,
  Info,
  Server,
  Shield,
  User,
  Layers,
  Timer,
  Usb,
  Ticket,
  TrendingUp,
  HeartPulse,
  ShieldCheck,
} from 'lucide-react';
import { formatUptime } from '../../lib/utils';
import type { Device, DeviceStatus } from './DeviceList';
import { formatDeviceSummaryOs } from './osDisplay';
import DeviceActions from './DeviceActions';
import DeviceInfoTab from './DeviceInfoTab';
import DeviceHardwareInventory from './DeviceHardwareInventory';
import DeviceSoftwareInventory from './DeviceSoftwareInventory';
import DevicePatchStatusTab from './DevicePatchStatusTab';
import DeviceVulnerabilitiesTab from './DeviceVulnerabilitiesTab';
import DeviceSecurityTab from './DeviceSecurityTab';
import DeviceAlertHistory from './DeviceAlertHistory';
import DeviceActivityFeed from './DeviceActivityFeed';
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
import DeviceUserIdleStat from './DeviceUserIdleStat';
import MacOSPermissionsBanner from './MacOSPermissionsBanner';
import { navigateTo } from '@/lib/navigation';
import { OverflowTabs } from '../shared/OverflowTabs';
import DeviceBackupTab from '../backup/DeviceBackupTab';
import DeviceTicketsTab from '../tickets/DeviceTicketsTab';
import DeviceAnomaliesPanel from './DeviceAnomaliesPanel';
import DeviceReliabilityPanel from './DeviceReliabilityPanel';
import DeviceMonitoringTab from './DeviceMonitoringTab';
import DeviceComplianceTab from './DeviceComplianceTab';

type Tab =
  | 'overview'
  | 'details'
  | 'hardware'
  | 'software'
  | 'patches'
  | 'vulnerabilities'
  | 'security'
  | 'management'
  | 'effective-config'
  | 'alerts'
  | 'anomalies'
  | 'scripts'
  | 'performance'
  | 'eventlog'
  | 'monitoring'
  | 'compliance'
  | 'activities'
  | 'connections'
  | 'filesystem'
  | 'ip-history'
  | 'boot-performance'
  | 'playbooks'
  | 'peripherals'
  | 'backup'
  | 'tickets';

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
  quarantined: 'bg-warning/15 text-warning border-warning/30',
  updating: 'bg-info/15 text-info border-info/30',
  pending: 'bg-muted text-muted-foreground border-border'
};

const statusLabels: Record<DeviceStatus, string> = {
  online: 'Online',
  offline: 'Offline',
  maintenance: 'Maintenance',
  decommissioned: 'Decommissioned',
  quarantined: 'Quarantined',
  updating: 'Updating',
  pending: 'Pending'
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

const VALID_TABS: Tab[] = [
  'overview', 'details', 'hardware', 'software', 'patches', 'vulnerabilities', 'security',
  'management', 'effective-config', 'alerts', 'scripts', 'performance',
  'anomalies', 'eventlog', 'monitoring', 'compliance', 'activities', 'connections', 'filesystem', 'ip-history',
  'boot-performance', 'playbooks', 'peripherals', 'backup', 'tickets',
];

function getTabFromHash(): Tab {
  if (typeof window === 'undefined') return 'overview';
  const hash = window.location.hash.replace('#', '').split('/')[0] ?? '';
  if (VALID_TABS.includes(hash as Tab)) return hash as Tab;
  return 'overview';
}

function getAnomalyIdFromHash(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const [tab, anomalyId] = window.location.hash.replace('#', '').split('/');
  return tab === 'anomalies' && anomalyId ? anomalyId : undefined;
}

export default function DeviceDetails({ device, timezone, onBack, onAction }: DeviceDetailsProps) {
  const [activeTab, setActiveTab] = useState<Tab>(getTabFromHash);
  const [focusedAnomalyId, setFocusedAnomalyId] = useState<string | undefined>(getAnomalyIdFromHash);
  // Whether the Overview Activity rail is collapsed to its thin vertical bar.
  // Starts collapsed so the page paints at full width during the async load and
  // never flashes a rail that then vanishes (the v0.85.0 stretch bug). Once the
  // feed loads, the data-driven default opens it when there's content; an empty
  // device simply stays collapsed with zero motion.
  const [activityCollapsed, setActivityCollapsed] = useState(true);
  // Set once the user clicks the collapse/expand affordance, so a manual choice
  // wins over the data-driven default for the rest of this device's view. Reset
  // per device below (no cross-device persistence).
  const activityUserToggled = useRef(false);

  const handleActivityHasContent = useCallback((hasContent: boolean) => {
    if (activityUserToggled.current) return;
    setActivityCollapsed(!hasContent);
  }, []);

  const toggleActivityCollapsed = useCallback(() => {
    activityUserToggled.current = true;
    setActivityCollapsed((c) => !c);
  }, []);

  // Re-derive the rail state for each device: forget any manual toggle and drop
  // back to the collapsed-during-load default until the new device's feed reports.
  useEffect(() => {
    activityUserToggled.current = false;
    setActivityCollapsed(true);
  }, [device.id]);

  useEffect(() => {
    const onHashChange = () => {
      setActiveTab(getTabFromHash());
      setFocusedAnomalyId(getAnomalyIdFromHash());
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const switchTab = (tab: Tab) => {
    window.location.hash = tab;
    setActiveTab(tab);
    setFocusedAnomalyId(undefined);
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
    { id: 'anomalies', label: 'Anomalies', icon: <TrendingUp className="h-4 w-4" />, title: 'Metric anomaly signals for this device' },
    { id: 'tickets', label: 'Tickets', icon: <Ticket className="h-4 w-4" />, title: 'Tickets linked to this device' },
    { id: 'eventlog', label: 'Event Log', icon: <FileText className="h-4 w-4" />, title: 'Windows/macOS system event logs' },
    { id: 'monitoring', label: 'Monitoring', icon: <HeartPulse className="h-4 w-4" />, title: 'Service/process watch results from Configuration Policies' },
    { id: 'compliance', label: 'Compliance', icon: <ShieldCheck className="h-4 w-4" />, title: 'Per-device Configuration Policy compliance results' },
    // --- Inventory ---
    { id: 'hardware', label: 'Hardware', icon: <Cpu className="h-4 w-4" />, separator: true },
    { id: 'software', label: 'Software', icon: <Package className="h-4 w-4" /> },
    { id: 'patches', label: 'Patches', icon: <CheckCircle className="h-4 w-4" />, title: 'OS update and patch status' },
    { id: 'vulnerabilities', label: 'Vulnerabilities', icon: <Bug className="h-4 w-4" />, title: 'CVEs detected on this device' },
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
    { id: 'backup', label: 'Backup', icon: <Database className="h-4 w-4" />, title: 'Backup status, jobs, snapshots, and verification' }
  ];

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-card p-6 shadow-xs">
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
                {device.pendingReboot && (
                  <span
                    data-testid="device-pending-reboot-badge"
                    title="The OS reports a pending reboot (Windows registry / Linux reboot-required markers)."
                    className="inline-flex shrink-0 items-center rounded-full border px-2.5 py-1 text-xs font-medium bg-warning/15 text-warning border-warning/30"
                  >
                    Reboot pending
                  </span>
                )}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                <span>{formatDeviceSummaryOs(device.os, device.osVersion)}</span>
                <span>Agent v{device.agentVersion}</span>
                <span>{device.siteName}</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <DeviceActions device={device} onAction={onAction} />
          </div>
        </div>
      </div>

      <MacOSPermissionsBanner deviceId={device.id} osType={device.os} />

      <OverflowTabs tabs={tabs} activeTab={activeTab} onTabChange={(id) => switchTab(id as Tab)} />

      {activeTab === 'overview' && (
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
          <div className="min-w-0 flex-1 space-y-6">
            {/* Two groups — Health (CPU/RAM/Uptime) and Activity (Last Seen/
                User/Idle) — divided on ≥sm. Stats are content-sized (flex, not
                an equal-width grid) with non-wrapping labels and values so e.g.
                "14d 13h 24m" and "Logged-in User" stay on one line; only the
                username (arbitrary length) is allowed to truncate. */}
            <div className="flex flex-col gap-4 rounded-lg border bg-card px-5 py-4 sm:flex-row sm:gap-6">
              <div className="flex flex-1 gap-x-6">
                <div className="shrink-0">
                  <div className="flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-muted-foreground">
                    <Cpu className="h-3.5 w-3.5" />
                    CPU
                  </div>
                  <p className="mt-1 text-lg font-semibold tabular-nums">{device.cpuPercent.toFixed(1)}%</p>
                </div>
                <div className="shrink-0">
                  <div className="flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-muted-foreground">
                    <MemoryStick className="h-3.5 w-3.5" />
                    RAM
                  </div>
                  <p className="mt-1 text-lg font-semibold tabular-nums">{device.ramPercent.toFixed(1)}%</p>
                </div>
                <div className="shrink-0">
                  <div className="flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-muted-foreground">
                    <Clock className="h-3.5 w-3.5" />
                    Uptime
                  </div>
                  <p className="mt-1 whitespace-nowrap text-lg font-semibold">{formatUptime(device.uptimeSeconds)}</p>
                </div>
              </div>
              <div className="hidden w-px self-stretch bg-border sm:block" aria-hidden="true" />
              <div className="flex min-w-0 flex-1 gap-x-6">
                <div className="shrink-0">
                  <div className="flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-muted-foreground">
                    <Clock className="h-3.5 w-3.5" />
                    Last Seen
                  </div>
                  <p className="mt-1 whitespace-nowrap text-lg font-semibold">{formatLastSeen(device.lastSeen, effectiveTimezone)}</p>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-muted-foreground">
                    <User className="h-3.5 w-3.5" />
                    Logged-in User
                  </div>
                  <p className="mt-1 truncate text-lg font-semibold" title={device.lastUser || undefined}>{device.lastUser || '—'}</p>
                </div>
                <div className="shrink-0">
                  <DeviceUserIdleStat deviceId={device.id} />
                </div>
              </div>
            </div>

            <DeviceReliabilityPanel deviceId={device.id} />

            <DevicePerformanceGraphs deviceId={device.id} compact />

            <DeviceWarrantyCard deviceId={device.id} compact />
          </div>

          <div
            className={`w-full shrink-0 overflow-hidden transition-[width] duration-300 ease-in-out ${
              activityCollapsed ? 'lg:w-11 lg:self-stretch' : 'lg:w-80'
            }`}
          >
            <DeviceActivityFeed
              deviceId={device.id}
              timezone={effectiveTimezone}
              collapsed={activityCollapsed}
              onToggleCollapse={toggleActivityCollapsed}
              onHasContentChange={handleActivityHasContent}
            />
          </div>
        </div>
      )}

      {activeTab === 'details' && (
        <DeviceInfoTab deviceId={device.id} />
      )}

      {activeTab === 'hardware' && (
        <DeviceHardwareInventory deviceId={device.id} />
      )}

      {activeTab === 'software' && (
        <DeviceSoftwareInventory deviceId={device.id} timezone={effectiveTimezone} osType={device.os} />
      )}

      {activeTab === 'patches' && (
        <DevicePatchStatusTab deviceId={device.id} timezone={effectiveTimezone} osType={device.os} />
      )}

      {activeTab === 'vulnerabilities' && (
        <DeviceVulnerabilitiesTab deviceId={device.id} timezone={effectiveTimezone} />
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
        <DeviceSecurityTab deviceId={device.id} orgId={device.orgId} timezone={effectiveTimezone} />
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

      {activeTab === 'anomalies' && (
        <DeviceAnomaliesPanel deviceId={device.id} focusedAnomalyId={focusedAnomalyId} />
      )}

      {activeTab === 'tickets' && (
        <DeviceTicketsTab deviceId={device.id} />
      )}

      {activeTab === 'scripts' && (
        <DeviceScriptHistory deviceId={device.id} timezone={effectiveTimezone} />
      )}

      {activeTab === 'performance' && (
        <div className="space-y-6">
          <DevicePerformanceGraphs deviceId={device.id} />
          <DeviceAnomaliesPanel deviceId={device.id} compact />
        </div>
      )}

      {activeTab === 'boot-performance' && (
        <DeviceBootPerformanceTab deviceId={device.id} timezone={effectiveTimezone} />
      )}

      {activeTab === 'eventlog' && (
        <DeviceLogsTab deviceId={device.id} timezone={effectiveTimezone} osType={device.os} />
      )}

      {activeTab === 'monitoring' && (
        <DeviceMonitoringTab deviceId={device.id} timezone={effectiveTimezone} />
      )}

      {activeTab === 'compliance' && (
        <DeviceComplianceTab deviceId={device.id} timezone={effectiveTimezone} />
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

      {activeTab === 'backup' && (
        <DeviceBackupTab
          deviceId={device.id}
          deviceStatus={device.status}
          timezone={effectiveTimezone}
        />
      )}
    </div>
  );
}
