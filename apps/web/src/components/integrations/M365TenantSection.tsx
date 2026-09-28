import { useCallback, useEffect, useId, useState } from "react";
import { Building2, Check, ChevronRight, Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useOrgStore } from "../../stores/orgStore";
import { getJwtClaims } from "../../lib/authScope";
import { formatDateTime } from "@/lib/dateTimeFormat";
import M365Integration from "./M365Integration";
import M365CustomerGraphReadCard, {
  type M365CustomerGraphReadCallbackResult,
} from "./M365CustomerGraphReadCard";
import M365CustomerGraphActionsCard, {
  type M365CustomerGraphActionsCallbackResult,
} from "./M365CustomerGraphActionsCard";
import {
  isUsableConsentConnection,
  type M365ConsentStepSummary,
  type M365LegacyStatus,
} from "./m365ConsentSummary";
import "@/lib/i18n";

interface M365TenantSectionProps {
  readCallbackResult?: M365CustomerGraphReadCallbackResult | null;
  readCallbackRefreshKey?: number;
  actionsCallbackResult?: M365CustomerGraphActionsCallbackResult | null;
  actionsCallbackRefreshKey?: number;
}

type Layout =
  /** Something has not reported yet: show one placeholder, keep everything mounted. */
  | "pending"
  /** No organization in scope: legacy first, one line instead of two card messages. */
  | "no-org"
  /** Consent onboarding is off for this instance/org and nothing is connected. */
  | "consent-unavailable"
  /** The tenant panel leads; legacy sits at the bottom. */
  | "consent-available";

type OrgNameSource = {
  organizations?: { id: string; name: string }[];
};

function TenantIdCopy({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation("integrations");
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(tenantId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked (insecure context / permissions); the ID is still
      // selectable beside the button, so fail quietly rather than toast.
    }
  };
  return (
    <button
      type="button"
      onClick={onCopy}
      data-testid="m365-copy-tenant-id"
      aria-label={t("m365TenantPanel.copyTenantId")}
      title={t("m365TenantPanel.copyTenantId")}
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >
      {copied
        ? <Check aria-hidden="true" className="h-4 w-4 text-success" />
        : <Copy aria-hidden="true" className="h-4 w-4" />}
      <span className="sr-only" aria-live="polite">{copied ? t("m365TenantPanel.copied") : ""}</span>
    </button>
  );
}

/**
 * Cloud tenants → Microsoft 365. Orders the three connection paths by what the
 * instance can actually do:
 *
 * - Consent onboarding unavailable (both profiles off, nothing connected): the
 *   legacy direct connection stays first; the consent path collapses to one line.
 * - Consent onboarding available (or a consent connection already exists): one
 *   tenant panel leads with Read (step 1) then Admin actions (step 2), and the
 *   legacy form moves under an "Advanced" disclosure at the bottom — unless the
 *   org already has a legacy connection, which is always shown expanded.
 *
 * The steps and the legacy card keep their own fetches and state machines and
 * report a summary up; every child stays mounted at a stable key so a layout
 * change reorders them instead of remounting (and refetching) them.
 */
export default function M365TenantSection({
  readCallbackResult = null,
  readCallbackRefreshKey = 0,
  actionsCallbackResult = null,
  actionsCallbackRefreshKey = 0,
}: M365TenantSectionProps) {
  const { t } = useTranslation("integrations");
  const currentOrgId = useOrgStore((value) => value.currentOrgId);
  const claims = getJwtClaims();
  const orgId = currentOrgId || (claims.scope === "organization" ? claims.orgId : null);
  const orgName = useOrgStore((value) => {
    const organizations = (value as OrgNameSource).organizations;
    return orgId && Array.isArray(organizations)
      ? organizations.find((org) => org.id === orgId)?.name ?? null
      : null;
  });

  const [legacyStatus, setLegacyStatus] = useState<M365LegacyStatus>("loading");
  const [read, setRead] = useState<M365ConsentStepSummary | null>(null);
  const [actions, setActions] = useState<M365ConsentStepSummary | null>(null);
  const [legacyOpen, setLegacyOpen] = useState(false);
  const legacyContentId = useId();

  const onReadState = useCallback((summary: M365ConsentStepSummary) => setRead(summary), []);
  const onActionsState = useCallback((summary: M365ConsentStepSummary) => setActions(summary), []);

  // The last `ready` summary per step, pinned to the org it was loaded for. A
  // step reports {loading, connection: null} on every reload (Retest, Sync,
  // Disconnect), so identity and the precedence note read from these instead
  // of from the live summaries, or they would flash "nothing connected" on
  // each reload. A new ready summary replaces them (including one with no
  // connection); an org change discards them.
  const [readyByStep, setReadyByStep] = useState<{
    orgId: string | null;
    read: M365ConsentStepSummary | null;
    actions: M365ConsentStepSummary | null;
  }>({ orgId, read: null, actions: null });
  useEffect(() => {
    setReadyByStep((current) => {
      const base = current.orgId === orgId ? current : { orgId, read: null, actions: null };
      const nextRead = read?.loadState === "ready" ? read : base.read;
      const nextActions = actions?.loadState === "ready" ? actions : base.actions;
      return base === current && nextRead === current.read && nextActions === current.actions
        ? current
        : { orgId, read: nextRead, actions: nextActions };
    });
  }, [actions, orgId, read]);
  const stored = readyByStep.orgId === orgId ? readyByStep : { read: null, actions: null };
  // The live summary wins whenever it is ready (the store catches up a render
  // later); the stored one only stands in while a step is reloading.
  const lastReady = {
    read: read?.loadState === "ready" ? read : stored.read,
    actions: actions?.loadState === "ready" ? actions : stored.actions,
  };

  const legacyConnected = legacyStatus === "connected";
  // Once a legacy connection has been shown expanded, keep it open through a
  // disconnect so its outcome stays on screen instead of folding away.
  useEffect(() => {
    if (legacyConnected) setLegacyOpen(true);
  }, [legacyConnected]);

  const hasCallback = readCallbackResult !== null || actionsCallbackResult !== null;
  let reportedLayout: Layout;
  if (
    legacyStatus === "loading"
    || !read || !actions
    || read.loadState === "loading" || actions.loadState === "loading"
  ) {
    reportedLayout = "pending";
  } else if (read.loadState === "unavailable" && actions.loadState === "unavailable") {
    reportedLayout = "no-org";
  } else if (
    !hasCallback
    && read.loadState === "ready" && actions.loadState === "ready"
    && !read.onboardingEnabled && !actions.onboardingEnabled
    && !read.connection && !actions.connection
  ) {
    reportedLayout = "consent-unavailable";
  } else {
    reportedLayout = "consent-available";
  }
  // "pending" only covers the first load. Once a layout has resolved, a step
  // that reloads (after Retest, Sync, Disconnect, an org switch) shows its own
  // skeleton inside the current layout instead of folding the whole sub-tab
  // back to the placeholder and dropping keyboard focus.
  const [settledLayout, setSettledLayout] = useState<Layout | null>(null);
  useEffect(() => {
    if (reportedLayout !== "pending") setSettledLayout(reportedLayout);
  }, [reportedLayout]);
  // A consent callback (a return from Microsoft) only happens where the consent
  // path exists, and its result banner is an alert: it must never mount inside
  // the hidden placeholder state, so a callback resolves the layout at once.
  const layout: Layout = reportedLayout === "pending"
    ? settledLayout ?? (hasCallback ? "consent-available" : "pending")
    : reportedLayout;

  const panelVisible = layout === "consent-available";
  const legacyFirst = layout !== "consent-available";
  // Fold legacy away only when it is known to hold nothing. A load error (or a
  // load still in flight) may be hiding a connection that takes precedence
  // over consent, so it stays expanded where its state is visible.
  const legacyCollapsible = layout === "consent-available"
    && (legacyStatus === "disconnected" || legacyStatus === "not-enabled");
  const consentConnected = Boolean(lastReady.read?.connection || lastReady.actions?.connection);

  // Identity comes from whichever consent connection has verified a tenant,
  // Read first. Only fields the envelopes already carry: no domain is shown.
  const identity = [lastReady.read?.connection, lastReady.actions?.connection].find(
    (connection) => connection?.tenantId,
  ) ?? null;
  const tenantName = identity ? identity.displayName || identity.tenantId : null;
  const consentTarget = identity?.displayName || orgName;

  const legacyBlock = (
    <section key="legacy" data-testid="m365-legacy">
      {legacyCollapsible && (
        <button
          type="button"
          data-testid="m365-legacy-disclosure"
          aria-expanded={legacyOpen}
          aria-controls={legacyContentId}
          onClick={() => setLegacyOpen((open) => !open)}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <ChevronRight
            aria-hidden="true"
            className={`h-4 w-4 transition-transform ${legacyOpen ? "rotate-90" : ""}`}
          />
          {t("m365TenantPanel.legacyDisclosure")}
        </button>
      )}
      <div
        id={legacyContentId}
        hidden={layout === "pending" || (legacyCollapsible && !legacyOpen)}
        className={legacyCollapsible ? "mt-3" : undefined}
      >
        <M365Integration
          onStatusChange={setLegacyStatus}
          legacyBadge={legacyConnected}
          showPrecedenceNote={legacyConnected && consentConnected}
        />
      </div>
    </section>
  );

  const consentBlock = (
    <div key="consent">
      {layout === "consent-unavailable" && (
        <p
          data-testid="m365-consent-unavailable"
          className="rounded-lg border bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
        >
          {t("m365TenantPanel.consentUnavailable")}
        </p>
      )}
      {layout === "no-org" && (
        <p
          data-testid="m365-consent-select-org"
          className="rounded-lg border bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
        >
          {t("m365TenantPanel.selectOrganization")}
        </p>
      )}
      <section
        data-testid="m365-tenant-panel"
        aria-labelledby="m365-tenant-panel-title"
        hidden={!panelVisible}
        className="rounded-xl border bg-card"
      >
        <header
          data-testid="m365-tenant-identity"
          className="flex min-w-0 items-start gap-3 border-b p-5 sm:p-6"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Building2 aria-hidden="true" className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2
              id="m365-tenant-panel-title"
              title={tenantName ?? undefined}
              className="truncate text-lg font-semibold text-foreground"
            >
              {tenantName
                ?? (orgName
                  ? t("m365TenantPanel.noTenantForOrg", { orgName })
                  : t("m365TenantPanel.noTenant"))}
            </h2>
            {identity?.tenantId && (
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                <span className="flex min-w-0 items-center gap-1">
                  <span className="shrink-0">{t("m365TenantPanel.tenantId")}</span>
                  <code
                    className="truncate font-mono text-xs text-foreground"
                    title={identity.tenantId}
                  >
                    {identity.tenantId}
                  </code>
                  <TenantIdCopy tenantId={identity.tenantId} />
                </span>
                <span>
                  {identity.lastVerifiedAt
                    ? t("m365TenantPanel.lastVerified", { date: formatDateTime(identity.lastVerifiedAt) })
                    : t("m365TenantPanel.notVerifiedYet")}
                </span>
              </div>
            )}
          </div>
        </header>
        <div className="divide-y">
          <div className="p-5 sm:p-6">
            <M365CustomerGraphReadCard
              callbackResult={readCallbackResult}
              callbackRefreshKey={readCallbackRefreshKey}
              onStateChange={onReadState}
              hideTenantIdentity
            />
          </div>
          <div className="p-5 sm:p-6">
            <M365CustomerGraphActionsCard
              callbackResult={actionsCallbackResult}
              callbackRefreshKey={actionsCallbackRefreshKey}
              onStateChange={onActionsState}
              hideTenantIdentity
              readConnected={
                read?.loadState === "ready" ? isUsableConsentConnection(read.connection) : undefined
              }
              consentTarget={consentTarget}
            />
          </div>
        </div>
      </section>
    </div>
  );

  return (
    <div className="space-y-6" data-testid="m365-tenant-section">
      {layout === "pending" && (
        <div
          data-testid="m365-tenant-loading"
          aria-busy="true"
          className="space-y-3 rounded-xl border bg-card p-5 sm:p-6"
        >
          <div className="skeleton h-5 w-64" />
          <div className="skeleton h-4 w-full max-w-xl" />
          <div className="skeleton h-4 w-full max-w-md" />
          <span className="sr-only">{t("m365TenantPanel.loading")}</span>
        </div>
      )}
      {legacyFirst ? [legacyBlock, consentBlock] : [consentBlock, legacyBlock]}
    </div>
  );
}
