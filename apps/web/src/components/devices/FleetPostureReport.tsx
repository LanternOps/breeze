import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Download,
  Loader2,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";

import { friendlyFetchError } from "../../lib/utils";
import { formatDateTime as formatUserDateTime } from "@/lib/dateTimeFormat";
import { fetchWithAuth } from "../../stores/auth";
import { useOrgStore } from "../../stores/orgStore";
import { toCsv } from "../../lib/csvExport";
import { downloadBlob } from "../../lib/downloadBlob";
import { useTranslation } from "react-i18next";
import "../../lib/i18n";
import { useHashState } from "../../lib/useHashState";
import {
  CATEGORY_LABELS,
  STATUS_BADGE,
  isCategoryKey,
  type CategoryKey,
} from "../../lib/postureCategories";

// ── Types (mirror GET /devices/management-posture/summary) ───────────

type ProductRow = {
  product: string;
  status: string;
  deviceCount: number;
  freshDeviceCount: number;
};

type OrgSummary = {
  orgId: string;
  totalDevices: number;
  neverScanned: number;
  stale: number;
  scannedNoneDetected: number;
  detectedDevices: number;
  freshDetectedDevices: number;
  products: ProductRow[];
};

type Summary = {
  category: CategoryKey;
  stalenessDays: number;
  totals: {
    totalDevices: number;
    neverScanned: number;
    stale: number;
    scannedNoneDetected: number;
    detectedDevices: number;
    freshDetectedDevices: number;
  };
  orgs: OrgSummary[];
};

type DrillDevice = {
  id: string;
  orgId: string;
  hostname: string;
  displayName: string | null;
  status: string;
  osType: string;
  lastSeenAt: string | null;
  collectedAt: string | null;
  detectionStatus: string;
  detectionVersion: string | null;
};

// ── Constants (same conventions as DeviceManagementTab) ──────────────

const CATEGORY_ORDER: CategoryKey[] = [
  "rmm",
  "remoteAccess",
  "mdm",
  "endpointSecurity",
  "policyEngine",
  "backup",
  "identityMfa",
  "siem",
  "dnsFiltering",
  "zeroTrustVpn",
  "patchManagement",
];

const WINDOW_OPTIONS = [7, 14, 30, 90];

/**
 * Remote-access products that ship as a separately-installed component of a
 * competing RMM and SURVIVE that RMM's uninstall (the plan's definition of an
 * orphan risk): ScreenConnect outlives a ConnectWise Automate uninstall;
 * Splashtop outlives Atera and Syncro uninstalls. Deliberately NOT every
 * remote-access detection — flagging an MSP's own sanctioned TeamViewer/
 * AnyDesk on every visit would train users to ignore the banner. A true
 * per-device orphan check (RA present AND its parent RMM absent) needs a
 * server-side cross-category query — follow-up on #3244.
 */
const ORPHAN_RISK_REMOTE_ACCESS = new Set(["ScreenConnect", "Splashtop"]);

function statusBadgeClass(status: string): string {
  return STATUS_BADGE[(status as keyof typeof STATUS_BADGE)] ?? STATUS_BADGE.unknown;
}

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

// ── Drill-down device list ───────────────────────────────────────────

function DrillDownList({
  category,
  product,
  status,
  stalenessDays,
  orgId,
  orgNames,
}: {
  category: CategoryKey;
  product: string;
  status: string;
  stalenessDays: number;
  /** The org whose count this drill-down explains. Passed explicitly: in
   *  "All organizations" mode fetchWithAuth injects no orgId, and without it
   *  the list would span every accessible org under one org's heading. */
  orgId: string;
  orgNames: Map<string, string>;
}) {
  const { t } = useTranslation("devices");
  const [devices, setDevices] = useState<DrillDevice[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const fetchPage = useCallback(
    async (nextPage: number, append: boolean) => {
      setLoading(true);
      setError(undefined);
      try {
        const params = new URLSearchParams({
          category,
          product,
          status,
          orgId,
          stalenessDays: String(stalenessDays),
          page: String(nextPage),
          limit: "50",
        });
        const response = await fetchWithAuth(
          `/devices/management-posture/devices?${params.toString()}`
        );
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const body = await response.json();
        setTotal(body.data.total ?? 0);
        setDevices((prev) => (append ? [...prev, ...body.data.devices] : body.data.devices));
        setPage(nextPage);
      } catch (err) {
        setError(friendlyFetchError(err));
      } finally {
        setLoading(false);
      }
    },
    [category, product, status, stalenessDays, orgId]
  );

  useEffect(() => {
    fetchPage(1, false);
  }, [fetchPage]);

  return (
    <div className="border-t border-border bg-muted/30 p-3" data-testid="posture-drilldown">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th className="py-1 pr-3 font-medium">{t("fleetPosture.colHostname")}</th>
            <th className="py-1 pr-3 font-medium">{t("fleetPosture.colOrganization")}</th>
            <th className="py-1 pr-3 font-medium">{t("fleetPosture.colDetectedVersion")}</th>
            <th className="py-1 pr-3 font-medium">{t("fleetPosture.colScannedAt")}</th>
          </tr>
        </thead>
        <tbody>
          {devices.map((d) => (
            <tr key={d.id} className="border-t border-border/50" data-testid="posture-drilldown-row">
              <td className="py-1.5 pr-3">
                <a href={`/devices/${d.id}`} className="text-primary hover:underline">
                  {d.displayName || d.hostname}
                </a>
              </td>
              <td className="py-1.5 pr-3">{orgNames.get(d.orgId) ?? d.orgId}</td>
              <td className="py-1.5 pr-3">{d.detectionVersion ?? "—"}</td>
              <td className="py-1.5 pr-3">
                {d.collectedAt ? formatDateTime(d.collectedAt) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {loading && (
        <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("fleetPosture.loading")}
        </div>
      )}
      {/* Errors render inline so an already-loaded page of rows survives a
          failed "Load more"; retrying refetches only the failed page. */}
      {error && !loading && (
        <div className="flex items-center gap-2 py-2 text-sm text-destructive" data-testid="posture-drilldown-error">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => fetchPage(page + (devices.length > 0 ? 1 : 0), devices.length > 0)}
            className="rounded-md border border-border px-2 py-0.5 text-xs hover:bg-muted"
          >
            {t("fleetPosture.retry")}
          </button>
        </div>
      )}
      {!loading && !error && devices.length < total && (
        <button
          type="button"
          onClick={() => fetchPage(page + 1, true)}
          className="mt-2 rounded-md border border-border px-3 py-1 text-sm hover:bg-muted"
          data-testid="posture-drilldown-more"
        >
          {t("fleetPosture.loadMore")}
        </button>
      )}
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────

export default function FleetPostureReport() {
  const { t } = useTranslation("devices");
  const organizations = useOrgStore((s) => s.organizations);
  const currentOrgId = useOrgStore((s) => s.currentOrgId);

  // SSR-safe hash-derived tab state (#2421): starts from the default and
  // adopts the hash pre-paint. isCategoryKey does an own-property check — a
  // plain `raw in CATEGORY_LABELS` would also match inherited keys like
  // '#toString' and wedge the page on an invalid category.
  const [category, setCategory] = useHashState<CategoryKey>("rmm", (raw) =>
    isCategoryKey(raw) ? raw : undefined
  );
  const [stalenessDays, setStalenessDays] = useState(7);
  const [summary, setSummary] = useState<Summary>();
  const [remoteAccess, setRemoteAccess] = useState<Summary>();
  const [raUnavailable, setRaUnavailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [expanded, setExpanded] = useState<string>();
  // Out-of-order guard: rapid category/window switches fire overlapping
  // fetches; only the latest request may commit state, otherwise a slower
  // older response would render under the newer selection.
  const requestSeq = useRef(0);

  const orgNames = new Map(organizations.map((o) => [o.id, o.name]));

  const fetchSummary = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(undefined);
    setExpanded(undefined);
    try {
      const query = (cat: CategoryKey) =>
        `/devices/management-posture/summary?category=${cat}&stalenessDays=${stalenessDays}`;
      // The orphaned-remote-access callout is best-effort; the main report
      // must not fail because of it — so its rejection is swallowed here and
      // surfaced as an explicit "findings unavailable" note instead.
      const [main, ra] = await Promise.all([
        fetchWithAuth(query(category)),
        category === "remoteAccess"
          ? Promise.resolve(undefined)
          : fetchWithAuth(query("remoteAccess")).catch(() => undefined),
      ]);
      if (seq !== requestSeq.current) return;
      if (!main.ok) throw new Error(`${main.status} ${main.statusText}`);
      const mainData = (await main.json()).data;
      const raData = ra && ra.ok ? (await ra.json()).data : undefined;
      if (seq !== requestSeq.current) return;
      setSummary(mainData);
      setRemoteAccess(raData);
      // Missing security findings must be visible, not silent — this report
      // is the only place the orphaned-RA exposure surfaces.
      setRaUnavailable(category !== "remoteAccess" && raData === undefined);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setError(friendlyFetchError(err));
      setSummary(undefined);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [category, stalenessDays, currentOrgId]);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

  const selectCategory = (next: CategoryKey) => {
    setCategory(next);
    if (typeof window !== "undefined") window.location.hash = next;
  };

  const exportCsv = () => {
    if (!summary) return;
    const header = [
      "Organization",
      "Category",
      "Metric",
      "Detection status",
      "Devices",
      `Fresh (<= ${summary.stalenessDays}d)`,
    ];
    const rows: (string | number)[][] = [];
    for (const org of summary.orgs) {
      const orgName = orgNames.get(org.orgId) ?? org.orgId;
      rows.push([orgName, summary.category, "Total devices", "", org.totalDevices, ""]);
      rows.push([orgName, summary.category, "Never scanned (posture unknown)", "", org.neverScanned, ""]);
      rows.push([orgName, summary.category, "Stale scan", "", org.stale, ""]);
      rows.push([orgName, summary.category, "Scanned, none detected", "", org.scannedNoneDetected, ""]);
      rows.push([orgName, summary.category, "Detected devices", "", org.detectedDevices, org.freshDetectedDevices]);
      for (const p of org.products) {
        rows.push([orgName, summary.category, p.product, p.status, p.deviceCount, p.freshDeviceCount]);
      }
    }
    const csv = toCsv(header, rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    downloadBlob(blob, `fleet-posture-${summary.category}-${new Date().toISOString().slice(0, 10)}.csv`);
  };

  const orphanProducts =
    remoteAccess?.orgs.flatMap((o) =>
      o.products
        .filter((p) => ORPHAN_RISK_REMOTE_ACCESS.has(p.product))
        .map((p) => ({ orgId: o.orgId, ...p }))
    ) ?? [];

  return (
    <div className="space-y-4" data-testid="fleet-posture-report">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{t("fleetPosture.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("fleetPosture.subtitle")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-sm text-muted-foreground" htmlFor="posture-category">
            {t("fleetPosture.labelCategory")}
          </label>
          <select
            id="posture-category"
            value={category}
            onChange={(e) => selectCategory(e.target.value as CategoryKey)}
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            data-testid="posture-category-select"
          >
            {CATEGORY_ORDER.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
          <label className="text-sm text-muted-foreground" htmlFor="posture-window">
            {t("fleetPosture.labelWindow")}
          </label>
          <select
            id="posture-window"
            value={stalenessDays}
            onChange={(e) => setStalenessDays(Number(e.target.value))}
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            data-testid="posture-window-select"
          >
            {WINDOW_OPTIONS.map((d) => (
              <option key={d} value={d}>
                {t("fleetPosture.windowDays", { count: d })}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={fetchSummary}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted"
            data-testid="posture-refresh"
          >
            <RefreshCw className="h-4 w-4" />
            {t("fleetPosture.refresh")}
          </button>
          <button
            type="button"
            onClick={exportCsv}
            disabled={!summary}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
            data-testid="posture-export-csv"
          >
            <Download className="h-4 w-4" />
            {t("fleetPosture.exportCsv")}
          </button>
        </div>
      </div>

      {loading && (
        <div className="flex items-center gap-2 py-10 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          {t("fleetPosture.loading")}
        </div>
      )}

      {error && !loading && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm">
          <p>{error}</p>
          <button
            type="button"
            onClick={fetchSummary}
            className="mt-2 rounded-md border border-border px-3 py-1 text-sm hover:bg-muted"
          >
            {t("fleetPosture.retry")}
          </button>
        </div>
      )}

      {summary && !loading && !error && (
        <>
          {/* Coverage denominators — posture age is part of the answer. A zero
              detection count is only meaningful next to these. */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5" data-testid="posture-totals">
            <StatCard
              label={t("fleetPosture.totalDevices")}
              value={summary.totals.totalDevices}
            />
            <StatCard
              label={t("fleetPosture.detected")}
              value={summary.totals.detectedDevices}
              hint={t("fleetPosture.freshOf", {
                fresh: summary.totals.freshDetectedDevices,
                total: summary.totals.detectedDevices,
              })}
            />
            <StatCard
              label={t("fleetPosture.cleanFresh")}
              value={summary.totals.scannedNoneDetected}
            />
            <StatCard
              label={t("fleetPosture.stale")}
              value={summary.totals.stale}
              tone={summary.totals.stale > 0 ? "warn" : undefined}
              hint={summary.totals.stale > 0 ? t("fleetPosture.staleHint") : undefined}
            />
            <StatCard
              label={t("fleetPosture.neverScanned")}
              value={summary.totals.neverScanned}
              tone={summary.totals.neverScanned > 0 ? "warn" : undefined}
              hint={summary.totals.neverScanned > 0 ? t("fleetPosture.neverScannedHint") : undefined}
            />
          </div>

          {/* Never render a bare zero: 0 detections with unknown devices is a
              different fact from 0 with everything fresh. */}
          {summary.totals.detectedDevices === 0 &&
            (summary.totals.neverScanned > 0 || summary.totals.stale > 0) && (
              <div
                className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
                data-testid="posture-zero-caveat"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                <span>
                  {t("fleetPosture.zeroCaveat", {
                    unknown: summary.totals.neverScanned + summary.totals.stale,
                  })}
                </span>
              </div>
            )}

          {raUnavailable && (
            <p className="text-xs text-muted-foreground" data-testid="posture-orphan-unavailable">
              {t("fleetPosture.securityUnavailable")}
            </p>
          )}

          {orphanProducts.length > 0 && category !== "remoteAccess" && (
            <div
              className="rounded-md border border-red-500/40 bg-red-500/10 p-4"
              data-testid="posture-orphan-callout"
            >
              <div className="flex items-center gap-2 font-medium">
                <ShieldAlert className="h-5 w-5 text-red-600" />
                {t("fleetPosture.securityTitle")}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("fleetPosture.securityBody")}
              </p>
              <ul className="mt-2 space-y-1 text-sm">
                {orphanProducts.map((p) => (
                  <li key={`${p.orgId}-${p.product}-${p.status}`} className="flex items-center gap-2">
                    <span className={`rounded border px-1.5 py-0.5 text-xs ${statusBadgeClass(p.status)}`}>
                      {p.status}
                    </span>
                    <span className="font-medium">{p.product}</span>
                    <span className="text-muted-foreground">
                      · {orgNames.get(p.orgId) ?? p.orgId} ·{" "}
                      {t("fleetPosture.deviceCount", { count: p.deviceCount })}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {summary.orgs.map((org) => (
            <div key={org.orgId} className="rounded-md border border-border" data-testid="posture-org-section">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border p-3">
                <h2 className="font-medium">{orgNames.get(org.orgId) ?? org.orgId}</h2>
                {/* Per-org migration progress. The three non-enrolled chips
                    PARTITION the fleet (fresh-detected + fresh-clean +
                    unknown == total): the raw coverage buckets overlap on
                    stale devices (a stale-clean scan is NOT "verified
                    clean"), so both/Breeze-only are derived from the fresh
                    counts only and every stale device counts as unknown. */}
                <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                  <span data-testid="posture-progress-enrolled">
                    {t("fleetPosture.progressEnrolled", { count: org.totalDevices })}
                  </span>
                  <span data-testid="posture-progress-both">
                    {t("fleetPosture.progressBoth", { count: org.freshDetectedDevices })}
                  </span>
                  <span data-testid="posture-progress-breeze-only">
                    {t("fleetPosture.progressBreezeOnly", {
                      count:
                        org.totalDevices - org.neverScanned - org.stale - org.freshDetectedDevices,
                    })}
                  </span>
                  <span
                    className={org.neverScanned + org.stale > 0 ? "text-amber-600" : undefined}
                    data-testid="posture-progress-unknown"
                  >
                    {t("fleetPosture.progressUnknown", { count: org.neverScanned + org.stale })}
                  </span>
                </div>
              </div>
              {org.products.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground" data-testid="posture-org-empty">
                  {t("fleetPosture.noDetections", { category: CATEGORY_LABELS[summary.category] })}{" "}
                  {org.neverScanned + org.stale > 0 &&
                    t("fleetPosture.zeroCaveat", { unknown: org.neverScanned + org.stale })}
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground">
                      <th className="p-3 font-medium">{t("fleetPosture.colProduct")}</th>
                      <th className="p-3 font-medium">{t("fleetPosture.colDetectionStatus")}</th>
                      <th className="p-3 font-medium">{t("fleetPosture.colDevices")}</th>
                      <th className="p-3 font-medium">{t("fleetPosture.colFresh")}</th>
                      <th className="p-3" />
                    </tr>
                  </thead>
                  <tbody>
                    {org.products.map((p) => {
                      const key = `${org.orgId}|${p.product}|${p.status}`;
                      const isOpen = expanded === key;
                      return (
                        <FragmentRow
                          key={key}
                          isOpen={isOpen}
                          onToggle={() => setExpanded(isOpen ? undefined : key)}
                          product={p}
                          category={summary.category}
                          stalenessDays={summary.stalenessDays}
                          orgId={org.orgId}
                          orgNames={orgNames}
                        />
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: number;
  hint?: string;
  tone?: "warn";
}) {
  return (
    <div
      className={`rounded-md border p-3 ${
        tone === "warn" ? "border-amber-500/40 bg-amber-500/10" : "border-border"
      }`}
    >
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

function FragmentRow({
  isOpen,
  onToggle,
  product,
  category,
  stalenessDays,
  orgId,
  orgNames,
}: {
  isOpen: boolean;
  onToggle: () => void;
  product: ProductRow;
  category: CategoryKey;
  stalenessDays: number;
  orgId: string;
  orgNames: Map<string, string>;
}) {
  const { t } = useTranslation("devices");
  return (
    <>
      <tr
        className="cursor-pointer border-t border-border/60 hover:bg-muted/40"
        onClick={onToggle}
        data-testid="posture-product-row"
      >
        <td className="p-3 font-medium">{product.product}</td>
        <td className="p-3">
          <span className={`rounded border px-1.5 py-0.5 text-xs ${statusBadgeClass(product.status)}`}>
            {product.status}
          </span>
        </td>
        <td className="p-3">{product.deviceCount}</td>
        <td className="p-3">
          {/* Posture age next to every count — a count with 0 fresh scans is
              not evidence the product is still (or no longer) there. */}
          <span className={product.freshDeviceCount < product.deviceCount ? "text-amber-600" : undefined}>
            {t("fleetPosture.freshOf", {
              fresh: product.freshDeviceCount,
              total: product.deviceCount,
            })}
          </span>
        </td>
        <td className="p-3 text-right text-muted-foreground">
          {isOpen ? <ChevronDown className="ml-auto h-4 w-4" /> : <ChevronRight className="ml-auto h-4 w-4" />}
        </td>
      </tr>
      {isOpen && (
        <tr>
          <td colSpan={5} className="p-0">
            <DrillDownList
              category={category}
              product={product.product}
              status={product.status}
              stalenessDays={stalenessDays}
              orgId={orgId}
              orgNames={orgNames}
            />
          </td>
        </tr>
      )}
    </>
  );
}
