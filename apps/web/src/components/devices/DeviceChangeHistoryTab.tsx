import { useCallback, useEffect, useState } from "react";
import { ArrowRight, History } from "lucide-react";
import { formatDateTime as formatUserDateTime } from "@/lib/dateTimeFormat";
import { fetchWithAuth } from "../../stores/auth";
import { useTranslation } from "react-i18next";
import "../../lib/i18n";

type ChangeItem = {
  id: string;
  deviceId: string;
  hostname: string | null;
  timestamp: string;
  changeType: string;
  changeAction: string;
  subject: string;
  beforeValue: Record<string, unknown> | null;
  afterValue: Record<string, unknown> | null;
  details: Record<string, unknown> | null;
};

type ChangesResponse = {
  changes: ChangeItem[];
  total: number;
  showing: number;
  hasMore: boolean;
  nextCursor: string | null;
};

type DeviceChangeHistoryTabProps = {
  deviceId: string;
};

const CHANGE_TYPES = [
  "software",
  "service",
  "startup",
  "network",
  "scheduled_task",
  "user_account",
] as const;
const CHANGE_ACTIONS = ["added", "removed", "modified", "updated"] as const;
const PAGE_LIMIT = 100;

function formatDateTime(value?: string | null): string {
  if (!value) return "—";
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

// Literal-key label lookups (not dynamic t()) so the keyUsage guard can verify
// every enum label statically. Unknown values fall back to the raw enum string.
function typeLabel(t: (key: string) => string, value: string): string {
  switch (value) {
    case "software":
      return t("deviceChangeHistoryTab.type_software");
    case "service":
      return t("deviceChangeHistoryTab.type_service");
    case "startup":
      return t("deviceChangeHistoryTab.type_startup");
    case "network":
      return t("deviceChangeHistoryTab.type_network");
    case "scheduled_task":
      return t("deviceChangeHistoryTab.type_scheduled_task");
    case "user_account":
      return t("deviceChangeHistoryTab.type_user_account");
    default:
      return value;
  }
}

function actionLabel(t: (key: string) => string, value: string): string {
  switch (value) {
    case "added":
      return t("deviceChangeHistoryTab.action_added");
    case "removed":
      return t("deviceChangeHistoryTab.action_removed");
    case "modified":
      return t("deviceChangeHistoryTab.action_modified");
    case "updated":
      return t("deviceChangeHistoryTab.action_updated");
    default:
      return value;
  }
}

function badgeClassForType(value: string): string {
  switch (value) {
    case "software":
      return "bg-blue-500/10 text-blue-600";
    case "service":
      return "bg-violet-500/10 text-violet-600";
    case "startup":
      return "bg-amber-500/10 text-amber-700";
    case "network":
      return "bg-cyan-500/10 text-cyan-600";
    case "scheduled_task":
      return "bg-indigo-500/10 text-indigo-600";
    case "user_account":
      return "bg-emerald-500/10 text-emerald-600";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function badgeClassForAction(value: string): string {
  switch (value) {
    case "added":
      return "bg-emerald-500/10 text-emerald-600";
    case "removed":
      return "bg-red-500/10 text-red-600";
    case "modified":
    case "updated":
      return "bg-amber-500/10 text-amber-700";
    default:
      return "bg-muted text-muted-foreground";
  }
}

// Renders a single before/after value. Objects become compact `key: val` pairs;
// scalars stringify directly.
function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, val]) =>
        `${key}: ${val !== null && typeof val === "object" ? JSON.stringify(val) : String(val)}`,
      )
      .join(", ");
  }
  return String(value);
}

// A null `before` with an `after` reads as an add; a null `after` reads as a
// removal; both present render as `old → new`.
function ChangeCell({
  before,
  after,
}: {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}) {
  const hasBefore = before !== null && before !== undefined;
  const hasAfter = after !== null && after !== undefined;
  if (!hasBefore && !hasAfter) {
    return <span className="text-muted-foreground">—</span>;
  }
  if (!hasBefore) {
    return (
      <span className="text-emerald-600">+ {formatValue(after)}</span>
    );
  }
  if (!hasAfter) {
    return (
      <span className="text-red-600 line-through">{formatValue(before)}</span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="text-muted-foreground line-through">
        {formatValue(before)}
      </span>
      <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="text-foreground">{formatValue(after)}</span>
    </span>
  );
}

export default function DeviceChangeHistoryTab({
  deviceId,
}: DeviceChangeHistoryTabProps) {
  const { t } = useTranslation("devices");
  const [items, setItems] = useState<ChangeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>();
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  const [typeFilter, setTypeFilter] = useState("");
  const [actionFilter, setActionFilter] = useState("");

  // Keyset pagination: `append` distinguishes a "Load more" (keep existing rows,
  // add the next page) from a fresh page-1 load (replace rows). A filter change
  // reruns the effect below via the fetchPage identity and always loads page 1.
  const fetchPage = useCallback(
    async (cursor: string | null, append: boolean) => {
      if (append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
        setError(undefined);
      }
      try {
        const params = new URLSearchParams({
          deviceId,
          limit: String(PAGE_LIMIT),
        });
        if (typeFilter) params.set("changeType", typeFilter);
        if (actionFilter) params.set("changeAction", actionFilter);
        if (cursor) params.set("cursor", cursor);

        const response = await fetchWithAuth(`/changes?${params.toString()}`);
        if (!response.ok) {
          setError(
            t("deviceChangeHistoryTab.loadError", { status: response.status }),
          );
          return;
        }
        const json = (await response.json()) as ChangesResponse;
        const changes = Array.isArray(json.changes) ? json.changes : [];
        setItems((prev) => (append ? [...prev, ...changes] : changes));
        setHasMore(Boolean(json.hasMore));
        setNextCursor(json.nextCursor ?? null);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : t("deviceChangeHistoryTab.loadError", { status: 0 }),
        );
      } finally {
        if (append) {
          setLoadingMore(false);
        } else {
          setLoading(false);
        }
      }
    },
    [deviceId, typeFilter, actionFilter, t],
  );

  useEffect(() => {
    // Reset rows + drop the cursor on every filter change, then load page 1.
    setItems([]);
    setNextCursor(null);
    setHasMore(false);
    fetchPage(null, false);
  }, [fetchPage]);

  const hasFilters = Boolean(typeFilter || actionFilter);

  if (loading) {
    return (
      <div
        data-testid="change-history-loading"
        className="flex items-center justify-center rounded-lg border bg-card py-12 shadow-xs"
      >
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-3 text-sm text-muted-foreground">
            {t("deviceChangeHistoryTab.loading")}
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div
        data-testid="change-history-error"
        className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center"
      >
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={() => fetchPage(null, false)}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {t("deviceChangeHistoryTab.retry")}
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-6 shadow-xs">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-lg font-semibold">
            {t("deviceChangeHistoryTab.title")}
          </h3>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            {items.length}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <select
            data-testid="change-history-type-filter"
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value)}
            className="rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-primary/20"
          >
            <option value="">{t("deviceChangeHistoryTab.allTypes")}</option>
            {CHANGE_TYPES.map((value) => (
              <option key={value} value={value}>
                {typeLabel(t, value)}
              </option>
            ))}
          </select>

          <select
            data-testid="change-history-action-filter"
            value={actionFilter}
            onChange={(event) => setActionFilter(event.target.value)}
            className="rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-primary/20"
          >
            <option value="">{t("deviceChangeHistoryTab.allActions")}</option>
            {CHANGE_ACTIONS.map((value) => (
              <option key={value} value={value}>
                {actionLabel(t, value)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-4 overflow-hidden rounded-md border">
        <div className="max-h-[560px] overflow-auto">
          <table className="min-w-full divide-y">
            <thead className="sticky top-0 bg-muted/40">
              <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">
                  {t("deviceChangeHistoryTab.colWhen")}
                </th>
                <th className="px-4 py-3">
                  {t("deviceChangeHistoryTab.colType")}
                </th>
                <th className="px-4 py-3">
                  {t("deviceChangeHistoryTab.colAction")}
                </th>
                <th className="px-4 py-3">
                  {t("deviceChangeHistoryTab.colSubject")}
                </th>
                <th className="px-4 py-3">
                  {t("deviceChangeHistoryTab.colChange")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {items.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    data-testid="change-history-empty"
                    className="px-4 py-6 text-center text-sm text-muted-foreground"
                  >
                    {hasFilters
                      ? t("deviceChangeHistoryTab.emptyFiltered")
                      : t("deviceChangeHistoryTab.empty")}
                  </td>
                </tr>
              ) : (
                items.map((item) => (
                  <tr
                    key={item.id}
                    data-testid="change-history-row"
                    className="text-sm hover:bg-muted/30"
                  >
                    <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
                      {formatDateTime(item.timestamp)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${badgeClassForType(item.changeType)}`}
                      >
                        {typeLabel(t, item.changeType)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${badgeClassForAction(item.changeAction)}`}
                      >
                        {actionLabel(t, item.changeAction)}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-medium">{item.subject}</td>
                    <td className="px-4 py-3 text-xs">
                      <ChangeCell
                        before={item.beforeValue}
                        after={item.afterValue}
                      />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {hasMore && (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            data-testid="change-history-load-more"
            onClick={() => fetchPage(nextCursor, true)}
            disabled={loadingMore}
            className="rounded-md border px-4 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("deviceChangeHistoryTab.loadMore")}
          </button>
        </div>
      )}
    </div>
  );
}
