import { useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { formatTimeAgo } from "../../lib/formatTime";
import { claimSamePageHashClick } from "../../lib/samePageHashClick";
import { useConnectionHealth, type ConnectionHealth } from "./useConnectionHealth";

export const KNOWN_CONDITIONS = [
  "sync_failed",
  "reauth_required",
  "disconnected",
  "error",
  "mailbox_error",
  "poll_failing",
  "needs_consent",
  "degraded",
  "suspended",
  "grant_missing",
  "grant_unexpected",
  "manifest_stale",
  "application_token_invalid",
  "tenant_mismatch",
  "grant_reconciliation_unavailable",
  "grant_revoked_reuse",
  "grant_revoked",
  "delivery_failed",
  "sync_stale",
  "verification_failed",
] as const;

const isSafeHref = (href: unknown): href is string =>
  typeof href === "string" && href.startsWith("/") && !href.startsWith("//");

interface ConnectionHealthPanelProps {
  /** Incidents the page already loaded; omitted, the panel loads its own. */
  health?: ConnectionHealth;
  /** Name for an incident's org; null hides the label (org not in the list). */
  resolveOrgName?: (orgId: string) => string | null;
}

export default function ConnectionHealthPanel({
  health,
  resolveOrgName,
}: ConnectionHealthPanelProps = {}) {
  const { t } = useTranslation("integrations");
  const own = useConnectionHealth(!health);
  const { state, retry } = health ?? own;
  const [showRecent, setShowRecent] = useState(false);

  if (state.kind === "hidden") return null;

  if (state.kind === "loading") {
    return (
      <section
        data-testid="connection-health-loading"
        aria-busy="true"
        className="rounded-lg border bg-card p-4"
      >
        <h2 className="text-sm font-semibold">{t("connectionHealthPanel.title")}</h2>
        <div className="mt-3 h-4 w-48 animate-pulse rounded bg-muted" />
      </section>
    );
  }

  const scopeLabel = (orgId: string | null) =>
    orgId === null
      ? t("integrationsPage.scope.partnerWide")
      : resolveOrgName?.(orgId) ?? null;

  const conditionLabel = (code: string) =>
    (KNOWN_CONDITIONS as readonly string[]).includes(code)
      ? t(/* i18n-dynamic */ `connectionHealthPanel.condition.${code}`)
      : t("connectionHealthPanel.condition.unknown");

  return (
    <section
      data-testid="connection-health-panel"
      className="rounded-lg border bg-card p-4"
    >
      <h2 className="text-sm font-semibold">{t("connectionHealthPanel.title")}</h2>

      {state.kind === "error" ? (
        <div
          data-testid="connection-health-error"
          className="mt-3 flex items-center gap-3 text-sm text-red-700 dark:text-red-400"
        >
          <span>{t("connectionHealthPanel.loadError")}</span>
          <button
            type="button"
            data-testid="connection-health-retry"
            onClick={retry}
            className="rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-muted"
          >
            {t("connectionHealthPanel.retry")}
          </button>
        </div>
      ) : (
        <>
          {state.open.data.length === 0 ? (
            <div className="mt-3">
              <p
                data-testid="connection-health-empty"
                className="flex items-center gap-2 text-sm text-foreground"
              >
                <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
                {t("connectionHealthPanel.allHealthy")}
              </p>
              <p
                data-testid="connection-health-empty-detail"
                className="mt-1 pl-6 text-xs text-muted-foreground"
              >
                {t("connectionHealthPanel.allHealthyDetail")}
              </p>
            </div>
          ) : (
            <ul className="mt-3 divide-y">
              {state.open.data.map((inc) => {
                const permanent = inc.severity === "permanent";
                const since = inc.openedAt ?? inc.firstFailedAt;
                const scope = scopeLabel(inc.orgId);
                return (
                  <li
                    key={inc.id}
                    data-testid="connection-health-open-row"
                    className="flex items-start gap-3 py-2 text-sm"
                  >
                    <AlertTriangle
                      className={`mt-0.5 h-4 w-4 shrink-0 ${
                        permanent
                          ? "text-red-600 dark:text-red-400"
                          : "text-amber-600 dark:text-amber-400"
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{inc.displayName}</span>
                        {scope ? (
                          <span
                            data-testid="connection-health-row-scope"
                            className="text-xs text-muted-foreground"
                          >
                            {scope}
                          </span>
                        ) : null}
                        <span
                          className={`rounded-full border px-2 py-0.5 text-xs ${
                            permanent
                              ? "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300"
                              : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                          }`}
                        >
                          {conditionLabel(inc.condition)}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {t("connectionHealthPanel.since", {
                            time: formatTimeAgo(since),
                          })}
                        </span>
                      </div>
                      {inc.detail ? (
                        <p className="mt-0.5 break-words text-xs text-muted-foreground">
                          {inc.detail}
                        </p>
                      ) : null}
                      {inc.remedy?.kind === "reconnect" ? (
                        <p className="mt-0.5 break-words text-xs font-medium">
                          {t("connectionHealthPanel.remedy.reconnect")}
                        </p>
                      ) : null}
                    </div>
                    {inc.remedy?.kind === "reconnect" ? null : isSafeHref(inc.fixHref) ? (
                      <a
                        href={inc.fixHref}
                        // Same-page fix links (/integrations#huntress) must fire a
                        // real hashchange or the Integrations tab never switches.
                        onClick={(e) => claimSamePageHashClick(e, inc.fixHref)}
                        className="shrink-0 text-xs font-medium text-primary hover:underline"
                      >
                        {t("connectionHealthPanel.fix")}
                      </a>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}

          {state.open.truncated ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {t("connectionHealthPanel.truncated", { count: 500 })}
            </p>
          ) : null}

          {state.recent.data.length > 0 ? (
            <div className="mt-3 border-t pt-3">
              <button
                type="button"
                data-testid="connection-health-recent-toggle"
                aria-expanded={showRecent}
                onClick={() => setShowRecent((v) => !v)}
                className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                {showRecent ? (
                  <ChevronDown className="h-3.5 w-3.5" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5" />
                )}
                {t("connectionHealthPanel.recentlyResolved", {
                  count: state.recent.data.length,
                })}
              </button>
              {showRecent ? (
                <ul className="mt-2 space-y-1">
                  {state.recent.data.map((inc) => (
                    <li
                      key={inc.id}
                      data-testid="connection-health-recent-row"
                      className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
                    >
                      <span className="font-medium text-foreground">
                        {inc.displayName}
                      </span>
                      <span>
                        {inc.resolution === "retired"
                          ? t("connectionHealthPanel.resolution.retired")
                          : t("connectionHealthPanel.resolution.recovered")}
                      </span>
                      {inc.resolvedAt ? (
                        <span>{formatTimeAgo(inc.resolvedAt)}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
