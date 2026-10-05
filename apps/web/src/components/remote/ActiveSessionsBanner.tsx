import { useEffect, useRef, useState } from 'react';
import { Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { resolvedFormattingLocale } from '../../lib/i18n/format';
import type { SessionType as RemoteSessionType } from './SessionHistory';
import '../../lib/i18n';

// Informational "someone else has a session here" banner for the device detail
// page. Reads GET /remote/devices/:id/active-sessions and shows other users'
// live sessions so a technician doesn't step over a colleague. It never blocks
// or ends anything.
//
// Why it polls: `remote.session.started` / `remote.session.ended` are declared
// in services/eventBus.ts but nothing publishes either, and a session ends on
// several paths (viewer close, agent disconnect, teardown, the zombie reaper,
// VNC relay close). Event-driven updates can follow once those publish.
//
// Until then: every 60s while the tab is visible, plus an immediate refresh when
// it becomes visible again or the page's device status changes. The server
// decides whether the device can host a session (it returns [] for an offline
// or stale-heartbeat device), so a stale client-side status never hides a real
// warning. Errors:
//   - the route's own 404 NOT_FOUND, a 403 ACCESS_DENIED (site gate), or a 403
//     with no code (missing remote:access / devices:read, or a disallowed token
//     scope): stop for good for this device, even across the page remounting
//     the banner.
//   - any other coded 403 (MFA_REQUIRED, ip_not_allowed, ...), which can clear
//     without leaving the page: stop the 60s poll and re-check when the tab
//     becomes visible again or the device status changes; a success resumes
//     normal polling. (The client can't pre-check the token's `mfa` claim: the
//     server also waives MFA when ENABLE_2FA is off, which the browser can't
//     see.)
//   - anything else (5xx, network, a 403/404 whose body isn't JSON, a router
//     miss): keep the last good list, so a single failed poll never hides a
//     real warning.

export const ACTIVE_SESSIONS_POLL_MS = 60_000;

type DisplayType = RemoteSessionType;
type ActiveSessionType = RemoteSessionType | 'vnc';
type ActiveSessionStatus = 'pending' | 'connecting' | 'active';

interface ActiveSession {
  type: ActiveSessionType;
  status: ActiveSessionStatus;
  /** Server-computed, so a skewed browser clock can't distort the duration. */
  elapsedSeconds: number;
  isCurrentUser: boolean;
  /** Opaque per-response key, one per distinct user (not a user id). */
  userKey: number;
  user: { name: string | null; email: string | null };
}

interface Props {
  deviceId: string;
  /** The page's live device status; a change triggers an immediate refresh. */
  deviceStatus?: string;
}

type Denial = 'permanent' | 'paused' | null;

// Devices permanently denied on the current page. Module-level so it survives
// the device page remounting the banner (it renders a spinner while refetching
// the device), and cleared on every client-side navigation (sign-out, sign-in,
// org switch are all soft swaps), so one user's denial never silences the
// banner for the next person on the same tab.
const permanentlyDenied = new Set<string>();
if (typeof document !== 'undefined') {
  document.addEventListener('astro:after-swap', () => permanentlyDenied.clear());
}

async function denialKind(res: Response): Promise<Denial> {
  if (res.status !== 403 && res.status !== 404) return null;
  let body: unknown;
  try {
    body = await res.clone().json();
  } catch {
    // Not the API's JSON (e.g. an edge/proxy error page): says nothing about
    // this route, so treat it as transient.
    return null;
  }
  if (!body || typeof body !== 'object') return null;
  const rawCode = (body as { code?: unknown }).code;
  const code = typeof rawCode === 'string' ? rawCode : undefined;
  // Only the route's own 404 is permanent; a router miss (e.g. an older API
  // without this route during a rolling update) is treated as transient.
  if (res.status === 404) return code === 'NOT_FOUND' ? 'permanent' : null;
  // No code: the permission/scope gates. ACCESS_DENIED: the route's site gate.
  if (code === undefined || code === 'ACCESS_DENIED') return 'permanent';
  return 'paused';
}

export default function ActiveSessionsBanner({ deviceId, deviceStatus }: Props) {
  const { t } = useTranslation('remote');
  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  const hadRowsRef = useRef(false);
  useEffect(() => {
    if (permanentlyDenied.has(deviceId)) return;

    let cancelled = false;
    let latestRequest = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    const startPolling = () => {
      if (timer === undefined) timer = setInterval(() => void load(), ACTIVE_SESSIONS_POLL_MS);
    };
    const stopPolling = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    };

    const load = async () => {
      if (cancelled || document.visibilityState === 'hidden') return;
      // Only the newest request may update state, so a slow poll can't
      // overwrite a fresher visibility-triggered one.
      const request = ++latestRequest;
      try {
        const res = await fetchWithAuth(`/remote/devices/${deviceId}/active-sessions`);
        if (cancelled || request !== latestRequest) return;
        if (!res.ok) {
          const denial = await denialKind(res);
          if (cancelled || request !== latestRequest || !denial) return;
          // Hidden because of the denial, not because everyone left: don't
          // announce the device as free.
          hadRowsRef.current = false;
          setSessions([]);
          stopPolling();
          if (denial === 'permanent') {
            permanentlyDenied.add(deviceId);
            document.removeEventListener('visibilitychange', onVisibilityChange);
          }
          // Paused (e.g. MFA_REQUIRED): the tab-visible listener stays, so
          // returning to the tab re-checks once and a success resumes polling.
          return;
        }
        const body = (await res.json()) as { data?: ActiveSession[] };
        if (cancelled || request !== latestRequest) return;
        setSessions(Array.isArray(body.data) ? body.data : []);
        startPolling(); // resumes the 60s poll after a pause
      } catch {
        // Transient (network) failure: keep the last good list.
      }
    };

    function onVisibilityChange() {
      if (document.visibilityState === 'visible') void load();
    }

    document.addEventListener('visibilitychange', onVisibilityChange);
    startPolling();
    void load();
    return () => {
      cancelled = true;
      stopPolling();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [deviceId, deviceStatus]);

  // One row per OTHER user (a colleague with desktop + terminal open is one
  // person). A user with any active session shows their active session types
  // and the time since the longest-running one; a user whose sessions are all
  // still coming up shows as connecting.
  const users = new Map<
    number,
    { label: string; activeTypes: DisplayType[]; connectingTypes: DisplayType[]; elapsedSeconds: number }
  >();
  for (const s of sessions) {
    if (s.isCurrentUser) continue;
    let entry = users.get(s.userKey);
    if (!entry) {
      entry = {
        label: s.user.name || s.user.email || t('activeSessionsBanner.unknownUser'),
        activeTypes: [],
        connectingTypes: [],
        elapsedSeconds: 0,
      };
      users.set(s.userKey, entry);
    }
    // VNC is screen access too: show it as Desktop, not a separate kind.
    const type: DisplayType = s.type === 'vnc' ? 'desktop' : s.type;
    if (s.status === 'active') {
      if (!entry.activeTypes.includes(type)) entry.activeTypes.push(type);
      entry.elapsedSeconds = Math.max(entry.elapsedSeconds, s.elapsedSeconds);
    } else if (!entry.connectingTypes.includes(type)) {
      entry.connectingTypes.push(type);
    }
  }

  // Same labels as Session History, so the two screens read identically.
  const typeLabels: Record<DisplayType, string> = {
    desktop: t('sessionHistory.types.desktop'),
    terminal: t('sessionHistory.types.terminal'),
    file_transfer: t('sessionHistory.types.fileTransfer'),
  };
  const listFormat = new Intl.ListFormat(resolvedFormattingLocale(), { style: 'long', type: 'conjunction' });
  // `?? type` keeps an unknown future type from throwing in ListFormat.
  const formatTypes = (types: DisplayType[]) => listFormat.format(types.map((type) => typeLabels[type] ?? type));
  const formatDuration = (seconds: number) => {
    const total = Math.max(0, Math.floor(seconds / 60));
    if (total < 1) return t('activeSessionsBanner.duration.lessThanMinute');
    if (total < 60) return t('activeSessionsBanner.duration.minutes', { count: total });
    const hours = Math.floor(total / 60);
    const minutes = total % 60;
    if (minutes === 0) return t('activeSessionsBanner.duration.hours', { count: hours });
    return t('activeSessionsBanner.duration.hoursMinutes', { hours, minutes });
  };

  const collator = new Intl.Collator(resolvedFormattingLocale());
  const rows = [...users.entries()].sort(([, a], [, b]) => collator.compare(a.label, b.label)).map(([key, u]) => ({
    key,
    name: u.label,
    text:
      u.activeTypes.length > 0
        ? t('activeSessionsBanner.session', {
            name: u.label,
            type: formatTypes(u.activeTypes),
            duration: formatDuration(u.elapsedSeconds),
          })
        : t('activeSessionsBanner.sessionConnecting', { name: u.label, type: formatTypes(u.connectingTypes) }),
  }));
  const title = rows.length > 0 ? t('activeSessionsBanner.title', { count: rows.length }) : '';
  // Screen-reader text: who is here, never per-minute durations, so a poll that
  // only changes "12 min" to "13 min" is silent. Announces the device becoming
  // free, but not an empty initial state.
  if (rows.length > 0) hadRowsRef.current = true;
  const announcement =
    rows.length > 0
      ? t('activeSessionsBanner.announcement', { count: rows.length, names: listFormat.format(rows.map((r) => r.name)) })
      : hadRowsRef.current
        ? t('activeSessionsBanner.announcementNone')
        : '';

  return (
    <>
      {/* Always mounted, so screen readers announce a colleague arriving or
          leaving, not every poll. */}
      <div role="status" className="sr-only" data-testid="device-active-sessions-live">
        {announcement}
      </div>
      {rows.length > 0 && (
        <div
          data-testid="device-active-sessions-banner"
          className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-foreground"
        >
          <Users className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
          <div>
            <p className="font-medium">{title}</p>
            <ul className="mt-0.5">
              {rows.map((r) => (
                <li key={r.key} data-testid={`device-active-session-row-${r.key}`}>
                  {r.text}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
