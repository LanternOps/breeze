import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { Download, DraftingCompass, Play, RotateCcw } from "lucide-react";
import type { FleetDesignOutcome, FleetDesignLedgerItem, FleetDesignRollbackResult } from "@breeze/shared";
import { useOrgStore } from "../../stores/orgStore";
import { fetchWithAuth } from "../../stores/auth";
import { showToast } from "../shared/Toast";
import { ActionError, runAction } from "@/lib/runAction";
import { useHashState } from "@/lib/useHashState";
import { formatDateTime } from "@/lib/dateTimeFormat";
import { PageHeader } from "../shared/PageHeader";
import { EmptyState } from "../shared/EmptyState";
import { exportReport, getBrowserTimezone } from "../reports/reportExport";
import FleetDesignViewer from "./FleetDesignViewer";
import DriftPanel from "./DriftPanel";
import ApplyDrawer from "./ApplyDrawer";
import { useDesignSelection } from "./useDesignSelection";
import {
  getDesign,
  listApplied,
  listDesigns,
  rollback,
  startDesignRun,
  type FleetDesignDetail,
  type FleetDesignListItem,
} from "@/lib/api/fleetDesign";

/**
 * Fleet Designer W03 (#5653) — the Fleet Design page: an org (+ optional
 * site) picker, the org's stored designs, and — once one is selected — the
 * eight-section viewer, the apply drawer, and rollback. See the wave plan's
 * Task 8 for the full behaviour contract.
 */
const SPECIFIC_SKIP_REASONS = new Set([
  "mode_off",
  "kill_switch_off",
  "agent_disabled",
  "no_effective_agent",
  "org_budget_exceeded",
  "agent_daily_budget_exceeded",
  "max_concurrent_design_runs",
  "design_rate",
  "duplicate",
]);

function toCamelCase(reason: string): string {
  return reason.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function startSkipLabel(t: (key: string, opts?: Record<string, unknown>) => string, reason: string): string {
  return SPECIFIC_SKIP_REASONS.has(reason)
    ? t(/* i18n-dynamic */ `page.startSkipped.${toCamelCase(reason)}`)
    : t("page.startSkipped.generic", { reason });
}

function parseRunIdHash(hash: string): string | undefined {
  return hash.length > 0 ? hash : undefined;
}

export default function FleetDesignPage() {
  const { t } = useTranslation("fleetDesign");
  const organizations = useOrgStore((s) => s.organizations);
  const globalOrgId = useOrgStore((s) => s.currentOrgId);

  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(globalOrgId);
  useEffect(() => {
    if (!selectedOrgId && organizations.length > 0) setSelectedOrgId(globalOrgId ?? organizations[0]!.id);
  }, [organizations, globalOrgId, selectedOrgId]);

  const [items, setItems] = useState<FleetDesignListItem[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string>();

  const [sites, setSites] = useState<Array<{ id: string; name: string }>>([]);
  const [siteId, setSiteId] = useState("");
  const [starting, setStarting] = useState(false);
  const [startSkipReason, setStartSkipReason] = useState<string>();

  const [selectedRunId, setSelectedRunId] = useHashState<string | undefined>(undefined, parseRunIdHash);
  const [detail, setDetail] = useState<FleetDesignDetail | null>(null);
  const [ledger, setLedger] = useState<FleetDesignLedgerItem[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string>();
  const [downloading, setDownloading] = useState(false);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [rollbackResult, setRollbackResult] = useState<FleetDesignRollbackResult | null>(null);

  const appliedRefs = useMemo(
    () => new Set(ledger.filter((i) => i.status === "applied").map((i) => i.itemRef)),
    [ledger],
  );
  const selection = useDesignSelection(appliedRefs);

  const loadList = useCallback(async () => {
    if (!selectedOrgId) return;
    setListLoading(true);
    setListError(undefined);
    try {
      setItems(await listDesigns(selectedOrgId));
    } catch {
      setListError(t("page.loadError"));
    } finally {
      setListLoading(false);
    }
  }, [selectedOrgId, t]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  // Best-effort site list for the optional scope selector — a failure here
  // just means "no site scoping offered", not a page error.
  useEffect(() => {
    if (!selectedOrgId) {
      setSites([]);
      return;
    }
    let cancelled = false;
    setSiteId("");
    fetchWithAuth(`/orgs/sites?organizationId=${encodeURIComponent(selectedOrgId)}`)
      .then(async (res) => {
        if (!res.ok || cancelled) return;
        const data = (await res.json().catch(() => null)) as { data?: unknown; sites?: unknown } | null;
        const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data?.sites) ? data.sites : [];
        if (!cancelled) setSites((rows as Array<{ id: string; name: string }>).map((s) => ({ id: s.id, name: s.name })));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selectedOrgId]);

  const loadDetail = useCallback(
    async (reportRunId: string) => {
      setDetailLoading(true);
      setDetailError(undefined);
      setRollbackResult(null);
      selection.clear();
      try {
        const [d, l] = await Promise.all([getDesign(reportRunId), listApplied(reportRunId)]);
        setDetail(d);
        setLedger(l);
      } catch {
        setDetail(null);
        setLedger([]);
        setDetailError(t("page.detailLoadError"));
      } finally {
        setDetailLoading(false);
      }
      // selection.clear is stable across renders (useCallback with no deps);
      // omitting it here avoids re-running this loader every time selection
      // itself changes (it would, since toggle recreates the selected Set).
    },
    [t],
  );

  useEffect(() => {
    if (selectedRunId) {
      void loadDetail(selectedRunId);
    } else {
      setDetail(null);
      setLedger([]);
    }
  }, [selectedRunId]);

  const selectRun = (reportRunId: string) => {
    window.location.hash = reportRunId;
    setSelectedRunId(reportRunId);
  };

  const handleStart = async () => {
    if (!selectedOrgId) return;
    setStarting(true);
    setStartSkipReason(undefined);
    try {
      await runAction<{ runId?: string }>({
        request: () => startDesignRun(selectedOrgId, siteId || undefined),
        errorFallback: t("page.startError"),
        successMessage: t("page.startSuccess"),
        parseSuccess: (d) => d as { runId?: string },
      });
      void loadList();
    } catch (err) {
      if (err instanceof ActionError && err.body && typeof err.body === "object" && "skipped" in err.body) {
        setStartSkipReason(String((err.body as { skipped: unknown }).skipped));
      }
    } finally {
      setStarting(false);
    }
  };

  const handleHeaderRollback = async () => {
    if (!selectedRunId) return;
    setRollingBack(true);
    try {
      const data = await runAction<FleetDesignRollbackResult>({
        request: () => rollback(selectedRunId),
        errorFallback: t("errors.genericRollback"),
        successMessage: (d) => t("result.rollbackDone", { count: d.rolledBack.length }),
        parseSuccess: (d) => d as FleetDesignRollbackResult,
      });
      setRollbackResult(data);
      void loadDetail(selectedRunId);
    } catch {
      // Already toasted by runAction.
    } finally {
      setRollingBack(false);
    }
  };

  const handleDownload = async () => {
    if (!selectedRunId) return;
    setDownloading(true);
    try {
      const res = await fetchWithAuth(`/reports/runs/${selectedRunId}/download`);
      if (!res.ok) throw new Error("download_failed");
      const payload = (await res.json()) as { type?: string; data?: { rows?: unknown[]; summary?: unknown } };
      await exportReport(payload.data?.rows ?? [], {
        format: "pdf",
        reportType: payload.type ?? "ai_fleet_design",
        timezone: getBrowserTimezone(),
        summary: payload.data?.summary as never,
      });
    } catch {
      showToast({ type: "error", message: t("page.downloadFailed") });
    } finally {
      setDownloading(false);
    }
  };

  const outcome: FleetDesignOutcome | undefined = detail?.summary.fleetDesign?.outcome;
  const drift = detail?.summary.fleetDesign?.drift ?? null;
  const hasAppliedRows = ledger.some((i) => i.status === "applied");

  return (
    <div className="space-y-6" data-testid="fleet-design-page">
      <PageHeader
        testId="fleet-design-header"
        icon={<DraftingCompass className="h-5 w-5" />}
        title={t("page.title")}
        description={t("page.description")}
      />

      <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-4">
        <div>
          <label className="text-xs font-medium text-muted-foreground" htmlFor="fleet-design-org-select">
            {t("page.orgLabel")}
          </label>
          <select
            id="fleet-design-org-select"
            data-testid="fleet-design-org-select"
            value={selectedOrgId ?? ""}
            onChange={(e) => {
              setSelectedOrgId(e.target.value || null);
              window.location.hash = "";
              setSelectedRunId(undefined);
            }}
            className="mt-1 h-9 w-56 rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          >
            {organizations.length === 0 && <option value="">{t("page.selectOrgPlaceholder")}</option>}
            {organizations.map((org) => (
              <option key={org.id} value={org.id}>
                {org.name}
              </option>
            ))}
          </select>
        </div>
        {sites.length > 0 && (
          <div>
            <label className="text-xs font-medium text-muted-foreground" htmlFor="fleet-design-site-select">
              {t("page.siteLabel")}
            </label>
            <select
              id="fleet-design-site-select"
              data-testid="fleet-design-site-select"
              value={siteId}
              onChange={(e) => setSiteId(e.target.value)}
              className="mt-1 h-9 w-48 rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            >
              <option value="">{t("page.allSites")}</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <button
          type="button"
          onClick={() => void handleStart()}
          disabled={starting || !selectedOrgId}
          data-testid="fleet-design-start-button"
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
        >
          <Play className="h-4 w-4" />
          {t("page.startButton")}
        </button>
        {startSkipReason && (
          <p className="w-full text-xs text-amber-700 dark:text-amber-400" data-testid="fleet-design-start-skip-reason">
            {startSkipLabel(t, startSkipReason)}
          </p>
        )}
      </div>

      {listError && <p className="text-sm text-destructive">{listError}</p>}
      {!listLoading && items.length === 0 && !listError && <EmptyState title={t("page.empty")} />}

      {items.length > 0 && (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm" data-testid="fleet-design-list">
            <thead>
              <tr className="border-b text-left text-xs font-medium text-muted-foreground">
                <th className="px-4 py-2">{t("page.listColumns.generated")}</th>
                <th className="px-4 py-2">{t("page.listColumns.functions")}</th>
                <th className="px-4 py-2">{t("page.listColumns.watches")}</th>
                <th className="px-4 py-2">{t("page.listColumns.rules")}</th>
                <th className="px-4 py-2">{t("page.listColumns.applied")}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr
                  key={item.reportRunId}
                  data-testid={`fleet-design-list-row-${item.reportRunId}`}
                  onClick={() => selectRun(item.reportRunId)}
                  aria-selected={item.reportRunId === selectedRunId}
                  className={`cursor-pointer border-b last:border-0 hover:bg-muted/30 ${
                    item.reportRunId === selectedRunId ? "bg-muted/40" : ""
                  }`}
                >
                  <td className="px-4 py-2">{item.generatedAt ? formatDateTime(item.generatedAt) : "—"}</td>
                  <td className="px-4 py-2">{item.functionCount}</td>
                  <td className="px-4 py-2">{item.watchCount}</td>
                  <td className="px-4 py-2">{item.ruleCount}</td>
                  <td className="px-4 py-2">
                    {item.reportRunId === selectedRunId ? ledger.filter((i) => i.status === "applied").length : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detailLoading && <p className="text-sm text-muted-foreground">{t("page.loadingDesign")}</p>}
      {detailError && <p className="text-sm text-destructive">{detailError}</p>}

      {outcome && selectedRunId && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              data-testid="fleet-design-review-apply"
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90"
            >
              {t("page.reviewApply")}
            </button>
            <button
              type="button"
              onClick={() => void handleDownload()}
              disabled={downloading}
              data-testid="fleet-design-download"
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              <Download className="h-4 w-4" />
              {t("page.downloadPdf")}
            </button>
            {hasAppliedRows && (
              <button
                type="button"
                onClick={() => void handleHeaderRollback()}
                disabled={rollingBack}
                data-testid="fleet-design-header-rollback"
                className="inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted disabled:opacity-50"
              >
                <RotateCcw className="h-4 w-4" />
                {t("result.rollback")}
              </button>
            )}
          </div>

          {rollbackResult && rollbackResult.refused.length > 0 && (
            <div
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              data-testid="fleet-design-rollback-refused"
            >
              <p>{t("result.rollbackRefused")}</p>
              <ul className="mt-1 list-disc pl-4">
                {rollbackResult.refused.map((r) => (
                  <li key={r.itemRef}>
                    {r.itemRef}: {r.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {drift && <DriftPanel drift={drift} />}

          <FleetDesignViewer outcome={outcome} selection={selection} />

          <ApplyDrawer
            open={drawerOpen}
            onClose={() => setDrawerOpen(false)}
            reportRunId={selectedRunId}
            approvalBase={selection.toApproval()}
            onApplied={() => {
              void loadDetail(selectedRunId);
              void loadList();
            }}
          />
        </div>
      )}
    </div>
  );
}
