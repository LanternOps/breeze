import { useCallback, useEffect, useState } from "react";
import { fetchWithAuth } from "../../stores/auth";

export type ConnectionIncident = {
  id: string;
  sourceKind: string;
  orgId: string | null;
  condition: string;
  severity: "permanent" | "transient";
  detail: string | null;
  displayName: string;
  fixHref: string;
  /** Set when the only remedy is outside Breeze (no repair page to link to). */
  remedy?: { kind: "reconnect" } | null;
  firstFailedAt: string;
  openedAt: string | null;
  lastObservedAt: string;
  resolvedAt: string | null;
  resolution: "recovered" | "retired" | null;
};

export type ConnectionIncidentList = { data: ConnectionIncident[]; truncated: boolean };

export type ConnectionHealthState =
  | { kind: "loading" }
  | { kind: "hidden" }
  | { kind: "error" }
  | { kind: "ready"; open: ConnectionIncidentList; recent: ConnectionIncidentList };

export type ConnectionHealth = { state: ConnectionHealthState; retry: () => void };

/** null = not an incident list; never read as "nothing is broken". */
const asList = (body: unknown): ConnectionIncidentList | null => {
  const b = (body ?? {}) as Partial<ConnectionIncidentList>;
  if (!Array.isArray(b.data)) return null;
  return { data: b.data, truncated: b.truncated === true };
};

async function loadConnectionHealth(): Promise<ConnectionHealthState> {
  try {
    const [openRes, recentRes] = await Promise.all([
      fetchWithAuth("/connection-health/incidents?status=open"),
      fetchWithAuth("/connection-health/incidents?status=recent"),
    ]);
    if (openRes?.status === 401 || openRes?.status === 403) {
      return { kind: "hidden" };
    }
    if (!openRes?.ok) return { kind: "error" };
    const open = asList(await openRes.json());
    if (!open) return { kind: "error" };
    // Recent is secondary: a failure there must not hide open incidents.
    const recent = (recentRes?.ok ? asList(await recentRes.json()) : null)
      ?? { data: [], truncated: false };
    return { kind: "ready", open, recent };
  } catch {
    return { kind: "error" };
  }
}

/**
 * Open + recently resolved connection-health incidents. The Integrations page
 * loads this once and shares it between the health overview and the per-item
 * status badges in its navigation; `enabled: false` skips the fetch for a
 * caller that was handed the data instead.
 */
export function useConnectionHealth(enabled = true): ConnectionHealth {
  const [state, setState] = useState<ConnectionHealthState>({ kind: "loading" });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void loadConnectionHealth().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const retry = useCallback(() => {
    setState({ kind: "loading" });
    void loadConnectionHealth().then(setState);
  }, []);

  return { state, retry };
}
