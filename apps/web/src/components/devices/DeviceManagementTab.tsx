import { useCallback, useEffect, useState } from "react";
import {
  Building2,
  CheckCircle2,
  Clock,
  Globe,
  HelpCircle,
  Loader2,
  Monitor,
  RefreshCw,
  Server,
  Shield,
  ShieldCheck,
  Wifi,
} from "lucide-react";

import { friendlyFetchError } from "../../lib/utils";
import { formatDateTime as formatUserDateTime } from "@/lib/dateTimeFormat";
import { fetchWithAuth } from "../../stores/auth";
import { useTranslation } from "react-i18next";
import "../../lib/i18n";

import {
  CATEGORY_LABELS,
  STATUS_BADGE,
  type CategoryKey,
  type DetectionStatus,
} from "../../lib/postureCategories";

// ── Types ────────────────────────────────────────────────────────────

type Detection = {
  name: string;
  version?: string;
  status: DetectionStatus;
  serviceName?: string;
  details?: Record<string, unknown>;
};

type JoinType =
  | "hybrid_azure_ad"
  | "azure_ad"
  | "on_prem_ad"
  | "workplace"
  | "none";

type IdentityStatus = {
  joinType: JoinType;
  azureAdJoined: boolean;
  domainJoined: boolean;
  workplaceJoined: boolean;
  domainName?: string;
  tenantId?: string;
  mdmUrl?: string;
  source: string;
};

type ManagementPosture = {
  collectedAt: string;
  scanDurationMs: number;
  categories: Partial<Record<CategoryKey, Detection[]>>;
  identity: IdentityStatus;
  errors?: string[];
};

type PostureResponse = {
  deviceId: string;
  hostname: string;
  posture: ManagementPosture | null;
  collected: boolean;
};

// ── Constants ────────────────────────────────────────────────────────

const CATEGORY_ORDER: CategoryKey[] = [
  "mdm",
  "endpointSecurity",
  "rmm",
  "policyEngine",
  "identityMfa",
  "zeroTrustVpn",
  "remoteAccess",
  "backup",
  "siem",
  "dnsFiltering",
  "patchManagement",
];

const JOIN_TYPE_LABELS: Record<JoinType, string> = {
  hybrid_azure_ad: "Hybrid Azure AD (Entra ID + On-Prem AD)",
  azure_ad: "Azure AD (Entra ID)",
  on_prem_ad: "On-Premises Active Directory",
  workplace: "Workplace Join",
  none: "Not Joined",
};

/**
 * `IdentityStatus.source` reported by agent platforms that have no
 * directory/join detection implementation (Linux, BSD, ...). Mirrors
 * `mgmtdetect.IdentitySourceUnsupported` in the Go agent. On such a device the
 * join type and the three join flags were never probed, so rendering them as
 * "Not Joined" / false asserts a negative result nobody checked (#5626).
 */
const IDENTITY_SOURCE_UNSUPPORTED = "unsupported";

// ── Helpers ──────────────────────────────────────────────────────────

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatUserDateTime(date, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function BoolFlag({
  label,
  value,
  unknown = false,
  testId,
}: {
  label: string;
  value: boolean;
  unknown?: boolean;
  testId?: string;
}) {
  const { t } = useTranslation("devices");
  return (
    <div className="flex items-center gap-2 text-sm" data-testid={testId}>
      {unknown ? (
        <HelpCircle className="h-4 w-4 text-muted-foreground/60" />
      ) : value ? (
        <CheckCircle2 className="h-4 w-4 text-emerald-600" />
      ) : (
        <span className="h-4 w-4 rounded-full border-2 border-muted-foreground/30" />
      )}
      <span
        className={value && !unknown ? "text-foreground" : "text-muted-foreground"}
      >
        {unknown
          ? t("deviceManagementTab.flagUnknown", { label })
          : label}
      </span>
    </div>
  );
}

// ── Component ────────────────────────────────────────────────────────

type DeviceManagementTabProps = {
  deviceId: string;
};

export default function DeviceManagementTab({
  deviceId,
}: DeviceManagementTabProps) {
  const { t } = useTranslation("devices");
  const [data, setData] = useState<PostureResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const fetchPosture = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetchWithAuth(
        `/devices/${deviceId}/management-posture`,
      );
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }
      setData(await response.json());
    } catch (err) {
      setError(friendlyFetchError(err));
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    fetchPosture();
  }, [fetchPosture]);

  // ── Loading state ──────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-lg border bg-card py-12 shadow-xs">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-3 text-sm text-muted-foreground">
            {t("deviceManagementTab.loadingManagementPosture")}
          </p>
        </div>
      </div>
    );
  }

  // ── Error state ────────────────────────────────────────────────────

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchPosture}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {t("deviceManagementTab.retry")}{" "}
        </button>
      </div>
    );
  }

  // ── Empty / not collected ──────────────────────────────────────────

  if (!data?.collected || !data.posture) {
    return (
      <div className="rounded-lg border bg-card p-8 text-center shadow-xs">
        <Monitor className="mx-auto h-10 w-10 text-muted-foreground/50" />
        <h3 className="mt-4 font-semibold">
          {t("deviceManagementTab.noManagementData")}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("deviceManagementTab.theAgentHasnTReportedManagement")}{" "}
        </p>
      </div>
    );
  }

  const { posture } = data;
  const { identity, categories } = posture;

  // The agent never probed join state on this platform, so the join type and
  // flags carry no information — show them as unknown rather than negative.
  const identityDetectionUnsupported =
    identity.source === IDENTITY_SOURCE_UNSUPPORTED;

  // Build ordered list of categories that have detections
  const populatedCategories = CATEGORY_ORDER.filter(
    (key) => categories[key] && categories[key]!.length > 0,
  );

  const totalDetections = populatedCategories.reduce(
    (sum, key) => sum + (categories[key]?.length ?? 0),
    0,
  );

  return (
    <div className="space-y-6">
      {/* ── Identity / Directory Status ───────────────────────────── */}
      <div className="rounded-lg border bg-card p-6 shadow-xs">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 mb-4">
            <Building2 className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">
              {t("deviceManagementTab.identityDirectoryStatus")}
            </h3>
          </div>
          <button
            type="button"
            onClick={fetchPosture}
            className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            {t("deviceManagementTab.refresh")}{" "}
          </button>
        </div>

        <div className="rounded-md border bg-background p-4">
          <div className="flex items-center gap-2 mb-3">
            <Globe className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium" data-testid="identity-join-type">
              {identityDetectionUnsupported
                ? t("deviceManagementTab.identityDetectionUnsupported")
                : // A newer agent can report a join type this build predates;
                  // fall back to the raw value rather than rendering "undefined".
                  (JOIN_TYPE_LABELS[identity.joinType] ?? identity.joinType)}
            </span>
          </div>

          {identityDetectionUnsupported && (
            <p
              className="mb-3 text-xs text-muted-foreground"
              data-testid="identity-detection-unsupported"
            >
              {t("deviceManagementTab.identityDetectionUnsupportedHint")}
            </p>
          )}

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div className="space-y-2">
              <BoolFlag
                testId="identity-flag-azureAdJoined"
                label={t("deviceManagementTab.azureAdEntraIdJoined")}
                value={identity.azureAdJoined}
                unknown={identityDetectionUnsupported}
              />
              <BoolFlag
                testId="identity-flag-domainJoined"
                label={t("deviceManagementTab.domainJoined")}
                value={identity.domainJoined}
                unknown={identityDetectionUnsupported}
              />
              <BoolFlag
                testId="identity-flag-workplaceJoined"
                label={t("deviceManagementTab.workplaceJoined")}
                value={identity.workplaceJoined}
                unknown={identityDetectionUnsupported}
              />
            </div>

            <div className="space-y-1.5 text-sm">
              {identity.domainName && (
                <div>
                  <span className="text-muted-foreground">
                    {t("deviceManagementTab.domain")}{" "}
                  </span>
                  <span className="font-medium">{identity.domainName}</span>
                </div>
              )}
              {identity.tenantId && (
                <div>
                  <span className="text-muted-foreground">
                    {t("deviceManagementTab.tenantId")}{" "}
                  </span>
                  <span className="font-mono text-xs">{identity.tenantId}</span>
                </div>
              )}
              {identity.mdmUrl && (
                <div>
                  <span className="text-muted-foreground">
                    {t("deviceManagementTab.mdmEnrollment")}{" "}
                  </span>
                  <span className="font-mono text-xs break-all">
                    {identity.mdmUrl}
                  </span>
                </div>
              )}
            </div>

            <div className="text-sm">
              <span className="text-muted-foreground">
                {t("deviceManagementTab.detectionSource")}{" "}
              </span>
              <span className="font-medium">{identity.source}</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Detected Management Tools ─────────────────────────────── */}
      <div className="rounded-lg border bg-card p-6 shadow-xs">
        <div className="flex items-center gap-2 mb-1">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">
            {t("deviceManagementTab.detectedManagementTools")}
          </h3>
        </div>
        <p className="mb-4 text-sm text-muted-foreground">
          {totalDetections} {t("deviceManagementTab.tool")}
          {totalDetections !== 1 ? t("deviceManagementTab.s") : ""}{" "}
          {t("deviceManagementTab.detectedAcross")} {populatedCategories.length}{" "}
          {t("deviceManagementTab.categor")}
          {populatedCategories.length !== 1
            ? t("deviceManagementTab.ies")
            : t("deviceManagementTab.y")}
        </p>

        {populatedCategories.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("deviceManagementTab.noManagementToolsDetectedOnThis")}
          </p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {populatedCategories.map((catKey) => {
              const detections = categories[catKey]!;
              return (
                <div
                  key={catKey}
                  className="rounded-md border bg-background p-4"
                >
                  <h4 className="text-sm font-semibold mb-3">
                    {CATEGORY_LABELS[catKey]}
                  </h4>
                  <div className="space-y-2">
                    {detections.map((det) => (
                      <div
                        key={det.name}
                        className="flex items-center justify-between gap-2"
                      >
                        <div className="min-w-0">
                          <p
                            className="text-sm font-medium truncate"
                            title={det.name}
                          >
                            {det.name}
                          </p>
                          {det.version && (
                            <p className="text-xs text-muted-foreground">
                              v{det.version}
                            </p>
                          )}
                        </div>
                        <span
                          className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-xs font-semibold capitalize ${STATUS_BADGE[det.status]}`}
                        >
                          {det.status}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Scan Errors ───────────────────────────────────────────── */}
      {posture.errors && posture.errors.length > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
          <h4 className="text-sm font-semibold text-amber-800 mb-2">
            {t("deviceManagementTab.scanWarnings")}
          </h4>
          <ul className="list-disc list-inside space-y-1">
            {posture.errors.map((err) => (
              <li key={err} className="text-xs text-amber-700">
                {err}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── Metadata footer ───────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <Clock className="h-3.5 w-3.5" />
          {t("deviceManagementTab.lastScanned")}{" "}
          {formatDateTime(posture.collectedAt)}
        </span>
        <span>
          {t("deviceManagementTab.scanDuration")} {posture.scanDurationMs}ms
        </span>
      </div>
    </div>
  );
}
