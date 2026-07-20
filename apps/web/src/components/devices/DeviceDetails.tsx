import { useState, useEffect, useRef, useCallback } from "react";
import { useHashState } from "@/lib/useHashState";
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
  Link2,
  Cloud,
  History,
} from "lucide-react";
import { formatPercent } from "@/lib/i18n/format";
import { formatUptime } from "../../lib/utils";
import type { Device, DeviceStatus } from "./DeviceList";
import { formatDeviceSummaryOs } from "./osDisplay";
import DeviceActions from "./DeviceActions";
import DeviceInfoTab from "./DeviceInfoTab";
import DeviceHardwareInventory from "./DeviceHardwareInventory";
import DeviceSoftwareInventory from "./DeviceSoftwareInventory";
import DevicePatchStatusTab from "./DevicePatchStatusTab";
import DeviceVulnerabilitiesTab from "./DeviceVulnerabilitiesTab";
import DeviceOneDriveTab from "./DeviceOneDriveTab";
import DeviceSecurityTab from "./DeviceSecurityTab";
import DeviceAlertHistory from "./DeviceAlertHistory";
import DeviceActivityFeed from "./DeviceActivityFeed";
import DeviceScriptHistory from "./DeviceScriptHistory";
import DevicePerformanceGraphs from "./DevicePerformanceGraphs";
import DeviceEventLogViewer from "./DeviceEventLogViewer";
import DeviceLogsTab from "./DeviceLogsTab";
import DeviceNetworkConnections from "./DeviceNetworkConnections";
import DeviceFilesystemTab from "./DeviceFilesystemTab";
import DeviceManagementTab from "./DeviceManagementTab";
import DeviceEffectiveConfigTab from "./DeviceEffectiveConfigTab";
import DeviceIpHistoryTab from "./DeviceIpHistoryTab";
import DeviceChangeHistoryTab from "./DeviceChangeHistoryTab";
import DeviceBootPerformanceTab from "./DeviceBootPerformanceTab";
import DevicePlaybookHistory from "./DevicePlaybookHistory";
import DevicePeripheralsTab from "./DevicePeripheralsTab";
import DeviceWarrantyCard from "./DeviceWarrantyCard";
import DeviceUserIdleStat from "./DeviceUserIdleStat";
import MacOSPermissionsBanner from "./MacOSPermissionsBanner";
import { navigateTo } from "@/lib/navigation";
import { OverflowTabs } from "../shared/OverflowTabs";
import DeviceBackupTab from "../backup/DeviceBackupTab";
import DeviceTicketsTab from "../tickets/DeviceTicketsTab";
import DeviceAnomaliesPanel from "./DeviceAnomaliesPanel";
import DeviceReliabilityPanel from "./DeviceReliabilityPanel";
import DeviceMonitoringTab from "./DeviceMonitoringTab";
import DeviceComplianceTab from "./DeviceComplianceTab";
import DeviceLinkedProfilesTab from "./DeviceLinkedProfilesTab";
import { useTranslation } from "react-i18next";
import "../../lib/i18n";
import { Puzzle } from "lucide-react";
import ExtensionSlotHost, {
  useExtensionSlotDescriptors,
} from "../extensions/ExtensionSlotHost";

type CoreTab =
  | "overview"
  | "details"
  | "hardware"
  | "software"
  | "patches"
  | "vulnerabilities"
  | "security"
  | "management"
  | "effective-config"
  | "onedrive"
  | "alerts"
  | "anomalies"
  | "scripts"
  | "performance"
  | "eventlog"
  | "monitoring"
  | "compliance"
  | "activities"
  | "connections"
  | "filesystem"
  | "ip-history"
  | "change-history"
  | "boot-performance"
  | "playbooks"
  | "peripherals"
  | "backup"
  | "linked-profiles"
  | "tickets";

/**
 * Extension-contributed `device.detail.tabs` tab id:
 * `ext:<extensionName>:<contributionId>` (contributionId is
 * ExtensionSlotDescriptor.key without the extension-name prefix duplicated —
 * see `ExtensionSlotDescriptor.key`, which this literally embeds via
 * `` `ext:${descriptor.key}` ``). Existence is NOT tracked in this closed
 * union — the registry (via `useExtensionSlotDescriptors`) is the source of
 * truth. An `ext:...` id with no matching enabled descriptor (extension
 * disabled/withdrawn after the hash was set) simply renders nothing, same
 * no-oracle posture as ExtensionPageHost.
 */
type ExtTab = `ext:${string}`;

type Tab = CoreTab | ExtTab;

type DeviceDetailsProps = {
  device: Device;
  timezone?: string;
  onBack?: () => void;
  onAction?: (action: string, device: Device) => void;
};

const statusColors: Record<DeviceStatus, string> = {
  online: "bg-success/15 text-success border-success/30",
  offline: "bg-destructive/15 text-destructive border-destructive/30",
  maintenance: "bg-warning/15 text-warning border-warning/30",
  decommissioned: "bg-muted text-muted-foreground border-border",
  quarantined: "bg-warning/15 text-warning border-warning/30",
  updating: "bg-info/15 text-info border-info/30",
  pending: "bg-muted text-muted-foreground border-border",
};

const statusLabels: Record<DeviceStatus, string> = {
  online: "Online",
  offline: "Offline",
  maintenance: "Maintenance",
  decommissioned: "Decommissioned",
  quarantined: "Quarantined",
  updating: "Updating",
  pending: "Pending",
};

function formatLastSeen(dateString: string, timezone?: string): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;

  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString(
    [],
    timezone ? { timeZone: timezone } : undefined,
  );
}

const VALID_TABS: CoreTab[] = [
  "overview",
  "details",
  "hardware",
  "software",
  "patches",
  "vulnerabilities",
  "security",
  "management",
  "effective-config",
  "onedrive",
  "alerts",
  "scripts",
  "performance",
  "anomalies",
  "eventlog",
  "monitoring",
  "compliance",
  "activities",
  "connections",
  "filesystem",
  "ip-history",
  "change-history",
  "boot-performance",
  "playbooks",
  "peripherals",
  "backup",
  "linked-profiles",
  "tickets",
];

// Mirrors the character set an `ExtensionSlotDescriptor.key` can contain:
// `extensionName` (packages/extension-sdk NAME_RE: `[a-z][a-z0-9-]{1,31}`)
// plus `:` plus `contributionId` (an `identifier`, or the `slot:element`
// fallback key — both draw only from `[a-z0-9._:-]`). Hash-safe: none of
// these characters are touched by `location.hash` normalization, and none
// collide with the `/` this module's own hash format uses as a separator
// (see `anomalyIdFromHash`'s sibling `<tab>/<rest>` shape).
const EXT_TAB_RE = /^ext:[a-z][a-z0-9-]{1,31}:[a-z0-9._:-]+$/;

// Pure hash parsers (leading `#` already stripped by useHashState) so they are
// SSR-safe — the hash is adopted post-mount by the hook (#2421). Exported for
// direct unit-testing of the hash round-trip without mounting the (heavy)
// full component.
export function tabFromHash(hash: string): Tab | undefined {
  const seg = hash.split("/")[0] ?? "";
  if (VALID_TABS.includes(seg as CoreTab)) return seg as CoreTab;
  if (EXT_TAB_RE.test(seg)) return seg as ExtTab;
  return undefined;
}

function anomalyIdFromHash(hash: string): string | undefined {
  const [tab, anomalyId] = hash.split("/");
  return tab === "anomalies" && anomalyId ? anomalyId : undefined;
}

export default function DeviceDetails({
  device,
  timezone,
  onBack,
  onAction,
}: DeviceDetailsProps) {
  const { t } = useTranslation("devices");
  // Enabled `device.detail.tabs` contributions, deterministically ordered.
  // Never throws — a registry failure or zero enabled contributions simply
  // appends no extension tabs (see useExtensionSlotDescriptors).
  const extensionTabDescriptors = useExtensionSlotDescriptors("device.detail.tabs", 1);
  const [activeTab, setActiveTab] = useHashState<Tab>("overview", tabFromHash);
  const [focusedAnomalyId, setFocusedAnomalyId] = useHashState<
    string | undefined
  >(undefined, anomalyIdFromHash);
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

  const switchTab = (tab: Tab) => {
    window.location.hash = tab;
    setActiveTab(tab);
    setFocusedAnomalyId(undefined);
  };

  // Use provided timezone or browser default
  const effectiveTimezone =
    timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  const tabs: {
    id: Tab;
    label: string;
    icon: React.ReactNode;
    separator?: boolean;
    title?: string;
  }[] = [
    // --- Summary ---
    {
      id: "overview",
      label: t("deviceDetails.overview"),
      icon: <Monitor className="h-4 w-4" />,
    },
    {
      id: "details",
      label: t("deviceDetails.details"),
      icon: <Info className="h-4 w-4" />,
      title: t("deviceDetails.osNetworkAndSystemDetails"),
    },
    {
      id: "linked-profiles",
      label: t("deviceDetails.linkedProfiles"),
      icon: <Link2 className="h-4 w-4" />,
      title: t("deviceDetails.multiBootOsProfilesLinkedTo"),
    },
    // --- Monitoring ---
    {
      id: "performance",
      label: t("deviceDetails.performance"),
      icon: <Activity className="h-4 w-4" />,
      separator: true,
      title: t("deviceDetails.cpuRamAndDiskUsageOver"),
    },
    {
      id: "alerts",
      label: t("deviceDetails.alerts"),
      icon: <AlertTriangle className="h-4 w-4" />,
      title: t("deviceDetails.alertHistoryForThisDevice"),
    },
    {
      id: "anomalies",
      label: t("deviceDetails.anomalies"),
      icon: <TrendingUp className="h-4 w-4" />,
      title: t("deviceDetails.metricAnomalySignalsForThisDevice"),
    },
    {
      id: "tickets",
      label: t("deviceDetails.tickets"),
      icon: <Ticket className="h-4 w-4" />,
      title: t("deviceDetails.ticketsLinkedToThisDevice"),
    },
    {
      id: "eventlog",
      label: t("deviceDetails.eventLog"),
      icon: <FileText className="h-4 w-4" />,
      title: t("deviceDetails.windowsMacosSystemEventLogs"),
    },
    {
      id: "monitoring",
      label: t("deviceDetails.monitoring"),
      icon: <HeartPulse className="h-4 w-4" />,
      title: t("deviceDetails.serviceProcessWatchResultsFromConfiguration"),
    },
    {
      id: "compliance",
      label: t("deviceDetails.compliance"),
      icon: <ShieldCheck className="h-4 w-4" />,
      title: t("deviceDetails.perDeviceConfigurationPolicyComplianceResults"),
    },
    // --- Inventory ---
    {
      id: "hardware",
      label: t("deviceDetails.hardware"),
      icon: <Cpu className="h-4 w-4" />,
      separator: true,
    },
    {
      id: "software",
      label: t("deviceDetails.software"),
      icon: <Package className="h-4 w-4" />,
    },
    {
      id: "patches",
      label: t("deviceDetails.patches"),
      icon: <CheckCircle className="h-4 w-4" />,
      title: t("deviceDetails.osUpdateAndPatchStatus"),
    },
    {
      id: "vulnerabilities",
      label: t("deviceDetails.vulnerabilities"),
      icon: <Bug className="h-4 w-4" />,
      title: t("deviceDetails.cvesDetectedOnThisDevice"),
    },
    {
      id: "peripherals",
      label: t("deviceDetails.peripherals"),
      icon: <Usb className="h-4 w-4" />,
      title: t("deviceDetails.usbBluetoothAndConnectedDevices"),
    },
    // --- Management ---
    {
      id: "scripts",
      label: t("deviceDetails.scripts"),
      icon: <Terminal className="h-4 w-4" />,
      separator: true,
      title: t("deviceDetails.scriptExecutionHistory"),
    },
    {
      id: "management",
      label: t("deviceDetails.management"),
      icon: <Server className="h-4 w-4" />,
      title: t("deviceDetails.agentSettingsAndDeviceManagement"),
    },
    {
      id: "effective-config",
      label: t("deviceDetails.config"),
      icon: <Layers className="h-4 w-4" />,
      title: t("deviceDetails.resolvedConfigurationFromAllAssignedPolicies"),
    },
    {
      id: "onedrive",
      label: "OneDrive",
      icon: <Cloud className="h-4 w-4" />,
      title: "OneDrive",
    },
    {
      id: "security",
      label: t("deviceDetails.security"),
      icon: <Shield className="h-4 w-4" />,
    },
    {
      id: "playbooks",
      label: t("deviceDetails.playbooks"),
      icon: <Activity className="h-4 w-4" />,
      title: t("deviceDetails.automatedRemediationPlaybookRuns"),
    },
    // --- History & Network ---
    {
      id: "activities",
      label: t("deviceDetails.activities"),
      icon: <ScrollText className="h-4 w-4" />,
      separator: true,
      title: t("deviceDetails.auditLogForThisDevice"),
    },
    {
      id: "connections",
      label: t("deviceDetails.connections"),
      icon: <Network className="h-4 w-4" />,
      title: t("deviceDetails.activeNetworkConnections"),
    },
    {
      id: "ip-history",
      label: t("deviceDetails.ipHistory"),
      icon: <Network className="h-4 w-4" />,
      title: t("deviceDetails.historicalPublicAndPrivateIpAddresses"),
    },
    {
      id: "change-history",
      label: t("deviceDetails.changeHistory"),
      icon: <History className="h-4 w-4" />,
      title: t("deviceDetails.changeHistoryTitle"),
    },
    {
      id: "filesystem",
      label: t("deviceDetails.diskCleanup"),
      icon: <HardDrive className="h-4 w-4" />,
      title: t("deviceDetails.diskUsageAnalysisAndCleanup"),
    },
    {
      id: "boot-performance",
      label: t("deviceDetails.bootPerf"),
      icon: <Timer className="h-4 w-4" />,
      title: t("deviceDetails.startupTimeAndBootProcessAnalysis"),
    },
    {
      id: "backup",
      label: t("deviceDetails.backup"),
      icon: <Database className="h-4 w-4" />,
      title: t("deviceDetails.backupStatusJobsSnapshotsAndVerification"),
    },
    // --- Runtime extensions (device.detail.tabs@1) ---
    // Appended last, after every core tab; `extensionTabDescriptors` is
    // already deterministically ordered (order -> extension name ->
    // contribution id), so this preserves that order here too.
    ...extensionTabDescriptors.map((descriptor, index) => ({
      id: `ext:${descriptor.key}` as ExtTab,
      label: descriptor.label ?? descriptor.extensionName,
      icon: <Puzzle className="h-4 w-4" />,
      separator: index === 0,
    })),
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
                <h1
                  className="truncate text-xl font-semibold tracking-tight"
                  title={device.displayName || device.hostname}
                >
                  {device.displayName || device.hostname}
                </h1>
                <span
                  className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-1 text-xs font-medium ${statusColors[device.status]}`}
                >
                  {statusLabels[device.status]}
                </span>
                {device.pendingReboot && (
                  <span
                    data-testid="device-pending-reboot-badge"
                    title={t("deviceDetails.theOsReportsAPendingReboot")}
                    className="inline-flex shrink-0 items-center rounded-full border px-2.5 py-1 text-xs font-medium bg-warning/15 text-warning border-warning/30"
                  >
                    {t("deviceDetails.rebootPending")}{" "}
                  </span>
                )}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                <span>
                  {formatDeviceSummaryOs(device.os, device.osVersion)}
                </span>
                <span>
                  {t("deviceDetails.agentV")}
                  {device.agentVersion}
                </span>
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

      <OverflowTabs
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={(id) => switchTab(id as Tab)}
      />

      {activeTab === "overview" && (
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
                  <p className="mt-1 text-lg font-semibold tabular-nums">
                    {formatPercent(device.cpuPercent / 100, {
                      minimumFractionDigits: 1,
                      maximumFractionDigits: 1,
                    })}
                  </p>
                </div>
                <div className="shrink-0">
                  <div className="flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-muted-foreground">
                    <MemoryStick className="h-3.5 w-3.5" />
                    RAM
                  </div>
                  <p className="mt-1 text-lg font-semibold tabular-nums">
                    {formatPercent(device.ramPercent / 100, {
                      minimumFractionDigits: 1,
                      maximumFractionDigits: 1,
                    })}
                  </p>
                </div>
                <div className="shrink-0">
                  <div className="flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-muted-foreground">
                    <Clock className="h-3.5 w-3.5" />
                    {t("deviceDetails.uptime")}{" "}
                  </div>
                  <p className="mt-1 whitespace-nowrap text-lg font-semibold">
                    {formatUptime(device.uptimeSeconds)}
                  </p>
                </div>
              </div>
              <div
                className="hidden w-px self-stretch bg-border sm:block"
                aria-hidden="true"
              />
              <div className="flex min-w-0 flex-1 gap-x-6">
                <div className="shrink-0">
                  <div className="flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-muted-foreground">
                    <Clock className="h-3.5 w-3.5" />
                    {t("deviceDetails.lastSeen")}{" "}
                  </div>
                  <p className="mt-1 whitespace-nowrap text-lg font-semibold">
                    {formatLastSeen(device.lastSeen, effectiveTimezone)}
                  </p>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-muted-foreground">
                    <User className="h-3.5 w-3.5" />
                    {t("deviceDetails.loggedInUser")}{" "}
                  </div>
                  <p
                    className="mt-1 truncate text-lg font-semibold"
                    title={device.lastUser || undefined}
                  >
                    {device.lastUser || "—"}
                  </p>
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
              activityCollapsed ? "lg:w-11 lg:self-stretch" : "lg:w-80"
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

      {activeTab === "details" && <DeviceInfoTab deviceId={device.id} />}

      {activeTab === "linked-profiles" && (
        <DeviceLinkedProfilesTab deviceId={device.id} />
      )}

      {activeTab === "hardware" && (
        <DeviceHardwareInventory deviceId={device.id} />
      )}

      {activeTab === "software" && (
        <DeviceSoftwareInventory
          deviceId={device.id}
          timezone={effectiveTimezone}
          osType={device.os}
        />
      )}

      {activeTab === "patches" && (
        <DevicePatchStatusTab
          deviceId={device.id}
          timezone={effectiveTimezone}
          osType={device.os}
        />
      )}

      {activeTab === "vulnerabilities" && (
        <DeviceVulnerabilitiesTab
          deviceId={device.id}
          timezone={effectiveTimezone}
        />
      )}

      {activeTab === "filesystem" && (
        <DeviceFilesystemTab
          deviceId={device.id}
          osType={device.os}
          onOpenFiles={() => {
            if (onAction) {
              onAction("files", device);
              return;
            }
            void navigateTo(`/remote/files/${device.id}`);
          }}
        />
      )}

      {activeTab === "security" && (
        <DeviceSecurityTab
          deviceId={device.id}
          orgId={device.orgId}
          timezone={effectiveTimezone}
        />
      )}

      {activeTab === "peripherals" && (
        <DevicePeripheralsTab
          deviceId={device.id}
          timezone={effectiveTimezone}
        />
      )}

      {activeTab === "management" && (
        <DeviceManagementTab deviceId={device.id} />
      )}

      {activeTab === "onedrive" && (
        <DeviceOneDriveTab deviceId={device.id} />
      )}

      {activeTab === "effective-config" && (
        <DeviceEffectiveConfigTab deviceId={device.id} />
      )}

      {activeTab === "alerts" && (
        <DeviceAlertHistory deviceId={device.id} timezone={effectiveTimezone} />
      )}

      {activeTab === "anomalies" && (
        <DeviceAnomaliesPanel
          deviceId={device.id}
          focusedAnomalyId={focusedAnomalyId}
        />
      )}

      {activeTab === "tickets" && <DeviceTicketsTab deviceId={device.id} />}

      {activeTab === "scripts" && (
        <DeviceScriptHistory
          deviceId={device.id}
          timezone={effectiveTimezone}
        />
      )}

      {activeTab === "performance" && (
        <div className="space-y-6">
          <DevicePerformanceGraphs deviceId={device.id} />
          <DeviceAnomaliesPanel deviceId={device.id} compact />
        </div>
      )}

      {activeTab === "boot-performance" && (
        <DeviceBootPerformanceTab
          deviceId={device.id}
          timezone={effectiveTimezone}
        />
      )}

      {activeTab === "eventlog" && (
        <DeviceLogsTab
          deviceId={device.id}
          timezone={effectiveTimezone}
          osType={device.os}
        />
      )}

      {activeTab === "monitoring" && (
        <DeviceMonitoringTab
          deviceId={device.id}
          timezone={effectiveTimezone}
        />
      )}

      {activeTab === "compliance" && (
        <DeviceComplianceTab
          deviceId={device.id}
          timezone={effectiveTimezone}
        />
      )}

      {activeTab === "activities" && (
        <DeviceEventLogViewer
          deviceId={device.id}
          timezone={effectiveTimezone}
        />
      )}

      {activeTab === "connections" && (
        <DeviceNetworkConnections deviceId={device.id} />
      )}

      {activeTab === "ip-history" && (
        <DeviceIpHistoryTab deviceId={device.id} />
      )}

      {activeTab === "change-history" && (
        <DeviceChangeHistoryTab deviceId={device.id} />
      )}

      {activeTab === "playbooks" && (
        <DevicePlaybookHistory
          deviceId={device.id}
          timezone={effectiveTimezone}
        />
      )}

      {activeTab === "backup" && (
        <DeviceBackupTab
          deviceId={device.id}
          deviceStatus={device.status}
          timezone={effectiveTimezone}
        />
      )}

      {activeTab.startsWith("ext:") && (
        // Scoped to exactly the active extension's descriptor — never
        // mounts every enabled device.detail.tabs contribution at once.
        // CONTEXT: only the documented DeviceDetailTabContextV1 shape (no
        // full `device` object, no orgName/siteName, nothing else).
        <ExtensionSlotHost
          slot="device.detail.tabs"
          contractVersion={1}
          descriptorKey={activeTab.slice("ext:".length)}
          context={{
            contractVersion: 1,
            deviceId: device.id,
            organizationId: device.orgId,
            siteId: device.siteId,
          }}
        />
      )}
    </div>
  );
}
