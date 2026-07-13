import { useEffect, useRef, useState } from 'react';
import { apiLogout, fetchWithAuth, restoreAccessTokenFromCookie, useAuthStore } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { navigateTo } from '../../lib/navigation';

const DEFAULT_IDLE_TIMEOUT_MINUTES = 60;
const DEFAULT_REFRESH_INTERVAL_MINUTES = 5;

const rawIdleTimeoutMinutes = Number(import.meta.env.PUBLIC_IDLE_TIMEOUT_MINUTES);
const rawRefreshIntervalMinutes = Number(import.meta.env.PUBLIC_SESSION_REFRESH_INTERVAL_MINUTES);

const IDLE_TIMEOUT_MINUTES = Number.isFinite(rawIdleTimeoutMinutes) && rawIdleTimeoutMinutes > 0
  ? rawIdleTimeoutMinutes
  : DEFAULT_IDLE_TIMEOUT_MINUTES;

const REFRESH_INTERVAL_MINUTES = Number.isFinite(rawRefreshIntervalMinutes) && rawRefreshIntervalMinutes > 0
  ? rawRefreshIntervalMinutes
  : DEFAULT_REFRESH_INTERVAL_MINUTES;

const DEFAULT_IDLE_TIMEOUT_MS = Math.max(1, IDLE_TIMEOUT_MINUTES) * 60 * 1000;
const REFRESH_INTERVAL_MS = Math.max(1, REFRESH_INTERVAL_MINUTES) * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 30 * 1000;

const ACTIVITY_EVENTS: ReadonlyArray<keyof WindowEventMap> = [
  'mousemove',
  'mousedown',
  'keydown',
  'scroll',
  'touchstart',
  'focus'
];

export default function AdminSessionManager() {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const currentOrgId = useOrgStore((state) => state.currentOrgId);
  const [idleTimeoutMs, setIdleTimeoutMs] = useState(DEFAULT_IDLE_TIMEOUT_MS);
  // Last budget we actually READ from the server, for any scope. Used only as a
  // clamp when a later lookup fails — see settleTimeout.
  const lastKnownBudgetMsRef = useRef<number | null>(null);
  const lastActivityAtRef = useRef<number>(Date.now());
  const lastRefreshAtRef = useRef<number>(0);
  const refreshInFlightRef = useRef(false);
  const idleLogoutInFlightRef = useRef(false);

  useEffect(() => {
    if (!isAuthenticated) {
      lastActivityAtRef.current = Date.now();
      lastRefreshAtRef.current = 0;
      return;
    }

    const markActivity = () => {
      lastActivityAtRef.current = Date.now();
    };

    for (const eventName of ACTIVITY_EVENTS) {
      window.addEventListener(eventName, markActivity, { passive: true });
    }
    document.addEventListener('visibilitychange', markActivity);

    return () => {
      for (const eventName of ACTIVITY_EVENTS) {
        window.removeEventListener(eventName, markActivity);
      }
      document.removeEventListener('visibilitychange', markActivity);
    };
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated) {
      setIdleTimeoutMs(DEFAULT_IDLE_TIMEOUT_MS);
      return;
    }

    let cancelled = false;

    // The scope just changed (or we just mounted), so whatever budget is in
    // state belongs to the PREVIOUS scope. Drop back to the frontend default
    // until the new scope's budget lands — otherwise a 5-minute org budget
    // stays armed against a partner admin who just switched to All Orgs and
    // logs them out moments later (#2429).
    //
    // Deliberately a reset-to-default and NOT a "park enforcement until this
    // resolves" flag: a settings fetch that never settles (hung connection)
    // would then disable idle logout for the whole session. Always enforcing
    // *some* budget fails safe. The default is only ever in force for the
    // duration of the refetch, and a scope switch is itself user activity, so
    // the idle clock is at ~0 across that window anyway.
    setIdleTimeoutMs(DEFAULT_IDLE_TIMEOUT_MS);

    /**
     * Apply the timeout for this scope. `configuredMinutes` is null when the
     * lookup failed.
     *
     * On failure we do NOT simply leave the frontend default in force: that
     * would RELAX a stricter policy (an org mandating a 5-minute idle timeout
     * whose settings fetch blips would silently get a 60-minute window — a 12x
     * loosening of a compliance control). Instead we clamp to the shortest
     * budget we have any evidence for. Erring shorter logs a user out early at
     * worst; erring longer leaves an unattended session open. (#2429)
     */
    const settleTimeout = (configuredMinutes: number | null) => {
      if (cancelled) return;
      if (configuredMinutes !== null && Number.isFinite(configuredMinutes) && configuredMinutes > 0) {
        const ms = Math.max(1, configuredMinutes) * 60 * 1000;
        lastKnownBudgetMsRef.current = ms;
        setIdleTimeoutMs(ms);
        return;
      }
      const lastKnown = lastKnownBudgetMsRef.current;
      setIdleTimeoutMs(
        lastKnown === null
          ? DEFAULT_IDLE_TIMEOUT_MS
          : Math.min(DEFAULT_IDLE_TIMEOUT_MS, lastKnown),
      );
    };

    const loadSessionTimeout = async () => {
      try {
        if (currentOrgId) {
          // Org selected: use that org's effective settings so a partner-level
          // `security.sessionTimeout` default is honored by the idle-logout
          // runtime, matching what the settings UI shows as effective/locked.
          // Reading the raw org record missed partner defaults the org hadn't
          // overridden locally (#2147).
          const response = await fetchWithAuth(
            `/orgs/organizations/${currentOrgId}/effective-settings`
          );
          if (!response.ok) {
            // Surface the failure: this is the path that enforces a possibly
            // partner-locked idle timeout, so a silent fall-back to the frontend
            // default must at least be diagnosable (matches OrgSettingsPage).
            console.warn(
              '[AdminSessionManager] Failed to load effective session timeout:',
              response.status
            );
            settleTimeout(null);
            return;
          }
          const data = await response.json();
          settleTimeout(Number(data?.effective?.security?.sessionTimeout));
          return;
        }

        // All Organizations mode intentionally sets `currentOrgId` to `null`.
        // The idle timeout is a property of the authenticated user's partner,
        // not of whichever org is selected for viewing data, so fall back to the
        // partner-level security policy. Without this the timer silently reset to
        // the 60-minute frontend default whenever no org was selected, logging a
        // partner admin out early despite a longer configured timeout (#2347).
        const response = await fetchWithAuth('/orgs/partners/me');
        if (!response.ok) {
          console.warn(
            '[AdminSessionManager] Failed to load partner session timeout:',
            response.status
          );
          settleTimeout(null);
          return;
        }
        const data = await response.json();
        settleTimeout(Number(data?.settings?.security?.sessionTimeout));
      } catch (err) {
        // Fall back to the frontend default — NOT to the previous scope's
        // budget, which is what `idleTimeoutMs` would otherwise still hold.
        console.warn('[AdminSessionManager] Error loading session timeout:', err);
        settleTimeout(null);
      }
    };

    void loadSessionTimeout();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, currentOrgId]);

  useEffect(() => {
    if (!isAuthenticated) return;

    let cancelled = false;

    const runHeartbeat = async () => {
      if (cancelled || idleLogoutInFlightRef.current) return;

      const now = Date.now();
      const idleMs = now - lastActivityAtRef.current;

      if (idleMs >= idleTimeoutMs) {
        idleLogoutInFlightRef.current = true;
        await apiLogout();
        if (!cancelled) {
          await navigateTo('/login', { replace: true });
        }
        return;
      }

      if (document.visibilityState !== 'visible') {
        return;
      }

      if (now - lastRefreshAtRef.current < REFRESH_INTERVAL_MS) {
        return;
      }

      if (refreshInFlightRef.current) {
        return;
      }

      refreshInFlightRef.current = true;
      try {
        const restored = await restoreAccessTokenFromCookie();
        if (restored) {
          lastRefreshAtRef.current = Date.now();
        }
      } finally {
        refreshInFlightRef.current = false;
      }
    };

    void runHeartbeat();
    const timer = window.setInterval(() => {
      void runHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [isAuthenticated, idleTimeoutMs]);

  return null;
}
