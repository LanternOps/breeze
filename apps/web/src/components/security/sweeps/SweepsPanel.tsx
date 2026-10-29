import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import type { SweepSummary } from "@breeze/shared";
import { formatDateTime } from "@/lib/dateTimeFormat";
import { errorKindOf, type LoadErrorKind } from "@/lib/httpError";
import { ActionError } from "@/lib/runAction";
import { friendlyFetchError } from "@/lib/utils";
import AccessDenied from "../../shared/AccessDenied";
import { showToast } from "../../shared/Toast";
import { listRuleSets } from "../detectionRules/ruleSetsApi";
import SweepDialog, { type SweepDialogPrefill } from "./SweepDialog";
import { describeSweepProgress } from "./sweepProgress";
import { cancelSweep, cancelSweepGroup, getSweepGroup, listSweeps } from "./sweepsApi";

/** Active sweeps are re-read this often while the tab is mounted. */
const POLL_MS = 10_000;

const TONE_BAR: Record<"info" | "success" | "warning", string> = {
  info: "bg-sky-500",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
};

function handleMutationError(err: unknown, fallback: string): void {
  if (err instanceof ActionError && err.status === 401) return;
  if (!(err instanceof ActionError)) showToast({ type: "error", message: fallback });
}

export default function SweepsPanel({
  group,
  onSelectGroup,
}: {
  /** The group shown in detail (`#sweeps&group=<id>`), or null for the list. */
  group: string | null;
  onSelectGroup: (groupId: string | null) => void;
}) {
  const { t } = useTranslation("security");
  const [sweeps, setSweeps] = useState<SweepSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorKind, setErrorKind] = useState<LoadErrorKind>("none");
  const [loadError, setLoadError] = useState<string>();
  const [currentVersions, setCurrentVersions] = useState<Map<string, number>>(new Map());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [resweep, setResweep] = useState<SweepDialogPrefill | null>(null);
  const loadedRef = useRef(false);
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const rows = group ? (await getSweepGroup(group)).sweeps : (await listSweeps({ limit: 50 })).data;
      if (seq !== requestSeq.current) return;
      setSweeps(rows);
      setErrorKind("none");
      setLoadError(undefined);
      loadedRef.current = true;
      // One published-version read per list, never per row (anchor C3-1).
      if (rows.length > 0) {
        try {
          const sets = await listRuleSets();
          if (seq !== requestSeq.current) return;
          setCurrentVersions(new Map(sets.map((s) => [s.id, s.publishedVersion])));
        } catch {
          // Without current versions the rules-changed hint is simply absent.
        }
      }
    } catch (err) {
      if (seq !== requestSeq.current) return;
      console.error("[SweepsPanel] load:", err);
      const kind = errorKindOf(err);
      setErrorKind(kind);
      if (kind === "other") setLoadError(friendlyFetchError(err));
      if (kind === "denied") setSweeps([]);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [group]);

  useEffect(() => {
    loadedRef.current = false;
    setLoading(true);
    void load();
    return () => {
      requestSeq.current += 1;
    };
  }, [load]);

  const hasActive = sweeps.some((s) => s.state === "active");
  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [hasActive, load]);

  const rulesChanged = useCallback(
    (s: SweepSummary) =>
      s.ruleSets.some((pin) => {
        const current = currentVersions.get(pin.id);
        return current !== undefined && current > pin.version;
      }),
    [currentVersions],
  );

  const cancelOne = async (s: SweepSummary) => {
    setBusyId(s.id);
    try {
      await cancelSweep(s.id);
      await load();
    } catch (err) {
      handleMutationError(err, t("common:states.error"));
    } finally {
      setBusyId(null);
    }
  };

  const cancelAll = async (groupId: string) => {
    setBusyId(groupId);
    try {
      await cancelSweepGroup(groupId);
      await load();
    } catch (err) {
      handleMutationError(err, t("common:states.error"));
    } finally {
      setBusyId(null);
    }
  };

  const openResweep = (s: SweepSummary) =>
    setResweep({
      ruleSetIds: s.ruleSets.map((r) => r.id),
      ruleSetNames: s.ruleSets.map((r) => r.name ?? r.id),
      scanType: s.scanType,
      ...(s.scanType === "custom" && s.paths ? { paths: s.paths } : {}),
      // SweepSummary does not store the scope, so the dialog opens at the
      // scope step with the sets, scan type and custom paths pre-filled.
      rescope: true,
    });

  const groupActive = useMemo(() => sweeps.some((s) => s.state === "active"), [sweeps]);

  if (errorKind === "denied") return <AccessDenied testId="sweeps-denied" />;

  if (loading && !loadedRef.current) {
    return (
      <div data-testid="sweeps-panel" className="flex justify-center py-10">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (errorKind === "other" && !loadedRef.current) {
    return (
      <div data-testid="sweeps-panel" className="py-6">
        <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          <span data-testid="sweeps-error">{loadError}</span>
          <button
            type="button"
            data-testid="sweeps-retry"
            onClick={() => void load()}
            className="rounded-md border border-destructive/40 bg-background px-3 py-1 text-xs font-medium"
          >
            {t("common:actions.retry")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="sweeps-panel" className="space-y-4">
      {errorKind === "other" && (
        <div role="alert" data-testid="sweeps-refresh-error" className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {t("sweeps.panel.refreshFailed")}
        </div>
      )}

      {group && (
        <div data-testid="sweep-group-detail" className="flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            data-testid="sweep-group-back"
            onClick={() => onSelectGroup(null)}
            className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
            {t("sweeps.panel.allSweeps")}
          </button>
          {groupActive && (
            <button
              type="button"
              data-testid="sweep-group-cancel-all"
              disabled={busyId === group}
              onClick={() => void cancelAll(group)}
              className="rounded-md border border-destructive/40 px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-50"
            >
              {t("sweeps.panel.cancelAll")}
            </button>
          )}
        </div>
      )}

      {sweeps.length === 0 ? (
        <p data-testid="sweeps-empty" className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
          {t("sweeps.panel.empty")}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-3 py-2">{t("sweeps.panel.columns.ruleSets")}</th>
                <th className="px-3 py-2">{t("sweeps.panel.columns.origin")}</th>
                <th className="px-3 py-2">{t("sweeps.panel.columns.progress")}</th>
                <th className="px-3 py-2">{t("sweeps.panel.columns.skipped")}</th>
                <th className="px-3 py-2">{t("sweeps.panel.columns.degraded")}</th>
                <th className="px-3 py-2">{t("sweeps.panel.columns.threats")}</th>
                <th className="px-3 py-2">{t("sweeps.panel.columns.created")}</th>
                <th className="px-3 py-2">{t("sweeps.panel.columns.state")}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {sweeps.map((s) => {
                const progress = describeSweepProgress(s);
                const changed = rulesChanged(s);
                const skippedTotal = Object.values(s.skipped).reduce((a, b) => a + (b ?? 0), 0);
                const restricted = Object.keys(s.skipped).length === 0;
                return (
                  <tr key={s.id} data-testid={`sweep-row-${s.id}`} className="border-b align-top last:border-0">
                    <td className="px-3 py-2">
                      <ul className="space-y-0.5">
                        {s.ruleSets.map((r) => (
                          <li key={r.id}>
                            {r.name ?? r.id} · {t("sweeps.version", { version: r.version })}
                          </li>
                        ))}
                      </ul>
                      <p className="text-xs text-muted-foreground">
                        {s.orgName ?? s.orgId} · {t(/* i18n-dynamic */ `sweeps.panel.scanType.${s.scanType}`)}
                      </p>
                      {changed && (
                        <p data-testid={`sweep-rules-changed-${s.id}`} className="mt-1 text-xs text-amber-700">
                          {t("sweeps.panel.rulesChanged")}
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-2">{t(/* i18n-dynamic */ `sweeps.panel.origin.${s.origin}`)}</td>
                    <td className="min-w-40 px-3 py-2">
                      <div
                        data-testid={`sweep-progress-${s.id}`}
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={progress.percent}
                        aria-label={progress.label}
                      >
                        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                          <div className={`h-full ${TONE_BAR[progress.tone]}`} style={{ width: `${progress.percent}%` }} />
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {progress.percent}% · {progress.label}
                        </p>
                        {s.state === "active" && s.progress.queued > 0 && (
                          <p className="text-xs text-muted-foreground">{t("sweeps.panel.queued", { queued: s.progress.queued })}</p>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2" title={restricted ? undefined : Object.entries(s.skipped).map(([k, v]) => `${k}: ${v}`).join(", ")}>
                      {restricted ? "—" : skippedTotal}
                    </td>
                    <td className="px-3 py-2">{s.progress.degraded}</td>
                    <td className="px-3 py-2">{s.progress.threatsFound}</td>
                    <td className="px-3 py-2 text-xs">
                      <div>{s.createdBy?.name ?? "—"}</div>
                      <div className="text-muted-foreground">{formatDateTime(s.createdAt)}</div>
                    </td>
                    <td className="px-3 py-2">
                      <span data-testid={`sweep-state-${s.id}`}>{t(/* i18n-dynamic */ `sweeps.panel.state.${s.state}`)}</span>
                    </td>
                    <td className="space-y-1 px-3 py-2 text-right">
                      {s.state === "active" && (
                        <button
                          type="button"
                          data-testid={`sweep-cancel-${s.id}`}
                          disabled={busyId === s.id}
                          onClick={() => void cancelOne(s)}
                          className="block w-full rounded-md border border-destructive/40 px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:opacity-50"
                        >
                          {t("sweeps.panel.cancel")}
                        </button>
                      )}
                      {changed && (s.state === "active" || s.progress.failed > 0) && (
                        <button
                          type="button"
                          data-testid={`sweep-resweep-${s.id}`}
                          onClick={() => openResweep(s)}
                          className="block w-full rounded-md border px-2 py-1 text-xs hover:bg-muted"
                        >
                          {t("sweeps.panel.resweep")}
                        </button>
                      )}
                      {!group && (
                        <button
                          type="button"
                          data-testid={`sweep-open-group-${s.id}`}
                          onClick={() => onSelectGroup(s.groupId)}
                          className="block w-full rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
                        >
                          {t("sweeps.panel.openGroup")}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {resweep && <SweepDialog prefill={resweep} onClose={() => setResweep(null)} />}
    </div>
  );
}
