import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { useState, useMemo, useEffect } from "react";
import { ChevronDown, ChevronRight, Clock, Loader2, Search } from "lucide-react";
import { formatToolName } from "../../lib/utils";
import { fetchWithAuth } from "../../stores/auth";
import { RATE_LIMIT_CONFIGS, groupByCategory } from "./tierConfig";
import type { ToolCategory } from "./tierConfig";
const TIER_BADGE: Record<number, string> = {
  1: "bg-green-500/15 text-green-700 border-green-500/30",
  2: "bg-blue-500/15 text-blue-700 border-blue-500/30",
  3: "bg-amber-500/15 text-amber-700 border-amber-500/30",
};
/** One row of GET /ai/tool-rate-limits (#6476). */
interface EffectiveToolRateLimit {
  toolName: string;
  baseLimit: number;
  limit: number;
  windowSeconds: number;
}
interface ToolRateLimitsResponse {
  orgId: string | null;
  multiplier: number;
  limits: EffectiveToolRateLimit[];
}
/** An API row joined with the tab's display metadata (tier/permission/category). */
interface RateLimitRow extends EffectiveToolRateLimit {
  tier: 1 | 2 | 3 | null;
  permission: string | null;
  category: ToolCategory;
}
const METADATA_BY_TOOL = new Map(RATE_LIMIT_CONFIGS.map((cfg) => [cfg.toolName, cfg]));
function toRow(limit: EffectiveToolRateLimit): RateLimitRow {
  const meta = METADATA_BY_TOOL.get(limit.toolName);
  return {
    ...limit,
    tier: meta?.tier ?? null,
    permission: meta?.permission ?? null,
    category: meta?.category ?? "Other",
  };
}
export function RateLimitStatus() {
  const { t } = useTranslation("security");
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [data, setData] = useState<ToolRateLimitsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithAuth("/ai/tool-rate-limits");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as ToolRateLimitsResponse;
        if (!cancelled) {
          setData(body);
          setLoadFailed(false);
        }
      } catch (err) {
        // Never fall back to a static copy: showing the shipped numbers when an
        // org has a multiplier would understate what the AI is allowed to do.
        console.error("[RateLimitStatus] Failed to load effective tool rate limits", err);
        if (!cancelled) setLoadFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const toggle = (key: string) =>
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  const q = search.toLowerCase().trim();
  const rows = useMemo(() => (data?.limits ?? []).map(toRow), [data]);
  const filtered = useMemo(() => {
    if (!q) return rows;
    return rows.filter(
      (row) =>
        row.toolName.toLowerCase().includes(q) ||
        (row.permission ?? "").toLowerCase().includes(q) ||
        row.category.toLowerCase().includes(q),
    );
  }, [q, rows]);
  const groups = useMemo(() => groupByCategory(filtered), [filtered]);
  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (loadFailed || !data) {
    return (
      <div
        data-testid="rate-limits-error"
        className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-sm text-destructive"
      >
        {t("aiRiskRateLimitStatus.failedToLoad")}
      </div>
    );
  }
  return (
    <div>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold">
            {t("aiRiskRateLimitStatus.rateLimitConfiguration")}
          </h2>
          <span className="text-xs text-muted-foreground">
            {t("aiRiskRateLimitStatus.ruleCount", { count: filtered.length })}
          </span>
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("aiRiskRateLimitStatus.filterRateLimits")}
            className="h-8 w-56 rounded-lg border bg-card pl-8 pr-3 text-xs focus:outline-hidden focus:ring-1 focus:ring-primary"
          />
        </div>
      </div>

      {data.multiplier > 1 && (
        <p
          data-testid="rate-limit-multiplier-note"
          className="mb-4 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
        >
          {t("aiRiskRateLimitStatus.multiplierApplied", { multiplier: data.multiplier })}
        </p>
      )}

      {groups.length === 0 ? (
        <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground shadow-xs">
          {t("aiRiskRateLimitStatus.noRateLimitsMatchYourSearch")}
        </div>
      ) : (
        <div className="rounded-lg border bg-card shadow-xs overflow-hidden">
          {groups.map((group) => {
            const key = `rl-${group.category}`;
            const isCollapsed = collapsed[key] ?? false;
            return (
              <RateLimitCategoryGroup
                key={key}
                category={group.category}
                configs={group.items}
                isCollapsed={isCollapsed}
                onToggle={() => toggle(key)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
function RateLimitCategoryGroup({
  category,
  configs,
  isCollapsed,
  onToggle,
}: {
  category: ToolCategory;
  configs: RateLimitRow[];
  isCollapsed: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation("security");
  return (
    <div className="border-b last:border-b-0">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm hover:bg-muted/30 transition-colors"
      >
        {isCollapsed ? (
          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
        )}
        <span className="font-medium">{category}</span>
        <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
          {configs.length}
        </span>
      </button>

      {!isCollapsed && (
        <div className="px-4 pb-3">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="pb-1.5 pl-6">
                  {t("aiRiskRateLimitStatus.tool")}
                </th>
                <th className="pb-1.5">{t("aiRiskRateLimitStatus.limit")}</th>
                <th className="pb-1.5">{t("aiRiskRateLimitStatus.window")}</th>
                <th className="pb-1.5">{t("aiRiskRateLimitStatus.tier")}</th>
                <th className="pb-1.5">
                  {t("aiRiskRateLimitStatus.permission")}
                </th>
              </tr>
            </thead>
            <tbody>
              {configs.map((cfg) => {
                const windowLabel =
                  cfg.windowSeconds >= 60
                    ? `${cfg.windowSeconds / 60} min`
                    : `${cfg.windowSeconds}s`;
                return (
                  <tr
                    key={cfg.toolName}
                    data-testid={`rate-limit-row-${cfg.toolName}`}
                    className="border-t border-dashed border-muted hover:bg-muted/20"
                  >
                    <td className="py-2 pl-6 font-medium">
                      {formatToolName(cfg.toolName)}
                    </td>
                    <td className="py-2">
                      <span className="inline-flex items-center gap-1" data-testid="rate-limit-effective">
                        <Clock className="h-3 w-3 text-muted-foreground" />
                        {t("aiRiskRateLimitStatus.requestCount", {
                          count: cfg.limit,
                        })}
                      </span>
                      {cfg.limit !== cfg.baseLimit && (
                        <span className="ml-1 text-muted-foreground" data-testid="rate-limit-base">
                          {t("aiRiskRateLimitStatus.defaultLimit", { limit: cfg.baseLimit })}
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-muted-foreground">
                      {windowLabel}
                    </td>
                    <td className="py-2">
                      {cfg.tier === null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span
                          className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${TIER_BADGE[cfg.tier]}`}
                        >
                          {t("aiRiskRateLimitStatus.t", { tier: cfg.tier })}
                        </span>
                      )}
                    </td>
                    <td className="py-2 font-mono text-muted-foreground">
                      {cfg.permission ?? "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
