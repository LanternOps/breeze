import { useEffect, useRef, useState } from 'react';
import { fetchWithAuth } from '../stores/auth';
import { useOrgStore } from '../stores/orgStore';

export interface DashboardQueryState<T> {
  data: T | null;
  error: unknown;
  /** True only until the first load settles — pollers refresh silently. */
  isLoading: boolean;
  /** True while any fetch is in flight (including background polls). */
  isFetching: boolean;
  /**
   * 403/404 from the endpoint: the caller lacks the permission or the
   * feature isn't available on this deployment. Consumers are expected to
   * hide or degrade (each widget documents which). Note a mid-session
   * 403/404 clears previously-loaded data — the keep-stale rule below only
   * applies to transient failures.
   */
  unavailable: boolean;
  /**
   * True while the cached `data` was fetched under a *previous* org scope and
   * the refetch for the current scope hasn't landed yet. Widgets that merely
   * display their own numbers can ignore this (a stale number for one paint is
   * better than a skeleton flash), but any widget that draws a *conclusion*
   * from another widget's data must treat it as "not known yet" — otherwise
   * switching from a populated org to an empty one paints the previous org's
   * denominator over the new org's zeros. See `fleetPresence` (#3613).
   */
  staleScope: boolean;
}

/**
 * One fetch slot of the dashboard. All slots take a caller-supplied refresh
 * token (the page's 60s tick, or the slower derived heavyTick for expensive
 * endpoints) and re-fetch when the global org scope changes, so every
 * widget always shows the same scope — the old per-widget pollers drifted
 * (RecentAlerts didn't refetch on an org change, showing the old scope
 * until its next poll).
 */
export function useDashboardQuery<T>(
  path: string,
  refreshToken: number,
  select: (json: unknown) => T,
): DashboardQueryState<T> {
  const [state, setState] = useState<DashboardQueryState<T>>({
    data: null,
    error: null,
    isLoading: true,
    isFetching: true,
    unavailable: false,
    staleScope: false,
  });
  const currentOrgId = useOrgStore((s) => s.currentOrgId);

  // The org scope the currently-held `data` was fetched under. `undefined`
  // until the first response lands.
  const dataOrgId = useRef<string | null | undefined>(undefined);

  // Keep the latest selector without making it an effect dependency —
  // callers pass inline arrows.
  const selectRef = useRef(select);
  selectRef.current = select;

  // Monotonic request id: a slow response from a stale org scope must never
  // overwrite the newer scope's data.
  const requestSeq = useRef(0);

  useEffect(() => {
    const seq = ++requestSeq.current;
    setState((prev) => ({
      ...prev,
      isFetching: true,
      staleScope: prev.data != null && dataOrgId.current !== currentOrgId,
    }));

    const run = async () => {
      try {
        const response = await fetchWithAuth(path);
        if (seq !== requestSeq.current) return;

        if (response.status === 403 || response.status === 404) {
          dataOrgId.current = currentOrgId;
          setState({
            data: null,
            error: null,
            isLoading: false,
            isFetching: false,
            unavailable: true,
            staleScope: false,
          });
          return;
        }
        if (!response.ok) throw response;

        const json = await response.json();
        if (seq !== requestSeq.current) return;
        dataOrgId.current = currentOrgId;
        setState({
          data: selectRef.current(json),
          error: null,
          isLoading: false,
          isFetching: false,
          unavailable: false,
          staleScope: false,
        });
      } catch (err) {
        if (seq !== requestSeq.current) return;
        // Non-Response errors are code defects (selector/JSON-parse bugs) or
        // network drops — leave a trail; a Response's status is already
        // meaningful to the consumer's error UI.
        if (!(err instanceof Response)) {
          console.error(`[dashboard] ${path} failed`, err);
        }
        // Keep stale data visible on a failed background poll; only surface
        // the error state when we have nothing to show.
        setState((prev) => ({
          data: prev.data,
          error: err,
          isLoading: false,
          isFetching: false,
          unavailable: false,
          // A failed refetch does NOT make old-scope data current — keep it
          // flagged so conclusions drawn from it stay suspended.
          staleScope: prev.data != null && dataOrgId.current !== currentOrgId,
        }));
      }
    };

    run();
  }, [path, refreshToken, currentOrgId]);

  return state;
}
