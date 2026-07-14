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
import { M365_PERMISSION_PROFILES } from "@breeze/shared";
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

export const M365_CUSTOMER_GRAPH_READ_CALLBACK_RESULTS = [
  "active",
  "degraded",
  ...STABLE_ERROR_CODES,
] as const;
export type M365CustomerGraphReadCallbackResult =
  (typeof M365_CUSTOMER_GRAPH_READ_CALLBACK_RESULTS)[number];

interface M365CustomerGraphReadCardProps {
  callbackResult?: M365CustomerGraphReadCallbackResult | null;
  callbackRefreshKey?: number;
}

type Grant = {
  resourceApplicationId: string;
  appRoleId: string;
  value: string | null;
};

type Connection = {
  id: string;
  tenantId: string | null;
  clientId: string | null;
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
type OrgGeneration = {
  orgId: string | null;
  generation: number;
  requestSequence: number;
};
type ScopedLoad = {
  scope: OrgGeneration;
  state: LoadState;
  data: Envelope | null;
};
type ScopedAction = { scope: OrgGeneration; name: ActionName };

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
    || (value.value !== null && (
      typeof value.value !== "string"
      || value.value.length < 1
      || value.value.length > 160
    ))
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

const TRUSTED_PROFILE = M365_PERMISSION_PROFILES["customer-graph-read"];

function grantTuple(grant: Grant): string {
  return `${grant.resourceApplicationId.toLowerCase()}:${grant.appRoleId.toLowerCase()}:${grant.value}`;
}

function matchesTrustedManifest(grants: Grant[]): boolean {
  const expected = [...(TRUSTED_PROFILE.applicationPermissionAssignments ?? [])]
    .map(grantTuple)
    .sort();
  const actual = grants.map(grantTuple).sort();
  return actual.length === expected.length
    && actual.every((grant, index) => grant === expected[index]);
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
    || (value.clientId !== null && (typeof value.clientId !== "string" || !GUID.test(value.clientId)))
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
    clientId: value.clientId as string | null,
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
    || value.profile.manifestVersion !== TRUSTED_PROFILE.version
    || grants === null || !matchesTrustedManifest(grants)
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
          <span className="break-words font-medium text-foreground">
            {grant.value ?? t("m365CustomerGraphRead.grants.unknownPermission", { appRoleId: grant.appRoleId })}
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function M365CustomerGraphReadCard({
  callbackResult = null,
  callbackRefreshKey = 0,
}: M365CustomerGraphReadCardProps) {
  const { t } = useTranslation("integrations");
  const currentOrgId = useOrgStore((value) => value.currentOrgId);
  const { can } = usePermissions();
  const claims = getJwtClaims();
  const orgId = currentOrgId || (claims.scope === "organization" ? claims.orgId : null);
  const scopeRef = useRef<OrgGeneration>({ orgId, generation: 0, requestSequence: 0 });
  if (scopeRef.current.orgId !== orgId) {
    scopeRef.current = {
      orgId,
      generation: scopeRef.current.generation + 1,
      requestSequence: 0,
    };
  }
  const scope = scopeRef.current;
  const [loaded, setLoaded] = useState<ScopedLoad>({
    scope,
    state: orgId ? "loading" : "unavailable",
    data: null,
  });
  const [actionState, setActionState] = useState<ScopedAction | null>(null);
  const actionRef = useRef<ScopedAction | null>(null);
  const canWrite = can("organizations", "write");
  const isCurrent = useCallback((target: OrgGeneration) => scopeRef.current === target, []);

  const load = useCallback(async (target: OrgGeneration) => {
    if (!isCurrent(target)) return;
    const sequence = ++target.requestSequence;
    if (!target.orgId) {
      setLoaded({ scope: target, state: "unavailable", data: null });
      return;
    }
    setLoaded({ scope: target, state: "loading", data: null });
    try {
      const response = await fetchWithAuth(`/m365/connections?orgId=${target.orgId}`);
      const raw = await response.json().catch(() => null);
      const parsed = response.ok ? parseEnvelope(raw) : null;
      if (!isCurrent(target) || sequence !== target.requestSequence) return;
      setLoaded({
        scope: target,
        state: parsed ? "ready" : "error",
        data: parsed,
      });
    } catch {
      if (isCurrent(target) && sequence === target.requestSequence) {
        setLoaded({ scope: target, state: "error", data: null });
      }
    }
  }, [isCurrent]);

  useEffect(() => {
    void load(scope);
    return () => { scope.requestSequence += 1; };
  }, [callbackRefreshKey, load, scope]);

  const scopedRequest = useCallback(async (
    target: OrgGeneration,
    request: () => Promise<Response>,
    stalePayload: unknown,
  ): Promise<Response> => {
    const silentResponse = () => new Response(JSON.stringify(stalePayload), {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
    });
    let response: Response;
    try {
      response = await request();
    } catch (error) {
      if (!isCurrent(target)) return silentResponse();
      throw error;
    }

    let body: string;
    try {
      body = await response.text();
    } catch (error) {
      if (!isCurrent(target)) return silentResponse();
      throw error;
    }
    if (!isCurrent(target)) return silentResponse();

    const bodylessStatus = response.status === 204
      || response.status === 205
      || response.status === 304;
    return new Response(bodylessStatus ? null : body, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    });
  }, [isCurrent]);

  const perform = useCallback(async (
    target: OrgGeneration,
    name: ActionName,
    task: () => Promise<void>,
  ) => {
    if (actionRef.current?.scope === target) return;
    const nextAction = { scope: target, name };
    actionRef.current = nextAction;
    if (isCurrent(target)) setActionState(nextAction);
    try {
      await task();
    } finally {
      if (actionRef.current === nextAction) actionRef.current = null;
      if (isCurrent(target)) {
        setActionState((current) => current === nextAction ? null : current);
      }
    }
  }, [isCurrent]);

  const loadState = loaded.scope === scope
    ? loaded.state
    : (orgId ? "loading" : "unavailable");
  const data = loaded.scope === scope ? loaded.data : null;
  const action = actionState?.scope === scope ? actionState.name : null;

  const startConsent = useCallback(() => {
    if (!orgId || !data || !canWrite || !data.onboardingEnabled) return;
    const target = scope;
    void perform(target, "consent", async () => {
      try {
        const url = await runAction<string>({
          request: () => scopedRequest(
            target,
            () => fetchWithAuth(`/m365/connections/customer-graph-read/consent?orgId=${target.orgId}`, { method: "POST" }),
            { adminConsentUrl: "https://login.microsoftonline.com/organizations/" },
          ),
          parseSuccess: parseConsentUrl,
          errorFallback: t("m365CustomerGraphRead.actions.consentFailed"),
        });
        if (isCurrent(target)) navigateTo(url);
      } catch (error) {
        if (isCurrent(target)) {
          handleActionError(error, t("m365CustomerGraphRead.actions.consentFailed"));
        }
      }
    });
  }, [canWrite, data, isCurrent, orgId, perform, scope, scopedRequest, t]);

  const retest = useCallback(() => {
    if (
      !orgId
      || !data?.connection
      || !canWrite
      || !(["active", "degraded"] as ConnectionStatus[]).includes(data.connection.status)
    ) return;
    const target = scope;
    const connectionId = data.connection.id;
    void perform(target, "retest", async () => {
      try {
        await runAction({
          request: () => scopedRequest(
            target,
            () => fetchWithAuth(`/m365/connections/${connectionId}/retest?orgId=${target.orgId}`, { method: "POST" }),
            {},
          ),
          errorFallback: t("m365CustomerGraphRead.actions.retestFailed"),
          successMessage: () => isCurrent(target)
            ? t("m365CustomerGraphRead.actions.retestSucceeded")
            : "",
        });
        if (isCurrent(target)) await load(target);
      } catch (error) {
        if (isCurrent(target)) {
          handleActionError(error, t("m365CustomerGraphRead.actions.retestFailed"));
        }
      }
    });
  }, [canWrite, data, isCurrent, load, orgId, perform, scope, scopedRequest, t]);

  const disconnect = useCallback(() => {
    if (!orgId || !data?.connection || !canWrite) return;
    if (!window.confirm(t("m365CustomerGraphRead.actions.disconnectWarning"))) return;
    const target = scope;
    const connectionId = data.connection.id;
    void perform(target, "disconnect", async () => {
      try {
        await runAction({
          request: () => scopedRequest(
            target,
            () => fetchWithAuth(`/m365/connections/${connectionId}/disconnect?orgId=${target.orgId}`, { method: "POST" }),
            {},
          ),
          errorFallback: t("m365CustomerGraphRead.actions.disconnectFailed"),
          successMessage: () => isCurrent(target)
            ? t("m365CustomerGraphRead.actions.disconnectSucceeded")
            : "",
        });
        if (isCurrent(target)) await load(target);
      } catch (error) {
        if (isCurrent(target)) {
          handleActionError(error, t("m365CustomerGraphRead.actions.disconnectFailed"));
        }
      }
    });
  }, [canWrite, data, isCurrent, load, orgId, perform, scope, scopedRequest, t]);

  const connection = data?.connection ?? null;
  const reconciliationUnavailable = connection?.lastErrorCode === "grant_reconciliation_unavailable";
  const hasLastKnownGrantHealth = reconciliationUnavailable && connection.grantsVerifiedAt !== null;
  const grantHealthUnknown = reconciliationUnavailable && connection.grantsVerifiedAt === null;
  const displayedMissingGrants = grantHealthUnknown ? [] : (connection?.missingGrants ?? []);
  const displayedUnexpectedGrants = grantHealthUnknown ? [] : (connection?.unexpectedGrants ?? []);
  const observedHeading = hasLastKnownGrantHealth
    ? t("m365CustomerGraphRead.grants.lastKnownObserved")
    : t("m365CustomerGraphRead.grants.observed");
  const missingHeading = hasLastKnownGrantHealth
    ? t("m365CustomerGraphRead.grants.lastKnownMissing")
    : t("m365CustomerGraphRead.grants.missing");
  const unexpectedAlert = hasLastKnownGrantHealth
    ? t("m365CustomerGraphRead.grants.lastKnownUnexpectedAlert")
    : t("m365CustomerGraphRead.grants.unexpectedAlert");
  const canRetestConnection = connection?.status === "active" || connection?.status === "degraded";
  const StatusIcon = connection ? statusIcon(connection.status) : Unplug;
  const errorCopy = useMemo(() => {
    if (!connection?.lastErrorCode) return null;
    return isStableErrorCode(connection.lastErrorCode)
      ? t(/* i18n-dynamic */ `m365CustomerGraphRead.errors.${connection.lastErrorCode}`)
      : t("m365CustomerGraphRead.errors.unknown");
  }, [connection, t]);
  const callbackCopy = callbackResult === "active"
    ? t("m365CustomerGraphRead.callback.active")
    : callbackResult === "degraded"
      ? t("m365CustomerGraphRead.callback.degraded")
      : callbackResult
        ? t(/* i18n-dynamic */ `m365CustomerGraphRead.errors.${callbackResult}`)
        : null;

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
            {t(/* i18n-dynamic */ `m365CustomerGraphRead.status.${connection.status}`)}
          </span>
        )}
      </div>

      {callbackCopy && (
        <p
          role={callbackResult === "active" ? "status" : "alert"}
          className={`mt-6 rounded-md p-3 text-sm ${
            callbackResult === "active"
              ? "bg-success/10 text-foreground"
              : "border border-warning/40 bg-warning/10 text-foreground"
          }`}
        >
          {callbackCopy}
        </p>
      )}

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
                {hasLastKnownGrantHealth && (
                  <p className="mb-3 text-sm text-muted-foreground">{t("m365CustomerGraphRead.grants.lastKnownHelp")}</p>
                )}
                {grantHealthUnknown && (
                  <p className="mb-3 text-sm text-muted-foreground">{t("m365CustomerGraphRead.grants.unknownHelp")}</p>
                )}
                <GrantList grants={connection.observedGrants} />
              </div>
            )}
          </div>

          {connection && (displayedMissingGrants.length > 0 || displayedUnexpectedGrants.length > 0) && (
            <div className="grid gap-6 border-t pt-5 lg:grid-cols-2">
              <div>
                <h3 className="mb-3 text-sm font-semibold text-foreground">{missingHeading}</h3>
                <GrantList grants={displayedMissingGrants} />
              </div>
              {displayedUnexpectedGrants.length > 0 && (
                <div role="alert" aria-label={unexpectedAlert} className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-destructive">
                  <div className="mb-3 flex items-center gap-2 font-semibold"><AlertTriangle aria-hidden="true" className="h-4 w-4" />{unexpectedAlert}</div>
                  <GrantList grants={displayedUnexpectedGrants} />
                </div>
              )}
            </div>
          )}

          <div className="flex flex-col gap-3 border-t pt-5 sm:flex-row sm:flex-wrap sm:items-center">
            <button type="button" onClick={startConsent} disabled={!canWrite || !data.onboardingEnabled || action !== null} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50">
              {action === "consent" && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}
              {connection ? t("m365CustomerGraphRead.actions.reconsent") : t("m365CustomerGraphRead.actions.connect")}
            </button>
            {connection && (
              <>
                {canRetestConnection && (
                  <button type="button" onClick={retest} disabled={!canWrite || action !== null} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50">
                    <RefreshCw aria-hidden="true" className={`h-4 w-4 ${action === "retest" ? "animate-spin" : ""}`} />{t("m365CustomerGraphRead.actions.retest")}
                  </button>
                )}
                <button type="button" onClick={disconnect} disabled={!canWrite || action !== null} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-destructive/40 px-4 py-2 text-sm font-medium text-destructive hover:bg-destructive/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-destructive disabled:cursor-not-allowed disabled:opacity-50">
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
