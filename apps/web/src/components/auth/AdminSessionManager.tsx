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
  // False while the effective timeout for the CURRENT scope is still in flight.
  // Scope switches (All Orgs ↔ org) refetch asynchronously, and until that lands
  // `idleTimeoutMs` still holds the PREVIOUS scope's budget — enforcing it would
  // let a 5-minute org timeout idle-log-out a partner admin who just switched to
  // All Orgs. The heartbeat therefore skips idle logout until this resolves.
  const [idleTimeoutResolved, setIdleTimeoutResolved] = useState(false);
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
      setIdleTimeoutResolved(false);
      return;
    }

    let cancelled = false;

    // The scope just changed (or we just mounted), so whatever is in state
    // belongs to the previous scope. Park enforcement and drop back to the
    // frontend default until the new scope's budget lands, so a stale — possibly
    // much shorter — budget can never be applied to the new scope (#2429).
    setIdleTimeoutResolved(false);
    setIdleTimeoutMs(DEFAULT_IDLE_TIMEOUT_MS);

    /**
     * Settle the timeout for this scope. `configuredMinutes` is null when the
     * lookup failed, which keeps the frontend default. EVERY path must call
     * this: leaving `idleTimeoutResolved` false would park idle logout forever
     * and turn a failed settings fetch into a session that never times out.
     */
    const settleTimeout = (configuredMinutes: number | null) => {
      if (cancelled) return;
      if (configuredMinutes !== null && Number.isFinite(configuredMinutes) && configuredMinutes > 0) {
        setIdleTimeoutMs(Math.max(1, configuredMinutes) * 60 * 1000);
      }
      setIdleTimeoutResolved(true);
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

      // Never idle-log-out against a budget we haven't confirmed for the current
      // scope — mid-switch that value belongs to the scope we just left (#2429).
      if (idleTimeoutResolved && idleMs >= idleTimeoutMs) {
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
  }, [isAuthenticated, idleTimeoutMs, idleTimeoutResolved]);

  return null;
}
