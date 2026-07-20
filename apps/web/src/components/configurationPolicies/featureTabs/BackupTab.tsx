import { useState, useEffect, useCallback } from "react";
import {
  HardDrive,
  Plus,
  Trash2,
  ChevronDown,
  Clock,
  FolderOpen,
  Laptop,
  Command,
  Terminal,
} from "lucide-react";
import type { FeatureTabProps } from "./types";
import { FEATURE_META } from "./types";
import { useFeatureLink } from "./useFeatureLink";
import FeatureTabShell from "./FeatureTabShell";
import BackupDestinationSection, {
  emptyConfigForm,
  capabilitySummary,
  supportsProviderImmutability,
} from "./BackupDestinationSection";
import type {
  BackupConfig,
  ConfigFormState,
  DestinationMode,
  TestStatus,
} from "./BackupDestinationSection";
import { createOsPresets, createExclusionGroups } from "./backupTabPresets";
import type { BackupOsPreset } from "./backupTabPresets";
import { ToggleRow, FieldError, PathList } from "./backupTabPrimitives";
import { deriveS3RegionFromEndpoint } from "@breeze/shared";
import { fetchWithAuth } from "../../../stores/auth";
import { extractApiError } from "@/lib/apiError";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
import AccessDenied from "../../shared/AccessDenied";

// ── Types ──────────────────────────────────────────────────────────────────────
type ScheduleFrequency = "daily" | "weekly" | "monthly";
type RetentionPreset = "standard" | "extended" | "compliance" | "custom";
type ImmutabilityMode = "none" | "application" | "provider";

type BackupScheduleSettings = {
  scheduleFrequency: ScheduleFrequency;
  scheduleTime: string;
  scheduleDayOfWeek: number;
  scheduleDayOfMonth: number;
  retentionPreset: RetentionPreset;
  retentionDays: number;
  retentionVersions: number;
  paths: string[];
  excludePatterns: string[];
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
  paths: [],
  excludePatterns: [],
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

const PRESET_ICONS = {
  windows: Laptop,
  macos: Command,
  linux: Terminal,
} as const;

// ── Subcomponents ──────────────────────────────────────────────────────────────
function SectionGroup({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t pt-6 first:border-t-0 first:pt-0">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>
      </div>
      <div className="mt-4 space-y-5">{children}</div>
    </section>
  );
}

function scheduleDescription(s: BackupScheduleSettings): string {
  const time = s.scheduleTime || "03:00";
  switch (s.scheduleFrequency) {
    case "daily":
      return i18n.t(
        "policies:configurationPolicies.featureTabs.backupTab.scheduleDaily",
        { time },
      );
    case "weekly": {
      const dayName =
        createDayOfWeekOptions().find((d) => d.value === s.scheduleDayOfWeek)
          ?.label ?? "";
      return i18n.t(
        "policies:configurationPolicies.featureTabs.backupTab.scheduleWeekly",
        { time, day: dayName },
      );
    }
    case "monthly":
      return i18n.t(
        "policies:configurationPolicies.featureTabs.backupTab.scheduleMonthly",
        { time, day: s.scheduleDayOfMonth },
      );
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

// True when settings deviate from defaults in the advanced (GFS / window)
// controls — used to auto-open the disclosure so saved values are never hidden.
function hasAdvancedValues(s: BackupScheduleSettings): boolean {
  return (
    s.gfsDailyRetention !== scheduleDefaults.gfsDailyRetention ||
    s.gfsWeeklyRetention !== scheduleDefaults.gfsWeeklyRetention ||
    s.gfsMonthlyRetention !== scheduleDefaults.gfsMonthlyRetention ||
    s.gfsYearlyRetention !== scheduleDefaults.gfsYearlyRetention ||
    s.gfsWeeklyDayOfWeek !== scheduleDefaults.gfsWeeklyDayOfWeek ||
    s.backupWindowStart !== "" ||
    s.backupWindowEnd !== ""
  );
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

// ── Main Component ─────────────────────────────────────────────────────────────
// Sentinel for "resolve the org's default destination at job time"
// (destination_config_id NULL server-side).
export const ORG_DEFAULT_DESTINATION = "__org_default__";

type PolicyBackupProfile = {
  id: string;
  name: string;
  partnerId: string | null;
  selections: Record<string, unknown> | null;
  isActive: boolean;
};

function profileSourceChips(
  selections: Record<string, unknown> | null | undefined,
): string[] {
  const s = (selections ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const chips: string[] = [];
  if (s.file?.enabled === true) {
    chips.push(
      i18n.t("policies:configurationPolicies.featureTabs.backupTab.fileBackup"),
    );
  }
  if (s.system_image?.enabled === true) {
    chips.push(
      i18n.t("policies:configurationPolicies.featureTabs.backupTab.systemState"),
    );
  }
  if (s.mssql?.enabled === true) {
    chips.push(
      i18n.t("policies:configurationPolicies.featureTabs.backupTab.sQLServer"),
    );
  }
  if (s.hyperv?.enabled === true) {
    chips.push(
      i18n.t("policies:configurationPolicies.featureTabs.backupTab.hyperVVMs"),
    );
  }
  return chips;
}

export default function BackupTab({
  policyId,
  existingLink,
  onLinkChanged,
  linkedPolicyId,
  parentLink,
  orgId,
}: FeatureTabProps) {
  useTranslation("policies");
  const scheduleOptions = createScheduleOptions();
  const retentionPresets = createRetentionPresets();
  const dayOfWeekOptions = createDayOfWeekOptions();
  const shortDayOfWeekOptions = createShortDayOfWeekOptions();
  const osPresets = createOsPresets();
  const exclusionGroups = createExclusionGroups();
  const { save, remove, saving, error, clearError } = useFeatureLink(policyId);
  const isInherited = !!parentLink && !existingLink;
  const effectiveLink = existingLink ?? parentLink;
  const meta = FEATURE_META.backup;
  // Partner-wide ("all organizations") policy: destinations are per-org, so
  // the link always resolves each device org's default at job time.
  const isPartnerWide = orgId === null;

  // Source mode: profile-linked (backup_profiles selection) vs custom
  // (legacy per-policy backupMode/paths/targets).
  const storedProfileId =
    ((effectiveLink?.inlineSettings as Record<string, unknown> | undefined)
      ?.backupProfileId as string | undefined) ?? null;
  const storedDestinationId =
    ((effectiveLink?.inlineSettings as Record<string, unknown> | undefined)
      ?.destinationConfigId as string | undefined) ?? null;
  const [sourceMode, setSourceMode] = useState<"profile" | "custom">(
    storedProfileId ? "profile" : "custom",
  );
  // Explicit user choice pins the mode; otherwise a fresh link defaults to
  // profile mode once we know profiles actually exist.
  const [sourceModeTouched, setSourceModeTouched] = useState(!!storedProfileId);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(
    storedProfileId,
  );
  const [profiles, setProfiles] = useState<PolicyBackupProfile[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(false);
  // A failed profile fetch must NOT render as "this org has no profiles" — a
  // user seeing a false-empty picker can switch to "custom" and save, which
  // permanently converts a profile link.
  const [profilesFailed, setProfilesFailed] = useState(false);

  // Destination state
  const [configs, setConfigs] = useState<BackupConfig[]>([]);
  const [configsLoading, setConfigsLoading] = useState(false);
  // Distinguishes "fetch not done yet" from "fetched, zero configs" so the
  // create form only auto-opens once we know the org truly has none.
  const [configsLoaded, setConfigsLoaded] = useState(false);
  // ...and a FAILED fetch is neither. Without this, a transient 500 renders the
  // "create your first destination" form over an org that already has some.
  //
  // 'denied' (403) is split out from 'other': a permission denial is terminal
  // for this user, so it gets a permissions panel and NO Retry — a retry could
  // only 403 again. (#2429)
  const [configsError, setConfigsError] = useState<"none" | "denied" | "other">(
    "none",
  );
  const [selectedConfigId, setSelectedConfigId] = useState<string>(() => {
    if (storedDestinationId) return storedDestinationId;
    // Legacy custom links stored the destination in featurePolicyId; profile
    // links store the profile there — never treat that as a destination.
    if (storedProfileId) return ORG_DEFAULT_DESTINATION;
    return effectiveLink?.featurePolicyId ?? "";
  });
  const [mode, setMode] = useState<DestinationMode>("select");
  const [editingConfigId, setEditingConfigId] = useState<string | null>(null);
  const [configForm, setConfigForm] =
    useState<ConfigFormState>(emptyConfigForm);
  const [configSaving, setConfigSaving] = useState(false);
  const [configError, setConfigError] = useState<string>();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [testStatus, setTestStatus] = useState<TestStatus>("idle");
  const [testMessage, setTestMessage] = useState<string>();

  // Typed-but-not-added backup path, flushed on save (controlled PathList input)
  const [pendingPath, setPendingPath] = useState("");

  // Schedule/retention inline settings
  const [settings, setSettings] = useState<BackupScheduleSettings>(() =>
    inflateSettings(
      effectiveLink?.inlineSettings as Record<string, unknown> | null,
    ),
  );
  // Initializer runs on mount only, when `settings` still holds the freshly
  // inflated value from the line above.
  const [advancedOpen, setAdvancedOpen] = useState(() =>
    hasAdvancedValues(settings),
  );

  // Backup mode and targets
  const [backupMode, setBackupMode] = useState<string>(
    ((effectiveLink?.inlineSettings as Record<string, unknown>)
      ?.backupMode as string) ?? "file",
  );
  const [targets, setTargets] = useState<Record<string, unknown>>(
    ((effectiveLink?.inlineSettings as Record<string, unknown>)
      ?.targets as Record<string, unknown>) ?? {},
  );
  // Set while a type switch would discard edited mode-specific targets
  const [pendingMode, setPendingMode] = useState<string | null>(null);

  // ── Fetch existing configs ─────────────────────────────────────────────────
  const fetchConfigs = useCallback(async () => {
    if (!meta.fetchUrl) return;
    setConfigsLoading(true);
    setConfigsError("none");
    try {
      const response = await fetchWithAuth(meta.fetchUrl);
      // Terminal for this user — not something a Retry can clear. Kept out of
      // the throw path so the status is not flattened into a message. (#2429)
      if (response.status === 403) {
        setConfigsError("denied");
        return;
      }
      if (!response.ok) {
        throw new Error(`Failed to load backup destinations (${response.status})`);
      }
      const payload = await response.json();
      setConfigs(
        Array.isArray(payload.data)
          ? payload.data
          : Array.isArray(payload)
            ? payload
            : [],
      );
      setConfigsLoaded(true);
    } catch (err) {
      // Never fall through to the empty state: the destination list is what the
      // whole tab keys off, and an empty one auto-opens the create form.
      console.error("Failed to load backup destinations", err);
      setConfigsError("other");
    } finally {
      setConfigsLoading(false);
    }
  }, [meta.fetchUrl]);

  useEffect(() => {
    fetchConfigs();
  }, [fetchConfigs]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setProfilesLoading(true);
      try {
        const response = await fetchWithAuth("/backup/profiles");
        if (!response.ok) {
          throw new Error(`Failed to load backup profiles (${response.status})`);
        }
        const payload = await response.json();
        if (!cancelled) {
          const rows = Array.isArray(payload.data) ? payload.data : [];
          setProfiles(rows);
          setProfilesFailed(false);
          if (rows.length > 0 && !effectiveLink) {
            setSourceModeTouched((touched) => {
              if (!touched) setSourceMode("profile");
              return touched;
            });
          }
        }
      } catch (err) {
        console.error("Failed to load backup profiles", err);
        if (!cancelled) setProfilesFailed(true);
      } finally {
        if (!cancelled) setProfilesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const link = existingLink ?? parentLink;
    const stored = link?.inlineSettings as Record<string, unknown> | undefined;
    const profileId = (stored?.backupProfileId as string | undefined) ?? null;
    const destinationId = (stored?.destinationConfigId as string | undefined) ?? null;
    if (profileId) {
      setSelectedProfileId(profileId);
      setSourceMode("profile");
      setSourceModeTouched(true);
      setSelectedConfigId(destinationId ?? ORG_DEFAULT_DESTINATION);
    } else if (destinationId) {
      setSelectedConfigId(destinationId);
    } else if (link?.featurePolicyId) {
      // Legacy custom link: featurePolicyId is the destination config.
      setSelectedConfigId(link.featurePolicyId);
    }
    if (link?.inlineSettings) {
      const stored = link.inlineSettings as Record<string, unknown>;
      const next = inflateSettings(stored);
      setSettings(next);
      if (hasAdvancedValues(next)) setAdvancedOpen(true);
      if (stored.backupMode) setBackupMode(stored.backupMode as string);
      if (stored.targets) setTargets(stored.targets as Record<string, unknown>);
    }
  }, [existingLink, parentLink]);

  useEffect(() => {
    if (configsLoaded && configs.length === 0 && !selectedConfigId) {
      setMode("create");
    }
  }, [configsLoaded, configs.length, selectedConfigId]);

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

  const clearFieldError = (key: string) =>
    setFieldErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });

  const updateConfigForm = (patch: Partial<ConfigFormState>) => {
    setConfigForm((prev) => ({ ...prev, ...patch }));
    if ("name" in patch) clearFieldError("configName");
    if ("bucket" in patch) clearFieldError("bucket");
    if ("region" in patch || "endpoint" in patch) clearFieldError("region");
    if ("localPath" in patch) clearFieldError("localPath");
  };

  const handleRetentionPreset = (preset: RetentionPreset) => {
    update("retentionPreset", preset);
    const p = retentionPresets.find((r) => r.value === preset);
    if (p && preset !== "custom") {
      update("retentionDays", p.days);
      update("retentionVersions", p.versions);
    }
  };

  const applyOsPreset = (preset: BackupOsPreset) => {
    clearFieldError("paths");
    setSettings((prev) => ({
      ...prev,
      paths: [
        ...prev.paths,
        ...preset.paths.filter((p) => !prev.paths.includes(p)),
      ],
      excludePatterns: [
        ...prev.excludePatterns,
        ...preset.excludes.filter((p) => !prev.excludePatterns.includes(p)),
      ],
    }));
  };

  // Switching type discards mode-specific target edits (Hyper-V consistency,
  // SQL excludes, ...). File paths/excludes persist across switches, so only
  // a non-empty `targets` needs the inline confirmation.
  const requestModeSwitch = (nextMode: string) => {
    if (nextMode === backupMode) {
      setPendingMode(null);
      return;
    }
    // File selections live in `settings.paths`/`excludePatterns` and survive a
    // switch; only non-file target edits are actually discarded.
    if (backupMode !== "file" && Object.keys(targets).length > 0) {
      setPendingMode(nextMode);
      return;
    }
    setBackupMode(nextMode);
    setTargets({});
  };

  const confirmModeSwitch = () => {
    if (!pendingMode) return;
    setBackupMode(pendingMode);
    setTargets({});
    setPendingMode(null);
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
    } catch (err) {
      // Bind and log: this catch also swallows network faults, JSON parse
      // failures, and any bug in the handler body above. Collapsing all of
      // those into a generic string with the error object discarded leaves no
      // way to tell "storage rejected us" from "our own code threw".
      console.error("[BackupTab] Connection test failed:", err);
      setTestStatus("failed");
      setTestMessage(
        i18n.t(
          "policies:configurationPolicies.featureTabs.backupTab.connectionTestFailed",
        ),
      );
    }
  };

  // ── Create / edit config via API ───────────────────────────────────────────
  const buildProviderDetails = (): Record<string, unknown> => {
    if (configForm.provider !== "s3") return { path: configForm.localPath };
    // Carry stored SSE settings through every edit (the API drops non-secret
    // keys missing from the payload, then 400s its encryption re-check).
    // Enabling encryption without a stored algorithm defaults to SSE-S3.
    const sseAlgorithm =
      configForm.sseAlgorithm ?? (configForm.encryption ? "AES256" : null);
    return {
      bucket: configForm.bucket,
      region: configForm.region.trim(),
      accessKey: configForm.accessKey,
      secretKey: configForm.secretKey,
      ...(configForm.endpoint ? { endpoint: configForm.endpoint } : {}),
      ...(configForm.prefix ? { prefix: configForm.prefix } : {}),
      ...(sseAlgorithm ? { serverSideEncryption: sseAlgorithm } : {}),
      ...(configForm.kmsKeyId ? { kmsKeyId: configForm.kmsKeyId } : {}),
    };
  };

  const createConfig = async (): Promise<string | null> => {
    setConfigError(undefined);
    setConfigSaving(true);
    try {
      const details = buildProviderDetails();
      const response = await fetchWithAuth("/backup/configs", {
        method: "POST",
        body: JSON.stringify({
          name: configForm.name,
          provider: configForm.provider,
          enabled: true,
          encryption: configForm.encryption,
          isDefault: configForm.isDefault,
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

  const beginEditConfig = (config: BackupConfig) => {
    const details = config.details ?? {};
    const region = typeof details.region === "string" ? details.region : "";
    setEditingConfigId(config.id);
    setConfigForm({
      name: config.name,
      provider: config.provider === "local" ? "local" : "s3",
      bucket: typeof details.bucket === "string" ? details.bucket : "",
      region,
      regionTouched: Boolean(region.trim()),
      accessKey: hasStoredSecret(details.accessKey) ? MASKED_SECRET : "",
      secretKey: hasStoredSecret(details.secretKey) ? MASKED_SECRET : "",
      endpoint: typeof details.endpoint === "string" ? details.endpoint : "",
      prefix: typeof details.prefix === "string" ? details.prefix : "",
      localPath:
        typeof details.path === "string" ? details.path : "/var/backups/breeze",
      encryption: config.encryption?.enabled === true,
      isDefault: config.isDefault === true,
      sseAlgorithm:
        typeof details.serverSideEncryption === "string"
          ? details.serverSideEncryption
          : null,
      kmsKeyId: typeof details.kmsKeyId === "string" ? details.kmsKeyId : null,
    });
    setConfigError(undefined);
    setFieldErrors({});
    setMode("edit");
  };

  const startCreateConfig = () => {
    setEditingConfigId(null);
    setConfigForm(emptyConfigForm);
    setConfigError(undefined);
    setFieldErrors({});
    setMode("create");
  };

  const cancelConfigForm = () => {
    setEditingConfigId(null);
    setConfigError(undefined);
    setFieldErrors({});
    setMode("select");
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
            name: configForm.name,
            encryption: configForm.encryption,
            isDefault: configForm.isDefault,
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
  const validateConfigForm = (): boolean => {
    const errors: Record<string, string> = {};
    if (!configForm.name.trim()) {
      errors.configName = i18n.t(
        "policies:configurationPolicies.featureTabs.backupTab.configNameIsRequired",
      );
    }
    if (configForm.provider === "s3") {
      if (!configForm.bucket.trim()) {
        errors.bucket = i18n.t(
          "policies:configurationPolicies.featureTabs.backupTab.s3BucketNameIsRequired",
        );
      }
      if (
        !configForm.region.trim() &&
        !deriveS3RegionFromEndpoint(configForm.endpoint)
      ) {
        errors.region = i18n.t(
          "policies:configurationPolicies.featureTabs.backupTab.s3RegionIsRequired",
        );
      }
    }
    if (configForm.provider === "local" && !configForm.localPath.trim()) {
      errors.localPath = i18n.t(
        "policies:configurationPolicies.featureTabs.backupTab.backupPathIsRequired",
      );
    }
    setFieldErrors((prev) => ({ ...prev, ...errors }));
    return Object.keys(errors).length === 0;
  };

  /**
   * Resolves the effective destination for this save.
   * Returns { destinationConfigId } where null means "org default at job
   * time", or undefined when validation failed (errors already set).
   */
  const resolveDestinationForSave = async (): Promise<
    { destinationConfigId: string | null } | undefined
  > => {
    // Partner-wide policies never pin a destination — each device org's
    // default is resolved at job time.
    if (isPartnerWide) return { destinationConfigId: null };
    if (mode === "create" || mode === "edit") {
      if (!validateConfigForm()) return undefined;
      const savedId = mode === "create" ? await createConfig() : await updateConfig();
      if (!savedId) return undefined;
      return { destinationConfigId: savedId };
    }
    if (selectedConfigId === ORG_DEFAULT_DESTINATION) {
      const defaultConfig = configs.find((c) => c.isDefault);
      if (!defaultConfig) {
        setFieldErrors((prev) => ({
          ...prev,
          destination: i18n.t(
            "policies:configurationPolicies.featureTabs.backupTab.destinationRequired",
          ),
        }));
        return undefined;
      }
      return { destinationConfigId: null };
    }
    if (!selectedConfigId) {
      setConfigError(
        i18n.t(
          "policies:configurationPolicies.featureTabs.backupTab.pleaseSelectOrCreateABackupConfiguration",
        ),
      );
      return undefined;
    }
    return { destinationConfigId: selectedConfigId };
  };

  /** The config whose provider capabilities gate provider-enforced WORM. */
  const destinationConfigForCapabilities = (
    destinationConfigId: string | null,
  ): BackupConfig | undefined => {
    if (destinationConfigId) return configs.find((c) => c.id === destinationConfigId);
    return configs.find((c) => c.isDefault);
  };

  const handleSave = async (options?: {
    downgradeInvalidProvider?: boolean;
  }) => {
    clearError();
    setConfigError(undefined);
    setFieldErrors({});

    // Block the save only when a profile link is actually at stake: we're
    // saving one (profile mode), or this policy already has one and a custom
    // save would silently convert it — and the failed fetch means we can't
    // even show the user what they'd be replacing. A plain custom save on a
    // policy that never had a profile is unaffected.
    if (profilesFailed && (sourceMode === "profile" || storedProfileId)) {
      setConfigError(
        i18n.t(
          "policies:configurationPolicies.featureTabs.backupTab.profilesLoadFailed",
        ),
      );
      return;
    }

    // ── Profile-linked save ─────────────────────────────────────────────
    if (sourceMode === "profile") {
      if (!selectedProfileId) {
        setFieldErrors({
          profile: i18n.t(
            "policies:configurationPolicies.featureTabs.backupTab.selectProfileRequired",
          ),
        });
        return;
      }
      const destination = await resolveDestinationForSave();
      if (!destination) return;
      const selected = destinationConfigForCapabilities(destination.destinationConfigId);
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
      const settingsToSave =
        providerModeInvalid && options?.downgradeInvalidProvider
          ? { ...settings, immutabilityMode: "application" as ImmutabilityMode }
          : settings;
      const full = buildInlineSettings(settingsToSave, backupMode, targets);
      const result = await save(existingLink?.id ?? null, {
        featureType: "backup",
        featurePolicyId: selectedProfileId,
        inlineSettings: {
          schedule: full.schedule,
          retention: full.retention,
          ...(destination.destinationConfigId
            ? { destinationConfigId: destination.destinationConfigId }
            : {}),
        },
      });
      if (result) {
        if (providerModeInvalid && options?.downgradeInvalidProvider) {
          setSettings((prev) => ({ ...prev, immutabilityMode: "application" }));
        }
        onLinkChanged(result, "backup");
      }
      return;
    }

    // ── Custom-selection save (legacy shape; destination moves to
    //    inlineSettings.destinationConfigId, featurePolicyId cleared) ────
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
        setFieldErrors({
          paths: i18n.t(
            "policies:configurationPolicies.featureTabs.backupTab.addAtLeastOneBackupPath",
          ),
        });
        return;
      }
    }
    const destination = await resolveDestinationForSave();
    if (!destination) return;
    const selected = destinationConfigForCapabilities(destination.destinationConfigId);
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
      featurePolicyId: null,
      inlineSettings: {
        ...buildInlineSettings(settingsToSave, backupMode, targets),
        ...(destination.destinationConfigId
          ? { destinationConfigId: destination.destinationConfigId }
          : {}),
      },
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
    const full = buildInlineSettings(settings, backupMode, targets);
    const explicitDestination =
      selectedConfigId && selectedConfigId !== ORG_DEFAULT_DESTINATION
        ? selectedConfigId
        : null;
    const result = await save(null, {
      featureType: "backup",
      featurePolicyId: sourceMode === "profile" ? selectedProfileId : null,
      inlineSettings:
        sourceMode === "profile"
          ? {
              schedule: full.schedule,
              retention: full.retention,
              ...(explicitDestination ? { destinationConfigId: explicitDestination } : {}),
            }
          : {
              ...full,
              ...(explicitDestination ? { destinationConfigId: explicitDestination } : {}),
            },
    });
    if (result) onLinkChanged(result, "backup");
  };

  const handleRevert = async () => {
    if (!existingLink) return;
    const ok = await remove(existingLink.id);
    if (ok) onLinkChanged(null, "backup");
  };

  const defaultConfig = configs.find((c) => c.isDefault);
  const selectedConfig =
    selectedConfigId === ORG_DEFAULT_DESTINATION
      ? defaultConfig
      : configs.find((c) => c.id === selectedConfigId);
  const isSaving = saving || configSaving;
  const combinedError = configError || error;
  const retentionInfo = retentionPresets.find(
    (p) => p.value === settings.retentionPreset,
  );
  const selectedConfigSupportsProvider =
    supportsProviderImmutability(selectedConfig);
  const invalidSavedProviderMode =
    settings.immutabilityMode === "provider" && !selectedConfigSupportsProvider;

  const backupTypeOptions = [
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
  ];

  // A partner-wide policy can only link partner-wide profiles (an org
  // profile has no meaning across orgs and the API rejects it).
  const linkableProfiles = isPartnerWide
    ? profiles.filter((profile) => profile.partnerId)
    : profiles;

  const showPresetCards = backupMode === "file" && settings.paths.length === 0;
  const remainingPresets = osPresets.filter((p) =>
    p.paths.some((x) => !settings.paths.includes(x)),
  );

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
      <div className="space-y-6">
        {/* ════════════════════════════════════════════════════════════════════
                GROUP 1: Source — what to back up
                ════════════════════════════════════════════════════════════════ */}
        <SectionGroup
          title={i18n.t(
            "policies:configurationPolicies.featureTabs.backupTab.sourceTitle",
          )}
          subtitle={i18n.t(
            "policies:configurationPolicies.featureTabs.backupTab.sourceSubtitle",
          )}
        >
          {/* Source mode: reusable profile vs per-policy custom selection */}
          <div className="grid grid-cols-2 gap-2 sm:max-w-md">
            {(
              [
                {
                  value: "profile" as const,
                  label: i18n.t(
                    "policies:configurationPolicies.featureTabs.backupTab.sourceUseProfile",
                  ),
                },
                {
                  value: "custom" as const,
                  label: i18n.t(
                    "policies:configurationPolicies.featureTabs.backupTab.sourceUseCustom",
                  ),
                },
              ] as const
            ).map((opt) => (
              <button
                key={opt.value}
                type="button"
                aria-pressed={sourceMode === opt.value}
                onClick={() => {
                  setSourceModeTouched(true);
                  setSourceMode(opt.value);
                }}
                className={`rounded-md border px-3 py-2 text-sm transition focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring ${
                  sourceMode === opt.value
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-muted text-muted-foreground hover:border-muted-foreground/30"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {sourceMode === "profile" && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.backupTab.sourceProfileHint",
                )}
              </p>
              {profilesLoading ? (
                <div className="grid gap-3 sm:grid-cols-2" aria-hidden>
                  {[0, 1].map((n) => (
                    <div
                      key={n}
                      className="h-20 animate-pulse rounded-md border border-muted bg-muted/30"
                    />
                  ))}
                </div>
              ) : profilesFailed ? (
                <div
                  className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm"
                  data-testid="backup-profiles-load-error"
                >
                  <p className="font-medium text-destructive">
                    {i18n.t(
                      "policies:configurationPolicies.featureTabs.backupTab.profilesLoadFailed",
                    )}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {i18n.t(
                      "policies:configurationPolicies.featureTabs.backupTab.profilesLoadFailedHint",
                    )}
                  </p>
                </div>
              ) : linkableProfiles.length === 0 ? (
                <div className="rounded-md border border-dashed p-4 text-sm">
                  <p className="font-medium">
                    {i18n.t(
                      "policies:configurationPolicies.featureTabs.backupTab.noProfilesYet",
                    )}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {i18n.t(
                      "policies:configurationPolicies.featureTabs.backupTab.createProfilesFirst",
                    )}
                  </p>
                  <a
                    href="/backup#profiles"
                    className="mt-2 inline-block text-xs text-primary hover:underline"
                  >
                    {i18n.t(
                      "policies:configurationPolicies.featureTabs.backupTab.manageProfiles",
                    )}
                  </a>
                </div>
              ) : (
                <>
                  <div className="grid gap-3 sm:grid-cols-2" role="radiogroup">
                    {linkableProfiles.map((profile) => (
                      <label
                        key={profile.id}
                        className={`relative flex cursor-pointer flex-col gap-1.5 rounded-md border p-3 transition ${
                          selectedProfileId === profile.id
                            ? "border-primary bg-primary/5 ring-1 ring-primary/40"
                            : "border-muted hover:border-muted-foreground/30"
                        }`}
                      >
                        <input
                          type="radio"
                          name="backupProfile"
                          className="peer sr-only"
                          checked={selectedProfileId === profile.id}
                          onChange={() => {
                            setSelectedProfileId(profile.id);
                            clearFieldError("profile");
                          }}
                          aria-label={profile.name}
                        />
                        <span
                          aria-hidden
                          className="pointer-events-none absolute inset-0 rounded-md peer-focus-visible:ring-2 peer-focus-visible:ring-ring"
                        />
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">{profile.name}</span>
                          {profile.partnerId && (
                            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                              {i18n.t("backup:profiles.allOrgs")}
                            </span>
                          )}
                          {!profile.isActive && (
                            <span className="rounded-full bg-yellow-500/15 px-2 py-0.5 text-[10px] font-semibold text-yellow-700">
                              {i18n.t(
                                "policies:configurationPolicies.featureTabs.backupTab.profileInactive",
                              )}
                            </span>
                          )}
                        </span>
                        <span className="flex flex-wrap gap-1">
                          {profileSourceChips(profile.selections).map((chip) => (
                            <span
                              key={chip}
                              className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                            >
                              {chip}
                            </span>
                          ))}
                        </span>
                      </label>
                    ))}
                  </div>
                  <FieldError message={fieldErrors.profile} />
                  <a
                    href="/backup#profiles"
                    className="inline-block text-xs text-primary hover:underline"
                  >
                    {i18n.t(
                      "policies:configurationPolicies.featureTabs.backupTab.manageProfiles",
                    )}
                  </a>
                </>
              )}
            </div>
          )}

          {sourceMode === "custom" && (
            <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {backupTypeOptions.map((opt) => (
              <button
                key={opt.value}
                type="button"
                aria-pressed={backupMode === opt.value}
                onClick={() => requestModeSwitch(opt.value)}
                className={`rounded-md border px-3 py-2 text-sm transition focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring ${
                  backupMode === opt.value
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-muted text-muted-foreground hover:border-muted-foreground/30"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {pendingMode && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-3 text-sm text-amber-800">
              <p className="font-medium">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.backupTab.switchTypeTitle",
                )}
              </p>
              <p className="mt-0.5 text-xs text-amber-900/80">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.backupTab.switchTypeBody",
                )}
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={confirmModeSwitch}
                  className="rounded-md border border-amber-600/40 bg-amber-600/10 px-3 py-1.5 text-xs font-medium text-amber-900"
                >
                  {i18n.t(
                    "policies:configurationPolicies.featureTabs.backupTab.switchTypeConfirm",
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setPendingMode(null)}
                  className="rounded-md border border-amber-600/40 bg-background px-3 py-1.5 text-xs font-medium text-amber-900"
                >
                  {i18n.t(
                    "policies:configurationPolicies.featureTabs.backupTab.switchTypeCancel",
                  )}
                </button>
              </div>
            </div>
          )}

          {/* ── Mode-specific target fields ─────────────────────────────────── */}
          {backupMode === "hyperv" && (
            <div className="space-y-4 rounded-md border bg-muted/30 p-4">
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
            <div className="space-y-4 rounded-md border bg-muted/30 p-4">
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
            <div className="rounded-md border bg-muted/30 p-4">
              <ToggleRow
                label={i18n.t(
                  "policies:configurationPolicies.featureTabs.backupTab.includeSystemState",
                )}
                description={i18n.t(
                  "policies:configurationPolicies.featureTabs.backupTab.captureRegistryBootFilesAndSystemComponents",
                )}
                checked={targets.includeSystemState === true}
                onChange={(checked) =>
                  setTargets({ ...targets, includeSystemState: checked })
                }
              />
            </div>
          )}

          {backupMode === "file" && (
            <>
              {/* OS quick-start presets */}
              {showPresetCards && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground">
                    {i18n.t(
                      "policies:configurationPolicies.featureTabs.backupTab.quickStartLabel",
                    )}
                  </p>
                  <div className="mt-2 grid gap-3 sm:grid-cols-3">
                    {osPresets.map((preset) => {
                      const Icon = PRESET_ICONS[preset.id];
                      return (
                        <button
                          key={preset.id}
                          type="button"
                          onClick={() => applyOsPreset(preset)}
                          className="flex flex-col gap-1.5 rounded-md border border-muted p-3 text-left transition hover:border-primary/40 hover:bg-primary/5 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <span className="flex items-center gap-2 text-sm font-medium">
                            <Icon className="h-4 w-4 text-muted-foreground" />
                            {preset.title}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {preset.summary}
                          </span>
                          <span className="mt-auto flex flex-wrap gap-1 pt-1">
                            {preset.paths.map((p) => (
                              <span
                                key={p}
                                className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground/80"
                              >
                                {p}
                              </span>
                            ))}
                            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                              {i18n.t(
                                "policies:configurationPolicies.featureTabs.backupTab.presetExclusionCount",
                                { count: preset.excludes.length },
                              )}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {i18n.t(
                      "policies:configurationPolicies.featureTabs.backupTab.mixedFleetHint",
                    )}
                  </p>
                </div>
              )}

              <div>
                <h4 className="flex items-center gap-2 text-xs font-medium">
                  <FolderOpen className="h-3.5 w-3.5" />
                  {i18n.t(
                    "policies:configurationPolicies.featureTabs.backupTab.backupPaths",
                  )}
                </h4>
                <p className="mt-1 text-xs text-muted-foreground">
                  {i18n.t(
                    "policies:configurationPolicies.featureTabs.backupTab.directoriesAndFilesToIncludeInBackups",
                  )}
                </p>
                <div className="mt-3">
                  <PathList
                    items={settings.paths}
                    onAdd={(v) => {
                      clearFieldError("paths");
                      update("paths", [...settings.paths, v]);
                    }}
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
                    emptyLabel={i18n.t(
                      "policies:configurationPolicies.featureTabs.backupTab.noPathsConfigured",
                    )}
                  />
                  <FieldError message={fieldErrors.paths} />
                </div>
                {settings.paths.length > 0 && remainingPresets.length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <span className="chart-legend-xs text-muted-foreground">
                      {i18n.t(
                        "policies:configurationPolicies.featureTabs.backupTab.addPreset",
                      )}
                    </span>
                    {remainingPresets.map((preset) => (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => applyOsPreset(preset)}
                        className="rounded-full border px-2.5 py-1 chart-legend-xs text-muted-foreground transition hover:border-primary/40 hover:text-primary"
                      >
                        + {preset.title}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* ── Exclusion patterns ─────────────────────────────────────── */}
              <div>
                <h4 className="text-xs font-medium">
                  {i18n.t(
                    "policies:configurationPolicies.featureTabs.backupTab.exclusionPatterns",
                  )}
                </h4>
                <p className="mt-1 text-xs text-muted-foreground">
                  {i18n.t(
                    "policies:configurationPolicies.featureTabs.backupTab.globPatternsToSkipDuringBackupClick",
                  )}
                </p>
                <div className="mt-2 space-y-1.5">
                  {exclusionGroups.map((group) => {
                    const remaining = group.items.filter(
                      (item) =>
                        !settings.excludePatterns.includes(item.pattern),
                    );
                    if (remaining.length === 0) return null;
                    return (
                      <div
                        key={group.id}
                        className="flex flex-wrap items-center gap-1.5"
                      >
                        <span className="w-14 shrink-0 chart-legend-xs text-muted-foreground">
                          {group.label}
                        </span>
                        {remaining.map((item) => (
                          <button
                            key={item.pattern}
                            type="button"
                            title={item.pattern}
                            onClick={() =>
                              update("excludePatterns", [
                                ...settings.excludePatterns,
                                item.pattern,
                              ])
                            }
                            className="rounded-full border px-2.5 py-1 chart-legend-xs text-muted-foreground transition hover:border-primary/40 hover:text-primary"
                          >
                            + {item.label}
                          </button>
                        ))}
                      </div>
                    );
                  })}
                </div>
                <div className="mt-3">
                  <PathList
                    items={settings.excludePatterns}
                    onAdd={(v) =>
                      update("excludePatterns", [
                        ...settings.excludePatterns,
                        v,
                      ])
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
                    emptyLabel={i18n.t(
                      "policies:configurationPolicies.featureTabs.backupTab.noExclusionsConfigured",
                    )}
                  />
                </div>
              </div>
            </>
          )}
            </>
          )}
        </SectionGroup>

        {/* ════════════════════════════════════════════════════════════════════
                GROUP 2: Destination — where backups are stored
                ════════════════════════════════════════════════════════════════ */}
        <SectionGroup
          title={i18n.t(
            "policies:configurationPolicies.featureTabs.backupTab.destinationTitle",
          )}
          subtitle={i18n.t(
            "policies:configurationPolicies.featureTabs.backupTab.destinationSubtitle",
          )}
        >
          {isPartnerWide ? (
            <div className="rounded-md border bg-muted/20 p-4 text-sm text-muted-foreground">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.backupTab.partnerDestinationNote",
              )}
            </div>
          ) : configsError === "denied" ? (
            // A permission denial is not a transient failure. Same "don't show
            // the picker over a load we couldn't complete" rule as below, but
            // with no Retry — it could only 403 again. (#2429)
            <AccessDenied testId="backup-destinations-denied" />
          ) : configsError === "other" ? (
            // Never show the destination picker (or its "create your first
            // destination" empty state) over a failed load — the org may well
            // have destinations we just couldn't fetch.
            <div
              className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm"
              data-testid="backup-destinations-load-error"
            >
              <p className="font-medium text-destructive">
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.backupTab.destinationsLoadFailed",
                )}
              </p>
              <button
                type="button"
                onClick={() => void fetchConfigs()}
                className="mt-2 text-xs text-primary hover:underline"
              >
                {i18n.t(
                  "policies:configurationPolicies.featureTabs.backupTab.destinationsLoadRetry",
                )}
              </button>
            </div>
          ) : (
            <>
              <BackupDestinationSection
                configs={configs}
                configsLoading={configsLoading}
                selectedConfigId={selectedConfigId}
                onSelect={(id) => {
                  clearFieldError("destination");
                  setSelectedConfigId(id);
                }}
                mode={mode}
                onStartCreate={startCreateConfig}
                onCancelForm={cancelConfigForm}
                onBeginEdit={beginEditConfig}
                form={configForm}
                onFormChange={updateConfigForm}
                fieldErrors={fieldErrors}
                testStatus={testStatus}
                testMessage={testMessage}
                onTest={handleTestConnection}
                orgDefaultCard={{
                  selected: selectedConfigId === ORG_DEFAULT_DESTINATION,
                  onSelect: () => {
                    clearFieldError("destination");
                    setSelectedConfigId(ORG_DEFAULT_DESTINATION);
                  },
                  defaultName: defaultConfig?.name ?? null,
                }}
              />
              <FieldError message={fieldErrors.destination} />
            </>
          )}
        </SectionGroup>

        {/* ════════════════════════════════════════════════════════════════════
                GROUP 3: Schedule & retention
                ════════════════════════════════════════════════════════════════ */}
        <SectionGroup
          title={i18n.t(
            "policies:configurationPolicies.featureTabs.backupTab.scheduleRetentionTitle",
          )}
          subtitle={i18n.t(
            "policies:configurationPolicies.featureTabs.backupTab.scheduleRetentionSubtitle",
          )}
        >
          <div>
            <h4 className="flex items-center gap-2 text-xs font-medium">
              <Clock className="h-3.5 w-3.5" />
              {i18n.t(
                "policies:configurationPolicies.featureTabs.backupTab.backupSchedule",
              )}
            </h4>
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
                    update(
                      "scheduleFrequency",
                      e.target.value as ScheduleFrequency,
                    )
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

          <div>
            <h4 className="text-xs font-medium">
              {i18n.t(
                "policies:configurationPolicies.featureTabs.backupTab.retentionPolicy",
              )}
            </h4>
            <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {retentionPresets.map((preset) => (
                <label
                  key={preset.value}
                  className={`flex cursor-pointer flex-col gap-1 rounded-md border p-3 text-sm transition has-focus-visible:ring-2 has-focus-visible:ring-ring ${
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
                    className="sr-only"
                  />
                  <span className="font-medium text-foreground">
                    {preset.label}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {preset.value === "custom"
                      ? i18n.t(
                          "policies:configurationPolicies.featureTabs.backupTab.setYourOwnValues",
                        )
                      : i18n.t(
                          "policies:configurationPolicies.featureTabs.backupTab.retentionSummary",
                          { days: preset.days, versions: preset.versions },
                        )}
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
                  "policies:configurationPolicies.featureTabs.backupTab.retentionReadback",
                  {
                    days: retentionInfo.days,
                    versions: retentionInfo.versions,
                  },
                )}
              </p>
            )}
          </div>

          {/* ── Advanced retention & timing (GFS + backup window) ───────────── */}
          <div className="rounded-md border">
            <button
              type="button"
              aria-expanded={advancedOpen}
              onClick={() => setAdvancedOpen((v) => !v)}
              className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left transition hover:bg-muted/40 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span>
                <span className="block text-xs font-medium">
                  {i18n.t(
                    "policies:configurationPolicies.featureTabs.backupTab.advancedRetentionTiming",
                  )}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {i18n.t(
                    "policies:configurationPolicies.featureTabs.backupTab.advancedRetentionTimingSummary",
                  )}
                </span>
              </span>
              <ChevronDown
                className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${advancedOpen ? "rotate-180" : ""}`}
                aria-hidden
              />
            </button>
            {advancedOpen && (
              <div className="space-y-5 border-t px-4 py-4">
                <div>
                  <h4 className="text-xs font-medium">
                    {i18n.t(
                      "policies:configurationPolicies.featureTabs.backupTab.gFSRetention",
                    )}
                  </h4>
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
                          update(
                            "gfsDailyRetention",
                            Number(e.target.value) || 7,
                          )
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
                          update(
                            "gfsWeeklyRetention",
                            Number(e.target.value) || 4,
                          )
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
                          update(
                            "gfsMonthlyRetention",
                            Number(e.target.value) || 12,
                          )
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
                          update(
                            "gfsYearlyRetention",
                            Number(e.target.value) || 3,
                          )
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

                <div>
                  <h4 className="text-xs font-medium">
                    {i18n.t(
                      "policies:configurationPolicies.featureTabs.backupTab.backupWindow",
                    )}
                  </h4>
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
                        onChange={(e) =>
                          update("backupWindowStart", e.target.value)
                        }
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
                        onChange={(e) =>
                          update("backupWindowEnd", e.target.value)
                        }
                        className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </SectionGroup>

        {/* ════════════════════════════════════════════════════════════════════
                GROUP 4: Protection — compliance guarantees
                ════════════════════════════════════════════════════════════════ */}
        <SectionGroup
          title={i18n.t(
            "policies:configurationPolicies.featureTabs.backupTab.snapshotProtection",
          )}
          subtitle={i18n.t(
            "policies:configurationPolicies.featureTabs.backupTab.theseSettingsStampFutureSnapshotsAtCreation",
          )}
        >
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
              <option
                value="provider"
                disabled={!selectedConfigSupportsProvider}
              >
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
        </SectionGroup>
      </div>
    </FeatureTabShell>
  );
}
