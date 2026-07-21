import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchWithAuth } from "@/stores/auth";
import {
  Search,
  X,
  Check,
  FileDown,
  FileText,
  Share2,
  AlertTriangle,
} from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import {
  formatDateTime as formatUserDateTime,
  formatTime as formatUserTime,
} from "@/lib/dateTimeFormat";
import { escapeCsvCell } from "@/lib/csvExport";
import type { Device, DeviceStatus, OSType } from "./DeviceList";
import { useTranslation } from "react-i18next";
import "../../lib/i18n";

type SoftwareItem = {
  name: string;
  version?: string;
  publisher?: string;
};

type PatchStatus = "installed" | "missing" | "pending" | "unknown";

type PatchItem = {
  id: string;
  name: string;
  status: PatchStatus;
};

type MetricPoint = {
  timestamp: string;
  cpu: number;
  ram: number;
  disk: number;
};

type DeviceComparisonData = Device & {
  cpuModel: string;
  totalRam: string;
  diskTotal: string;
  software: SoftwareItem[];
  patches: PatchItem[];
  config: Record<string, string>;
  metrics: MetricPoint[];
};

type MetricKey = "cpu" | "ram" | "disk";

type TimeRange = "1h" | "6h" | "24h";

type DeviceCompareProps = {
  timezone?: string;
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

const metricColors = ["#3b82f6", "#22c55e", "#f97316", "#a855f7"];

const timeRangeOptions: Record<
  TimeRange,
  { count: number; intervalMs: number }
> = {
  "1h": { count: 12, intervalMs: 5 * 60 * 1000 },
  "6h": { count: 24, intervalMs: 15 * 60 * 1000 },
  "24h": { count: 24, intervalMs: 60 * 60 * 1000 },
};

function normalizeOs(value: unknown): OSType {
  const raw = String(value ?? "").toLowerCase();
  if (raw.includes("mac")) return "macos";
  if (
    raw.includes("lin") ||
    raw.includes("ubuntu") ||
    raw.includes("debian") ||
    raw.includes("centos")
  )
    return "linux";
  return "windows";
}

function normalizeStatus(value: unknown): DeviceStatus {
  const raw = String(value ?? "").toLowerCase();
  if (raw.includes("maint")) return "maintenance";
  if (raw.includes("offline")) return "offline";
  if (raw.includes("online")) return "online";
  return "offline";
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function formatCapacity(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim().length > 0) return value;
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  if (value < 128) return `${Math.round(value)} GB`;
  if (value < 1024) return `${Math.round(value)} GB`;
  const gb = value / (1024 * 1024 * 1024);
  if (gb >= 1) return `${Math.round(gb)} GB`;
  const mb = value / (1024 * 1024);
  if (mb >= 1) return `${Math.round(mb)} MB`;
  return `${value} B`;
}

function formatTimestamp(
  timestamp: string,
  range: TimeRange,
  timezone?: string,
): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  const tzOptions = timezone ? { timeZone: timezone } : undefined;
  switch (range) {
    case "1h":
      return formatUserTime(date, {
        hour: "2-digit",
        minute: "2-digit",
        ...tzOptions,
      });
    case "6h":
      return formatUserTime(date, {
        hour: "2-digit",
        minute: "2-digit",
        ...tzOptions,
      });
    case "24h":
      return formatUserDateTime(date, {
        weekday: "short",
        hour: "2-digit",
        ...tzOptions,
      });
    default:
      return formatUserTime(date, tzOptions);
  }
}

function formatDateTime(value: string, timezone?: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatUserDateTime(
    date,
    timezone ? { timeZone: timezone } : undefined,
  );
}

function createSeededRandom(seed: number) {
  let value = seed % 2147483647;
  if (value <= 0) value += 2147483646;
  return () => {
    value = (value * 48271) % 2147483647;
    return value / 2147483647;
  };
}

function hashSeed(input: string): number {
  return input
    .split("")
    .reduce((acc, char) => acc + char.charCodeAt(0) * 37, 0);
}

function normalizeDeviceSummary(
  raw: Record<string, unknown>,
  index: number,
  labels: { device: string; unknown: string },
): Device {
  const id = String(raw.id ?? raw.deviceId ?? raw.uuid ?? `device-${index}`);
  const hostname = String(
    raw.hostname ?? raw.displayName ?? raw.name ?? `${labels.device} ${id}`,
  );
  const os = normalizeOs(
    raw.os ?? raw.osType ?? raw.platform ?? raw.operatingSystem ?? "windows",
  );
  const osVersion = String(
    raw.osVersion ?? raw.platformVersion ?? raw.version ?? labels.unknown,
  );
  const status = normalizeStatus(
    raw.status ?? raw.state ?? raw.connectionStatus ?? "offline",
  );
  const cpu = raw.cpu as Record<string, unknown> | undefined;
  const ram = raw.ram as Record<string, unknown> | undefined;
  const agent = raw.agent as Record<string, unknown> | undefined;
  const cpuPercent = toNumber(
    raw.cpuPercent ?? raw.cpuUsage ?? cpu?.percent,
    0,
  );
  const ramPercent = toNumber(
    raw.ramPercent ?? raw.memoryUsage ?? ram?.percent,
    0,
  );
  const lastSeen = String(
    raw.lastSeen ?? raw.lastSeenAt ?? raw.seenAt ?? "2024-01-15T12:00:00.000Z",
  );
  const orgId = String(raw.orgId ?? raw.organizationId ?? "");
  const orgName = String(raw.orgName ?? raw.organizationName ?? labels.unknown);
  const siteId = String(raw.siteId ?? raw.locationId ?? "site-0");
  const siteName = String(
    raw.siteName ?? raw.location ?? raw.site ?? labels.unknown,
  );
  const agentVersion = String(
    raw.agentVersion ?? agent?.version ?? raw.agent ?? "-",
  );
  const tags = Array.isArray(raw.tags)
    ? raw.tags.map((tag) => String(tag))
    : [];

  return {
    id,
    hostname,
    os,
    osVersion,
    status,
    cpuPercent,
    ramPercent,
    lastSeen,
    orgId,
    orgName,
    siteId,
    siteName,
    agentVersion,
    tags,
  };
}

function normalizeSoftwareList(
  raw: unknown,
  unknownLabel: string,
): SoftwareItem[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (typeof item === "string") {
          return { name: item };
        }
        if (item && typeof item === "object") {
          const record = item as Record<string, unknown>;
          return {
            name: String(
              record.name ??
                record.title ??
                record.package ??
                record.app ??
                unknownLabel,
            ),
            version: record.version ? String(record.version) : undefined,
            publisher: record.publisher ? String(record.publisher) : undefined,
          };
        }
        return null;
      })
      .filter((item): item is SoftwareItem => item !== null);
  }
  if (typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    const installed = record.installedApps ?? record.apps ?? record.software;
    if (Array.isArray(installed))
      return normalizeSoftwareList(installed, unknownLabel);
  }
  return [];
}

function normalizePatchList(
  raw: unknown,
  labels: { patch: string; unknown: string },
): PatchItem[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((item, index) => {
        if (typeof item === "string") {
          return {
            id: `patch-${index}`,
            name: item,
            status: "installed",
          };
        }
        if (item && typeof item === "object") {
          const record = item as Record<string, unknown>;
          const statusRaw = String(
            record.status ?? record.state ?? record.approvalStatus ?? "unknown",
          ).toLowerCase();
          let status: PatchStatus = "unknown";
          if (statusRaw.includes("install") || statusRaw.includes("applied"))
            status = "installed";
          else if (
            statusRaw.includes("missing") ||
            statusRaw.includes("needed")
          )
            status = "missing";
          else if (
            statusRaw.includes("pending") ||
            statusRaw.includes("available")
          )
            status = "pending";
          return {
            id: String(record.id ?? record.patchId ?? `patch-${index}`),
            name: String(
              record.name ?? record.title ?? record.kb ?? labels.patch,
            ),
            status,
          };
        }
        return null;
      })
      .filter((item): item is PatchItem => item !== null);
  }
  if (typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    const installed = record.installed ?? record.approved ?? record.applied;
    const missing = record.missing ?? record.pending ?? record.available;
    const items: PatchItem[] = [];

    if (Array.isArray(installed)) {
      items.push(
        ...normalizePatchList(installed, labels).map((item) => ({
          ...item,
          status: "installed" as PatchStatus,
        })),
      );
    }
    if (Array.isArray(missing)) {
      items.push(
        ...normalizePatchList(missing, labels).map((item) => ({
          ...item,
          status: "missing" as PatchStatus,
        })),
      );
    }
    if (items.length > 0) return items;
  }
  return [];
}

function normalizeConfig(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};
  return Object.entries(raw as Record<string, unknown>).reduce<
    Record<string, string>
  >((acc, [key, value]) => {
    if (value === undefined) return acc;
    if (typeof value === "string" && value.trim().length > 0) {
      acc[key] = value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      acc[key] = String(value);
    } else {
      acc[key] = JSON.stringify(value);
    }
    return acc;
  }, {});
}

function normalizeMetrics(raw: unknown): MetricPoint[] {
  const points: MetricPoint[] = [];
  if (Array.isArray(raw)) {
    raw.forEach((item) => {
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        const timestamp = String(
          record.timestamp ?? record.time ?? record.at ?? "",
        );
        if (!timestamp) return;
        points.push({
          timestamp,
          cpu: toNumber(record.cpu ?? record.cpuPercent ?? record.cpu_usage, 0),
          ram: toNumber(
            record.ram ?? record.ramPercent ?? record.memory_usage,
            0,
          ),
          disk: toNumber(
            record.disk ?? record.diskPercent ?? record.storage_usage,
            0,
          ),
        });
      }
    });
  } else if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    const candidates =
      record.points ?? record.samples ?? record.history ?? record.data;
    if (Array.isArray(candidates)) return normalizeMetrics(candidates);
  }
  return points;
}

// Fixed base timestamp for deterministic metric generation (avoids hydration mismatch)
const FIXED_BASE_TIMESTAMP = Date.now();

function generateMetrics(device: Device, range: TimeRange): MetricPoint[] {
  const { count, intervalMs } = timeRangeOptions[range];
  const random = createSeededRandom(hashSeed(device.id));

  let cpu = Math.max(10, device.cpuPercent || 35);
  let ram = Math.max(20, device.ramPercent || 50);
  let disk = 40 + random() * 20;

  const points: MetricPoint[] = [];
  for (let index = count - 1; index >= 0; index -= 1) {
    cpu = Math.min(95, Math.max(5, cpu + (random() - 0.5) * 12));
    ram = Math.min(95, Math.max(10, ram + (random() - 0.5) * 8));
    disk = Math.min(90, Math.max(15, disk + (random() - 0.5) * 5));

    points.push({
      timestamp: new Date(
        FIXED_BASE_TIMESTAMP - index * intervalMs,
      ).toISOString(),
      cpu: Math.round(cpu),
      ram: Math.round(ram),
      disk: Math.round(disk),
    });
  }
  return points;
}

function deviceToComparisonData(
  device: Device,
  unknownLabel: string,
): DeviceComparisonData {
  return {
    ...device,
    cpuModel: unknownLabel,
    totalRam: unknownLabel,
    diskTotal: unknownLabel,
    software: [],
    patches: [],
    config: {},
    metrics: [],
  };
}

function normalizeDeviceDetail(
  raw: Record<string, unknown>,
  fallback: Device,
  labels: { patch: string; unknown: string },
): DeviceComparisonData {
  const source = (raw.device ?? raw.data ?? raw.item ?? raw) as Record<
    string,
    unknown
  >;
  const id = String(source.id ?? source.deviceId ?? fallback.id);
  const hostname = String(
    source.hostname ?? source.displayName ?? source.name ?? fallback.hostname,
  );
  const os = normalizeOs(
    source.os ?? source.osType ?? source.platform ?? fallback.os,
  );
  const osVersion = String(
    source.osVersion ??
      source.platformVersion ??
      fallback.osVersion ??
      labels.unknown,
  );
  const status = normalizeStatus(
    source.status ?? source.state ?? fallback.status,
  );
  const cpu = source.cpu as Record<string, unknown> | undefined;
  const memory = source.memory as Record<string, unknown> | undefined;
  const agent = source.agent as Record<string, unknown> | undefined;
  const cpuPercent = toNumber(
    source.cpuPercent ?? cpu?.percent ?? fallback.cpuPercent,
    fallback.cpuPercent,
  );
  const ramPercent = toNumber(
    source.ramPercent ?? memory?.percent ?? fallback.ramPercent,
    fallback.ramPercent,
  );
  const lastSeen = String(
    source.lastSeen ?? source.lastSeenAt ?? fallback.lastSeen,
  );
  const siteId = String(source.siteId ?? source.locationId ?? fallback.siteId);
  const siteName = String(
    source.siteName ?? source.location ?? fallback.siteName,
  );
  const agentVersion = String(
    source.agentVersion ?? agent?.version ?? fallback.agentVersion,
  );
  const tags = Array.isArray(source.tags)
    ? source.tags.map((tag) => String(tag))
    : fallback.tags;

  const hardware = (source.hardware ??
    source.specs ??
    source.system ??
    {}) as Record<string, unknown>;
  const cpuModel = String(
    hardware.cpuModel ??
      (hardware.cpu as Record<string, unknown> | undefined)?.model ??
      source.cpuModel ??
      labels.unknown,
  );
  const totalRam = formatCapacity(
    hardware.totalRam ??
      hardware.memoryTotal ??
      (hardware.memory as Record<string, unknown> | undefined)?.total ??
      source.totalRam ??
      source.ramTotal,
    labels.unknown,
  );
  const diskTotal = formatCapacity(
    hardware.diskTotal ??
      (hardware.disk as Record<string, unknown> | undefined)?.total ??
      source.diskTotal ??
      source.storageTotal,
    labels.unknown,
  );

  const softwareRecord = source.software as Record<string, unknown> | undefined;
  const software = normalizeSoftwareList(
    softwareRecord?.installedApps ?? source.installedApps ?? source.software,
    labels.unknown,
  );
  const patches = normalizePatchList(
    source.patches ??
      source.patchStatus ??
      source.patchSummary ??
      source.updates,
    labels,
  );
  const config = normalizeConfig(
    source.configuration ?? source.config ?? source.settings,
  );
  const metrics = normalizeMetrics(
    source.metrics ?? source.performance ?? source.telemetry,
  );

  return {
    id,
    hostname,
    os,
    osVersion,
    status,
    cpuPercent,
    ramPercent,
    lastSeen,
    orgId: String(source.orgId ?? source.organizationId ?? ""),
    orgName: String(
      source.orgName ?? source.organizationName ?? labels.unknown,
    ),
    siteId,
    siteName,
    agentVersion,
    tags,
    cpuModel,
    totalRam,
    diskTotal,
    software,
    patches,
    config,
    metrics,
  };
}

function getPatchStatus(patches: PatchItem[], patchName: string): PatchStatus {
  const match = patches.find((patch) => patch.name === patchName);
  return match?.status ?? "unknown";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildPdfHtml(
  selectedDevices: DeviceComparisonData[],
  osLabels: Record<OSType, string>,
  generatedDate: string,
  labels: {
    title: string;
    reportTitle: string;
    generated: string;
    specs: string;
    spec: string;
    os: string;
    cpu: string;
    ram: string;
    disk: string;
    agentVersion: string;
    software: string;
    noSoftwareData: string;
    patches: string;
    missingForDevice: (hostname: string) => string;
    none: string;
    configuration: string;
    key: string;
    unknown: string;
  },
): string {
  const safe = (value: unknown): string => escapeHtml(String(value ?? "-"));

  const specsRows = [
    {
      label: labels.os,
      getValue: (device: DeviceComparisonData) =>
        `${osLabels[device.os]} ${device.osVersion}`,
    },
    {
      label: labels.cpu,
      getValue: (device: DeviceComparisonData) =>
        device.cpuModel || labels.unknown,
    },
    {
      label: labels.ram,
      getValue: (device: DeviceComparisonData) =>
        device.totalRam || labels.unknown,
    },
    {
      label: labels.disk,
      getValue: (device: DeviceComparisonData) =>
        device.diskTotal || labels.unknown,
    },
    {
      label: labels.agentVersion,
      getValue: (device: DeviceComparisonData) =>
        device.agentVersion || labels.unknown,
    },
  ];

  const specsTableRows = specsRows
    .map(
      (row) =>
        `<tr><td>${safe(row.label)}</td>${selectedDevices.map((device) => `<td>${safe(row.getValue(device))}</td>`).join("")}</tr>`,
    )
    .join("");

  const softwareSection = selectedDevices
    .map((device) => {
      const list = device.software.map((item) => item.name).join(", ");
      return `<div><strong>${safe(device.hostname)}:</strong> ${safe(list || labels.noSoftwareData)}</div>`;
    })
    .join("");

  const patchesSection = selectedDevices
    .map((device) => {
      const missing = device.patches
        .filter((patch) => patch.status === "missing")
        .map((patch) => patch.name);
      return `<div><strong>${safe(labels.missingForDevice(device.hostname))}:</strong> ${safe(missing.join(", ") || labels.none)}</div>`;
    })
    .join("");

  const configKeys = Array.from(
    new Set(selectedDevices.flatMap((device) => Object.keys(device.config))),
  );
  const configRows = configKeys
    .map(
      (key) =>
        `<tr><td>${safe(key)}</td>${selectedDevices.map((device) => `<td>${safe(device.config[key] ?? "-")}</td>`).join("")}</tr>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html>
  <head>
    <title>${safe(labels.title)}</title>
  </head>
  <body>
    <h1>${safe(labels.reportTitle)}</h1>
    <div>${safe(labels.generated)} ${safe(generatedDate)}</div>
    <h2>${safe(labels.specs)}</h2>
    <table>
      <thead>
        <tr>
          <th>${safe(labels.spec)}</th>
          ${selectedDevices.map((device) => `<th>${safe(device.hostname)}</th>`).join("")}
        </tr>
      </thead>
      <tbody>
        ${specsTableRows}
      </tbody>
    </table>
    <h2>${safe(labels.software)}</h2>
    ${softwareSection}
    <h2>${safe(labels.patches)}</h2>
    ${patchesSection}
    <h2>${safe(labels.configuration)}</h2>
    <table>
      <thead>
        <tr>
          <th>${safe(labels.key)}</th>
          ${selectedDevices.map((device) => `<th>${safe(device.hostname)}</th>`).join("")}
        </tr>
      </thead>
      <tbody>
        ${configRows}
      </tbody>
    </table>
  </body>
</html>`;
}

export default function DeviceCompare({ timezone }: DeviceCompareProps = {}) {
  const { t } = useTranslation("devices");
  const unknownLabel = t("deviceCompare.values.unknown");
  const statusLabels: Record<DeviceStatus, string> = {
    online: t("deviceCompare.status.online"),
    offline: t("deviceCompare.status.offline"),
    maintenance: t("deviceCompare.status.maintenance"),
    decommissioned: t("deviceCompare.status.decommissioned"),
    quarantined: t("deviceCompare.status.quarantined"),
    updating: t("deviceCompare.status.updating"),
    pending: t("deviceCompare.status.pending"),
  };
  const osLabels: Record<OSType, string> = {
    windows: t("deviceCompare.operatingSystems.windows"),
    macos: t("deviceCompare.operatingSystems.macos"),
    linux: t("deviceCompare.operatingSystems.linux"),
  };
  const timeRangeLabels: Record<TimeRange, string> = {
    "1h": t("deviceCompare.timeRanges.1h"),
    "6h": t("deviceCompare.timeRanges.6h"),
    "24h": t("deviceCompare.timeRanges.24h"),
  };
  const [availableDevices, setAvailableDevices] = useState<Device[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [deviceDetails, setDeviceDetails] = useState<
    Record<string, DeviceComparisonData>
  >({});
  const [loadingDevices, setLoadingDevices] = useState(true);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [listError, setListError] = useState<string>();
  const [detailsError, setDetailsError] = useState<string>();
  const [query, setQuery] = useState("");
  const [metricKey, setMetricKey] = useState<MetricKey>("cpu");
  const [timeRange, setTimeRange] = useState<TimeRange>("6h");
  const [showAllConfig, setShowAllConfig] = useState(false);
  const [copied, setCopied] = useState(false);

  // Use provided timezone or browser default
  const effectiveTimezone =
    timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  const deviceMap = useMemo(() => {
    const map = new Map<string, Device>();
    availableDevices.forEach((device) => map.set(device.id, device));
    return map;
  }, [availableDevices]);

  const filteredDevices = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return availableDevices;
    return availableDevices.filter((device) =>
      device.hostname.toLowerCase().includes(normalizedQuery),
    );
  }, [availableDevices, query]);

  const selectedDevices = useMemo(() => {
    return selectedIds
      .map((id) => {
        if (deviceDetails[id]) return deviceDetails[id];
        const device = deviceMap.get(id);
        if (device) return deviceToComparisonData(device, unknownLabel);
        return null;
      })
      .filter((item): item is DeviceComparisonData => item !== null);
  }, [selectedIds, deviceDetails, deviceMap, unknownLabel]);

  const canCompare = selectedIds.length >= 2;
  const selectionLimitReached = selectedIds.length >= 4;

  const fetchAvailableDevices = useCallback(async () => {
    try {
      setLoadingDevices(true);
      setListError(undefined);
      const response = await fetchWithAuth("/devices");
      if (!response.ok) {
        throw new Error(t("deviceCompare.errors.fetchDevices"));
      }
      const data = await response.json();
      const items = (data.devices ??
        data.data ??
        data.items ??
        data) as unknown;
      if (!Array.isArray(items))
        throw new Error(t("deviceCompare.errors.unexpectedResponse"));
      const normalized = items.map(
        (device: Record<string, unknown>, index: number) =>
          normalizeDeviceSummary(device, index, {
            device: t("deviceCompare.values.device"),
            unknown: unknownLabel,
          }),
      );
      setAvailableDevices(normalized);
    } catch (err) {
      setAvailableDevices([]);
      setListError(
        err instanceof Error
          ? err.message
          : t("deviceCompare.failedToLoadDevices"),
      );
    } finally {
      setLoadingDevices(false);
    }
  }, [t, unknownLabel]);

  const fetchDeviceDetails = useCallback(
    async (ids: string[]) => {
      if (ids.length === 0) return;
      setLoadingDetails(true);
      setDetailsError(undefined);

      const failedIds: string[] = [];
      try {
        const results = await Promise.all(
          ids.map(async (id) => {
            const fallback = deviceMap.get(id);
            try {
              const response = await fetchWithAuth(`/devices/${id}`);
              if (!response.ok)
                throw new Error(t("deviceCompare.errors.fetchDevice"));
              const data = await response.json();
              const baseFallback: Device = fallback ?? {
                id,
                hostname: `${t("deviceCompare.values.device")} ${id}`,
                os: "windows",
                osVersion: unknownLabel,
                status: "offline",
                cpuPercent: 0,
                ramPercent: 0,
                lastSeen: new Date().toISOString(),
                orgId: "",
                orgName: unknownLabel,
                siteId: "",
                siteName: unknownLabel,
                agentVersion: "-",
                tags: [],
              };
              const normalized = normalizeDeviceDetail(
                data as Record<string, unknown>,
                baseFallback,
                {
                  patch: t("deviceCompare.values.patch"),
                  unknown: unknownLabel,
                },
              );
              return [id, normalized] as const;
            } catch {
              failedIds.push(id);
              if (fallback) {
                return [
                  id,
                  deviceToComparisonData(fallback, unknownLabel),
                ] as const;
              }
              return [id, null] as const;
            }
          }),
        );
        setDeviceDetails((prev) => {
          const next: Record<string, DeviceComparisonData> = { ...prev };
          results.forEach(([id, detail]) => {
            if (detail) {
              next[id] = detail;
            }
          });
          Object.keys(next).forEach((id) => {
            if (!ids.includes(id)) delete next[id];
          });
          return next;
        });
        if (failedIds.length > 0) {
          setDetailsError(
            t("deviceCompare.errors.detailsCount", {
              count: failedIds.length,
            }),
          );
        }
      } catch (err) {
        setDetailsError(
          err instanceof Error
            ? err.message
            : t("deviceCompare.failedToLoadDeviceDetails"),
        );
      } finally {
        setLoadingDetails(false);
      }
    },
    [deviceMap, t, unknownLabel],
  );

  useEffect(() => {
    fetchAvailableDevices();
  }, [fetchAvailableDevices]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const idsParam = params.get("ids");
    if (idsParam) {
      const ids = Array.from(
        new Set(
          idsParam
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean),
        ),
      ).slice(0, 4);
      if (ids.length > 0) {
        setSelectedIds(ids);
      }
    }
  }, []);

  useEffect(() => {
    if (availableDevices.length === 0) return;
    if (selectedIds.length === 0) {
      setSelectedIds(availableDevices.slice(0, 2).map((device) => device.id));
    }
  }, [availableDevices, selectedIds.length]);

  useEffect(() => {
    if (selectedIds.length === 0) return;
    fetchDeviceDetails(selectedIds);
  }, [selectedIds, fetchDeviceDetails]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (selectedIds.length > 0) {
      params.set("ids", selectedIds.join(","));
    } else {
      params.delete("ids");
    }
    const queryString = params.toString();
    const nextUrl = `${window.location.pathname}${queryString ? `?${queryString}` : ""}`;
    window.history.replaceState({}, "", nextUrl);
  }, [selectedIds]);

  const handleToggleDevice = (id: string) => {
    setSelectedIds((prev) => {
      if (prev.includes(id)) {
        return prev.filter((existing) => existing !== id);
      }
      if (prev.length >= 4) return prev;
      return [...prev, id];
    });
  };

  const handleClear = () => {
    setSelectedIds([]);
  };

  const handleShare = async () => {
    const url = window.location.href;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      window.prompt(t("deviceCompare.sharePrompt"), url);
    }
  };

  const handleExportCsv = () => {
    if (selectedDevices.length === 0) return;

    const rows: string[][] = [];
    const header = [
      t("deviceCompare.csv.category"),
      t("deviceCompare.csv.item"),
      ...selectedDevices.map((device) => device.hostname),
    ];
    rows.push(header);

    rows.push([
      t("deviceCompare.csv.specs"),
      t("deviceCompare.labels.os"),
      ...selectedDevices.map(
        (device) => `${osLabels[device.os]} ${device.osVersion}`,
      ),
    ]);
    rows.push([
      t("deviceCompare.csv.specs"),
      t("deviceCompare.labels.cpu"),
      ...selectedDevices.map((device) => device.cpuModel || unknownLabel),
    ]);
    rows.push([
      t("deviceCompare.csv.specs"),
      t("deviceCompare.labels.ram"),
      ...selectedDevices.map((device) => device.totalRam || unknownLabel),
    ]);
    rows.push([
      t("deviceCompare.csv.specs"),
      t("deviceCompare.labels.disk"),
      ...selectedDevices.map((device) => device.diskTotal || unknownLabel),
    ]);
    rows.push([
      t("deviceCompare.csv.specs"),
      t("deviceCompare.labels.agentVersion"),
      ...selectedDevices.map((device) => device.agentVersion || unknownLabel),
    ]);

    const commonSoftware = selectedDevices
      .map((device) => device.software.map((item) => item.name))
      .reduce<string[]>((acc, list, index) => {
        if (index === 0) return list;
        return acc.filter((item) => list.includes(item));
      }, []);
    rows.push([
      t("deviceCompare.csv.software"),
      t("deviceCompare.csv.common"),
      commonSoftware.join("; "),
    ]);
    selectedDevices.forEach((device) => {
      const unique = device.software
        .map((item) => item.name)
        .filter((name) => !commonSoftware.includes(name));
      rows.push([
        t("deviceCompare.csv.software"),
        t("deviceCompare.csv.uniqueToDevice", {
          hostname: device.hostname,
        }),
        unique.join("; "),
      ]);
    });

    selectedDevices.forEach((device) => {
      const missing = device.patches
        .filter((patch) => patch.status === "missing")
        .map((patch) => patch.name);
      rows.push([
        t("deviceCompare.csv.patches"),
        t("deviceCompare.csv.missingForDevice", {
          hostname: device.hostname,
        }),
        missing.join("; "),
      ]);
    });

    const configKeys = Array.from(
      new Set(selectedDevices.flatMap((device) => Object.keys(device.config))),
    );
    configKeys.forEach((key) => {
      rows.push([
        t("deviceCompare.csv.configuration"),
        key,
        ...selectedDevices.map((device) => device.config[key] ?? "-"),
      ]);
    });

    // Neutralize spreadsheet-formula injection from agent-supplied fields
    // (hostname/cpuModel/software/patch/config values) before quoting.
    const csv = rows
      .map((row) => row.map((value) => escapeCsvCell(value ?? "")).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    link.download = t("deviceCompare.csv.filename", {
      timestamp: Date.now(),
    });
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const handleExportPdf = () => {
    if (selectedDevices.length === 0) return;
    const generatedDate = formatDateTime(
      new Date().toISOString(),
      effectiveTimezone,
    );
    const html = buildPdfHtml(selectedDevices, osLabels, generatedDate, {
      title: t("deviceCompare.deviceComparison"),
      reportTitle: t("deviceCompare.report.title"),
      generated: t("deviceCompare.report.generated"),
      specs: t("deviceCompare.csv.specs"),
      spec: t("deviceCompare.spec"),
      os: t("deviceCompare.labels.os"),
      cpu: t("deviceCompare.labels.cpu"),
      ram: t("deviceCompare.labels.ram"),
      disk: t("deviceCompare.labels.disk"),
      agentVersion: t("deviceCompare.labels.agentVersion"),
      software: t("deviceCompare.csv.software"),
      noSoftwareData: t("deviceCompare.report.noSoftwareData"),
      patches: t("deviceCompare.csv.patches"),
      missingForDevice: (hostname) =>
        t("deviceCompare.csv.missingForDevice", { hostname }),
      none: t("deviceCompare.values.none"),
      configuration: t("deviceCompare.report.configuration"),
      key: t("deviceCompare.key"),
      unknown: unknownLabel,
    });
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const blobUrl = URL.createObjectURL(blob);
    const printWindow = window.open(blobUrl, "_blank", "width=900,height=700");
    if (!printWindow) {
      URL.revokeObjectURL(blobUrl);
      return;
    }
    printWindow.addEventListener("afterprint", () =>
      URL.revokeObjectURL(blobUrl),
    );
    printWindow.addEventListener("load", () => {
      printWindow.focus();
      printWindow.print();
    });
  };

  const softwareComparison = useMemo(() => {
    const namesByDevice = new Map<string, string[]>();
    selectedDevices.forEach((device) => {
      const names = Array.from(
        new Set(device.software.map((item) => item.name)),
      ).sort();
      namesByDevice.set(device.id, names);
    });

    const deviceLists = Array.from(namesByDevice.values());
    const common =
      deviceLists.length > 0
        ? deviceLists.reduce((acc, list, index) => {
            if (index === 0) return list;
            return acc.filter((item) => list.includes(item));
          }, [] as string[])
        : [];

    const uniqueByDevice: Record<string, string[]> = {};
    selectedDevices.forEach((device) => {
      const names = namesByDevice.get(device.id) ?? [];
      uniqueByDevice[device.id] = names.filter(
        (name) => !common.includes(name),
      );
    });

    return { common, uniqueByDevice };
  }, [selectedDevices]);

  const patchNames = useMemo(() => {
    const set = new Set<string>();
    selectedDevices.forEach((device) => {
      device.patches.forEach((patch) => set.add(patch.name));
    });
    return Array.from(set);
  }, [selectedDevices]);

  const configRows = useMemo(() => {
    const keys = Array.from(
      new Set(selectedDevices.flatMap((device) => Object.keys(device.config))),
    ).sort();
    return keys
      .map((key) => {
        const values = selectedDevices.map(
          (device) => device.config[key] ?? "-",
        );
        const isSame = values.every((value) => value === values[0]);
        return { key, values, isSame };
      })
      .filter((row) => showAllConfig || !row.isSame);
  }, [selectedDevices, showAllConfig]);

  const metricsByDevice = useMemo(() => {
    const result: Record<string, MetricPoint[]> = {};
    selectedDevices.forEach((device) => {
      const existing =
        device.metrics.length > 0
          ? device.metrics
          : generateMetrics(device, timeRange);
      const sliced = existing.slice(-timeRangeOptions[timeRange].count);
      result[device.id] =
        sliced.length > 0 ? sliced : generateMetrics(device, timeRange);
    });
    return result;
  }, [selectedDevices, timeRange]);

  const chartData = useMemo(() => {
    if (selectedDevices.length === 0) return [];
    const baseId = selectedDevices[0].id;
    const timeline = metricsByDevice[baseId] ?? [];

    return timeline.map((point, index) => {
      const row: Record<string, string | number> = {
        timestamp: point.timestamp,
      };
      selectedDevices.forEach((device) => {
        const series = metricsByDevice[device.id] ?? [];
        const value = series[index]?.[metricKey] ?? 0;
        row[device.id] = value;
      });
      return row;
    });
  }, [selectedDevices, metricsByDevice, metricKey]);

  if (loadingDevices) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">
            {t("deviceCompare.loadingDevices")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            {t("deviceCompare.deviceComparison")}
          </h1>
          <p className="text-muted-foreground">
            {t(
              "deviceCompare.compareHardwareSoftwarePatchesAndConfiguration",
            )}{" "}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleExportPdf}
            className="inline-flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm font-medium shadow-xs hover:bg-muted"
          >
            <FileText className="h-4 w-4" />
            {t("deviceCompare.exportPdf")}{" "}
          </button>
          <button
            type="button"
            onClick={handleExportCsv}
            className="inline-flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm font-medium shadow-xs hover:bg-muted"
          >
            <FileDown className="h-4 w-4" />
            {t("deviceCompare.exportCsv")}{" "}
          </button>
          <button
            type="button"
            onClick={handleShare}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground shadow-xs hover:opacity-90"
          >
            <Share2 className="h-4 w-4" />
            {copied
              ? t("deviceCompare.linkCopied")
              : t("deviceCompare.shareLink")}
          </button>
        </div>
      </div>

      {listError && (
        <div className="flex items-center justify-between rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>
              {t("deviceCompare.failedToLoadDevices2")} {listError}
            </span>
          </div>
          <button
            type="button"
            onClick={fetchAvailableDevices}
            className="shrink-0 rounded-md border border-destructive/40 px-3 py-1.5 text-xs font-medium hover:bg-destructive/10"
          >
            {t("deviceCompare.retry")}{" "}
          </button>
        </div>
      )}

      <div className="rounded-lg border bg-card p-6 shadow-xs">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-4 lg:max-w-xl">
            <div>
              <h2 className="text-lg font-semibold">
                {t("deviceCompare.selectDevices24")}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t("deviceCompare.chooseTheDevicesYouWantTo")}{" "}
              </p>
            </div>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                placeholder={t("deviceCompare.searchByHostname")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-10 w-full rounded-md border bg-background pl-9 pr-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="max-h-72 space-y-2 overflow-auto pr-1">
              {filteredDevices.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t("deviceCompare.noDevicesMatchYourSearch")}
                </p>
              ) : (
                filteredDevices.map((device) => {
                  const isSelected = selectedIds.includes(device.id);
                  const disabled = !isSelected && selectionLimitReached;

                  return (
                    <button
                      key={device.id}
                      type="button"
                      disabled={disabled}
                      onClick={() => handleToggleDevice(device.id)}
                      className={`flex w-full items-center justify-between rounded-md border p-3 text-left transition ${
                        isSelected
                          ? "border-primary/50 bg-primary/5"
                          : "border-muted hover:border-primary/30 hover:bg-muted/40"
                      } ${disabled ? "opacity-50" : ""}`}
                    >
                      <div className="flex items-start gap-3">
                        <div
                          className={`mt-1 h-2.5 w-2.5 rounded-full ${
                            device.status === "online"
                              ? "bg-green-500"
                              : device.status === "maintenance"
                                ? "bg-yellow-500"
                                : "bg-red-500"
                          }`}
                        />
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-medium">
                              {device.hostname}
                            </span>
                            <span
                              className={`rounded-full border px-2 py-0.5 text-xs ${statusColors[device.status]}`}
                            >
                              {statusLabels[device.status]}
                            </span>
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground">
                            {osLabels[device.os]} {device.osVersion} ·{" "}
                            {device.siteName}
                          </div>
                        </div>
                      </div>
                      {isSelected ? (
                        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary text-primary-foreground">
                          <Check className="h-4 w-4" />
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {disabled
                            ? t("deviceCompare.limitReached")
                            : t("deviceCompare.add")}
                        </span>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          </div>

          <div className="w-full space-y-4 lg:max-w-sm">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">
                {t("deviceCompare.selectedDevices")}
              </h3>
              <button
                type="button"
                onClick={handleClear}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                {t("deviceCompare.clearAll")}{" "}
              </button>
            </div>
            {selectedIds.length === 0 ? (
              <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                {t("deviceCompare.selectAtLeastTwoDevicesTo")}{" "}
              </div>
            ) : (
              <div className="space-y-2">
                {selectedDevices.map((device) => (
                  <div
                    key={device.id}
                    className="flex items-center justify-between rounded-md border px-3 py-2"
                  >
                    <div>
                      <div className="text-sm font-medium">
                        {device.hostname}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {osLabels[device.os]} {device.osVersion}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleToggleDevice(device.id)}
                      className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                      aria-label={t("deviceCompare.removeDevice", {
                        hostname: device.hostname,
                      })}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div
              className={`rounded-md border p-3 text-xs ${canCompare ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700" : "border-muted text-muted-foreground"}`}
            >
              {canCompare
                ? t("deviceCompare.readyToCompare", {
                    count: selectedIds.length,
                  })
                : t("deviceCompare.selectAtLeastTwoDevicesTo2")}
            </div>
          </div>
        </div>
      </div>

      {detailsError && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          {detailsError}
        </div>
      )}

      {loadingDetails && (
        <div className="flex items-center gap-3 rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          {t("deviceCompare.fetchingComparisonData")}{" "}
        </div>
      )}

      {canCompare && (
        <>
          <div className="rounded-lg border bg-card p-6 shadow-xs">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold">
                  {t("deviceCompare.specsAtAGlance")}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {t("deviceCompare.sideBySideHardwareAndAgent")}
                </p>
              </div>
              <span className="text-xs text-muted-foreground">
                {t("deviceCompare.deviceCount", {
                  count: selectedIds.length,
                })}
              </span>
            </div>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40">
                  <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <th className="py-2">{t("deviceCompare.spec")}</th>
                    {selectedDevices.map((device) => (
                      <th key={device.id} className="py-2">
                        {device.hostname}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[
                    {
                      label: t("deviceCompare.os"),
                      value: (device: DeviceComparisonData) =>
                        `${osLabels[device.os]} ${device.osVersion}`,
                    },
                    {
                      label: t("deviceCompare.labels.cpu"),
                      value: (device: DeviceComparisonData) =>
                        device.cpuModel || unknownLabel,
                    },
                    {
                      label: t("deviceCompare.labels.ram"),
                      value: (device: DeviceComparisonData) =>
                        device.totalRam || unknownLabel,
                    },
                    {
                      label: t("deviceCompare.disk"),
                      value: (device: DeviceComparisonData) =>
                        device.diskTotal || unknownLabel,
                    },
                    {
                      label: t("deviceCompare.agentVersion"),
                      value: (device: DeviceComparisonData) =>
                        device.agentVersion || unknownLabel,
                    },
                  ].map((row) => (
                    <tr key={row.label} className="border-b last:border-0">
                      <td className="py-3 font-medium text-muted-foreground">
                        {row.label}
                      </td>
                      {selectedDevices.map((device) => (
                        <td key={device.id} className="py-3">
                          {row.value(device)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-xs">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold">
                  {t("deviceCompare.softwareDiff")}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {t("deviceCompare.commonPackagesAndSoftwareUniqueTo")}
                </p>
              </div>
              <span className="text-xs text-muted-foreground">
                {softwareComparison.common.length}{" "}
                {t("deviceCompare.commonApps")}
              </span>
            </div>
            <div className="mt-4 grid gap-4 lg:grid-cols-3">
              <div className="rounded-md border bg-muted/30 p-4">
                <h3 className="text-sm font-semibold">
                  {t("deviceCompare.commonSoftware")}
                </h3>
                {softwareComparison.common.length === 0 ? (
                  <p className="mt-3 text-xs text-muted-foreground">
                    {t("deviceCompare.noSharedSoftwareDetected")}
                  </p>
                ) : (
                  <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
                    {softwareComparison.common.map((name) => (
                      <li key={name}>{name}</li>
                    ))}
                  </ul>
                )}
              </div>
              {selectedDevices.map((device) => {
                const unique =
                  softwareComparison.uniqueByDevice[device.id] ?? [];
                return (
                  <div key={device.id} className="rounded-md border p-4">
                    <h3 className="text-sm font-semibold">
                      {t("deviceCompare.uniqueTo")} {device.hostname}
                    </h3>
                    {unique.length === 0 ? (
                      <p className="mt-3 text-xs text-muted-foreground">
                        {t("deviceCompare.noUniqueSoftware")}
                      </p>
                    ) : (
                      <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
                        {unique.map((name) => (
                          <li key={name}>{name}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-xs">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold">
                  {t("deviceCompare.patchStatusComparison")}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {t("deviceCompare.trackMissingAndInstalledPatchesPer")}
                </p>
              </div>
              <span className="text-xs text-muted-foreground">
                {patchNames.length} {t("deviceCompare.patchesTracked")}
              </span>
            </div>
            <div className="mt-4 grid gap-4 lg:grid-cols-3">
              {selectedDevices.map((device) => {
                const installed = device.patches.filter(
                  (patch) => patch.status === "installed",
                ).length;
                const missing = device.patches.filter(
                  (patch) => patch.status === "missing",
                ).length;
                const pending = device.patches.filter(
                  (patch) => patch.status === "pending",
                ).length;
                return (
                  <div key={device.id} className="rounded-md border p-4">
                    <h3 className="text-sm font-semibold">{device.hostname}</h3>
                    <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                      <div className="rounded-md bg-emerald-500/10 px-2 py-1 text-emerald-700">
                        {installed} {t("deviceCompare.installed")}
                      </div>
                      <div className="rounded-md bg-amber-500/10 px-2 py-1 text-amber-700">
                        {pending} {t("deviceCompare.pending")}
                      </div>
                      <div className="rounded-md bg-red-500/10 px-2 py-1 text-red-700">
                        {missing} {t("deviceCompare.missing")}
                      </div>
                    </div>
                    <div className="mt-3 text-xs text-muted-foreground">
                      {t("deviceCompare.missing2")}{" "}
                      {device.patches
                        .filter((patch) => patch.status === "missing")
                        .map((patch) => patch.name)
                        .join(", ") || t("deviceCompare.values.none")}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-6 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40">
                  <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <th className="py-2">{t("deviceCompare.patch")}</th>
                    {selectedDevices.map((device) => (
                      <th key={device.id} className="py-2">
                        {device.hostname}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {patchNames.length === 0 ? (
                    <tr>
                      <td
                        colSpan={selectedDevices.length + 1}
                        className="py-4 text-center text-sm text-muted-foreground"
                      >
                        {t("deviceCompare.noPatchDataAvailable")}{" "}
                      </td>
                    </tr>
                  ) : (
                    patchNames.map((patch) => (
                      <tr key={patch} className="border-b last:border-0">
                        <td className="py-3 font-medium text-muted-foreground">
                          {patch}
                        </td>
                        {selectedDevices.map((device) => {
                          const status = getPatchStatus(device.patches, patch);
                          const statusLabel =
                            status === "installed"
                              ? t("deviceCompare.installed2")
                              : status === "missing"
                                ? t("deviceCompare.missing3")
                                : status === "pending"
                                  ? t("deviceCompare.pending2")
                                  : t("deviceCompare.unknown");
                          const statusStyle =
                            status === "installed"
                              ? "text-emerald-700"
                              : status === "missing"
                                ? "text-red-700"
                                : status === "pending"
                                  ? "text-amber-700"
                                  : "text-muted-foreground";

                          return (
                            <td
                              key={device.id}
                              className={`py-3 ${statusStyle}`}
                            >
                              {statusLabel}
                            </td>
                          );
                        })}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-xs">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold">
                  {t("deviceCompare.configurationDiff")}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {t("deviceCompare.compareConfigurationValuesAcrossDevices")}
                </p>
              </div>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={showAllConfig}
                  onChange={(event) => setShowAllConfig(event.target.checked)}
                  className="h-4 w-4 rounded border"
                />
                {t("deviceCompare.showAllKeys")}{" "}
              </label>
            </div>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/40">
                  <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    <th className="py-2">{t("deviceCompare.key")}</th>
                    {selectedDevices.map((device) => (
                      <th key={device.id} className="py-2">
                        {device.hostname}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {configRows.length === 0 ? (
                    <tr>
                      <td
                        colSpan={selectedDevices.length + 1}
                        className="py-4 text-center text-sm text-muted-foreground"
                      >
                        {t(
                          "deviceCompare.noConfigurationDifferencesDetected",
                        )}{" "}
                      </td>
                    </tr>
                  ) : (
                    configRows.map((row) => (
                      <tr
                        key={row.key}
                        className={`border-b last:border-0 ${row.isSame ? "" : "bg-muted/30"}`}
                      >
                        <td className="py-3 font-medium text-muted-foreground">
                          {row.key}
                        </td>
                        {row.values.map((value, index) => (
                          <td
                            key={`${row.key}-${selectedDevices[index].id}`}
                            className="py-3"
                          >
                            {value}
                          </td>
                        ))}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-xs">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold">
                  {t("deviceCompare.performanceComparison")}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {t("deviceCompare.compareCpuRamAndDiskUtilization")}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex rounded-md border">
                  {(["cpu", "ram", "disk"] as MetricKey[]).map((key) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setMetricKey(key)}
                      className={`px-3 py-1.5 text-xs font-medium transition ${
                        metricKey === key
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {key.toUpperCase()}
                    </button>
                  ))}
                </div>
                <select
                  value={timeRange}
                  onChange={(event) =>
                    setTimeRange(event.target.value as TimeRange)
                  }
                  className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                >
                  {Object.entries(timeRangeOptions).map(([value]) => (
                    <option key={value} value={value}>
                      {timeRangeLabels[value as TimeRange]}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="mt-6 h-80">
              {chartData.length === 0 ? (
                <div className="flex h-full items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
                  {t("deviceCompare.noPerformanceDataAvailable")}{" "}
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData}>
                    <CartesianGrid
                      strokeDasharray="3 3"
                      className="stroke-muted"
                    />
                    <XAxis
                      dataKey="timestamp"
                      tickFormatter={(value) =>
                        formatTimestamp(
                          value as string,
                          timeRange,
                          effectiveTimezone,
                        )
                      }
                      tick={{ fontSize: 12 }}
                      className="text-muted-foreground"
                    />
                    <YAxis
                      domain={[0, 100]}
                      tick={{ fontSize: 12 }}
                      className="text-muted-foreground"
                      tickFormatter={(value) => `${value}%`}
                      width={40}
                    />
                    <Tooltip
                      wrapperClassName="chart-tooltip"
                      labelFormatter={(value) =>
                        formatDateTime(String(value), effectiveTimezone)
                      }
                      formatter={(value, name) => [
                        `${value}%`,
                        name,
                      ]}
                    />
                    <Legend
                      formatter={(value) => {
                        const device = selectedDevices.find(
                          (item) => item.id === value,
                        );
                        return device?.hostname ?? value;
                      }}
                    />
                    {selectedDevices.map((device, index) => (
                      <Line
                        key={device.id}
                        type="monotone"
                        dataKey={device.id}
                        stroke={metricColors[index % metricColors.length]}
                        strokeWidth={2}
                        dot={false}
                        name={device.hostname}
                        activeDot={{ r: 4 }}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </>
      )}

      {!canCompare && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-700">
          <AlertTriangle className="mt-0.5 h-4 w-4" />
          {t("deviceCompare.selectAtLeastTwoDevicesTo3")}{" "}
        </div>
      )}
    </div>
  );
}
