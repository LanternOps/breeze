import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  Loader2,
  Shield,
  ShieldAlert,
  XCircle,
  Zap,
} from "lucide-react";
import { fetchWithAuth } from "@/stores/auth";
import { formatDateTime } from "@/lib/dateTimeFormat";
import { friendlyFetchError } from "@/lib/utils";
import { errorKindOf, throwIfNotOk, type LoadErrorKind } from "@/lib/httpError";
import AccessDenied from "../shared/AccessDenied";
type DeviceSecurity = {
  deviceId: string;
  deviceName: string;
  provider: {
    name: string;
    vendor: string;
  } | null;
  providerVersion: string | null;
  definitionsVersion: string | null;
  definitionsUpdatedAt: string | null;
  lastScanAt: string | null;
  lastScanType: string | null;
  realTimeProtection: boolean;
  firewallEnabled: boolean;
  encryptionStatus: "encrypted" | "partial" | "unencrypted";
  gatekeeperEnabled?: boolean | null;
  status: "protected" | "at_risk" | "unprotected" | "offline";
  threatsDetected: number;
};
type DeviceSecurityStatusProps = {
  deviceId?: string;
  showAvActions?: boolean;
};
export default function DeviceSecurityStatus({
  deviceId,
  showAvActions = false,
}: DeviceSecurityStatusProps) {
  const { t } = useTranslation("security");
  const [data, setData] = useState<DeviceSecurity | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string>();
  const [errorKind, setErrorKind] = useState<LoadErrorKind>("none");
  const fetchStatus = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    setErrorKind("none");
    try {
      let resolvedDeviceId = deviceId;
      if (!resolvedDeviceId) {
        const listRes = await fetchWithAuth("/security/status?limit=1");
        // HttpError (not a bare Error) so a 403 survives the throw and the render
        // can tell "you may not see this" from "this broke, try again" (#2472).
        throwIfNotOk(listRes);
        const listJson = await listRes.json();
        resolvedDeviceId = listJson.data?.[0]?.deviceId;
      }
      if (!resolvedDeviceId) {
        setData(null);
        return;
      }
      const statusRes = await fetchWithAuth(
        `/security/status/${resolvedDeviceId}`,
      );
      throwIfNotOk(statusRes);
      const statusJson = await statusRes.json();
      setData(statusJson.data ?? null);
    } catch (err) {
      const kind = errorKindOf(err);
      setErrorKind(kind);
      // 'denied' renders AccessDenied, which supplies its own copy.
      if (kind === "other") setError(friendlyFetchError(err));
    } finally {
      setLoading(false);
    }
  }, [deviceId]);
  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);
  const runQuickScan = async () => {
    if (!data) return;
    setScanning(true);
    setError(undefined);
    try {
      const response = await fetchWithAuth(`/security/scan/${data.deviceId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scanType: "quick" }),
      });
      throwIfNotOk(response);
      await fetchStatus();
    } catch (err) {
      setError(friendlyFetchError(err));
    } finally {
      setScanning(false);
    }
  };
  const formatDate = (value: string | null): string => {
    if (!value) return "-";
    return formatDateTime(value, { fallback: "-" });
  };
  if (loading) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-xs">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("securityDeviceSecurityStatus.loadingSecurityStatus")}
        </div>
      </div>
    );
  }
  // A 403 is terminal for this user — a retry hits the same permission gate. Stop
  // before the protection panels: falling through would paint the "no device
  // security data" empty state and tell someone who may not see the data that
  // there's nothing to show. Fabricated emptiness is worse than an error. (#2472)
  if (errorKind === "denied") {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-xs">
        <AccessDenied testId="device-security-status-denied" />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-xs">
        <p className="text-sm text-muted-foreground">
          {t("securityDeviceSecurityStatus.noDeviceSecurityDataAvailable")}
        </p>
      </div>
    );
  }
  const baseProtectionItems = [
    {
      id: "realtime",
      label: t("securityDeviceSecurityStatus.realTimeProtection"),
      enabled: data.realTimeProtection,
      detail: data.realTimeProtection
        ? t("securityDeviceSecurityStatus.running")
        : t("securityDeviceSecurityStatus.disabled"),
    },
    {
      id: "firewall",
      label: t("securityDeviceSecurityStatus.firewall"),
      enabled: data.firewallEnabled,
      detail: data.firewallEnabled
        ? t("securityDeviceSecurityStatus.policyEnforced")
        : t("securityDeviceSecurityStatus.disabled"),
    },
    {
      id: "encryption",
      label: t("securityDeviceSecurityStatus.diskEncryption"),
      enabled: data.encryptionStatus !== "unencrypted",
      detail: data.encryptionStatus,
    },
  ];
  const hasGatekeeper = typeof data.gatekeeperEnabled === "boolean";
  const protectionItems = hasGatekeeper
    ? [
        ...baseProtectionItems,
        {
          id: "gatekeeper",
          label: t("securityDeviceSecurityStatus.guardianGatekeeper"),
          enabled: data.gatekeeperEnabled === true,
          detail: data.gatekeeperEnabled
            ? t("securityDeviceSecurityStatus.enabled")
            : t("securityDeviceSecurityStatus.disabled"),
        },
      ]
    : baseProtectionItems;
  if (!showAvActions) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-xs">
        {error && (
          <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full border bg-muted/40">
            <Shield className="h-5 w-5 text-emerald-600" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">
              {t("securityDeviceSecurityStatus.deviceSecurityStatus")}
            </h2>
            <p className="text-sm text-muted-foreground">{data.deviceName}</p>
          </div>
        </div>

        <div
          className={`mt-6 grid gap-4 ${hasGatekeeper ? "sm:grid-cols-4" : "sm:grid-cols-3"}`}
        >
          <div className="rounded-md border bg-muted/30 p-4">
            <p className="text-xs uppercase text-muted-foreground">
              {t("securityDeviceSecurityStatus.detectedAV")}
            </p>
            <p className="mt-2 text-sm font-medium">
              {data.provider?.name ??
                t("securityDeviceSecurityStatus.unknownProvider")}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {data.provider?.vendor ??
                t("securityDeviceSecurityStatus.unknownVendor")}
            </p>
          </div>
          <div className="rounded-md border bg-muted/30 p-4">
            <p className="text-xs uppercase text-muted-foreground">
              {t("securityDeviceSecurityStatus.firewall")}
            </p>
            <p className="mt-2 text-sm font-medium">
              {data.firewallEnabled
                ? t("securityDeviceSecurityStatus.enabled")
                : t("securityDeviceSecurityStatus.disabled")}
            </p>
          </div>
          <div className="rounded-md border bg-muted/30 p-4">
            <p className="text-xs uppercase text-muted-foreground">
              {t("securityDeviceSecurityStatus.diskEncryption")}
            </p>
            <p className="mt-2 text-sm font-medium capitalize">
              {data.encryptionStatus}
            </p>
          </div>
          {hasGatekeeper && (
            <div className="rounded-md border bg-muted/30 p-4">
              <p className="text-xs uppercase text-muted-foreground">
                {t("securityDeviceSecurityStatus.guardianGatekeeper")}
              </p>
              <p className="mt-2 text-sm font-medium">
                {data.gatekeeperEnabled
                  ? t("securityDeviceSecurityStatus.enabled")
                  : t("securityDeviceSecurityStatus.disabled")}
              </p>
            </div>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-lg border bg-card p-6 shadow-xs">
      {error && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full border bg-muted/40">
            <Shield className="h-5 w-5 text-emerald-600" />
          </div>
          <div>
            <h2 className="text-lg font-semibold">
              {t("securityDeviceSecurityStatus.deviceSecurityStatus")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {data.deviceName} -{" "}
              {data.provider?.name ??
                t("securityDeviceSecurityStatus.unknownProvider")}
            </p>
          </div>
        </div>
        <span
          className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${data.threatsDetected > 0 ? "bg-red-500/10 text-red-700" : "bg-emerald-500/10 text-emerald-700"}`}
        >
          {t("securityDeviceSecurityStatus.threatsDetectedCount", {
            count: data.threatsDetected,
          })}
        </span>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <div className="rounded-md border bg-muted/30 p-4">
          <p className="text-xs uppercase text-muted-foreground">
            {t("securityDeviceSecurityStatus.agentDefinitions")}
          </p>
          <p className="mt-2 text-sm font-medium">
            {data.providerVersion ?? data.definitionsVersion ?? "-"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("securityDeviceSecurityStatus.definitionsUpdated", {
              time: formatDate(data.definitionsUpdatedAt),
            })}
          </p>
        </div>
        <div className="rounded-md border bg-muted/30 p-4">
          <p className="text-xs uppercase text-muted-foreground">
            {t("securityDeviceSecurityStatus.lastScan")}
          </p>
          <p className="mt-2 text-sm font-medium capitalize">
            {data.lastScanType ?? "-"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatDate(data.lastScanAt)}
          </p>
        </div>
      </div>

      <div className="mt-6 space-y-3">
        {protectionItems.map((item) => (
          <div
            key={item.id}
            className="flex items-center justify-between rounded-md border bg-background px-4 py-3"
          >
            <div>
              <p className="text-sm font-medium">{item.label}</p>
              <p className="text-xs capitalize text-muted-foreground">
                {item.detail}
              </p>
            </div>
            {item.enabled ? (
              <CheckCircle2 className="h-5 w-5 text-emerald-600" />
            ) : (
              <XCircle className="h-5 w-5 text-red-500" />
            )}
          </div>
        ))}
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={runQuickScan}
          disabled={scanning}
          className="inline-flex items-center gap-2 rounded-md border bg-background px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-60"
        >
          {scanning ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Zap className="h-4 w-4" />
          )}
          {t("securityDeviceSecurityStatus.quickScan")}
        </button>
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-md border bg-background px-4 py-2 text-sm font-medium hover:bg-muted"
        >
          <ShieldAlert className="h-4 w-4" />
          {t("securityDeviceSecurityStatus.reviewThreats")}
        </button>
      </div>
    </div>
  );
}
