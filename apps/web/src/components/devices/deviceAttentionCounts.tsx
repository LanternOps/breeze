import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import { fetchWithAuth } from "../../stores/auth";
import { EntityLink } from "@/components/shared/EntityLink";
import { severityConfig } from "@/components/alerts/alertConfig";
import { cn } from "@/lib/utils";
import "../../lib/i18n";

// #9038 — the devices list's "Attention" column and the grid card's matching
// pills: open alerts by severity + open tickets per device, from
// GET /devices/attention-counts (batched, max 100 ids per request).
//
// Request shape, by layer:
//   fetchDeviceAttentionCounts   one HTTP request for ≤100 ids
//   loadDeviceAttentionCounts    coalesces every caller in the same short
//                                window into one id set, split into ≤100-id
//                                requests — so a grid of N cards (each its own
//                                hook) still costs ceil(N/100) requests, never N
//   useDeviceAttentionCounts     per-component cache by id; debounced so one
//                                rows-change is one load; asks only for ids it
//                                has not already got. No polling.

export const ATTENTION_SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type AttentionSeverity = (typeof ATTENTION_SEVERITIES)[number];

export type DeviceAttention = {
  alerts: Record<AttentionSeverity, number>;
  tickets: number;
};

export type AttentionEntry =
  | { status: "loading" }
  | { status: "error" }
  /** `counts` is null when the device has nothing open. */
  | { status: "ready"; counts: DeviceAttention | null };

export type AttentionLookup = (deviceId: string) => AttentionEntry;

export const MAX_ATTENTION_IDS_PER_REQUEST = 100;
export const ATTENTION_DEBOUNCE_MS = 150;
const COALESCE_WINDOW_MS = 25;

function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function normalizeEntry(raw: unknown): DeviceAttention | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as { alerts?: Record<string, unknown>; tickets?: unknown };
  const alerts = {} as Record<AttentionSeverity, number>;
  for (const sev of ATTENTION_SEVERITIES) alerts[sev] = toCount(record.alerts?.[sev]);
  return { alerts, tickets: toCount(record.tickets) };
}

/** One request for at most {@link MAX_ATTENTION_IDS_PER_REQUEST} ids. Throws on a non-OK response. */
export async function fetchDeviceAttentionCounts(
  ids: readonly string[],
): Promise<Record<string, DeviceAttention>> {
  const query = ids.map(encodeURIComponent).join(",");
  const response = await fetchWithAuth(`/devices/attention-counts?ids=${query}`);
  if (!response.ok) {
    throw new Error(`attention-counts request failed: HTTP ${response.status}`);
  }
  const body = (await response.json()) as { counts?: Record<string, unknown> } | null;
  const out: Record<string, DeviceAttention> = {};
  for (const [id, raw] of Object.entries(body?.counts ?? {})) {
    const entry = normalizeEntry(raw);
    if (entry) out[id] = entry;
  }
  return out;
}

type Waiter = {
  ids: readonly string[];
  resolve: (counts: Record<string, DeviceAttention>) => void;
  reject: (error: unknown) => void;
};

let pendingIds = new Set<string>();
let pendingWaiters: Waiter[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

async function flushPending(): Promise<void> {
  const ids = [...pendingIds];
  const waiters = pendingWaiters;
  pendingIds = new Set();
  pendingWaiters = [];
  flushTimer = null;

  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += MAX_ATTENTION_IDS_PER_REQUEST) {
    chunks.push(ids.slice(i, i + MAX_ATTENTION_IDS_PER_REQUEST));
  }
  const results = await Promise.allSettled(chunks.map((chunk) => fetchDeviceAttentionCounts(chunk)));

  const merged: Record<string, DeviceAttention> = {};
  const failedIds = new Set<string>();
  let firstError: unknown = null;
  results.forEach((result, i) => {
    if (result.status === "fulfilled") {
      Object.assign(merged, result.value);
    } else {
      firstError ??= result.reason;
      for (const id of chunks[i]!) failedIds.add(id);
    }
  });
  // One warning per failed load, not per row or per card. The cells render a
  // quiet dash — a missing badge is not worth a toast.
  if (firstError) console.warn("[devices] attention counts unavailable", firstError);

  for (const waiter of waiters) {
    if (waiter.ids.some((id) => failedIds.has(id))) {
      waiter.reject(firstError);
      continue;
    }
    const own: Record<string, DeviceAttention> = {};
    for (const id of waiter.ids) if (merged[id]) own[id] = merged[id];
    waiter.resolve(own);
  }
}

/**
 * Coalesced, chunked load: calls landing within a short window share one id
 * set, fetched as ≤100-id requests. Resolves with the entries for `ids` that
 * have something open (ids with nothing open get no key).
 */
export function loadDeviceAttentionCounts(ids: readonly string[]): Promise<Record<string, DeviceAttention>> {
  if (ids.length === 0) return Promise.resolve({});
  return new Promise((resolve, reject) => {
    for (const id of ids) pendingIds.add(id);
    pendingWaiters.push({ ids, resolve, reject });
    if (flushTimer === null) {
      flushTimer = setTimeout(() => void flushPending(), COALESCE_WINDOW_MS);
    }
  });
}

/**
 * Attention counts for the given device ids, cached by id for the life of the
 * component. While `enabled` is false nothing is requested and every id reads
 * as loading. A failed id reads as `error` until a later rows-change retries it.
 */
export function useDeviceAttentionCounts(ids: readonly string[], enabled: boolean): AttentionLookup {
  const [cache, setCache] = useState<Record<string, DeviceAttention | null>>({});
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const inFlight = useRef(new Set<string>());
  // Results land even if the rows changed mid-flight (they are still valid
  // cache entries, and their ids are skipped by the next load while in
  // flight); only an unmounted component drops them.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Stable across renders that pass the same ids in a new array.
  const idsKey = useMemo(() => [...new Set(ids)].join(","), [ids]);

  useEffect(() => {
    if (!enabled || idsKey === "") return;
    const timer = setTimeout(() => {
      const missing = idsKey
        .split(",")
        .filter((id) => !(id in cacheRef.current) && !inFlight.current.has(id));
      if (missing.length === 0) return;
      for (const id of missing) inFlight.current.add(id);
      setFailed((prev) => {
        if (!missing.some((id) => prev.has(id))) return prev;
        const next = new Set(prev);
        for (const id of missing) next.delete(id);
        return next;
      });
      loadDeviceAttentionCounts(missing)
        .then((counts) => {
          if (!mounted.current) return;
          setCache((prev) => {
            const next = { ...prev };
            for (const id of missing) next[id] = counts[id] ?? null;
            return next;
          });
        })
        .catch(() => {
          if (!mounted.current) return;
          setFailed((prev) => new Set([...prev, ...missing]));
        })
        .finally(() => {
          for (const id of missing) inFlight.current.delete(id);
        });
    }, ATTENTION_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [idsKey, enabled]);

  return (deviceId: string): AttentionEntry => {
    if (deviceId in cache) return { status: "ready", counts: cache[deviceId] ?? null };
    if (failed.has(deviceId)) return { status: "error" };
    return { status: "loading" };
  };
}

// Explicit per-severity calls (not a computed key) so the i18n key-usage
// scanners see every key literally.
function severityCountLabel(t: TFunction, severity: AttentionSeverity, count: number): string {
  switch (severity) {
    case "critical":
      return t("deviceList.attention.alerts.critical", { count });
    case "high":
      return t("deviceList.attention.alerts.high", { count });
    case "medium":
      return t("deviceList.attention.alerts.medium", { count });
    case "low":
      return t("deviceList.attention.alerts.low", { count });
    case "info":
      return t("deviceList.attention.alerts.info", { count });
  }
}

function hasOpenItems(counts: DeviceAttention | null): boolean {
  return !!counts && (counts.tickets > 0 || ATTENTION_SEVERITIES.some((sev) => counts.alerts[sev] > 0));
}

const pillBase =
  "inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium";

/**
 * The cell body: highest-severity alert pill, then an open-ticket pill, each
 * linking to that device tab. A dash when nothing is open or the counts
 * could not be loaded; a one-line skeleton while loading.
 */
export function DeviceAttentionPills({
  deviceId,
  entry,
  className,
  pillsOnly = false,
}: {
  deviceId: string;
  entry: AttentionEntry;
  className?: string;
  /** Grid cards: render nothing (no skeleton, no dash) unless there is a pill to show. */
  pillsOnly?: boolean;
}) {
  const { t } = useTranslation("devices");

  if (pillsOnly && (entry.status !== "ready" || !hasOpenItems(entry.counts))) {
    return null;
  }

  if (entry.status === "loading") {
    return (
      <span data-testid={`device-${deviceId}-attention-loading`} className={cn("block", className)}>
        <span aria-hidden="true" className="block h-4 w-20 animate-pulse rounded bg-muted" />
        <span className="sr-only">{t("deviceList.attention.loading")}</span>
      </span>
    );
  }

  const dash = (testId: string, srText: string) => (
    <span data-testid={testId} className={className}>
      <span className="text-muted-foreground" aria-hidden="true">
        —
      </span>
      <span className="sr-only">{srText}</span>
    </span>
  );

  if (entry.status === "error") {
    return dash(`device-${deviceId}-attention-unavailable`, t("deviceList.attention.unavailable"));
  }

  const counts = entry.counts;
  const top = counts ? ATTENTION_SEVERITIES.find((sev) => counts.alerts[sev] > 0) : undefined;
  const tickets = counts?.tickets ?? 0;
  if (!top && tickets === 0) {
    return dash(`device-${deviceId}-attention-none`, t("deviceList.attention.none"));
  }

  const breakdown = counts
    ? ATTENTION_SEVERITIES.filter((sev) => counts.alerts[sev] > 0)
        .map((sev) => severityCountLabel(t, sev, counts.alerts[sev]))
        .join(", ")
    : "";

  return (
    <span className={cn("flex flex-wrap items-center gap-1", className)}>
      {top && counts && (
        <span
          data-testid={`device-${deviceId}-attention-alerts`}
          title={t("deviceList.attention.alertsTitle", { breakdown })}
          className={cn(pillBase, severityConfig[top].bg, severityConfig[top].border, severityConfig[top].color)}
        >
          <EntityLink
            kind="device"
            id={deviceId}
            hash="alerts"
            name={severityCountLabel(t, top, counts.alerts[top])}
          />
        </span>
      )}
      {tickets > 0 && (
        <span
          data-testid={`device-${deviceId}-attention-tickets`}
          className={cn(pillBase, "border-border bg-muted/50 text-foreground")}
        >
          <EntityLink
            kind="device"
            id={deviceId}
            hash="tickets"
            name={t("deviceList.attention.tickets", { count: tickets })}
          />
        </span>
      )}
    </span>
  );
}
