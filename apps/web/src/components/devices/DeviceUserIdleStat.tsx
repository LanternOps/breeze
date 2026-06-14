import { useState, useEffect, useCallback } from 'react';
import { Timer } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

export type ActiveSession = {
  id: string;
  username: string;
  sessionType: 'console' | 'rdp' | 'ssh' | 'other' | null;
  osSessionId: string | null;
  loginAt: string | null;
  idleMinutes: number | null;
  activityState: 'active' | 'idle' | 'locked' | 'away' | 'disconnected' | null;
  lastActivityAt: string | null;
  updatedAt: string | null;
};

// The session that best represents "the user at this device": the console
// session when present, otherwise the least-idle active session.
export function selectIdleSession(sessions: ActiveSession[]): ActiveSession | null {
  if (sessions.length === 0) return null;
  const consoleSession = sessions.find((s) => s.sessionType === 'console');
  if (consoleSession) return consoleSession;
  return [...sessions].sort(
    (a, b) => (a.idleMinutes ?? Number.POSITIVE_INFINITY) - (b.idleMinutes ?? Number.POSITIVE_INFINITY)
  )[0];
}

export function formatIdle(session: ActiveSession | null): string {
  if (!session) return '—';
  if (session.activityState === 'locked') return 'Locked';
  if (session.idleMinutes === null || session.idleMinutes === undefined) return '—';
  if (session.idleMinutes < 1) return 'Active';
  const hours = Math.floor(session.idleMinutes / 60);
  const minutes = Math.floor(session.idleMinutes % 60);
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

function tooltip(sessions: ActiveSession[]): string | undefined {
  if (sessions.length === 0) return undefined;
  const lines = sessions.map(
    (s) => `${s.username} (${s.sessionType ?? 'unknown'}): ${formatIdle(s)}`
  );
  const updatedAt = sessions
    .map((s) => s.updatedAt)
    .filter((v): v is string => Boolean(v))
    .sort()
    .pop();
  if (updatedAt) {
    const d = new Date(updatedAt);
    if (!isNaN(d.getTime())) {
      lines.push(`As of ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
    }
  }
  return lines.join('\n');
}

type DeviceUserIdleStatProps = {
  deviceId: string;
};

export default function DeviceUserIdleStat({ deviceId }: DeviceUserIdleStatProps) {
  const [sessions, setSessions] = useState<ActiveSession[]>([]);
  const [error, setError] = useState(false);

  const fetchSessions = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetchWithAuth(`/devices/${deviceId}/sessions/active`);
      if (signal?.aborted) return;
      if (!res.ok) {
        setError(true);
        return;
      }
      const body = await res.json();
      if (signal?.aborted) return;
      setSessions(body?.data?.activeUsers ?? []);
      setError(false);
    } catch {
      if (!signal?.aborted) setError(true);
    }
  }, [deviceId]);

  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    void fetchSessions(controller.signal);
    return () => controller.abort();
  }, [fetchSessions]);

  const selected = selectIdleSession(sessions);

  return (
    <div>
      <div className="flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-muted-foreground">
        <Timer className="h-3.5 w-3.5" />
        User Idle
      </div>
      {error ? (
        // Distinct from the legitimate "—" empty state: a fetch failure is
        // interactive (click to retry) and labelled, so a tech can tell
        // "no active session" apart from "couldn't load".
        <button
          type="button"
          onClick={() => { setError(false); void fetchSessions(); }}
          title="Couldn't load idle status — click to retry"
          aria-label="Couldn't load idle status — retry"
          className="mt-1 text-lg font-semibold text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground"
        >
          —
        </button>
      ) : (
        <p className="mt-1 text-lg font-semibold" title={tooltip(sessions)}>
          {formatIdle(selected)}
        </p>
      )}
    </div>
  );
}
