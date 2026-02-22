import { useEffect, useRef, useState } from 'react';
import { apiLogout, fetchWithAuth, restoreAccessTokenFromCookie, useAuthStore } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';

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
    if (!isAuthenticated || !currentOrgId) {
      setIdleTimeoutMs(DEFAULT_IDLE_TIMEOUT_MS);
      return;
    }

    let cancelled = false;

    const loadOrgSessionTimeout = async () => {
      try {
        const response = await fetchWithAuth(`/orgs/organizations/${currentOrgId}`);
        if (!response.ok) {
          return;
        }
        const data = await response.json();
        const configuredMinutes = Number(data?.settings?.security?.sessionTimeout);
        if (!cancelled && Number.isFinite(configuredMinutes) && configuredMinutes > 0) {
          setIdleTimeoutMs(Math.max(1, configuredMinutes) * 60 * 1000);
        }
      } catch {
        // Keep current timeout fallback when org settings cannot be loaded.
      }
    };

    void loadOrgSessionTimeout();

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
          window.location.href = '/login';
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
