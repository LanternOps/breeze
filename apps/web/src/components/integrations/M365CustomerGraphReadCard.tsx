import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Loader2,
  PauseCircle,
  RefreshCw,
  ShieldCheck,
  Unplug,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { fetchWithAuth } from "../../stores/auth";
import { useOrgStore } from "../../stores/orgStore";
import { getJwtClaims } from "../../lib/authScope";
import { usePermissions } from "../../lib/permissions";
import { handleActionError, runAction } from "../../lib/runAction";
import { navigateTo } from "@/lib/navigation";
import { formatDateTime } from "@/lib/dateTimeFormat";
import "@/lib/i18n";

const STATUSES = [
  "pending-consent",
  "verifying",
  "active",
  "degraded",
  "suspended",
  "revoked",
] as const;
type ConnectionStatus = (typeof STATUSES)[number];

const STABLE_ERROR_CODES = [
  "consent_expired",
  "consent_state_mismatch",
  "consent_cancelled",
  "admin_role_required",
  "tenant_mismatch",
  "tenant_already_bound",
  "credential_unavailable",
  "identity_token_invalid",
  "application_token_invalid",
  "grant_reconciliation_unavailable",
  "grant_missing",
  "grant_unexpected",
  "manifest_stale",
  "organization_probe_failed",
  "executor_unavailable",
] as const;
type StableErrorCode = (typeof STABLE_ERROR_CODES)[number];

type Grant = {
  resourceApplicationId: string;
  appRoleId: string;
  value: string;
};

type Connection = {
  id: string;
  tenantId: string | null;
  clientId: string;
  displayName: string | null;
  status: ConnectionStatus;
  manifestVersion: number;
  observedGrants: Grant[];
  missingGrants: Grant[];
  unexpectedGrants: Grant[];
  grantsVerifiedAt: string | null;
  lastVerifiedAt: string | null;
  lastErrorCode: string | null;
};

type Envelope = {
  profile: {
    id: "customer-graph-read";
    displayName: string;
    manifestVersion: 2;
    requiredGrants: Grant[];
  };
  onboardingEnabled: boolean;
  connection: Connection | null;
};

type LoadState = "unavailable" | "loading" | "ready" | "error";
type ActionName = "consent" | "retest" | "disconnect";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseGrant(value: unknown): Grant | null {
  if (!isRecord(value) || !hasExactKeys(value, ["resourceApplicationId", "appRoleId", "value"])) return null;
  if (
    typeof value.resourceApplicationId !== "string"
    || !GUID.test(value.resourceApplicationId)
    || typeof value.appRoleId !== "string"
    || !GUID.test(value.appRoleId)
    || typeof value.value !== "string"
    || value.value.length < 1
    || value.value.length > 160
  ) return null;
  return {
    resourceApplicationId: value.resourceApplicationId,
    appRoleId: value.appRoleId,
    value: value.value,
  };
}

function parseGrants(value: unknown): Grant[] | null {
  if (!Array.isArray(value) || value.length > 64) return null;
  const grants = value.map(parseGrant);
  if (grants.some((grant) => grant === null)) return null;
  const parsed = grants as Grant[];
  const unique = new Set(parsed.map((grant) => `${grant.resourceApplicationId}:${grant.appRoleId}`));
  return unique.size === parsed.length ? parsed : null;
}

function parseTimestamp(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return undefined;
  return value;
}

function parseConnection(value: unknown): Connection | null | undefined {
  if (value === null) return null;
  const keys = [
    "id", "tenantId", "clientId", "displayName", "status", "manifestVersion",
    "observedGrants", "missingGrants", "unexpectedGrants", "grantsVerifiedAt",
    "lastVerifiedAt", "lastErrorCode",
  ];
  if (!isRecord(value) || !hasExactKeys(value, keys)) return undefined;
  const observedGrants = parseGrants(value.observedGrants);
  const missingGrants = parseGrants(value.missingGrants);
  const unexpectedGrants = parseGrants(value.unexpectedGrants);
  const grantsVerifiedAt = parseTimestamp(value.grantsVerifiedAt);
  const lastVerifiedAt = parseTimestamp(value.lastVerifiedAt);
  if (
    typeof value.id !== "string" || !GUID.test(value.id)
    || (value.tenantId !== null && (typeof value.tenantId !== "string" || !GUID.test(value.tenantId)))
    || typeof value.clientId !== "string" || !GUID.test(value.clientId)
    || (value.displayName !== null && typeof value.displayName !== "string")
    || typeof value.status !== "string" || !(STATUSES as readonly string[]).includes(value.status)
    || typeof value.manifestVersion !== "number" || !Number.isSafeInteger(value.manifestVersion) || value.manifestVersion < 1
    || observedGrants === null || missingGrants === null || unexpectedGrants === null
    || grantsVerifiedAt === undefined || lastVerifiedAt === undefined
    || (value.lastErrorCode !== null && typeof value.lastErrorCode !== "string")
  ) return undefined;
  return {
    id: value.id,
    tenantId: value.tenantId as string | null,
    clientId: value.clientId,
    displayName: value.displayName as string | null,
    status: value.status as ConnectionStatus,
    manifestVersion: value.manifestVersion,
    observedGrants,
    missingGrants,
    unexpectedGrants,
    grantsVerifiedAt,
    lastVerifiedAt,
    lastErrorCode: value.lastErrorCode as string | null,
  };
}

function parseEnvelope(value: unknown): Envelope | null {
  if (!isRecord(value) || !hasExactKeys(value, ["profile", "onboardingEnabled", "connection"])) return null;
  if (!isRecord(value.profile) || !hasExactKeys(value.profile, ["id", "displayName", "manifestVersion", "requiredGrants"])) return null;
  const grants = parseGrants(value.profile.requiredGrants);
  const connection = parseConnection(value.connection);
  if (
    value.profile.id !== "customer-graph-read"
    || typeof value.profile.displayName !== "string"
    || value.profile.manifestVersion !== 2
    || grants === null || grants.length !== 9
    || typeof value.onboardingEnabled !== "boolean"
    || connection === undefined
  ) return null;
  return {
    profile: {
      id: "customer-graph-read",
      displayName: value.profile.displayName,
      manifestVersion: 2,
      requiredGrants: grants,
    },
    onboardingEnabled: value.onboardingEnabled,
    connection,
  };
}

function parseConsentUrl(value: unknown): string {
  if (!isRecord(value) || !hasExactKeys(value, ["adminConsentUrl"]) || typeof value.adminConsentUrl !== "string") {
    throw new Error("Invalid consent response");
  }
  const url = new URL(value.adminConsentUrl);
  if (url.protocol !== "https:" || url.hostname !== "login.microsoftonline.com") {
    throw new Error("Invalid consent response");
  }
  return url.toString();
}

function isStableErrorCode(value: string | null): value is StableErrorCode {
  return value !== null && (STABLE_ERROR_CODES as readonly string[]).includes(value);
}

function statusIcon(status: ConnectionStatus) {
  if (status === "active") return CheckCircle2;
  if (status === "degraded") return AlertTriangle;
  if (status === "suspended") return PauseCircle;
  if (status === "revoked") return Unplug;
  return Clock3;
}

function statusClass(status: ConnectionStatus): string {
  if (status === "active") return "border-success/30 bg-success/10 text-success";
  if (status === "degraded") return "border-warning/40 bg-warning/10 text-warning-foreground";
  if (status === "revoked") return "border-destructive/30 bg-destructive/10 text-destructive";
  return "border-border bg-muted text-muted-foreground";
}

function GrantList({ grants, testId }: { grants: Grant[]; testId?: string }) {
  const { t } = useTranslation("integrations");
  if (grants.length === 0) return <p className="text-sm text-muted-foreground">{t("m365CustomerGraphRead.none")}</p>;
  return (
    <ul className="space-y-1.5 text-sm">
      {grants.map((grant) => (
        <li key={`${grant.resourceApplicationId}:${grant.appRoleId}`} data-testid={testId} className="flex min-w-0 items-start gap-2">
          <CheckCircle2 aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="break-words font-medium text-foreground">{grant.value}</span>
        </li>
      ))}
    </ul>
  );
}

export default function M365CustomerGraphReadCard() {
  const { t } = useTranslation("integrations");
  const currentOrgId = useOrgStore((value) => value.currentOrgId);
  const { can } = usePermissions();
  const claims = getJwtClaims();
  const orgId = currentOrgId || (claims.scope === "organization" ? claims.orgId : null);
  const [loadState, setLoadState] = useState<LoadState>(orgId ? "loading" : "unavailable");
  const [data, setData] = useState<Envelope | null>(null);
  const [action, setAction] = useState<ActionName | null>(null);
  const actionRef = useRef<ActionName | null>(null);
  const requestId = useRef(0);
  const canWrite = can("organizations", "write");

  const load = useCallback(async () => {
    const sequence = ++requestId.current;
    setData(null);
    if (!orgId) {
      setLoadState("unavailable");
      return;
    }
    setLoadState("loading");
    try {
      const response = await fetchWithAuth(`/m365/connections?orgId=${orgId}`);
      const raw = await response.json().catch(() => null);
      const parsed = response.ok ? parseEnvelope(raw) : null;
      if (sequence !== requestId.current) return;
      if (!parsed) {
        setLoadState("error");
        return;
      }
      setData(parsed);
      setLoadState("ready");
    } catch {
      if (sequence === requestId.current) setLoadState("error");
    }
  }, [orgId]);

  useEffect(() => {
    void load();
    return () => { requestId.current += 1; };
  }, [load]);

  const perform = useCallback(async (name: ActionName, task: () => Promise<void>) => {
    if (actionRef.current) return;
    actionRef.current = name;
    setAction(name);
    try {
      await task();
    } finally {
      actionRef.current = null;
      setAction(null);
    }
  }, []);

  const startConsent = useCallback(() => {
    if (!orgId || !data || !canWrite || !data.onboardingEnabled) return;
    void perform("consent", async () => {
      try {
        const url = await runAction<string>({
          request: () => fetchWithAuth(`/m365/connections/customer-graph-read/consent?orgId=${orgId}`, { method: "POST" }),
          parseSuccess: parseConsentUrl,
          errorFallback: t("m365CustomerGraphRead.actions.consentFailed"),
        });
        navigateTo(url);
      } catch (error) {
        handleActionError(error, t("m365CustomerGraphRead.actions.consentFailed"));
      }
    });
  }, [canWrite, data, orgId, perform, t]);

  const retest = useCallback(() => {
    if (!orgId || !data?.connection || !canWrite) return;
    void perform("retest", async () => {
      try {
        await runAction({
          request: () => fetchWithAuth(`/m365/connections/${data.connection!.id}/retest?orgId=${orgId}`, { method: "POST" }),
          errorFallback: t("m365CustomerGraphRead.actions.retestFailed"),
          successMessage: t("m365CustomerGraphRead.actions.retestSucceeded"),
        });
        await load();
      } catch (error) {
        handleActionError(error, t("m365CustomerGraphRead.actions.retestFailed"));
      }
    });
  }, [canWrite, data, load, orgId, perform, t]);

  const disconnect = useCallback(() => {
    if (!orgId || !data?.connection || !canWrite) return;
    if (!window.confirm(t("m365CustomerGraphRead.actions.disconnectWarning"))) return;
    void perform("disconnect", async () => {
      try {
        await runAction({
          request: () => fetchWithAuth(`/m365/connections/${data.connection!.id}/disconnect?orgId=${orgId}`, { method: "POST" }),
          errorFallback: t("m365CustomerGraphRead.actions.disconnectFailed"),
          successMessage: t("m365CustomerGraphRead.actions.disconnectSucceeded"),
        });
        await load();
      } catch (error) {
        handleActionError(error, t("m365CustomerGraphRead.actions.disconnectFailed"));
      }
    });
  }, [canWrite, data, load, orgId, perform, t]);

  const connection = data?.connection ?? null;
  const observedHeading = connection?.lastErrorCode === "grant_reconciliation_unavailable"
    ? t("m365CustomerGraphRead.grants.lastKnownObserved")
    : t("m365CustomerGraphRead.grants.observed");
  const StatusIcon = connection ? statusIcon(connection.status) : Unplug;
  const errorCopy = useMemo(() => {
    if (!connection?.lastErrorCode) return null;
    return isStableErrorCode(connection.lastErrorCode)
      ? t(`m365CustomerGraphRead.errors.${connection.lastErrorCode}`)
      : t("m365CustomerGraphRead.errors.unknown");
  }, [connection, t]);

  return (
    <section className="rounded-xl border bg-card p-5 sm:p-6" aria-labelledby="customer-graph-read-title">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <ShieldCheck aria-hidden="true" className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h2 id="customer-graph-read-title" className="text-lg font-semibold text-foreground">{t("m365CustomerGraphRead.title")}</h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">{t("m365CustomerGraphRead.description")}</p>
          </div>
        </div>
        {connection && (
          <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${statusClass(connection.status)}`}>
            <StatusIcon aria-hidden="true" className="h-3.5 w-3.5" />
            {t(`m365CustomerGraphRead.status.${connection.status}`)}
          </span>
        )}
      </div>

      {loadState === "unavailable" && (
        <p className="mt-6 rounded-md bg-muted p-4 text-sm text-muted-foreground">{t("m365CustomerGraphRead.selectOrganization")}</p>
      )}
      {loadState === "loading" && (
        <div className="mt-6 space-y-3" aria-label={t("m365CustomerGraphRead.loading")}>
          <div className="skeleton h-5 w-48" />
          <div className="skeleton h-4 w-full max-w-2xl" />
          <span className="sr-only">{t("m365CustomerGraphRead.loading")}</span>
        </div>
      )}
      {loadState === "error" && (
        <div role="alert" className="mt-6 rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          {t("m365CustomerGraphRead.unavailable")}
        </div>
      )}

      {loadState === "ready" && data && (
        <div className="mt-6 space-y-6">
          {!data.onboardingEnabled && (
            <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
              {t("m365CustomerGraphRead.onboardingUnavailable")}
            </p>
          )}
          {errorCopy && (
            <p className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-foreground">{errorCopy}</p>
          )}

          {connection && (
            <div className="border-t pt-5">
              <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
                <div><dt className="text-xs font-medium text-muted-foreground">{t("m365CustomerGraphRead.tenant")}</dt><dd className="mt-1 text-sm font-medium text-foreground">{connection.displayName || t("m365CustomerGraphRead.unnamedTenant")}</dd></div>
                <div><dt className="text-xs font-medium text-muted-foreground">{t("m365CustomerGraphRead.tenantId")}</dt><dd className="mt-1 break-all font-mono text-xs text-foreground">{connection.tenantId || t("m365CustomerGraphRead.notVerified")}</dd></div>
                <div><dt className="text-xs font-medium text-muted-foreground">{t("m365CustomerGraphRead.manifest")}</dt><dd className="mt-1 text-sm text-foreground">{t("m365CustomerGraphRead.manifestVersion", { version: connection.manifestVersion })}</dd></div>
                <div><dt className="text-xs font-medium text-muted-foreground">{t("m365CustomerGraphRead.grants.grantsVerifiedAt")}</dt><dd className="mt-1 text-sm text-foreground">{connection.grantsVerifiedAt ? formatDateTime(connection.grantsVerifiedAt) : t("m365CustomerGraphRead.never")}</dd></div>
                <div><dt className="text-xs font-medium text-muted-foreground">{t("m365CustomerGraphRead.lastVerifiedAt")}</dt><dd className="mt-1 text-sm text-foreground">{connection.lastVerifiedAt ? formatDateTime(connection.lastVerifiedAt) : t("m365CustomerGraphRead.never")}</dd></div>
              </dl>
            </div>
          )}

          <div className="grid gap-6 border-t pt-5 lg:grid-cols-2">
            <div>
              <h3 className="mb-3 text-sm font-semibold text-foreground">{t("m365CustomerGraphRead.grants.required")}</h3>
              <GrantList grants={data.profile.requiredGrants} testId="required-grant" />
            </div>
            {connection && (
              <div>
                <h3 className="mb-3 text-sm font-semibold text-foreground">{observedHeading}</h3>
                {connection.lastErrorCode === "grant_reconciliation_unavailable" && (
                  <p className="mb-3 text-sm text-muted-foreground">{t("m365CustomerGraphRead.grants.lastKnownHelp")}</p>
                )}
                <GrantList grants={connection.observedGrants} />
              </div>
            )}
          </div>

          {connection && (connection.missingGrants.length > 0 || connection.unexpectedGrants.length > 0) && (
            <div className="grid gap-6 border-t pt-5 lg:grid-cols-2">
              <div>
                <h3 className="mb-3 text-sm font-semibold text-foreground">{t("m365CustomerGraphRead.grants.missing")}</h3>
                <GrantList grants={connection.missingGrants} />
              </div>
              {connection.unexpectedGrants.length > 0 && (
                <div role="alert" aria-label={t("m365CustomerGraphRead.grants.unexpectedAlert")} className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-destructive">
                  <div className="mb-3 flex items-center gap-2 font-semibold"><AlertTriangle aria-hidden="true" className="h-4 w-4" />{t("m365CustomerGraphRead.grants.unexpectedAlert")}</div>
                  <GrantList grants={connection.unexpectedGrants} />
                </div>
              )}
            </div>
          )}

          <div className="flex flex-col gap-3 border-t pt-5 sm:flex-row sm:flex-wrap sm:items-center">
            <button type="button" onClick={startConsent} disabled={!canWrite || !data.onboardingEnabled || action !== null} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50">
              {action === "consent" && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}
              {connection ? t("m365CustomerGraphRead.actions.reconsent") : t("m365CustomerGraphRead.actions.connect")}
            </button>
            {connection && (
              <>
                <button type="button" onClick={retest} disabled={!canWrite || action !== null} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50">
                  <RefreshCw aria-hidden="true" className={`h-4 w-4 ${action === "retest" ? "animate-spin" : ""}`} />{t("m365CustomerGraphRead.actions.retest")}
                </button>
                <button type="button" onClick={disconnect} disabled={!canWrite || action !== null} className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-destructive/40 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-destructive disabled:cursor-not-allowed disabled:opacity-50">
                  <Unplug aria-hidden="true" className="h-4 w-4" />{t("m365CustomerGraphRead.actions.disconnect")}
                </button>
              </>
            )}
            {!canWrite && <p className="text-sm text-muted-foreground">{t("m365CustomerGraphRead.actions.permissionRequired")}</p>}
          </div>

          <p className="text-xs leading-5 text-muted-foreground">
            {t("m365CustomerGraphRead.microsoftConsentHelp")} {" "}
            <a href="https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/manage-application-permissions" target="_blank" rel="noreferrer noopener" className="font-medium text-primary underline-offset-4 hover:underline">{t("m365CustomerGraphRead.microsoftConsentDocs")}</a>
          </p>
        </div>
      )}
    </section>
  );
}
