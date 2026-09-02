import { useCallback, useEffect, useRef, useState } from 'react';
import {
  apiLogout,
  fetchWithAuth,
  handleSessionExpired,
  restoreAccessTokenFromCookieDetailed,
  useAuthStore
} from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import IdleWarningDialog from './IdleWarningDialog';

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
const IDLE_WARNING_LEAD_MS = 2 * 60 * 1000;
const COUNTDOWN_TICK_MS = 1000;

// Passive signals keep an unattended session alive during normal use, but once
// the warning is up they must not answer it on the user's behalf: a drifting
// mouse, an auto-scrolling page or a tab regaining focus is not a person at the
// keyboard. Only deliberate input (or the modal's button) may extend the
// session from that point.
const PASSIVE_ACTIVITY_EVENTS: ReadonlyArray<keyof WindowEventMap> = [
  'mousemove',
  'scroll',
  'focus'
];

const DELIBERATE_ACTIVITY_EVENTS: ReadonlyArray<keyof WindowEventMap> = [
  'mousedown',
  'keydown',
  'touchstart'
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
  const [warningVisible, setWarningVisible] = useState(false);
  const [warningRemainingMs, setWarningRemainingMs] = useState(0);
  const [signingOut, setSigningOut] = useState(false);
  // Mirrors `warningVisible` for the window event handlers, which are
  // registered once per authenticated session and would otherwise close over a
  // stale value.
  const warningVisibleRef = useRef(false);

  /** Keepalive refresh. Shared by the heartbeat and the "Stay signed in" path. */
  const refreshAccessToken = useCallback(async () => {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    try {
      const outcome = await restoreAccessTokenFromCookieDetailed();
      if (outcome === 'restored') {
        lastRefreshAtRef.current = Date.now();
      } else if (outcome === 'auth-failed' || outcome === 'origin-rejected') {
        // The refresh endpoint reached a verdict: the session is
        // unrecoverable. Stand the heartbeat down before evicting so no
        // later tick fires a redundant refresh against a dead cookie.
        //
        // 'origin-rejected' evicts identically but carries its own reason to
        // /login: the API refused this browser's Origin, so the sign-in page
        // must explain the CORS/PUBLIC_APP_URL mismatch instead of claiming the
        // session expired.
        idleLogoutInFlightRef.current = true;
        handleSessionExpired(outcome === 'origin-rejected' ? 'origin-rejected' : 'session-expired');
      }
      // 'transient': no verdict on the cookie (network/5xx blip) — do
      // nothing. lastRefreshAtRef stays stale so the next 30s heartbeat
      // retries; an offline user (e.g. on a plane) must NOT be logged out.
    } finally {
      refreshInFlightRef.current = false;
    }
  }, []);

  const runIdleLogout = useCallback(async () => {
    if (idleLogoutInFlightRef.current) return;
    idleLogoutInFlightRef.current = true;
    setSigningOut(true);
    // Order matters: apiLogout revokes the refresh-token family server-side and
    // needs the Bearer/localStorage state that handleSessionExpired's logout()
    // clears.
    await apiLogout();
    handleSessionExpired('idle');
  }, []);

  const dismissWarning = useCallback(() => {
    if (!warningVisibleRef.current || idleLogoutInFlightRef.current) return;
    warningVisibleRef.current = false;
    setWarningVisible(false);
    lastActivityAtRef.current = Date.now();
    // Belt-and-braces freshness on an explicit continue. The token has NOT
    // necessarily gone stale — the 5-minute keepalive is visibility-gated, not
    // activity-gated, so a visible-but-idle tab has been refreshing it all
    // along; a backgrounded tab has not. Refresh unconditionally rather than
    // reason about which case we're in.
    void refreshAccessToken();
  }, [refreshAccessToken]);

  useEffect(() => {
    if (!isAuthenticated) {
      lastActivityAtRef.current = Date.now();
      lastRefreshAtRef.current = 0;
      warningVisibleRef.current = false;
      setWarningVisible(false);
      setSigningOut(false);
      // Currently unreachable-harmful: every eviction path (idle logout,
      // session-expired) ends in a full-page location.replace, so this ref
      // never survives to be read stale. Reset anyway so a future eviction
      // path that stays client-side-only isn't silently blocked from
      // retrying idle logout.
      idleLogoutInFlightRef.current = false;
      return;
    }

    const markActivity = () => {
      lastActivityAtRef.current = Date.now();
    };

    const handlePassiveActivity = () => {
      if (warningVisibleRef.current) return;
      markActivity();
    };

    const handleDeliberateActivity = () => {
      if (warningVisibleRef.current) {
        dismissWarning();
        return;
      }
      markActivity();
    };

    for (const eventName of PASSIVE_ACTIVITY_EVENTS) {
      window.addEventListener(eventName, handlePassiveActivity, { passive: true });
    }
    for (const eventName of DELIBERATE_ACTIVITY_EVENTS) {
      window.addEventListener(eventName, handleDeliberateActivity, { passive: true });
    }
    document.addEventListener('visibilitychange', handlePassiveActivity);

    return () => {
      for (const eventName of PASSIVE_ACTIVITY_EVENTS) {
        window.removeEventListener(eventName, handlePassiveActivity);
      }
      for (const eventName of DELIBERATE_ACTIVITY_EVENTS) {
        window.removeEventListener(eventName, handleDeliberateActivity);
      }
      document.removeEventListener('visibilitychange', handlePassiveActivity);
    };
  }, [isAuthenticated, dismissWarning]);

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
        await runIdleLogout();
        return;
      }

      // Never warn for more than half the budget: a 2-minute org policy would
      // otherwise raise the modal the moment the session starts.
      const leadMs = Math.min(IDLE_WARNING_LEAD_MS, idleTimeoutMs / 2);
      if (idleMs >= idleTimeoutMs - leadMs) {
        warningVisibleRef.current = true;
        setWarningVisible(true);
        setWarningRemainingMs(idleTimeoutMs - idleMs);
      }

      if (document.visibilityState !== 'visible') {
        return;
      }

      if (now - lastRefreshAtRef.current < REFRESH_INTERVAL_MS) {
        return;
      }

      await refreshAccessToken();
    };

    void runHeartbeat();
    const timer = window.setInterval(() => {
      void runHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [isAuthenticated, idleTimeoutMs, refreshAccessToken, runIdleLogout]);

  // The 30s heartbeat raises the warning; this drives the visible countdown and
  // owns expiry, so the logout lands on the second the countdown shows 0:00
  // rather than up to a heartbeat later.
  useEffect(() => {
    if (!warningVisible) return;

    const tick = () => {
      if (idleLogoutInFlightRef.current) return;
      const remainingMs = idleTimeoutMs - (Date.now() - lastActivityAtRef.current);
      setWarningRemainingMs(Math.max(0, remainingMs));
      if (remainingMs <= 0) {
        void runIdleLogout();
      }
    };

    const timer = window.setInterval(tick, COUNTDOWN_TICK_MS);
    return () => window.clearInterval(timer);
  }, [warningVisible, idleTimeoutMs, runIdleLogout]);

  if (!warningVisible) return null;

  return (
    <IdleWarningDialog
      remainingMs={warningRemainingMs}
      signingOut={signingOut}
      onStay={dismissWarning}
    />
  );
}
