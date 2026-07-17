import { useCallback, useEffect, useState } from "react";
import {
  Monitor,
  Cpu,
  Shield,
  Tag,
  Info,
  ListChecks,
  Pencil,
  Check,
  X,
  AlertTriangle,
  BatteryCharging,
  Lock,
} from "lucide-react";
import type {
  BatteryStatus,
  DesktopAccessState,
  TCCPermissions,
  VpnPresence,
} from "@breeze/shared";
import {
  activeVpnList,
  getVpnProviderLabel,
  getVpnProviderIcon,
} from "@/lib/vpnProviders";
import MacOSPermissionsCard from "./MacOSPermissionsCard";
import { fetchWithAuth } from "../../stores/auth";
import { formatUptime } from "../../lib/utils";
import { runAction, ActionError } from "../../lib/runAction";
import { formatDateTime } from "@/lib/dateTimeFormat";
import {
  DEVICE_ROLES,
  getDeviceRoleLabel,
  getDeviceRoleIcon,
  getDeviceRoleSourceLabel,
  getDeviceRoleSourceColor,
} from "@/lib/deviceRoles";
import { formatDeviceDetailOsVersion } from "./osDisplay";
import { formatNumber } from "@/lib/i18n/format";
import { useTranslation } from "react-i18next";
import "../../lib/i18n";

type DeviceInfoTabProps = {
  deviceId: string;
};

type CustomFieldDef = {
  id: string;
  name: string;
  fieldKey: string;
  type: "text" | "number" | "boolean" | "dropdown" | "date";
  options: {
    choices?: Array<{ label: string; value: string }>;
    min?: number;
    max?: number;
    maxLength?: number;
    pattern?: string;
  } | null;
  required: boolean;
  defaultValue: unknown;
  deviceTypes: string[] | null;
};

type DeviceInfo = {
  hostname?: string | null;
  displayName?: string | null;
  osType?: string | null;
  osVersion?: string | null;
  osBuild?: string | null;
  architecture?: string | null;
  agentVersion?: string | null;
  watchdogVersion?: string | null;
  status?: string | null;
  lastSeenAt?: string | null;
  enrolledAt?: string | null;
  lastUser?: string | null;
  uptimeSeconds?: number | null;
  deviceRole?: string | null;
  deviceRoleSource?: string | null;
  tags?: string[];
  customFields?: Record<string, unknown>;
  tccPermissions?: TCCPermissions | null;
  desktopAccess?: DesktopAccessState | null;
  batteryStatus?: BatteryStatus | null;
  activeVpns?: VpnPresence[] | null;
  hardware?: {
    serialNumber?: string | null;
    manufacturer?: string | null;
    model?: string | null;
    biosVersion?: string | null;
    gpuModel?: string | null;
    cpuModel?: string | null;
    cpuCores?: number | null;
    cpuThreads?: number | null;
    ramTotalMb?: number | null;
    diskTotalGb?: number | null;
    motherboardManufacturer?: string | null;
    motherboardProduct?: string | null;
    motherboardVersion?: string | null;
  } | null;
};

function formatRam(valueMb: number | null | undefined): string {
  if (valueMb === null || valueMb === undefined) return "—";
  const gb = valueMb / 1024;
  return gb >= 1
    ? `${formatNumber(gb, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} GB`
    : `${formatNumber(valueMb)} MB`;
}

function formatDisk(valueGb: number | null | undefined): string {
  if (valueGb === null || valueGb === undefined) return "—";
  if (valueGb >= 1024)
    return `${formatNumber(valueGb / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} TB`;
  return `${formatNumber(valueGb, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} GB`;
}

const batteryChargingStateLabels: Record<
  NonNullable<BatteryStatus["chargingState"]>,
  string
> = {
  charging: "Charging",
  discharging: "Discharging",
  full: "Full",
  not_charging: "Not charging",
  unknown: "Unknown",
};

function formatBatteryDuration(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return "—";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

function formatDate(dateString: string | null | undefined): string {
  if (!dateString) return "—";
  return formatDateTime(dateString, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const osTypeLabels: Record<string, string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
};

function formatOsType(raw: string | null | undefined): string {
  if (!raw) return "—";
  return osTypeLabels[raw.toLowerCase()] ?? raw;
}

function formatWatchdogVersion(raw: string | null | undefined): string {
  const version = raw?.trim();
  return version ? version : "Not Installed";
}

function formatDesktopAccessMode(
  mode: DesktopAccessState["mode"] | undefined,
): string {
  switch (mode) {
    case "user_session":
      return "Ready After User Login";
    case "login_window":
      return "Ready At Login Window";
    case "unavailable":
      return "Unavailable";
    default:
      return "Unknown";
  }
}

function formatDesktopAccessReason(
  reason: DesktopAccessState["reason"] | undefined | null,
): string {
  switch (reason) {
    case "missing_permission":
      return "Missing Permission";
    case "missing_entitlement":
      return "Missing Entitlement";
    case "helper_not_connected":
      return "Helper Not Connected";
    case "virtual_display_unavailable":
      return "Virtual Display Unavailable";
    case "unsupported_os":
      return "Unsupported macOS Version";
    case "manual_install":
      return "Manual Install";
    case "no_display_session":
      return "No Display Session";
    case "wayland_unsupported":
      return "Wayland Unsupported";
    case "x11_connect_failed":
      return "X11 Connection Failed";
    case "x11_auth_failed":
      return "X11 Authentication Failed";
    default:
      return "—";
  }
}

function InfoRow({ label, value }: { label: string; value: string }) {
  const { t } = useTranslation("devices");
  return (
    <div className="flex justify-between py-2">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium text-right">{value || "—"}</dd>
    </div>
  );
}

const hardwareIdentityPlaceholderValues = new Set([
  "0",
  "00000000",
  "000000000000000",
  "123456789",
  "default string",
  "none",
  "null",
  "n/a",
  "na",
  "not applicable",
  "not available",
  "not specified",
  "o.e.m",
  "oem",
  "serial number",
  "system manufacturer",
  "system product name",
  "system serial number",
  "unknown",
]);

function formatHardwareIdentityValue(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return "—";

  const normalized = trimmed
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\.+$/, "");
  if (
    hardwareIdentityPlaceholderValues.has(normalized) ||
    normalized.includes("to be filled by")
  ) {
    return "—";
  }
  return trimmed;
}

function formatMotherboard(hw: DeviceInfo["hardware"]): string {
  const values = [
    formatHardwareIdentityValue(hw?.motherboardManufacturer),
    formatHardwareIdentityValue(hw?.motherboardProduct),
    formatHardwareIdentityValue(hw?.motherboardVersion),
  ].filter((part) => part !== "—");

  const parts: string[] = [];
  for (const value of values) {
    const valueLower = value.toLowerCase();
    const containingIndex = parts.findIndex((part) =>
      valueLower.startsWith(`${part.toLowerCase()} `),
    );
    if (containingIndex >= 0) {
      parts.splice(containingIndex, 1);
    }
    const isDuplicate = parts.some((part) => {
      const partLower = part.toLowerCase();
      return partLower === valueLower || partLower.startsWith(`${valueLower} `);
    });
    if (!isDuplicate) {
      parts.push(value);
    }
  }

  if (parts.length === 0) return "—";

  return parts.join(" ");
}

function splitGpuModels(value: string | null | undefined): string[] {
  return (value ?? "")
    .split(";")
    .map((model) => model.trim())
    .filter(Boolean);
}

function GpuInfoRow({ value }: { value: string | null | undefined }) {
  const { t } = useTranslation("devices");
  const gpuModels = splitGpuModels(value);

  return (
    <div className="flex justify-between gap-4 py-2">
      <dt className="text-sm text-muted-foreground">
        {t("deviceInfoTab.gpu")}
      </dt>
      <dd className="space-y-1 text-sm font-medium text-right">
        {gpuModels.length > 0
          ? gpuModels.map((model, index) => (
              <div key={`${model}-${index}`}>{model}</div>
            ))
          : t("deviceInfoTab.text")}
      </dd>
    </div>
  );
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const { t } = useTranslation("devices");
  return (
    <div className="rounded-lg border bg-card p-6 shadow-xs">
      <div className="flex items-center gap-2 mb-4">
        {icon}
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      <dl className="divide-y">{children}</dl>
    </div>
  );
}

const statusColors: Record<string, string> = {
  online: "bg-success/15 text-success border-success/30",
  offline: "bg-destructive/15 text-destructive border-destructive/30",
  maintenance: "bg-warning/15 text-warning border-warning/30",
  updating: "bg-info/15 text-info border-info/30",
};

export default function DeviceInfoTab({ deviceId }: DeviceInfoTabProps) {
  const { t } = useTranslation("devices");
  const [info, setInfo] = useState<DeviceInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [fieldDefs, setFieldDefs] = useState<CustomFieldDef[]>([]);
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editValue, setEditValue] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [editingRole, setEditingRole] = useState(false);
  const [selectedRole, setSelectedRole] = useState<string>("unknown");
  const [savingRole, setSavingRole] = useState(false);
  const [editingDisplayName, setEditingDisplayName] = useState(false);
  const [displayNameDraft, setDisplayNameDraft] = useState("");
  const [savingDisplayName, setSavingDisplayName] = useState(false);

  const fetchInfo = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetchWithAuth(`/devices/${deviceId}`);
      if (!response.ok) {
        let detail = `Failed to fetch device details (HTTP ${response.status})`;
        try {
          const body = await response.json();
          if (body.error) detail = body.error;
        } catch {
          /* failed to parse error details, using HTTP status */
        }
        throw new Error(detail);
      }
      const data = await response.json();
      setInfo(data);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t("deviceInfoTab.failedToFetchDeviceDetails"),
      );
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    fetchInfo();
  }, [fetchInfo]);

  useEffect(() => {
    fetchWithAuth("/custom-fields")
      .then((r) => {
        if (!r.ok) {
          console.error(
            `Failed to fetch custom field definitions (HTTP ${r.status})`,
          );
          return null;
        }
        return r.json();
      })
      .then((data) => {
        if (data) setFieldDefs(data.data ?? data ?? []);
      })
      .catch((err) => {
        console.error("Failed to load custom field definitions:", err);
      });
  }, []);

  const handleSaveRole = async () => {
    setSavingRole(true);
    setSaveError(null);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/devices/${deviceId}`, {
            method: "PATCH",
            body: JSON.stringify({ deviceRole: selectedRole }),
          }),
        errorFallback: "Failed to save device role",
        successMessage: "Device role saved",
      });
      setInfo((prev) =>
        prev
          ? { ...prev, deviceRole: selectedRole, deviceRoleSource: "manual" }
          : prev,
      );
      setEditingRole(false);
    } catch (err) {
      if (err instanceof ActionError) {
        if (err.status === 401) return;
        setSaveError(err.message);
      } else {
        console.error("Failed to save device role:", err);
        setSaveError(
          "Network error. Please check your connection and try again.",
        );
      }
    } finally {
      setSavingRole(false);
    }
  };

  const handleSaveDisplayName = async () => {
    setSavingDisplayName(true);
    setSaveError(null);
    // Trim; an empty draft clears the display name (PATCH with null).
    const trimmed = displayNameDraft.trim();
    const payload: { displayName: string | null } = {
      displayName: trimmed === "" ? null : trimmed,
    };
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/devices/${deviceId}`, {
            method: "PATCH",
            body: JSON.stringify(payload),
          }),
        errorFallback: "Failed to save display name",
        successMessage:
          payload.displayName === null
            ? t("deviceInfoTab.displayNameCleared")
            : t("deviceInfoTab.displayNameSaved"),
      });
      setInfo((prev) =>
        prev ? { ...prev, displayName: payload.displayName } : prev,
      );
      setEditingDisplayName(false);
    } catch (err) {
      if (err instanceof ActionError) {
        if (err.status === 401) return; // auth redirect handles UX
        // runAction already surfaced a toast; mirror the message inline for
        // the form so the user sees it next to the input.
        setSaveError(err.message);
      } else {
        console.error("Failed to save display name:", err);
        setSaveError(
          "Network error. Please check your connection and try again.",
        );
      }
    } finally {
      setSavingDisplayName(false);
    }
  };

  // Filter field definitions to those applicable to this device's OS type
  const applicableFields = fieldDefs.filter((def) => {
    if (!def.deviceTypes || def.deviceTypes.length === 0) return true;
    return info?.osType ? def.deviceTypes.includes(info.osType) : true;
  });

  const handleSaveField = async (fieldKey: string) => {
    setSaving(true);
    setSaveError(null);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/devices/${deviceId}`, {
            method: "PATCH",
            body: JSON.stringify({ customFields: { [fieldKey]: editValue } }),
          }),
        errorFallback: `Failed to save "${fieldKey}"`,
        successMessage: "Custom field saved",
      });
      setInfo((prev) =>
        prev
          ? {
              ...prev,
              customFields: {
                ...(prev.customFields ?? {}),
                [fieldKey]: editValue,
              },
            }
          : prev,
      );
      setEditingField(null);
    } catch (err) {
      if (err instanceof ActionError) {
        if (err.status === 401) return;
        setSaveError(err.message);
      } else {
        console.error(`Failed to save custom field "${fieldKey}":`, err);
        setSaveError(
          "Network error. Please check your connection and try again.",
        );
      }
    } finally {
      setSaving(false);
    }
  };

  const renderFieldValue = (def: CustomFieldDef, value: unknown): string => {
    if (value === null || value === undefined || value === "") return "—";
    if (def.type === "boolean")
      return value ? t("deviceInfoTab.yes") : t("deviceInfoTab.no");
    if (def.type === "dropdown" && def.options?.choices) {
      const choice = def.options.choices.find((c) => c.value === value);
      return choice?.label ?? String(value);
    }
    if (def.type === "date" && typeof value === "string")
      return formatDate(value);
    return String(value);
  };

  const renderFieldEditor = (def: CustomFieldDef) => {
    const inputClass =
      "h-8 w-full rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring";
    switch (def.type) {
      case "text":
        return (
          <input
            type="text"
            value={String(editValue ?? "")}
            onChange={(e) => setEditValue(e.target.value)}
            maxLength={def.options?.maxLength}
            className={inputClass}
            autoFocus
          />
        );
      case "number":
        return (
          <input
            type="number"
            value={
              editValue === null || editValue === undefined
                ? ""
                : String(editValue)
            }
            onChange={(e) =>
              setEditValue(e.target.value ? Number(e.target.value) : null)
            }
            min={def.options?.min}
            max={def.options?.max}
            className={inputClass}
            autoFocus
          />
        );
      case "boolean":
        return (
          <button
            type="button"
            onClick={() => setEditValue(!editValue)}
            className={`inline-flex h-8 items-center rounded-full border px-3 text-sm transition ${
              editValue
                ? "border-primary bg-primary/10 text-primary"
                : "bg-muted text-muted-foreground"
            }`}
          >
            {editValue ? t("deviceInfoTab.yes") : t("deviceInfoTab.no")}
          </button>
        );
      case "dropdown":
        return (
          <select
            value={String(editValue ?? "")}
            onChange={(e) => setEditValue(e.target.value)}
            className={inputClass}
            autoFocus
          >
            <option value="">{t("deviceInfoTab.select")}</option>
            {def.options?.choices?.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        );
      case "date":
        return (
          <input
            type="date"
            value={String(editValue ?? "")}
            onChange={(e) => setEditValue(e.target.value)}
            className={inputClass}
            autoFocus
          />
        );
      default:
        return null;
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-lg border bg-card py-12 shadow-xs">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-3 text-sm text-muted-foreground">
            {t("deviceInfoTab.loadingDeviceDetails")}
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchInfo}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {t("deviceInfoTab.retry")}{" "}
        </button>
      </div>
    );
  }

  const hw = info?.hardware;
  const status = info?.status ?? "offline";
  const tags = info?.tags ?? [];

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* Page-level save error. Hoisted out of the Custom Fields section
          (which only renders when applicableFields.length > 0) so the
          display-name / role / field error states are always visible. */}
      {saveError && (
        <div
          role="alert"
          className="lg:col-span-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {saveError}
        </div>
      )}
      <Section
        title={t("deviceInfoTab.system")}
        icon={<Monitor className="h-4 w-4 text-muted-foreground" />}
      >
        <InfoRow
          label={t("deviceInfoTab.hostname")}
          value={info?.hostname ?? "—"}
        />
        <div className="flex items-center justify-between py-2">
          <dt className="text-sm text-muted-foreground">
            {t("deviceInfoTab.displayName")}
          </dt>
          <dd className="text-sm font-medium text-right flex items-center gap-2">
            {editingDisplayName ? (
              <>
                <input
                  type="text"
                  value={displayNameDraft}
                  onChange={(e) => setDisplayNameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleSaveDisplayName();
                    if (e.key === "Escape") setEditingDisplayName(false);
                  }}
                  maxLength={255}
                  placeholder={t("deviceInfoTab.leaveBlankToClear")}
                  className="h-8 w-48 rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={handleSaveDisplayName}
                  disabled={savingDisplayName}
                  className="inline-flex h-7 w-7 items-center justify-center rounded text-primary hover:bg-primary/10"
                  title={t("deviceInfoTab.save")}
                >
                  <Check className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => setEditingDisplayName(false)}
                  className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted"
                  title={t("deviceInfoTab.cancel")}
                >
                  <X className="h-4 w-4" />
                </button>
              </>
            ) : (
              <>
                <span
                  className={
                    info?.displayName ? "" : "text-muted-foreground italic"
                  }
                >
                  {info?.displayName ?? "Not set"}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setDisplayNameDraft(info?.displayName ?? "");
                    setEditingDisplayName(true);
                    setSaveError(null);
                  }}
                  className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                  title={t("deviceInfoTab.editDisplayName")}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
              </>
            )}
          </dd>
        </div>
        <InfoRow
          label={t("deviceInfoTab.serialNumber")}
          value={formatHardwareIdentityValue(hw?.serialNumber)}
        />
        <InfoRow
          label={t("deviceInfoTab.manufacturer")}
          value={formatHardwareIdentityValue(hw?.manufacturer)}
        />
        <InfoRow
          label={t("deviceInfoTab.model")}
          value={formatHardwareIdentityValue(hw?.model)}
        />
      </Section>

      <div className="rounded-lg border bg-card p-6 shadow-xs">
        <div className="flex items-center gap-2 mb-4">
          {(() => {
            const role = (info?.deviceRole ?? "unknown") as string;
            const RoleIcon = getDeviceRoleIcon(role);
            return <RoleIcon className="h-4 w-4 text-muted-foreground" />;
          })()}
          <h3 className="text-sm font-semibold">
            {t("deviceInfoTab.deviceRole")}
          </h3>
        </div>
        <dl className="divide-y">
          <div className="flex items-center justify-between py-2">
            <dt className="text-sm text-muted-foreground">
              {t("deviceInfoTab.role")}
            </dt>
            <dd className="text-sm font-medium text-right flex items-center gap-2">
              {editingRole ? (
                <>
                  <select
                    value={selectedRole}
                    onChange={(e) => setSelectedRole(e.target.value)}
                    className="h-8 w-40 rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    autoFocus
                  >
                    {DEVICE_ROLES.map((role) => (
                      <option key={role} value={role}>
                        {getDeviceRoleLabel(role)}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={handleSaveRole}
                    disabled={savingRole}
                    className="inline-flex h-7 w-7 items-center justify-center rounded text-primary hover:bg-primary/10"
                    title={t("deviceInfoTab.save")}
                  >
                    <Check className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingRole(false)}
                    className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted"
                    title={t("deviceInfoTab.cancel")}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </>
              ) : (
                <>
                  {(() => {
                    const role = (info?.deviceRole ?? "unknown") as string;
                    const RoleIcon = getDeviceRoleIcon(role);
                    return (
                      <span className="inline-flex items-center gap-1.5 rounded-full border bg-muted/50 px-2.5 py-1 text-xs font-medium">
                        <RoleIcon className="h-3 w-3" />
                        {getDeviceRoleLabel(role)}
                      </span>
                    );
                  })()}
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedRole(info?.deviceRole ?? "unknown");
                      setEditingRole(true);
                      setSaveError(null);
                    }}
                    className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                    title={t("deviceInfoTab.changeRole")}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
            </dd>
          </div>
          <div className="flex justify-between py-2">
            <dt className="text-sm text-muted-foreground">
              {t("deviceInfoTab.source")}
            </dt>
            <dd>
              <span
                className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${getDeviceRoleSourceColor(info?.deviceRoleSource ?? "auto")}`}
              >
                {getDeviceRoleSourceLabel(info?.deviceRoleSource ?? "auto")}
              </span>
            </dd>
          </div>
        </dl>
      </div>

      <Section
        title={t("deviceInfoTab.operatingSystem")}
        icon={<Info className="h-4 w-4 text-muted-foreground" />}
      >
        <InfoRow
          label={t("deviceInfoTab.osType")}
          value={formatOsType(info?.osType)}
        />
        <InfoRow
          label={t("deviceInfoTab.osVersion")}
          value={
            formatDeviceDetailOsVersion(info?.osType, info?.osVersion) || "—"
          }
        />
        <InfoRow
          label={t("deviceInfoTab.osBuild")}
          value={info?.osBuild ?? "—"}
        />
        <InfoRow
          label={t("deviceInfoTab.architecture")}
          value={info?.architecture ?? "—"}
        />
      </Section>

      <Section
        title={t("deviceInfoTab.hardwareSummary")}
        icon={<Cpu className="h-4 w-4 text-muted-foreground" />}
      >
        <InfoRow
          label={t("deviceInfoTab.cpuModel")}
          value={hw?.cpuModel ?? "—"}
        />
        <InfoRow
          label={t("deviceInfoTab.coresThreads")}
          value={
            hw?.cpuCores
              ? `${hw.cpuCores} cores${hw.cpuThreads ? ` / ${hw.cpuThreads} threads` : ""}`
              : t("deviceInfoTab.text")
          }
        />
        <InfoRow
          label={t("deviceInfoTab.ramTotal")}
          value={formatRam(hw?.ramTotalMb)}
        />
        <InfoRow
          label={t("deviceInfoTab.diskTotal")}
          value={formatDisk(hw?.diskTotalGb)}
        />
        <GpuInfoRow value={hw?.gpuModel} />
        <InfoRow
          label={t("deviceInfoTab.motherboard")}
          value={formatMotherboard(hw)}
        />
        <InfoRow
          label={t("deviceInfoTab.biosVersion")}
          value={hw?.biosVersion ?? "—"}
        />
      </Section>

      {/* Power / battery current state (#2142) — only for devices that actually
          have a battery. Desktops (present: false) and never-reported devices
          (null) omit the section entirely. */}
      {info?.batteryStatus?.present && (
        <Section
          title={t("deviceInfoTab.power")}
          icon={<BatteryCharging className="h-4 w-4 text-muted-foreground" />}
        >
          <InfoRow
            label={t("deviceInfoTab.batteryCharge")}
            value={
              typeof info.batteryStatus.percent === "number"
                ? `${Math.round(info.batteryStatus.percent)}%`
                : t("deviceInfoTab.text")
            }
          />
          <InfoRow
            label={t("deviceInfoTab.chargingState")}
            value={
              info.batteryStatus.chargingState
                ? batteryChargingStateLabels[info.batteryStatus.chargingState]
                : t("deviceInfoTab.text")
            }
          />
          <InfoRow
            label={t("deviceInfoTab.powerSource")}
            value={
              info.batteryStatus.pluggedIn === undefined
                ? t("deviceInfoTab.text")
                : info.batteryStatus.pluggedIn
                  ? t("deviceInfoTab.acPluggedIn")
                  : t("deviceInfoTab.battery")
            }
          />
          {typeof info.batteryStatus.timeRemainingMinutes === "number" && (
            <InfoRow
              label={t("deviceInfoTab.timeRemaining")}
              value={formatBatteryDuration(
                info.batteryStatus.timeRemainingMinutes,
              )}
            />
          )}
          {typeof info.batteryStatus.timeToFullMinutes === "number" && (
            <InfoRow
              label={t("deviceInfoTab.timeToFull")}
              value={formatBatteryDuration(
                info.batteryStatus.timeToFullMinutes,
              )}
            />
          )}
          <InfoRow
            label={t("deviceInfoTab.lastReported")}
            value={formatDate(info.batteryStatus.reportedAt)}
          />
        </Section>
      )}

      {/* Active VPN clients (#2139) — full list from cached network inventory.
          Only rendered when at least one active VPN was reported. */}
      {(() => {
        const vpns = activeVpnList(info?.activeVpns);
        if (vpns.length === 0) return null;
        return (
          <Section
            title={t("deviceInfoTab.vpn")}
            icon={<Lock className="h-4 w-4 text-muted-foreground" />}
          >
            <div className="space-y-4" data-testid="device-vpn-section">
              {vpns.map((vpn) => {
                const Icon = getVpnProviderIcon(vpn.provider);
                return (
                  <div
                    key={`${vpn.provider}:${vpn.interfaceName}`}
                    className="rounded-md border p-3"
                    data-testid={`device-vpn-row-${vpn.provider}`}
                  >
                    <div className="mb-2 flex items-center gap-2">
                      <Icon
                        className="h-4 w-4 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <span className="text-sm font-semibold">
                        {getVpnProviderLabel(vpn.provider)}
                      </span>
                    </div>
                    <dl className="divide-y">
                      <InfoRow
                        label={t("deviceInfoTab.interface")}
                        value={vpn.interfaceName}
                      />
                      {vpn.ipv4 && (
                        <InfoRow
                          label={t("deviceInfoTab.vpnIpv4")}
                          value={vpn.ipv4}
                        />
                      )}
                      {vpn.ipv6 && (
                        <InfoRow
                          label={t("deviceInfoTab.vpnIpv6")}
                          value={vpn.ipv6}
                        />
                      )}
                      {vpn.dnsName && (
                        <InfoRow
                          label={t("deviceInfoTab.vpnDnsName")}
                          value={vpn.dnsName}
                        />
                      )}
                      <InfoRow
                        label={t("deviceInfoTab.detectionSource")}
                        value={vpn.detectionSource}
                      />
                      <InfoRow
                        label={t("deviceInfoTab.lastReported")}
                        value={formatDate(vpn.reportedAt)}
                      />
                    </dl>
                  </div>
                );
              })}
            </div>
          </Section>
        );
      })()}

      <Section
        title={t("deviceInfoTab.agent")}
        icon={<Shield className="h-4 w-4 text-muted-foreground" />}
      >
        <InfoRow
          label={t("deviceInfoTab.agentVersion")}
          value={info?.agentVersion ?? "—"}
        />
        <InfoRow
          label={t("deviceInfoTab.watchdogVersion")}
          value={formatWatchdogVersion(info?.watchdogVersion)}
        />
        <div className="flex justify-between py-2">
          <dt className="text-sm text-muted-foreground">
            {t("deviceInfoTab.status")}
          </dt>
          <dd>
            <span
              className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${statusColors[status] ?? "bg-muted/40 text-muted-foreground border-muted"}`}
            >
              {status.charAt(0).toUpperCase() + status.slice(1)}
            </span>
          </dd>
        </div>
        <InfoRow
          label={t("deviceInfoTab.lastSeen")}
          value={formatDate(info?.lastSeenAt)}
        />
        <InfoRow
          label={t("deviceInfoTab.enrolled")}
          value={formatDate(info?.enrolledAt)}
        />
        <InfoRow
          label={t("deviceInfoTab.systemUptime")}
          value={formatUptime(info?.uptimeSeconds)}
        />
        <InfoRow
          label={t("deviceInfoTab.loggedInUser")}
          value={info?.lastUser ?? "—"}
        />
      </Section>

      {info?.osType === "macos" && info?.desktopAccess && (
        <Section
          title={t("deviceInfoTab.desktopAccess")}
          icon={<Monitor className="h-4 w-4 text-muted-foreground" />}
        >
          <InfoRow
            label={t("deviceInfoTab.mode")}
            value={formatDesktopAccessMode(info.desktopAccess.mode)}
          />
          <InfoRow
            label={t("deviceInfoTab.loginUiReachable")}
            value={
              info.desktopAccess.loginUiReachable
                ? t("deviceInfoTab.yes")
                : t("deviceInfoTab.no")
            }
          />
          <InfoRow
            label={t("deviceInfoTab.virtualDisplay")}
            value={
              info.desktopAccess.virtualDisplayReady
                ? t("deviceInfoTab.ready")
                : t("deviceInfoTab.notReady")
            }
          />
          <InfoRow
            label={t("deviceInfoTab.remoteDesktopPermission")}
            value={
              info.desktopAccess.remoteDesktopPermission == null
                ? t("deviceInfoTab.unknown")
                : info.desktopAccess.remoteDesktopPermission
                  ? t("deviceInfoTab.granted")
                  : t("deviceInfoTab.missing")
            }
          />
          <InfoRow
            label={t("deviceInfoTab.reason")}
            value={formatDesktopAccessReason(info.desktopAccess.reason)}
          />
          <InfoRow
            label={t("deviceInfoTab.lastChecked")}
            value={formatDate(info.desktopAccess.checkedAt)}
          />
          {info.desktopAccess.mode === "unavailable" && (
            <div className="pt-3">
              <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <p className="text-sm text-amber-700 dark:text-amber-400">
                  {info.desktopAccess.reason === "unsupported_os"
                    ? t("deviceInfoTab.thisMacIsBelowTheMacos")
                    : info.desktopAccess.reason === "manual_install"
                      ? t(
                          "deviceInfoTab.loginWindowReachabilityIsOnlyAdvertised",
                        )
                      : info.desktopAccess.reason === "missing_entitlement"
                        ? t("deviceInfoTab.theNativeLoginWindowDesktopPath")
                        : t("deviceInfoTab.theNativeLoginWindowDesktopPath2")}
                </p>
              </div>
            </div>
          )}
        </Section>
      )}

      {info?.osType === "macos" && info?.tccPermissions && (
        <MacOSPermissionsCard
          deviceId={deviceId}
          tccPermissions={info.tccPermissions}
          formatDate={formatDate}
        />
      )}

      {tags.length > 0 && (
        <div className="rounded-lg border bg-card p-6 shadow-xs">
          <div className="flex items-center gap-2 mb-4">
            <Tag className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">{t("deviceInfoTab.tags")}</h3>
          </div>
          <div className="flex flex-wrap gap-2">
            {tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center rounded-full border bg-muted/40 px-3 py-1 text-xs font-medium text-muted-foreground"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
      )}

      {applicableFields.length > 0 && (
        <div className="rounded-lg border bg-card p-6 shadow-xs lg:col-span-2">
          <div className="flex items-center gap-2 mb-4">
            <ListChecks className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">
              {t("deviceInfoTab.customFields")}
            </h3>
          </div>
          <dl className="divide-y">
            {applicableFields.map((def) => {
              const currentValue =
                info?.customFields?.[def.fieldKey] ?? def.defaultValue ?? null;
              const isEditing = editingField === def.fieldKey;

              return (
                <div
                  key={def.fieldKey}
                  className="flex items-center justify-between gap-4 py-2"
                >
                  <dt className="text-sm text-muted-foreground shrink-0">
                    {def.name}
                    {def.required && (
                      <span className="ml-1 text-amber-500">
                        {t("deviceInfoTab.text2")}
                      </span>
                    )}
                  </dt>
                  <dd className="text-sm font-medium text-right flex items-center gap-2">
                    {isEditing ? (
                      <>
                        <div className="w-48">{renderFieldEditor(def)}</div>
                        <button
                          type="button"
                          onClick={() => handleSaveField(def.fieldKey)}
                          disabled={saving}
                          className="inline-flex h-7 w-7 items-center justify-center rounded text-primary hover:bg-primary/10"
                          title={t("deviceInfoTab.save")}
                        >
                          <Check className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingField(null)}
                          className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted"
                          title={t("deviceInfoTab.cancel")}
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </>
                    ) : (
                      <>
                        <span>{renderFieldValue(def, currentValue)}</span>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingField(def.fieldKey);
                            setEditValue(currentValue);
                            setSaveError(null);
                          }}
                          className="inline-flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                          title={t("deviceInfoTab.edit")}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      </>
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        </div>
      )}
    </div>
  );
}
