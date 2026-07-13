import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { useEffect, useState } from "react";
import { Activity, Loader2, ShieldAlert, ShieldCheck } from "lucide-react";
import { fetchWithAuth } from "../../stores/auth";
import { errorKindOf, throwIfNotOk, type LoadErrorKind } from "@/lib/httpError";
import AccessDenied from "../shared/AccessDenied";
import SecurityStatCard from "./SecurityStatCard";
interface S1Summary {
  totalAgents: number;
  mappedDevices: number;
  infectedAgents: number;
  activeThreats: number;
  highOrCriticalThreats: number;
  pendingActions: number;
  reportedThreatCount: number;
}
interface S1Status {
  integration: {
    id: string;
  } | null;
  summary: S1Summary;
}
interface HuntressStatus {
  integration: {
    id: string;
  } | null;
  coverage: {
    totalAgents: number;
    mappedAgents: number;
    unmappedAgents: number;
    offlineAgents: number;
  };
  incidents: {
    open: number;
  };
}
async function getJson<T>(url: string): Promise<T> {
  const res = await fetchWithAuth(url);
  // HttpError (not a bare Error) so a 403 survives the throw and the render can
  // tell "you may not see this" from "this broke, try again" (#2472).
  throwIfNotOk(res);
  return (await res.json()) as T;
}

/** Worst-case outcome across the two provider fetches. */
function worstKind(...kinds: LoadErrorKind[]): LoadErrorKind {
  if (kinds.includes("other")) return "other";
  if (kinds.includes("denied")) return "denied";
  return "none";
}

function settledKind(result: PromiseSettledResult<unknown>): LoadErrorKind {
  return result.status === "rejected" ? errorKindOf(result.reason) : "none";
}
export default function EdrSummaryPanel() {
  const { t } = useTranslation("security");
  const [s1, setS1] = useState<S1Status | null>(null);
  const [huntress, setHuntress] = useState<HuntressStatus | null>(null);
  const [loading, setLoading] = useState(true);
  // Was a single `fetchFailed` boolean, which collapsed a 403 into the same bit
  // as a 500 and reported a permission denial as "EDR status unavailable" — i.e.
  // an outage. Keep the kind so the render can tell the two apart (#2472).
  const [failureKind, setFailureKind] = useState<LoadErrorKind>("none");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [s1Res, huntressRes] = await Promise.allSettled([
        getJson<S1Status>("/s1/status"),
        getJson<HuntressStatus>("/huntress/status"),
      ]);
      if (cancelled) return;
      setS1(s1Res.status === "fulfilled" ? s1Res.value : null);
      setHuntress(
        huntressRes.status === "fulfilled" ? huntressRes.value : null,
      );
      // An unconfigured integration still resolves with { integration: null };
      // a rejected fetch is a real failure and must not look like "not configured".
      // A transient failure outranks a denial: if either provider is genuinely
      // broken, Retry/"unavailable" is still the honest message.
      setFailureKind(worstKind(settledKind(s1Res), settledKind(huntressRes)));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const showS1 = s1?.integration != null;
  const showHuntress = huntress?.integration != null;
  if (loading) {
    return (
      <div
        className="rounded-lg border bg-card p-6 shadow-xs"
        data-testid="edr-summary-panel"
      >
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("securityEdrSummaryPanel.loadingEDRPosture")}
        </div>
      </div>
    );
  }
  if (!showS1 && !showHuntress) {
    if (failureKind === "none") return null;
    // A 403 is terminal for this user — a retry hits the same permission gate, and
    // "EDR status unavailable" would misreport a permission denial as an outage.
    if (failureKind === "denied") {
      return (
        <div
          className="rounded-lg border bg-card p-6 shadow-xs"
          data-testid="edr-summary-panel"
        >
          <AccessDenied testId="edr-summary-denied" />
        </div>
      );
    }
    return (
      <div
        className="rounded-lg border bg-card p-6 shadow-xs"
        data-testid="edr-summary-panel"
      >
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <ShieldAlert className="h-4 w-4" />
          {t("securityEdrSummaryPanel.edrStatusUnavailable")}
        </div>
      </div>
    );
  }
  return (
    <div
      className="rounded-lg border bg-card p-6 shadow-xs"
      data-testid="edr-summary-panel"
    >
      <div className="mb-4 flex items-center gap-2">
        <ShieldAlert className="h-4 w-4 text-primary" />
        <h3 className="text-lg font-semibold">
          {t("securityEdrSummaryPanel.endpointDetectionAndAmpResponse")}
        </h3>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {showS1 && s1 && (
          <>
            <div data-testid="edr-card-s1-active-threats">
              <SecurityStatCard
                icon={ShieldAlert}
                label={t("securityEdrSummaryPanel.sentineloneActiveThreats")}
                value={s1.summary.activeThreats}
                variant={s1.summary.activeThreats > 0 ? "danger" : "success"}
                detail={`${s1.summary.highOrCriticalThreats} high/critical`}
              />
            </div>
            <div data-testid="edr-card-s1-coverage">
              <SecurityStatCard
                icon={ShieldCheck}
                label={t("securityEdrSummaryPanel.sentineloneAgents")}
                value={`${s1.summary.mappedDevices}/${s1.summary.totalAgents}`}
                detail={`${s1.summary.infectedAgents} infected`}
                variant={s1.summary.infectedAgents > 0 ? "warning" : "default"}
              />
            </div>
          </>
        )}

        {showHuntress && huntress && (
          <>
            <div data-testid="edr-card-huntress-open-incidents">
              <SecurityStatCard
                icon={Activity}
                label={t("securityEdrSummaryPanel.huntressOpenIncidents")}
                value={huntress.incidents.open}
                variant={huntress.incidents.open > 0 ? "danger" : "success"}
              />
            </div>
            <div data-testid="edr-card-huntress-coverage">
              <SecurityStatCard
                icon={ShieldCheck}
                label={t("securityEdrSummaryPanel.huntressAgents")}
                value={`${huntress.coverage.mappedAgents}/${huntress.coverage.totalAgents}`}
                detail={`${huntress.coverage.offlineAgents} offline, ${huntress.coverage.unmappedAgents} unmapped`}
                variant={
                  huntress.coverage.unmappedAgents > 0 ? "warning" : "default"
                }
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
