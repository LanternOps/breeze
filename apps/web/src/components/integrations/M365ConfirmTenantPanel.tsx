import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { fetchWithAuth } from "../../stores/auth";
import { useOrgStore } from "../../stores/orgStore";
import { handleActionError, runAction } from "../../lib/runAction";
import { navigateToMicrosoftLogin } from "@/lib/navigation";
import "@/lib/i18n";

/**
 * Confirm-tenant interstitial (#7913 W03), shared by both Customer Graph
 * cards. After an /organizations sign-in Breeze knows — cryptographically —
 * which tenant the administrator belongs to, but not whether that is the
 * customer's tenant or the technician's own MSP tenant. This screen shows it
 * and requires an explicit confirm before Microsoft's consent screen.
 *
 * The tenant is display-only here: the confirm POST carries no tenant, and
 * the server builds the consent URL from its own parked session.
 */

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type OrgNameSource = { organizations?: { id: string; name: string }[] };

interface PendingConfirmation {
  tenantId: string;
  administratorUsername: string | null;
}

type PanelState =
  | { kind: "loading" }
  | { kind: "ready"; pending: PendingConfirmation }
  | { kind: "expired" }
  | { kind: "cancelled" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePending(value: unknown): PendingConfirmation | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "administratorUsername,expiresAt,tenantId") return null;
  if (typeof value.tenantId !== "string" || !GUID.test(value.tenantId)) return null;
  if (
    value.administratorUsername !== null
    && (typeof value.administratorUsername !== "string"
      || value.administratorUsername.length < 1
      || value.administratorUsername.length > 256)
  ) return null;
  if (typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))) return null;
  return { tenantId: value.tenantId, administratorUsername: value.administratorUsername as string | null };
}

/** Accepts only a Microsoft login URL, exactly like the cards' consent start. */
export function parseMicrosoftConsentUrl(value: unknown): string {
  if (
    !isRecord(value)
    || Object.keys(value).length !== 1
    || typeof value.adminConsentUrl !== "string"
  ) {
    throw new Error("Invalid consent response");
  }
  const url = new URL(value.adminConsentUrl);
  if (url.protocol !== "https:" || url.hostname !== "login.microsoftonline.com") {
    throw new Error("Invalid consent response");
  }
  return url.toString();
}

/** The four steps of identity-first consent, in order. */
export function M365ConsentSteps({ className = "" }: { className?: string }) {
  const { t } = useTranslation("integrations");
  return (
    <div className={className} data-testid="m365-consent-steps">
      <p className="text-sm font-medium text-foreground">{t("m365ConfirmTenant.steps.title")}</p>
      <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
        <li>{t("m365ConfirmTenant.steps.identity")}</li>
        <li>{t("m365ConfirmTenant.steps.confirm")}</li>
        <li>{t("m365ConfirmTenant.steps.consent")}</li>
        <li>{t("m365ConfirmTenant.steps.verify")}</li>
      </ol>
    </div>
  );
}

interface M365ConfirmTenantPanelProps {
  /** Profile consent base, e.g. `/m365/connections/customer-graph-read/consent`. */
  apiBase: string;
  orgId: string;
  canWrite: boolean;
  /** Called after a successful cancel so the card can reload its connection. */
  onCancelled: () => void;
  testId: string;
}

export function M365ConfirmTenantPanel({
  apiBase,
  orgId,
  canWrite,
  onCancelled,
  testId,
}: M365ConfirmTenantPanelProps) {
  const { t } = useTranslation("integrations");
  const orgName = useOrgStore((value) => {
    const organizations = (value as OrgNameSource).organizations;
    return Array.isArray(organizations)
      ? organizations.find((org) => org.id === orgId)?.name ?? null
      : null;
  });
  const [panel, setPanel] = useState<PanelState>({ kind: "loading" });
  const [busy, setBusy] = useState<"continue" | "cancel" | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Guards a slow response from an org the operator has since left.
  const orgRef = useRef(orgId);
  orgRef.current = orgId;

  useEffect(() => {
    let active = true;
    setPanel({ kind: "loading" });
    void (async () => {
      try {
        const response = await fetchWithAuth(`${apiBase}/pending?orgId=${orgId}`);
        const raw = response.ok ? await response.json().catch(() => null) : null;
        const pending = parsePending(raw);
        if (active) setPanel(pending ? { kind: "ready", pending } : { kind: "expired" });
      } catch {
        if (active) setPanel({ kind: "expired" });
      }
    })();
    return () => { active = false; };
  }, [apiBase, orgId]);

  useEffect(() => {
    if (panel.kind === "ready") headingRef.current?.focus();
  }, [panel.kind]);

  const confirm = useCallback(async () => {
    if (busy || !canWrite) return;
    const target = orgId;
    setBusy("continue");
    try {
      const url = await runAction<string>({
        request: () => fetchWithAuth(`${apiBase}/continue?orgId=${target}`, { method: "POST" }),
        parseSuccess: parseMicrosoftConsentUrl,
        errorFallback: t("m365ConfirmTenant.continueFailed"),
      });
      if (orgRef.current === target) navigateToMicrosoftLogin(url);
    } catch (error) {
      if (orgRef.current === target) handleActionError(error, t("m365ConfirmTenant.continueFailed"));
    } finally {
      setBusy(null);
    }
  }, [apiBase, busy, canWrite, orgId, t]);

  const cancel = useCallback(async () => {
    if (busy || !canWrite) return;
    const target = orgId;
    setBusy("cancel");
    try {
      await runAction({
        request: () => fetchWithAuth(`${apiBase}/cancel?orgId=${target}`, { method: "POST" }),
        errorFallback: t("m365ConfirmTenant.cancelFailed"),
      });
      if (orgRef.current === target) {
        setPanel({ kind: "cancelled" });
        onCancelled();
      }
    } catch (error) {
      if (orgRef.current === target) handleActionError(error, t("m365ConfirmTenant.cancelFailed"));
    } finally {
      setBusy(null);
    }
  }, [apiBase, busy, canWrite, onCancelled, orgId, t]);

  return (
    <div
      data-testid={testId}
      role="region"
      aria-labelledby={`${testId}-title`}
      className="mt-6 rounded-lg border border-warning/40 bg-warning/10 p-4 sm:p-5"
    >
      <h4
        id={`${testId}-title`}
        ref={headingRef}
        tabIndex={-1}
        className="text-sm font-semibold text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        {t("m365ConfirmTenant.title")}
      </h4>

      {panel.kind === "loading" && (
        <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground" aria-busy="true">
          <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
          {t("m365ConfirmTenant.loading")}
        </p>
      )}

      {panel.kind === "expired" && (
        <p role="alert" className="mt-3 text-sm text-foreground">{t("m365ConfirmTenant.expired")}</p>
      )}

      {panel.kind === "cancelled" && (
        <p role="status" className="mt-3 text-sm text-foreground">{t("m365ConfirmTenant.cancelled")}</p>
      )}

      {panel.kind === "ready" && (
        <>
          <p className="mt-3 max-w-prose text-sm text-foreground">
            {panel.pending.administratorUsername
              ? t("m365ConfirmTenant.signedInAs", {
                  username: panel.pending.administratorUsername,
                  tenantId: panel.pending.tenantId,
                })
              : t("m365ConfirmTenant.signedInTo", { tenantId: panel.pending.tenantId })}
          </p>
          <dl className="mt-3 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-xs font-medium text-muted-foreground">{t("m365ConfirmTenant.tenantIdLabel")}</dt>
              <dd className="mt-1 break-all font-mono text-xs text-foreground">{panel.pending.tenantId}</dd>
            </div>
            {panel.pending.administratorUsername && (
              <div className="min-w-0">
                <dt className="text-xs font-medium text-muted-foreground">{t("m365ConfirmTenant.usernameLabel")}</dt>
                <dd className="mt-1 break-all text-foreground">{panel.pending.administratorUsername}</dd>
              </div>
            )}
          </dl>
          <p className="mt-3 max-w-prose text-sm font-medium text-foreground">
            {orgName
              ? t("m365ConfirmTenant.requestFor", { orgName })
              : t("m365ConfirmTenant.requestForThisOrg")}
          </p>
          <p className="mt-3 flex max-w-prose items-start gap-2 text-sm text-foreground">
            <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            {t("m365ConfirmTenant.mspWarning")}
          </p>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
            <button
              type="button"
              onClick={() => void confirm()}
              disabled={!canWrite || busy !== null}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === "continue" && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}
              {t("m365ConfirmTenant.continue")}
            </button>
            <button
              type="button"
              onClick={() => void cancel()}
              disabled={!canWrite || busy !== null}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === "cancel" && <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />}
              {t("m365ConfirmTenant.cancel")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
