import { useState, useEffect, useCallback } from "react";
import {
  HardDrive,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  CheckCircle2,
  XCircle,
  Cloud,
  FolderOpen,
  Server,
  Clock,
  Shield,
} from "lucide-react";
import { deriveS3RegionFromEndpoint } from "@breeze/shared";
import type { FeatureTabProps } from "./types";
import { FEATURE_META } from "./types";
import { useFeatureLink } from "./useFeatureLink";
import FeatureTabShell from "./FeatureTabShell";
import { fetchWithAuth } from "../../../stores/auth";
import { extractApiError } from "@/lib/apiError";
import { formatDateTime } from "@/lib/dateTimeFormat";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
// ── Types ──────────────────────────────────────────────────────────────────────
type ScheduleFrequency = "daily" | "weekly" | "monthly";
type RetentionPreset = "standard" | "extended" | "compliance" | "custom";
type BackupProvider = "s3" | "local";
type ImmutabilityMode = "none" | "application" | "provider";
type BackupScheduleSettings = {
  scheduleFrequency: ScheduleFrequency;
  scheduleTime: string;
  scheduleDayOfWeek: number;
  scheduleDayOfMonth: number;
  retentionPreset: RetentionPreset;
  retentionDays: number;
  retentionVersions: number;
  compression: boolean;
  encryption: boolean;
  paths: string[];
  excludePatterns: string[];
  notifyOnFailure: boolean;
  notifyOnSuccess: boolean;
  notifyOnMissed: boolean;
  s3Prefix: string;
  gfsDailyRetention: number;
  gfsWeeklyRetention: number;
  gfsMonthlyRetention: number;
  gfsYearlyRetention: number;
  gfsWeeklyDayOfWeek: number;
  legalHoldEnabled: boolean;
  legalHoldReason: string;
  immutabilityMode: ImmutabilityMode;
  immutableDays: number;
  backupWindowStart: string;
  backupWindowEnd: string;
  bandwidthLimitMbps: number;
  priority: number;
};
type BackupConfig = {
  id: string;
  name: string;
  provider: string;
  enabled: boolean;
  details: Record<string, unknown>;
  providerCapabilities?: {
    objectLock: {
      supported: boolean;
      checkedAt: string;
      error: string | null;
    };
  } | null;
  createdAt: string;
  updatedAt: string;
};
type BackupInlineSettingsPayload = {
  schedule: {
    frequency: ScheduleFrequency;
    time: string;
    timezone?: string;
    dayOfWeek?: number;
    dayOfMonth?: number;
    windowStart?: string;
    windowEnd?: string;
  };
  retention: {
    preset: RetentionPreset;
    retentionDays: number;
    maxVersions: number;
    keepDaily: number;
    keepWeekly: number;
    keepMonthly: number;
    keepYearly: number;
    weeklyDay: number;
    legalHold?: boolean;
    legalHoldReason?: string;
    immutabilityMode?: ImmutabilityMode;
    immutableDays?: number;
  };
  paths: string[];
  backupMode: string;
  targets: Record<string, unknown>;
};
// ── Constants ──────────────────────────────────────────────────────────────────
// Matches the API's redaction sentinel: sending it back on PATCH keeps the stored secret.
const MASKED_SECRET = "********";
function hasStoredSecret(value: unknown): boolean {
  if (typeof value === "string") return value.length > 0;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return record.redacted === true && record.hasSecret !== false;
  }
  return false;
}
const scheduleDefaults: BackupScheduleSettings = {
  scheduleFrequency: "daily",
  scheduleTime: "03:00",
  scheduleDayOfWeek: 0,
  scheduleDayOfMonth: 1,
  retentionPreset: "standard",
  retentionDays: 30,
  retentionVersions: 5,
  compression: true,
  encryption: true,
  paths: [],
  excludePatterns: [],
  notifyOnFailure: true,
  notifyOnSuccess: false,
  notifyOnMissed: true,
  s3Prefix: "",
  gfsDailyRetention: 7,
  gfsWeeklyRetention: 4,
  gfsMonthlyRetention: 12,
  gfsYearlyRetention: 3,
  gfsWeeklyDayOfWeek: 0,
  legalHoldEnabled: false,
  legalHoldReason: "",
  immutabilityMode: "none",
  immutableDays: 30,
  backupWindowStart: "",
  backupWindowEnd: "",
  bandwidthLimitMbps: 0,
  priority: 50,
};
const createScheduleOptions = (): {
  value: ScheduleFrequency;
  label: string;
}[] => [
  {
    value: "daily",
    label: i18n.t("policies:configurationPolicies.featureTabs.backupTab.daily"),
  },
  {
    value: "weekly",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.backupTab.weekly",
    ),
  },
  {
    value: "monthly",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.backupTab.monthly",
    ),
  },
];
const createRetentionPresets = (): {
  value: RetentionPreset;
  label: string;
  days: number;
  versions: number;
}[] => [
  {
    value: "standard",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.backupTab.standard",
    ),
    days: 30,
    versions: 5,
  },
  {
    value: "extended",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.backupTab.extended",
    ),
    days: 90,
    versions: 10,
  },
  {
    value: "compliance",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.backupTab.compliance",
    ),
    days: 365,
    versions: 20,
  },
  {
    value: "custom",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.backupTab.custom",
    ),
    days: 0,
    versions: 0,
  },
];
const createDayOfWeekOptions = () => [
  {
    value: 0,
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.backupTab.sunday",
    ),
  },
  {
    value: 1,
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.backupTab.monday",
    ),
  },
  {
    value: 2,
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.backupTab.tuesday",
    ),
  },
  {
    value: 3,
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.backupTab.wednesday",
    ),
  },
  {
    value: 4,
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.backupTab.thursday",
    ),
  },
  {
    value: 5,
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.backupTab.friday",
    ),
  },
  {
    value: 6,
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.backupTab.saturday",
    ),
  },
];
const createShortDayOfWeekOptions = () => [
  {
    value: 0,
    label: i18n.t("policies:configurationPolicies.featureTabs.backupTab.sun"),
  },
  {
    value: 1,
    label: i18n.t("policies:configurationPolicies.featureTabs.backupTab.mon"),
  },
  {
    value: 2,
    label: i18n.t("policies:configurationPolicies.featureTabs.backupTab.tue"),
  },
  {
    value: 3,
    label: i18n.t("policies:configurationPolicies.featureTabs.backupTab.wed"),
  },
  {
    value: 4,
    label: i18n.t("policies:configurationPolicies.featureTabs.backupTab.thu"),
  },
  {
    value: 5,
    label: i18n.t("policies:configurationPolicies.featureTabs.backupTab.fri"),
  },
  {
    value: 6,
    label: i18n.t("policies:configurationPolicies.featureTabs.backupTab.sat"),
  },
];
const createProviderOptions = (): {
  value: BackupProvider;
  label: string;
  description: string;
  icon: typeof Cloud;
}[] => [
  {
    value: "s3",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.backupTab.amazonS3S3Compatible",
    ),
    description: i18n.t(
      "policies:configurationPolicies.featureTabs.backupTab.aWSS3MinIOWasabiBackblazeB2",
    ),
    icon: Cloud,
  },
  {
    value: "local",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.backupTab.localNetworkPath",
    ),
    description: i18n.t(
      "policies:configurationPolicies.featureTabs.backupTab.localDiskNASOrUNCShare",
    ),
    icon: Server,
  },
];
const createProviderLabels = (): Record<string, string> => ({
  s3: "Amazon S3",
  local: "Local / NAS",
});
const createCommonExclusions = () => [
  {
    pattern: "*.tmp",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.backupTab.tempFiles",
    ),
  },
  {
    pattern: "*.log",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.backupTab.logFiles",
    ),
  },
  {
    pattern: "node_modules/**",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.backupTab.nodeModules",
    ),
  },
  {
    pattern: "$RECYCLE.BIN/**",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.backupTab.recycleBin",
    ),
  },
  {
    pattern: "*.swp",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.backupTab.swapFiles",
    ),
  },
  {
    pattern: "Thumbs.db",
    label: i18n.t(
      "policies:configurationPolicies.featureTabs.backupTab.thumbsDb",
    ),
  },
];
// ── Subcomponents ──────────────────────────────────────────────────────────────
function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-md border bg-background px-4 py-3">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 items-center rounded-full border transition ${checked ? "bg-emerald-500/80" : "bg-muted"}`}
      >
        <span
          className={`inline-block h-5 w-5 rounded-full bg-white transition ${checked ? "translate-x-5" : "translate-x-1"}`}
        />
      </button>
    </div>
  );
}
function PathList({
  items,
  onAdd,
  onRemove,
  placeholder,
  label,
  pendingValue,
  onPendingChange,
}: {
  items: string[];
  onAdd: (value: string) => void;
  onRemove: (value: string) => void;
  placeholder: string;
  label: string;
  /** Optional controlled pending input so the parent can flush a typed-but-not-added value on save. */
  pendingValue?: string;
  onPendingChange?: (value: string) => void;
}) {
  const [localInput, setLocalInput] = useState("");
  const input = pendingValue ?? localInput;
  const setInput = onPendingChange ?? setLocalInput;
  const handleAdd = () => {
    const trimmed = input.trim();
    if (!trimmed || items.includes(trimmed)) return;
    onAdd(trimmed);
    setInput("");
  };
  return (
    <div>
      <div className="flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) =>
            e.key === "Enter" && (e.preventDefault(), handleAdd())
          }
          placeholder={placeholder}
          className="h-9 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
        />
        <button
          type="button"
          onClick={handleAdd}
          className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-muted"
        >
          <Plus className="h-3.5 w-3.5" />
          {i18n.t("common:actions.add")}
        </button>
      </div>
      {items.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {items.map((item) => (
            <div
              key={item}
              className="flex items-center justify-between rounded-md border bg-muted/30 px-3 py-1.5 text-sm"
            >
              <span className="truncate font-mono text-xs">{item}</span>
              <button
                type="button"
                onClick={() => onRemove(item)}
                className="ml-2 rounded p-1 hover:bg-muted"
              >
                <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            </div>
          ))}
        </div>
      )}
      {items.length === 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          {i18n.t("common:labels.no")}
          {label}
          {i18n.t(
            "policies:configurationPolicies.featureTabs.backupTab.configured",
          )}
        </p>
      )}
    </div>
  );
}
function scheduleDescription(s: BackupScheduleSettings): string {
  const time = s.scheduleTime || "03:00";
  const dayName =
    createDayOfWeekOptions().find((d) => d.value === s.scheduleDayOfWeek)?.label ??
    "Sunday";
  switch (s.scheduleFrequency) {
    case "daily":
      return `Every day at ${time} in the device's effective timezone`;
    case "weekly":
      return `Every ${dayName} at ${time} in the device's effective timezone`;
    case "monthly":
      return `Day ${s.scheduleDayOfMonth} of each month at ${time} in the device's effective timezone`;
    default:
      return "";
  }
}
function inflateSettings(
  stored?: Record<string, unknown> | null,
): BackupScheduleSettings {
  const schedule = (stored?.schedule ?? {}) as Record<string, unknown>;
  const retention = (stored?.retention ?? {}) as Record<string, unknown>;
  const targets = (stored?.targets ?? {}) as Record<string, unknown>;
  const persistedPaths = Array.isArray(stored?.paths)
    ? (stored?.paths as string[])
    : [];
  const targetPaths = Array.isArray(targets.paths)
    ? (targets.paths as string[])
    : [];
  const excludes = Array.isArray(targets.excludes)
    ? (targets.excludes as string[])
    : [];
  return {
    ...scheduleDefaults,
    scheduleFrequency:
      (schedule.frequency as ScheduleFrequency) ??
      scheduleDefaults.scheduleFrequency,
    scheduleTime: (schedule.time as string) ?? scheduleDefaults.scheduleTime,
    scheduleDayOfWeek:
      (schedule.dayOfWeek as number) ?? scheduleDefaults.scheduleDayOfWeek,
    scheduleDayOfMonth:
      (schedule.dayOfMonth as number) ?? scheduleDefaults.scheduleDayOfMonth,
    retentionPreset:
      (retention.preset as RetentionPreset) ?? scheduleDefaults.retentionPreset,
    retentionDays:
      (retention.retentionDays as number) ?? scheduleDefaults.retentionDays,
    retentionVersions:
      (retention.maxVersions as number) ?? scheduleDefaults.retentionVersions,
    paths: persistedPaths.length > 0 ? persistedPaths : targetPaths,
    excludePatterns: excludes,
    gfsDailyRetention:
      (retention.keepDaily as number) ?? scheduleDefaults.gfsDailyRetention,
    gfsWeeklyRetention:
      (retention.keepWeekly as number) ?? scheduleDefaults.gfsWeeklyRetention,
    gfsMonthlyRetention:
      (retention.keepMonthly as number) ?? scheduleDefaults.gfsMonthlyRetention,
    gfsYearlyRetention:
      (retention.keepYearly as number) ?? scheduleDefaults.gfsYearlyRetention,
    gfsWeeklyDayOfWeek:
      (retention.weeklyDay as number) ?? scheduleDefaults.gfsWeeklyDayOfWeek,
    legalHoldEnabled: retention.legalHold === true,
    legalHoldReason:
      (retention.legalHoldReason as string) ?? scheduleDefaults.legalHoldReason,
    immutabilityMode:
      (retention.immutabilityMode as ImmutabilityMode) ??
      scheduleDefaults.immutabilityMode,
    immutableDays:
      (retention.immutableDays as number) ?? scheduleDefaults.immutableDays,
    backupWindowStart:
      (schedule.windowStart as string) ?? scheduleDefaults.backupWindowStart,
    backupWindowEnd:
      (schedule.windowEnd as string) ?? scheduleDefaults.backupWindowEnd,
  };
}
function buildInlineSettings(
  settings: BackupScheduleSettings,
  backupMode: string,
  targets: Record<string, unknown>,
): BackupInlineSettingsPayload {
  const normalizedTargets =
    backupMode === "file"
      ? {
          paths: settings.paths ?? [],
          excludes: settings.excludePatterns ?? [],
        }
      : targets;
  return {
    schedule: {
      frequency: settings.scheduleFrequency,
      time: settings.scheduleTime,
      ...(settings.scheduleFrequency === "weekly"
        ? { dayOfWeek: settings.scheduleDayOfWeek }
        : {}),
      ...(settings.scheduleFrequency === "monthly"
        ? { dayOfMonth: settings.scheduleDayOfMonth }
        : {}),
      ...(settings.backupWindowStart
        ? { windowStart: settings.backupWindowStart }
        : {}),
      ...(settings.backupWindowEnd
        ? { windowEnd: settings.backupWindowEnd }
        : {}),
    },
    retention: {
      preset: settings.retentionPreset,
      retentionDays: settings.retentionDays,
      maxVersions: settings.retentionVersions,
      keepDaily: settings.gfsDailyRetention,
      keepWeekly: settings.gfsWeeklyRetention,
      keepMonthly: settings.gfsMonthlyRetention,
      keepYearly: settings.gfsYearlyRetention,
      weeklyDay: settings.gfsWeeklyDayOfWeek,
      ...(settings.legalHoldEnabled
        ? {
            legalHold: true,
            legalHoldReason: settings.legalHoldReason,
          }
        : {}),
      ...(settings.immutabilityMode !== "none"
        ? {
            immutabilityMode: settings.immutabilityMode,
            immutableDays: settings.immutableDays,
          }
        : {}),
    },
    paths: settings.paths ?? [],
    backupMode,
    targets: normalizedTargets,
  };
}
function getObjectLockCapability(config?: BackupConfig | null) {
  return config?.providerCapabilities?.objectLock ?? null;
}
function supportsProviderImmutability(config?: BackupConfig | null): boolean {
  return (
    config?.provider === "s3" &&
    getObjectLockCapability(config)?.supported === true
  );
}
function capabilitySummary(config?: BackupConfig | null): string {
  if (!config) return "Select a storage config to check provider immutability.";
  const capability = getObjectLockCapability(config);
  if (config.provider !== "s3") {
    return "Provider-enforced WORM is only available for S3-backed configs.";
  }
  if (!capability) {
    return "Run Test to verify that the selected bucket has object lock enabled.";
  }
  if (capability.supported) {
    return `Object lock verified on ${formatDateTime(capability.checkedAt)}.`;
  }
  return capability.error ?? "Object lock is not available for this config.";
}
// ── Main Component ─────────────────────────────────────────────────────────────
export default function BackupTab({
  policyId,
  existingLink,
  onLinkChanged,
  linkedPolicyId,
  parentLink,
}: FeatureTabProps) {
  useTranslation("policies");
  const scheduleOptions = createScheduleOptions();
  const retentionPresets = createRetentionPresets();
  const dayOfWeekOptions = createDayOfWeekOptions();
  const shortDayOfWeekOptions = createShortDayOfWeekOptions();
  const providerOptions = createProviderOptions();
  const providerLabels = createProviderLabels();
  const commonExclusions = createCommonExclusions();
  const { save, remove, saving, error, clearError } = useFeatureLink(policyId);
  const isInherited = !!parentLink && !existingLink;
  const effectiveLink = existingLink ?? parentLink;
  const meta = FEATURE_META.backup;
  // Config selection / creation
  const [configs, setConfigs] = useState<BackupConfig[]>([]);
  const [configsLoading, setConfigsLoading] = useState(false);
  const [selectedConfigId, setSelectedConfigId] = useState<string>(
    () => effectiveLink?.featurePolicyId ?? "",
  );
  const [mode, setMode] = useState<"select" | "create" | "edit">("select");
  // New / edited config fields
  const [editingConfigId, setEditingConfigId] = useState<string | null>(null);
  const [newConfigName, setNewConfigName] = useState("");
  const [newProvider, setNewProvider] = useState<BackupProvider>("s3");
  const [s3Bucket, setS3Bucket] = useState("");
  const [s3Region, setS3Region] = useState("us-east-1");
  const [s3RegionTouched, setS3RegionTouched] = useState(false);
  const [s3AccessKey, setS3AccessKey] = useState("");
  const [s3SecretKey, setS3SecretKey] = useState("");
  const [s3Endpoint, setS3Endpoint] = useState("");
  const [localPath, setLocalPath] = useState("/var/backups/breeze");
  const [configSaving, setConfigSaving] = useState(false);
  const [configError, setConfigError] = useState<string>();
  const [testMessage, setTestMessage] = useState<string>();
  // Typed-but-not-added backup path, flushed on save (controlled PathList input)
  const [pendingPath, setPendingPath] = useState("");
  // Connection test
  const [testStatus, setTestStatus] = useState<
    "idle" | "testing" | "success" | "failed"
  >("idle");
  // Schedule/retention inline settings
  const [settings, setSettings] = useState<BackupScheduleSettings>(() => {
    return inflateSettings(
      effectiveLink?.inlineSettings as
        | Record<string, unknown>
        | null
        | undefined,
    );
  });
  // Backup mode and targets
  const [backupMode, setBackupMode] = useState<string>(
    ((effectiveLink?.inlineSettings as Record<string, unknown>)
      ?.backupMode as string) ?? "file",
  );
  const [targets, setTargets] = useState<Record<string, unknown>>(
    ((effectiveLink?.inlineSettings as Record<string, unknown>)
      ?.targets as Record<string, unknown>) ?? {},
  );
  // ── Fetch existing configs ─────────────────────────────────────────────────
  const fetchConfigs = useCallback(async () => {
    if (!meta.fetchUrl) return;
    setConfigsLoading(true);
    try {
      const response = await fetchWithAuth(meta.fetchUrl);
      if (response.ok) {
        const payload = await response.json();
        setConfigs(
          Array.isArray(payload.data)
            ? payload.data
            : Array.isArray(payload)
              ? payload
              : [],
        );
      }
    } catch {
      // Silently fail
    } finally {
      setConfigsLoading(false);
    }
  }, [meta.fetchUrl]);
  useEffect(() => {
    fetchConfigs();
  }, [fetchConfigs]);
  useEffect(() => {
    const link = existingLink ?? parentLink;
    if (link?.featurePolicyId) setSelectedConfigId(link.featurePolicyId);
    if (link?.inlineSettings) {
      const stored = link.inlineSettings as Record<string, unknown>;
      setSettings(inflateSettings(stored));
      if (stored.backupMode) setBackupMode(stored.backupMode as string);
      if (stored.targets) setTargets(stored.targets as Record<string, unknown>);
    }
  }, [existingLink, parentLink]);
  useEffect(() => {
    if (!configsLoading && configs.length === 0 && !selectedConfigId) {
      setMode("create");
    }
  }, [configsLoading, configs.length, selectedConfigId]);
  // Reset test status when config changes
  useEffect(() => {
    setTestStatus("idle");
    setTestMessage(undefined);
  }, [selectedConfigId]);
  // ── Helpers ────────────────────────────────────────────────────────────────
  const update = <K extends keyof BackupScheduleSettings>(
    key: K,
    value: BackupScheduleSettings[K],
  ) => setSettings((prev) => ({ ...prev, [key]: value }));
  const handleRetentionPreset = (preset: RetentionPreset) => {
    update("retentionPreset", preset);
    const p = retentionPresets.find((r) => r.value === preset);
    if (p && preset !== "custom") {
      update("retentionDays", p.days);
      update("retentionVersions", p.versions);
    }
  };
  // ── Test connection ────────────────────────────────────────────────────────
  const handleTestConnection = async () => {
    if (!selectedConfigId) return;
    setTestStatus("testing");
    setTestMessage(undefined);
    try {
      const response = await fetchWithAuth(
        `/backup/configs/${selectedConfigId}/test`,
        {
          method: "POST",
        },
      );
      const data = await response.json().catch(() => ({}));
      const nextConfig = data?.config;
      if (nextConfig?.id) {
        setConfigs((prev) =>
          prev.map((config) =>
            config.id === nextConfig.id ? nextConfig : config,
          ),
        );
      }
      const capability = data?.providerCapabilities?.objectLock;
      setTestMessage(
        capability?.supported === true
          ? "Connection succeeded and object lock support was verified."
          : capability?.error || data?.error || "Connection test completed.",
      );
      setTestStatus(
        response.ok && data.status === "success" ? "success" : "failed",
      );
    } catch {
      setTestStatus("failed");
      setTestMessage(
        i18n.t(
          "policies:configurationPolicies.featureTabs.backupTab.connectionTestFailed",
        ),
      );
    }
  };
  // ── Create config via API ──────────────────────────────────────────────────
  const buildProviderDetails = (): Record<string, unknown> =>
    newProvider === "s3"
      ? {
          bucket: s3Bucket,
          region: s3Region.trim(),
          accessKey: s3AccessKey,
          secretKey: s3SecretKey,
          ...(s3Endpoint ? { endpoint: s3Endpoint } : {}),
          ...(settings.s3Prefix ? { prefix: settings.s3Prefix } : {}),
        }
      : { path: localPath };
  const createConfig = async (): Promise<string | null> => {
    setConfigError(undefined);
    setConfigSaving(true);
    try {
      const details = buildProviderDetails();
      const response = await fetchWithAuth("/backup/configs", {
        method: "POST",
        body: JSON.stringify({
          name: newConfigName,
          provider: newProvider,
          enabled: true,
          details,
        }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(
          extractApiError(
            data,
            i18n.t(
              "policies:configurationPolicies.featureTabs.backupTab.failedToCreateBackupConfig",
            ),
          ),
        );
      }
      const created = await response.json();
      const cfg = created.data ?? created;
      setConfigs((prev) => [...prev, cfg]);
      setSelectedConfigId(cfg.id);
      setMode("select");
      return cfg.id;
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : "An error occurred");
      return null;
    } finally {
      setConfigSaving(false);
    }
  };
  // ── Edit existing config ───────────────────────────────────────────────────
  const beginEditConfig = (config: BackupConfig) => {
    const details = config.details ?? {};
    setEditingConfigId(config.id);
    setNewConfigName(config.name);
    setNewProvider(config.provider === "local" ? "local" : "s3");
    setS3Bucket(typeof details.bucket === "string" ? details.bucket : "");
    const region = typeof details.region === "string" ? details.region : "";
    setS3Region(region);
    setS3RegionTouched(Boolean(region.trim()));
    setS3Endpoint(typeof details.endpoint === "string" ? details.endpoint : "");
    update("s3Prefix", typeof details.prefix === "string" ? details.prefix : "");
    setS3AccessKey(hasStoredSecret(details.accessKey) ? MASKED_SECRET : "");
    setS3SecretKey(hasStoredSecret(details.secretKey) ? MASKED_SECRET : "");
    setLocalPath(
      typeof details.path === "string" ? details.path : "/var/backups/breeze",
    );
    setConfigError(undefined);
    setMode("edit");
  };
  const updateConfig = async (): Promise<string | null> => {
    if (!editingConfigId) return null;
    setConfigError(undefined);
    setConfigSaving(true);
    try {
      const response = await fetchWithAuth(
        `/backup/configs/${editingConfigId}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            name: newConfigName,
            details: buildProviderDetails(),
          }),
        },
      );
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(
          extractApiError(
            data,
            i18n.t(
              "policies:configurationPolicies.featureTabs.backupTab.failedToUpdateBackupConfig",
            ),
          ),
        );
      }
      const updated = await response.json();
      const cfg = updated.data ?? updated;
      setConfigs((prev) => prev.map((c) => (c.id === cfg.id ? cfg : c)));
      setSelectedConfigId(cfg.id);
      setEditingConfigId(null);
      setMode("select");
      return cfg.id;
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : "An error occurred");
      return null;
    } finally {
      setConfigSaving(false);
    }
  };
  // ── Save feature link ──────────────────────────────────────────────────────
  const handleSave = async (options?: {
    downgradeInvalidProvider?: boolean;
  }) => {
    clearError();
    setConfigError(undefined);
    // File mode: commit a typed-but-not-added path, then require at least one.
    let pathsForSave = settings.paths;
    if (backupMode === "file") {
      const pending = pendingPath.trim();
      if (pending && !pathsForSave.includes(pending)) {
        pathsForSave = [...pathsForSave, pending];
        update("paths", pathsForSave);
        setPendingPath("");
      }
      if (pathsForSave.length === 0) {
        setConfigError(
          i18n.t(
            "policies:configurationPolicies.featureTabs.backupTab.addAtLeastOneBackupPath",
          ),
        );
        return;
      }
    }
    let configId = selectedConfigId;
    if (mode === "create" || mode === "edit") {
      if (!newConfigName.trim()) {
        setConfigError(
          i18n.t(
            "policies:configurationPolicies.featureTabs.backupTab.configNameIsRequired",
          ),
        );
        return;
      }
      if (newProvider === "s3" && !s3Bucket.trim()) {
        setConfigError(
          i18n.t(
            "policies:configurationPolicies.featureTabs.backupTab.s3BucketNameIsRequired",
          ),
        );
        return;
      }
      if (
        newProvider === "s3" &&
        !s3Region.trim() &&
        !deriveS3RegionFromEndpoint(s3Endpoint)
      ) {
        setConfigError(
          i18n.t(
            "policies:configurationPolicies.featureTabs.backupTab.s3RegionIsRequired",
          ),
        );
        return;
      }
      if (newProvider === "local" && !localPath.trim()) {
        setConfigError(
          i18n.t(
            "policies:configurationPolicies.featureTabs.backupTab.backupPathIsRequired",
          ),
        );
        return;
      }
      const savedId = mode === "create" ? await createConfig() : await updateConfig();
      if (!savedId) return;
      configId = savedId;
    }
    if (!configId) {
      setConfigError(
        i18n.t(
          "policies:configurationPolicies.featureTabs.backupTab.pleaseSelectOrCreateABackupConfiguration",
        ),
      );
      return;
    }
    const selected = configs.find((c) => c.id === configId);
    const providerModeInvalid =
      settings.immutabilityMode === "provider" &&
      !supportsProviderImmutability(selected);
    if (providerModeInvalid && !options?.downgradeInvalidProvider) {
      setConfigError(
        i18n.t(
          "policies:configurationPolicies.featureTabs.backupTab.providerImmutabilityCannotBeSavedUntilObject",
        ),
      );
      return;
    }
    const baseSettings = { ...settings, paths: pathsForSave };
    const settingsToSave =
      providerModeInvalid && options?.downgradeInvalidProvider
        ? {
            ...baseSettings,
            immutabilityMode: "application" as ImmutabilityMode,
          }
        : baseSettings;
    const result = await save(existingLink?.id ?? null, {
      featureType: "backup",
      featurePolicyId: configId,
      inlineSettings: buildInlineSettings(settingsToSave, backupMode, targets),
    });
    if (result) {
      if (providerModeInvalid && options?.downgradeInvalidProvider) {
        setSettings((prev) => ({ ...prev, immutabilityMode: "application" }));
      }
      onLinkChanged(result, "backup");
    }
  };
  const handleRemove = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, "backup");
  };
  const handleOverride = async () => {
    clearError();
    const result = await save(null, {
      featureType: "backup",
      featurePolicyId: selectedConfigId || null,
      inlineSettings: buildInlineSettings(settings, backupMode, targets),
    });
    if (result) onLinkChanged(result, "backup");
  };
  const handleRevert = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, "backup");
  };
  const selectedConfig = configs.find((c) => c.id === selectedConfigId);
  const isSaving = saving || configSaving;
  const combinedError = configError || error;
  const retentionInfo = retentionPresets.find(
    (p) => p.value === settings.retentionPreset,
  );
  const selectedConfigSupportsProvider =
    supportsProviderImmutability(selectedConfig);
  const invalidSavedProviderMode =
    settings.immutabilityMode === "provider" && !selectedConfigSupportsProvider;
  const selectedCapability = getObjectLockCapability(selectedConfig);
  return (
    <FeatureTabShell
      title={meta.label}
      description={meta.description}
      icon={<HardDrive className="h-5 w-5" />}
      isConfigured={!!existingLink || isInherited}
      saving={isSaving}
      error={combinedError}
      onSave={handleSave}
      onRemove={existingLink && !linkedPolicyId ? handleRemove : undefined}
      isInherited={isInherited}
      onOverride={isInherited ? handleOverride : undefined}
      onRevert={
        !isInherited && !!linkedPolicyId && !!existingLink
          ? handleRevert
          : undefined
      }
    >
      {/* ══════════════════════════════════════════════════════════════════════
              SECTION 0: Backup Type
              ══════════════════════════════════════════════════════════════════════ */}
      <div className="space-y-3">
        <label className="text-sm font-medium text-foreground">
          {i18n.t(
            "policies:configurationPolicies.featureTabs.backupTab.backupType",
          )}
        </label>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            {
              value: "file",
              label: i18n.t(
                "policies:configurationPolicies.featureTabs.backupTab.fileBackup",
              ),
            },
            {
              value: "hyperv",
              label: i18n.t(
                "policies:configurationPolicies.featureTabs.backupTab.hyperVVMs",
              ),
            },
            {
              value: "mssql",
              label: i18n.t(
                "policies:configurationPolicies.featureTabs.backupTab.sQLServer",
              ),
            },
            {
              value: "system_image",
              label: i18n.t(
                "policies:configurationPolicies.featureTabs.backupTab.systemState",
              ),
            },
          ].map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                setBackupMode(opt.value);
                setTargets({});
              }}
              className={`rounded-md border px-3 py-2 text-sm ${
                backupMode === opt.value
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-muted text-muted-foreground hover:border-muted-foreground/30"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Mode-specific target fields ──────────────────────────────────────── */}
      {backupMode === "hyperv" && (
        <div className="mt-4 space-y-4 rounded-md border bg-muted/30 p-4">
          <p className="text-xs text-muted-foreground">
            {i18n.t(
              "policies:configurationPolicies.featureTabs.backupTab.allDiscoveredVMsAreBackedUpAutomatically",
            )}
          </p>
          <p className="text-xs text-muted-foreground/70">
            {i18n.t(
              "policies:configurationPolicies.featureTabs.backupTab.backupsAreStoredInTheConfiguredStorage",
            )}
          </p>
          <div>
            <label className="text-sm font-medium text-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.backupTab.consistencyType",
              )}
            </label>
            <select
              value={(targets.consistencyType as string) ?? "application"}
              onChange={(e) =>
                setTargets({ ...targets, consistencyType: e.target.value })
              }
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            >
              <option value="application">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.backupTab.applicationConsistentVSS",
                )}
              </option>
              <option value="crash">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.backupTab.crashConsistent",
                )}
              </option>
            </select>
          </div>
          <div>
            <label className="text-sm font-medium text-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.backupTab.excludeVMs",
              )}
            </label>
            <input
              value={
                Array.isArray(targets.excludeVms)
                  ? (targets.excludeVms as string[]).join(", ")
                  : ""
              }
              onChange={(e) =>
                setTargets({
                  ...targets,
                  excludeVms: e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
              placeholder={i18n.t(
                "policies:configurationPolicies.featureTabs.backupTab.vMDev01VMTest02",
              )}
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            />
            <p className="mt-1 chart-legend-xs text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.backupTab.commaSeparatedVMNamesToSkip",
              )}
            </p>
          </div>
        </div>
      )}

      {backupMode === "mssql" && (
        <div className="mt-4 space-y-4 rounded-md border bg-muted/30 p-4">
          <p className="text-xs text-muted-foreground">
            {i18n.t(
              "policies:configurationPolicies.featureTabs.backupTab.allDiscoveredDatabasesAreBackedUpAutomatically",
            )}
          </p>
          <p className="text-xs text-muted-foreground/70">
            {i18n.t(
              "policies:configurationPolicies.featureTabs.backupTab.backupsAreStoredInTheConfiguredStorage2",
            )}
          </p>
          <div>
            <label className="text-sm font-medium text-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.backupTab.backupType2",
              )}
            </label>
            <select
              value={(targets.backupType as string) ?? "full"}
              onChange={(e) =>
                setTargets({ ...targets, backupType: e.target.value })
              }
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            >
              <option value="full">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.backupTab.full",
                )}
              </option>
              <option value="differential">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.backupTab.differential",
                )}
              </option>
              <option value="log">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.backupTab.transactionLog",
                )}
              </option>
            </select>
          </div>
          <div>
            <label className="text-sm font-medium text-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.backupTab.excludeDatabases",
              )}
            </label>
            <input
              value={
                Array.isArray(targets.excludeDatabases)
                  ? (targets.excludeDatabases as string[]).join(", ")
                  : ""
              }
              onChange={(e) =>
                setTargets({
                  ...targets,
                  excludeDatabases: e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
              placeholder={i18n.t(
                "policies:configurationPolicies.featureTabs.backupTab.tempdbModel",
              )}
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            />
            <p className="mt-1 chart-legend-xs text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.backupTab.commaSeparatedDatabaseNamesToSkip",
              )}
            </p>
          </div>
        </div>
      )}

      {backupMode === "system_image" && (
        <div className="mt-4 rounded-md border bg-muted/30 p-4">
          <div className="flex items-center justify-between rounded-md border bg-background px-4 py-3">
            <div>
              <p className="text-sm font-medium">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.backupTab.includeSystemState",
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.backupTab.captureRegistryBootFilesAndSystemComponents",
                )}
              </p>
            </div>
            <button
              type="button"
              onClick={() =>
                setTargets({
                  ...targets,
                  includeSystemState: !targets.includeSystemState,
                })
              }
              className={`relative inline-flex h-6 w-11 items-center rounded-full border transition ${targets.includeSystemState ? "bg-emerald-500/80" : "bg-muted"}`}
            >
              <span
                className={`inline-block h-5 w-5 rounded-full bg-white transition ${targets.includeSystemState ? "translate-x-5" : "translate-x-1"}`}
              />
            </button>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
              SECTION 1: Storage Configuration
              ══════════════════════════════════════════════════════════════════════ */}
      <div>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">
            {i18n.t(
              "policies:configurationPolicies.featureTabs.backupTab.storageConfiguration",
            )}
          </h3>
          {configs.length > 0 && (
            <button
              type="button"
              onClick={() => {
                if (mode === "select") {
                  setMode("create");
                } else {
                  setEditingConfigId(null);
                  setMode("select");
                }
              }}
              className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
            >
              {mode === "edit" ? (
                i18n.t("common:actions.cancel")
              ) : mode === "create" ? (
                i18n.t(
                  "policies:configurationPolicies.featureTabs.backupTab.useExistingConfig",
                )
              ) : (
                <>
                  <Plus className="h-3.5 w-3.5" />
                  {i18n.t(
                    "policies:configurationPolicies.featureTabs.backupTab.createNew",
                  )}
                </>
              )}
            </button>
          )}
        </div>

        {mode === "select" ? (
          <div className="mt-2">
            {configsLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.backupTab.loadingBackupConfigs",
                )}
              </div>
            ) : configs.length === 0 ? (
              <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.backupTab.noBackupConfigurationsYet",
                )}{" "}
                <button
                  type="button"
                  onClick={() => setMode("create")}
                  className="text-primary underline underline-offset-2"
                >
                  {i18n.t(
                    "policies:configurationPolicies.featureTabs.backupTab.createOneNow",
                  )}
                </button>
              </div>
            ) : (
              <>
                <select
                  value={selectedConfigId}
                  onChange={(e) => setSelectedConfigId(e.target.value)}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                >
                  <option value="">
                    {i18n.t(
                      "policies:configurationPolicies.featureTabs.backupTab.selectABackupConfig",
                    )}
                  </option>
                  {configs.map((cfg) => (
                    <option key={cfg.id} value={cfg.id}>
                      {cfg.name} ({providerLabels[cfg.provider] ?? cfg.provider}
                      )
                      {!cfg.enabled
                        ? i18n.t(
                            "policies:configurationPolicies.featureTabs.backupTab.disabled",
                          )
                        : ""}
                    </option>
                  ))}
                </select>

                {/* Config summary card */}
                {selectedConfig && (
                  <div className="mt-3 rounded-md border bg-muted/20 p-4">
                    <div className="flex items-start justify-between">
                      <div className="space-y-1.5">
                        <div className="flex items-center gap-2">
                          {selectedConfig.provider === "s3" ? (
                            <Cloud className="h-4 w-4 text-blue-500" />
                          ) : (
                            <Server className="h-4 w-4 text-slate-500" />
                          )}
                          <span className="text-sm font-medium">
                            {providerLabels[selectedConfig.provider] ??
                              selectedConfig.provider}
                          </span>
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                              selectedConfig.enabled
                                ? "bg-emerald-500/15 text-emerald-700"
                                : "bg-yellow-500/15 text-yellow-700"
                            }`}
                          >
                            {selectedConfig.enabled
                              ? i18n.t("common:states.active")
                              : i18n.t("common:states.disabled")}
                          </span>
                        </div>
                        {/* Show provider-specific details */}
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                          {selectedConfig.provider === "s3" &&
                            !!selectedConfig.details.bucket && (
                              <span>
                                {i18n.t(
                                  "policies:configurationPolicies.featureTabs.backupTab.bucket",
                                )}
                                <span className="font-mono text-foreground">
                                  {String(selectedConfig.details.bucket)}
                                </span>
                              </span>
                            )}
                          {selectedConfig.provider === "s3" &&
                            !!selectedConfig.details.region && (
                              <span>
                                {i18n.t(
                                  "policies:configurationPolicies.featureTabs.backupTab.region",
                                )}
                                <span className="font-mono text-foreground">
                                  {String(selectedConfig.details.region)}
                                </span>
                              </span>
                            )}
                          {selectedConfig.provider === "s3" &&
                            !!selectedConfig.details.endpoint && (
                              <span>
                                {i18n.t(
                                  "policies:configurationPolicies.featureTabs.backupTab.endpoint",
                                )}
                                <span className="font-mono text-foreground">
                                  {String(selectedConfig.details.endpoint)}
                                </span>
                              </span>
                            )}
                          {selectedConfig.provider === "local" &&
                            !!selectedConfig.details.path && (
                              <span>
                                {i18n.t(
                                  "policies:configurationPolicies.featureTabs.backupTab.path",
                                )}
                                <span className="font-mono text-foreground">
                                  {String(selectedConfig.details.path)}
                                </span>
                              </span>
                            )}
                          <span>
                            {i18n.t(
                              "policies:configurationPolicies.featureTabs.backupTab.objectLock",
                            )}{" "}
                            <span className="font-mono text-foreground">
                              {selectedConfig.provider !== "s3"
                                ? i18n.t(
                                    "policies:configurationPolicies.featureTabs.backupTab.notSupported",
                                  )
                                : selectedCapability
                                  ? selectedCapability.supported
                                    ? i18n.t(
                                        "policies:configurationPolicies.featureTabs.backupTab.verified",
                                      )
                                    : i18n.t(
                                        "policies:configurationPolicies.featureTabs.backupTab.unavailable",
                                      )
                                  : i18n.t(
                                      "policies:configurationPolicies.featureTabs.backupTab.untested",
                                    )}
                            </span>
                          </span>
                        </div>
                        {capabilitySummary(selectedConfig) !== testMessage && (
                          <p className="text-xs text-muted-foreground">
                            {capabilitySummary(selectedConfig)}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                      {/* Edit config button */}
                      <button
                        type="button"
                        onClick={() => beginEditConfig(selectedConfig)}
                        className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition hover:bg-muted"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        {i18n.t("common:actions.edit")}
                      </button>
                      {/* Test connection button */}
                      <button
                        type="button"
                        onClick={handleTestConnection}
                        disabled={testStatus === "testing"}
                        className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition hover:bg-muted disabled:opacity-50"
                      >
                        {testStatus === "testing" && (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        )}
                        {testStatus === "success" && (
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                        )}
                        {testStatus === "failed" && (
                          <XCircle className="h-3.5 w-3.5 text-destructive" />
                        )}
                        {testStatus === "idle" && (
                          <Shield className="h-3.5 w-3.5" />
                        )}
                        {testStatus === "testing"
                          ? i18n.t(
                              "policies:configurationPolicies.featureTabs.backupTab.testing2",
                            )
                          : testStatus === "success"
                            ? i18n.t(
                                "policies:configurationPolicies.featureTabs.backupTab.connected",
                              )
                            : testStatus === "failed"
                              ? i18n.t(
                                  "policies:configurationPolicies.featureTabs.backupTab.failed2",
                                )
                              : i18n.t(
                                  "policies:configurationPolicies.featureTabs.backupTab.test",
                                )}
                      </button>
                      </div>
                    </div>
                    {testMessage && (
                      <div
                        className={`mt-3 rounded-md border px-3 py-2 text-xs ${
                          testStatus === "failed"
                            ? "border-destructive/40 bg-destructive/10 text-destructive"
                            : "border-emerald-500/40 bg-emerald-500/10 text-emerald-700"
                        }`}
                      >
                        {testMessage}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          /* ── Create / edit config ─────────────────────────────────────── */
          <div className="mt-2 space-y-4 rounded-md border bg-muted/10 p-4">
            {mode === "edit" && (
              <p className="text-xs font-medium text-primary">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.backupTab.editingStorageConfiguration",
                )}
              </p>
            )}
            <div>
              <label className="text-xs font-medium text-muted-foreground">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.backupTab.configurationName",
                )}
              </label>
              <input
                value={newConfigName}
                onChange={(e) => setNewConfigName(e.target.value)}
                placeholder={i18n.t(
                  "policies:configurationPolicies.featureTabs.backupTab.eGProductionS3Backups",
                )}
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            </div>

            {/* Provider is immutable once created — hide the picker while editing */}
            {mode !== "edit" && (
            <div>
              <label className="text-xs font-medium text-muted-foreground">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.backupTab.provider",
                )}
              </label>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                {providerOptions.map((opt) => {
                  const Icon = opt.icon;
                  return (
                    <label
                      key={opt.value}
                      className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm transition ${
                        newProvider === opt.value
                          ? "border-primary/40 bg-primary/10"
                          : "border-muted hover:border-muted-foreground/30"
                      }`}
                    >
                      <input
                        type="radio"
                        name="backupProvider"
                        value={opt.value}
                        checked={newProvider === opt.value}
                        onChange={() => setNewProvider(opt.value)}
                        className="hidden"
                      />
                      <Icon
                        className={`mt-0.5 h-5 w-5 shrink-0 ${newProvider === opt.value ? "text-primary" : "text-muted-foreground"}`}
                      />
                      <div>
                        <span className="font-medium text-foreground">
                          {opt.label}
                        </span>
                        <p className="text-xs text-muted-foreground">
                          {opt.description}
                        </p>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
            )}

            {newProvider === "s3" && (
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="text-xs text-muted-foreground">
                      {i18n.t(
                        "policies:configurationPolicies.featureTabs.backupTab.bucketName",
                      )}
                    </label>
                    <input
                      value={s3Bucket}
                      onChange={(e) => setS3Bucket(e.target.value)}
                      placeholder={i18n.t(
                        "policies:configurationPolicies.featureTabs.backupTab.myBackupBucket",
                      )}
                      className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">
                      {i18n.t(
                        "policies:configurationPolicies.featureTabs.backupTab.region2",
                      )}
                    </label>
                    <input
                      value={s3Region}
                      onChange={(e) => {
                        setS3Region(e.target.value);
                        setS3RegionTouched(true);
                      }}
                      placeholder={i18n.t(
                        "policies:configurationPolicies.featureTabs.backupTab.usEast1",
                      )}
                      className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    />
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="text-xs text-muted-foreground">
                      {i18n.t(
                        "policies:configurationPolicies.featureTabs.backupTab.accessKeyID",
                      )}
                    </label>
                    <input
                      value={s3AccessKey}
                      onChange={(e) => setS3AccessKey(e.target.value)}
                      placeholder={i18n.t(
                        "policies:configurationPolicies.featureTabs.backupTab.aKIA",
                      )}
                      autoComplete="off"
                      className="mt-1 h-10 w-full rounded-md border bg-background px-3 font-mono text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">
                      {i18n.t(
                        "policies:configurationPolicies.featureTabs.backupTab.secretAccessKey",
                      )}
                    </label>
                    <input
                      type="password"
                      value={s3SecretKey}
                      onChange={(e) => setS3SecretKey(e.target.value)}
                      placeholder={i18n.t(
                        "policies:configurationPolicies.featureTabs.backupTab.secretKey",
                      )}
                      autoComplete="off"
                      className="mt-1 h-10 w-full rounded-md border bg-background px-3 font-mono text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    />
                  </div>
                </div>
                {mode === "edit" && (
                  <p className="chart-legend-xs text-muted-foreground">
                    {i18n.t(
                      "policies:configurationPolicies.featureTabs.backupTab.secretsUnchangedHint",
                    )}
                  </p>
                )}
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className="text-xs text-muted-foreground">
                      {i18n.t(
                        "policies:configurationPolicies.featureTabs.backupTab.pathPrefix",
                      )}
                      <span className="text-muted-foreground/60">
                        {i18n.t(
                          "policies:configurationPolicies.featureTabs.backupTab.optional",
                        )}
                      </span>
                    </label>
                    <input
                      value={settings.s3Prefix}
                      onChange={(e) => update("s3Prefix", e.target.value)}
                      placeholder={i18n.t(
                        "policies:configurationPolicies.featureTabs.backupTab.backupsBreeze",
                      )}
                      className="mt-1 h-10 w-full rounded-md border bg-background px-3 font-mono text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    />
                    <p className="mt-1 chart-legend-xs text-muted-foreground">
                      {i18n.t(
                        "policies:configurationPolicies.featureTabs.backupTab.keyPrefixForOrganizingObjectsInThe",
                      )}
                    </p>
                  </div>
                  <div>
                    <label className="text-xs text-muted-foreground">
                      {i18n.t(
                        "policies:configurationPolicies.featureTabs.backupTab.customEndpoint",
                      )}
                      <span className="text-muted-foreground/60">
                        {i18n.t(
                          "policies:configurationPolicies.featureTabs.backupTab.optional2",
                        )}
                      </span>
                    </label>
                    <input
                      value={s3Endpoint}
                      onChange={(e) => {
                        const value = e.target.value;
                        setS3Endpoint(value);
                        // Providers like Backblaze B2 encode the signing region
                        // in the endpoint — fill it in unless the user set one.
                        const derived = deriveS3RegionFromEndpoint(value);
                        if (derived && (!s3RegionTouched || !s3Region.trim())) {
                          setS3Region(derived);
                        }
                      }}
                      placeholder={i18n.t(
                        "policies:configurationPolicies.featureTabs.backupTab.httpsS3UsWest002Backblazeb2Com",
                      )}
                      className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    />
                    <p className="mt-1 chart-legend-xs text-muted-foreground">
                      {i18n.t(
                        "policies:configurationPolicies.featureTabs.backupTab.forMinIOWasabiBackblazeB2Etc",
                      )}
                    </p>
                  </div>
                </div>
              </div>
            )}
            {newProvider === "local" && (
              <div>
                <label className="text-xs text-muted-foreground">
                  {i18n.t(
                    "policies:configurationPolicies.featureTabs.backupTab.backupPath",
                  )}
                </label>
                <input
                  value={localPath}
                  onChange={(e) => setLocalPath(e.target.value)}
                  placeholder={i18n.t(
                    "policies:configurationPolicies.featureTabs.backupTab.varBackupsBreezeOrNasBackups",
                  )}
                  className="mt-1 h-10 w-full rounded-md border bg-background px-3 font-mono text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                />
                <p className="mt-1 chart-legend-xs text-muted-foreground">
                  {i18n.t(
                    "policies:configurationPolicies.featureTabs.backupTab.localDiskPathMountedNASOrUNC",
                  )}
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
              SECTION 2: What to Back Up (file mode only)
              ══════════════════════════════════════════════════════════════════════ */}
      {backupMode === "file" && (
        <>
          <div className="mt-6">
            <h3 className="text-sm font-semibold flex items-center gap-2">
              <FolderOpen className="h-4 w-4" />
              {i18n.t(
                "policies:configurationPolicies.featureTabs.backupTab.backupPaths",
              )}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.backupTab.directoriesAndFilesToIncludeInBackups",
              )}
            </p>
            <div className="mt-3">
              <PathList
                items={settings.paths}
                onAdd={(v) => update("paths", [...settings.paths, v])}
                onRemove={(v) =>
                  update(
                    "paths",
                    settings.paths.filter((p) => p !== v),
                  )
                }
                pendingValue={pendingPath}
                onPendingChange={setPendingPath}
                placeholder={i18n.t(
                  "policies:configurationPolicies.featureTabs.backupTab.cUsersOrHomeOrEtc",
                )}
                label={i18n.t(
                  "policies:configurationPolicies.featureTabs.backupTab.paths",
                )}
              />
            </div>
          </div>

          {/* ── Exclusion patterns ──────────────────────────────────────────── */}
          <div className="mt-6">
            <h3 className="text-sm font-semibold">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.backupTab.exclusionPatterns",
              )}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.backupTab.globPatternsToSkipDuringBackupClick",
              )}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {commonExclusions
                .filter((e) => !settings.excludePatterns.includes(e.pattern))
                .map((e) => (
                  <button
                    key={e.pattern}
                    type="button"
                    onClick={() =>
                      update("excludePatterns", [
                        ...settings.excludePatterns,
                        e.pattern,
                      ])
                    }
                    className="rounded-full border px-2.5 py-1 chart-legend-xs text-muted-foreground transition hover:border-primary/40 hover:text-primary"
                  >
                    + {e.label}
                  </button>
                ))}
            </div>
            <div className="mt-3">
              <PathList
                items={settings.excludePatterns}
                onAdd={(v) =>
                  update("excludePatterns", [...settings.excludePatterns, v])
                }
                onRemove={(v) =>
                  update(
                    "excludePatterns",
                    settings.excludePatterns.filter((p) => p !== v),
                  )
                }
                placeholder={i18n.t(
                  "policies:configurationPolicies.featureTabs.backupTab.tmpOrLogs",
                )}
                label={i18n.t(
                  "policies:configurationPolicies.featureTabs.backupTab.exclusions",
                )}
              />
            </div>
          </div>
        </>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
              SECTION 3: Schedule
              ══════════════════════════════════════════════════════════════════════ */}
      <div className="mt-6">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <Clock className="h-4 w-4" />
          {i18n.t(
            "policies:configurationPolicies.featureTabs.backupTab.backupSchedule",
          )}
        </h3>
        <div className="mt-2 grid gap-4 sm:grid-cols-3">
          <div>
            <label className="text-xs text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.backupTab.frequency",
              )}
            </label>
            <select
              value={settings.scheduleFrequency}
              onChange={(e) =>
                update("scheduleFrequency", e.target.value as ScheduleFrequency)
              }
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              {scheduleOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.backupTab.time",
              )}
            </label>
            <input
              type="time"
              value={settings.scheduleTime}
              onChange={(e) => update("scheduleTime", e.target.value)}
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>
          {settings.scheduleFrequency === "weekly" && (
            <div>
              <label className="text-xs text-muted-foreground">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.backupTab.dayOfWeek",
                )}
              </label>
              <select
                value={settings.scheduleDayOfWeek}
                onChange={(e) =>
                  update("scheduleDayOfWeek", Number(e.target.value))
                }
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
              >
                {dayOfWeekOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          {settings.scheduleFrequency === "monthly" && (
            <div>
              <label className="text-xs text-muted-foreground">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.backupTab.dayOfMonth",
                )}
              </label>
              <input
                type="number"
                min={1}
                max={28}
                value={settings.scheduleDayOfMonth}
                onChange={(e) =>
                  update("scheduleDayOfMonth", Number(e.target.value) || 1)
                }
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
              />
            </div>
          )}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {scheduleDescription(settings)}
        </p>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
              SECTION 4: Retention
              ══════════════════════════════════════════════════════════════════════ */}
      <div className="mt-6">
        <h3 className="text-sm font-semibold">
          {i18n.t(
            "policies:configurationPolicies.featureTabs.backupTab.retentionPolicy",
          )}
        </h3>
        <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {retentionPresets.map((preset) => (
            <label
              key={preset.value}
              className={`flex cursor-pointer flex-col gap-1 rounded-md border p-3 text-sm transition ${
                settings.retentionPreset === preset.value
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-muted text-muted-foreground hover:text-foreground"
              }`}
            >
              <input
                type="radio"
                name="retentionPreset"
                value={preset.value}
                checked={settings.retentionPreset === preset.value}
                onChange={() => handleRetentionPreset(preset.value)}
                className="hidden"
              />
              <span className="font-medium text-foreground">
                {preset.label}
              </span>
              <span className="text-xs text-muted-foreground">
                {preset.value === "custom"
                  ? i18n.t(
                      "policies:configurationPolicies.featureTabs.backupTab.setYourOwnValues",
                    )
                  : i18n.t("policies:configurationPolicies.featureTabs.backupTab.retentionSummary", { days: preset.days, versions: preset.versions })}
              </span>
            </label>
          ))}
        </div>
        {settings.retentionPreset === "custom" && (
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
              <label className="text-xs text-muted-foreground">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.backupTab.retentionDays",
                )}
              </label>
              <input
                type="number"
                min={1}
                max={3650}
                value={settings.retentionDays}
                onChange={(e) =>
                  update("retentionDays", Number(e.target.value) || 30)
                }
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.backupTab.maxVersions",
                )}
              </label>
              <input
                type="number"
                min={1}
                max={100}
                value={settings.retentionVersions}
                onChange={(e) =>
                  update("retentionVersions", Number(e.target.value) || 5)
                }
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
              />
            </div>
          </div>
        )}
        {settings.retentionPreset !== "custom" && retentionInfo && (
          <p className="mt-2 text-xs text-muted-foreground">
            {i18n.t(
              "policies:configurationPolicies.featureTabs.backupTab.keepBackupsFor",
            )}
            {retentionInfo.days}
            {i18n.t(
              "policies:configurationPolicies.featureTabs.backupTab.daysWithUpTo",
            )}
            {retentionInfo.versions}
            {i18n.t(
              "policies:configurationPolicies.featureTabs.backupTab.versionsPerDevice",
            )}
          </p>
        )}
      </div>

      <div className="mt-6">
        <h3 className="text-sm font-semibold">
          {i18n.t(
            "policies:configurationPolicies.featureTabs.backupTab.gFSRetention",
          )}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {i18n.t(
            "policies:configurationPolicies.featureTabs.backupTab.keepLongerRunningRestorePointsForGrandfather",
          )}
        </p>
        <div className="mt-3 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          <div>
            <label className="text-xs text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.backupTab.daily2",
              )}
            </label>
            <input
              type="number"
              min={1}
              max={365}
              value={settings.gfsDailyRetention}
              onChange={(e) =>
                update("gfsDailyRetention", Number(e.target.value) || 7)
              }
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.backupTab.weekly2",
              )}
            </label>
            <input
              type="number"
              min={1}
              max={260}
              value={settings.gfsWeeklyRetention}
              onChange={(e) =>
                update("gfsWeeklyRetention", Number(e.target.value) || 4)
              }
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.backupTab.monthly2",
              )}
            </label>
            <input
              type="number"
              min={1}
              max={120}
              value={settings.gfsMonthlyRetention}
              onChange={(e) =>
                update("gfsMonthlyRetention", Number(e.target.value) || 12)
              }
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.backupTab.yearly",
              )}
            </label>
            <input
              type="number"
              min={1}
              max={25}
              value={settings.gfsYearlyRetention}
              onChange={(e) =>
                update("gfsYearlyRetention", Number(e.target.value) || 3)
              }
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.backupTab.weeklyBackupDay",
              )}
            </label>
            <select
              value={settings.gfsWeeklyDayOfWeek}
              onChange={(e) =>
                update("gfsWeeklyDayOfWeek", Number(e.target.value))
              }
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              {shortDayOfWeekOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="mt-6 space-y-4">
        <h3 className="text-sm font-semibold">
          {i18n.t(
            "policies:configurationPolicies.featureTabs.backupTab.snapshotProtection",
          )}
        </h3>
        <p className="text-xs text-muted-foreground">
          {i18n.t(
            "policies:configurationPolicies.featureTabs.backupTab.theseSettingsStampFutureSnapshotsAtCreation",
          )}
        </p>
        {invalidSavedProviderMode && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-3 text-sm text-amber-800">
            <p>
              {i18n.t(
                "policies:configurationPolicies.featureTabs.backupTab.providerImmutabilityIsConfiguredButTheSelected",
              )}
            </p>
            <p className="mt-1 text-xs text-amber-900/80">
              {capabilitySummary(selectedConfig)}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleTestConnection}
                disabled={!selectedConfigId || testStatus === "testing"}
                className="rounded-md border border-amber-600/40 bg-background px-3 py-1.5 text-xs font-medium text-amber-900 disabled:opacity-50"
              >
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.backupTab.retestConfig",
                )}
              </button>
              <button
                type="button"
                onClick={() =>
                  void handleSave({ downgradeInvalidProvider: true })
                }
                disabled={isSaving}
                className="rounded-md border border-amber-600/40 bg-amber-600/10 px-3 py-1.5 text-xs font-medium text-amber-900 disabled:opacity-50"
              >
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.backupTab.saveWithApplicationProtection",
                )}
              </button>
            </div>
          </div>
        )}
        <ToggleRow
          label={i18n.t(
            "policies:configurationPolicies.featureTabs.backupTab.legalHold",
          )}
          description={i18n.t(
            "policies:configurationPolicies.featureTabs.backupTab.preventRetentionCleanupFromDeletingFutureSnapshots",
          )}
          checked={settings.legalHoldEnabled}
          onChange={(checked) => {
            update("legalHoldEnabled", checked);
            if (!checked) update("legalHoldReason", "");
          }}
        />
        {settings.legalHoldEnabled && (
          <div>
            <label className="text-xs text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.backupTab.legalHoldReason",
              )}
            </label>
            <input
              value={settings.legalHoldReason}
              onChange={(e) => update("legalHoldReason", e.target.value)}
              placeholder={i18n.t(
                "policies:configurationPolicies.featureTabs.backupTab.reasonForPreservingFutureSnapshots",
              )}
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>
        )}

        <div>
          <label className="text-xs text-muted-foreground">
            {i18n.t(
              "policies:configurationPolicies.featureTabs.backupTab.immutability",
            )}
          </label>
          <select
            value={settings.immutabilityMode}
            onChange={(e) =>
              update("immutabilityMode", e.target.value as ImmutabilityMode)
            }
            className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
          >
            <option value="none">{i18n.t("common:labels.none")}</option>
            <option value="application">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.backupTab.applicationLevelProtection",
              )}
            </option>
            <option value="provider" disabled={!selectedConfigSupportsProvider}>
              {i18n.t(
                "policies:configurationPolicies.featureTabs.backupTab.providerEnforcedWORM",
              )}
            </option>
          </select>
          <p className="mt-1 chart-legend-xs text-muted-foreground">
            {i18n.t(
              "policies:configurationPolicies.featureTabs.backupTab.applicationLevelProtectionBlocksDeletionInBreeze",
            )}
          </p>
        </div>
        {settings.immutabilityMode !== "none" && (
          <div>
            <label className="text-xs text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.backupTab.immutableForDays",
              )}
            </label>
            <input
              type="number"
              min={1}
              max={3650}
              value={settings.immutableDays}
              onChange={(e) =>
                update("immutableDays", Number(e.target.value) || 30)
              }
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>
        )}
      </div>

      <div className="mt-6">
        <h3 className="text-sm font-semibold">
          {i18n.t(
            "policies:configurationPolicies.featureTabs.backupTab.backupWindow",
          )}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {i18n.t(
            "policies:configurationPolicies.featureTabs.backupTab.leaveBlankToAllowBackupsAtAny",
          )}
        </p>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <div>
            <label className="text-xs text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.backupTab.startTime",
              )}
            </label>
            <input
              type="time"
              value={settings.backupWindowStart}
              onChange={(e) => update("backupWindowStart", e.target.value)}
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.backupTab.endTime",
              )}
            </label>
            <input
              type="time"
              value={settings.backupWindowEnd}
              onChange={(e) => update("backupWindowEnd", e.target.value)}
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
            />
          </div>
        </div>
      </div>
    </FeatureTabShell>
  );
}
