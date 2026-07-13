import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, ShieldCheck, Target, Users } from "lucide-react";
import {
  cn,
  formatNumber,
  friendlyFetchError,
  widthPercentClass,
} from "@/lib/utils";
import { fetchWithAuth } from "@/stores/auth";
import { errorKindOf, throwIfNotOk, type LoadErrorKind } from "@/lib/httpError";
import AccessDenied from "../shared/AccessDenied";
import SecurityPageHeader from "./SecurityPageHeader";
import SecurityStatCard from "./SecurityStatCard";
type ScoreComponent = {
  category: string;
  label: string;
  score: number;
  weight: number;
  status: string;
  affectedDevices: number;
  totalDevices: number;
};
type ScoreBreakdown = {
  overallScore: number;
  grade: string;
  devicesAudited: number;
  components: ScoreComponent[];
};
const statusBadge: Record<string, string> = {
  good: "bg-emerald-500/15 text-emerald-700 border-emerald-500/30",
  warning: "bg-amber-500/15 text-amber-700 border-amber-500/30",
  critical: "bg-red-500/15 text-red-700 border-red-500/30",
};
const scoreBarColor = (score: number) =>
  score >= 80 ? "bg-emerald-500" : score >= 60 ? "bg-amber-500" : "bg-red-500";
export default function ScoreDetailPage() {
  const { t } = useTranslation("security");
  const [data, setData] = useState<ScoreBreakdown | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [errorKind, setErrorKind] = useState<LoadErrorKind>("none");
  const abortRef = useRef<AbortController | null>(null);
  const fetchData = useCallback(async () => {
    setError(undefined);
    setErrorKind("none");
    setLoading(true);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetchWithAuth("/security/score-breakdown", {
        signal: controller.signal,
      });
      // HttpError (not a bare Error) so a 403 survives the throw and the render
      // can tell "you may not see this" from "this broke, try again" (#2429).
      throwIfNotOk(res);
      const json = await res.json();
      if (!json.data)
        throw new Error(t("securityScoreDetailPage.invalidResponseFromServer"));
      setData(json.data);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      console.error("[ScoreDetailPage] fetch error:", err);
      const kind = errorKindOf(err);
      setErrorKind(kind);
      if (kind === "other") setError(friendlyFetchError(err));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    fetchData();
    return () => abortRef.current?.abort();
  }, [fetchData]);
  if (loading && !data) {
    return (
      <div className="space-y-6">
        <SecurityPageHeader
          title={t("securityScoreDetailPage.securityScore")}
          subtitle={t("securityScoreDetailPage.scoreBreakdownByCategory")}
        />
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }
  // A 403 is terminal for this user — the permission gate will deny a retry too,
  // so show the access-denied panel (no Retry button) instead of the transient
  // failure banner below (#2429).
  if (errorKind === "denied") {
    return (
      <div className="space-y-6">
        <SecurityPageHeader
          title={t("securityScoreDetailPage.securityScore")}
          subtitle={t("securityScoreDetailPage.scoreBreakdownByCategory")}
        />
        <AccessDenied testId="security-score-detail-denied" />
      </div>
    );
  }
  if (error && !data) {
    return (
      <div className="space-y-6">
        <SecurityPageHeader
          title={t("securityScoreDetailPage.securityScore")}
          subtitle={t("securityScoreDetailPage.scoreBreakdownByCategory")}
        />
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
          <p className="text-sm text-destructive">{error}</p>
          <button
            type="button"
            onClick={fetchData}
            className="mt-2 text-sm text-primary hover:underline"
          >
            {t("securityScoreDetailPage.retry")}
          </button>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="space-y-6">
        <SecurityPageHeader
          title={t("securityScoreDetailPage.securityScore")}
          subtitle={t("securityScoreDetailPage.scoreBreakdownByCategory")}
        />
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
          <p className="text-sm text-destructive">
            {t("securityScoreDetailPage.unableToLoadScoreData")}
          </p>
          <button
            type="button"
            onClick={fetchData}
            className="mt-2 text-sm text-primary hover:underline"
          >
            {t("securityScoreDetailPage.retry")}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <SecurityPageHeader
        title={t("securityScoreDetailPage.securityScore")}
        subtitle={t("securityScoreDetailPage.scoreBreakdownByCategory")}
        loading={loading}
        onRefresh={fetchData}
      />

      {error && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-center">
          <p className="text-sm text-amber-700">
            {t("securityScoreDetailPage.dataMayBeOutdated", { error })}
          </p>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <SecurityStatCard
          icon={ShieldCheck}
          label={t("securityScoreDetailPage.overallScore")}
          value={`${data.overallScore}/100`}
          variant={
            data.overallScore >= 80
              ? "success"
              : data.overallScore >= 60
                ? "warning"
                : "danger"
          }
        />
        <SecurityStatCard
          icon={Target}
          label={t("securityScoreDetailPage.grade")}
          value={data.grade}
          variant={
            [
              t("securityScoreDetailPage.a"),
              t("securityScoreDetailPage.a2"),
              t("securityScoreDetailPage.a3"),
              t("securityScoreDetailPage.b"),
              t("securityScoreDetailPage.b2"),
              t("securityScoreDetailPage.b3"),
            ].includes(data.grade)
              ? "success"
              : [
                    t("securityScoreDetailPage.c"),
                    t("securityScoreDetailPage.c2"),
                    t("securityScoreDetailPage.c3"),
                  ].includes(data.grade)
                ? "warning"
                : "danger"
          }
        />
        <SecurityStatCard
          icon={Users}
          label={t("securityScoreDetailPage.devicesAudited")}
          value={formatNumber(data.devicesAudited)}
        />
      </div>

      <div className="rounded-lg border bg-card shadow-xs">
        <div className="overflow-x-auto rounded-lg">
          <table className="min-w-full divide-y">
            <thead className="bg-muted/40">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">
                  {t("securityScoreDetailPage.category")}
                </th>
                <th className="px-4 py-3">
                  {t("securityScoreDetailPage.score")}
                </th>
                <th className="px-4 py-3 text-center">
                  {t("securityScoreDetailPage.weight")}
                </th>
                <th className="px-4 py-3 text-center">
                  {t("securityScoreDetailPage.weighted")}
                </th>
                <th className="px-4 py-3 text-center">
                  {t("securityScoreDetailPage.status")}
                </th>
                <th className="px-4 py-3 text-right">
                  {t("securityScoreDetailPage.affected")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {data.components.map((comp) => (
                <tr
                  key={comp.category}
                  className="transition hover:bg-muted/40"
                >
                  <td className="px-4 py-3 text-sm font-medium">
                    {comp.label}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="h-2 w-24 rounded-full bg-muted">
                        <div
                          className={cn(
                            "h-2 rounded-full",
                            scoreBarColor(comp.score),
                            widthPercentClass(comp.score),
                          )}
                        />
                      </div>
                      <span className="text-sm font-medium">{comp.score}%</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-center text-sm text-muted-foreground">
                    {comp.weight}%
                  </td>
                  <td className="px-4 py-3 text-center text-sm font-medium">
                    {Math.round((comp.score * comp.weight) / 100)}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span
                      className={cn(
                        "inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold capitalize",
                        statusBadge[comp.status] ?? statusBadge.warning,
                      )}
                    >
                      {comp.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-sm">
                    {comp.affectedDevices > 0 ? (
                      <span className="text-amber-600">
                        {comp.affectedDevices}/{comp.totalDevices}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">
                        0/{comp.totalDevices}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
