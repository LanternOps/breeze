import { useEffect, useState } from 'react';
import type { DesktopAccessState, RemoteAccessPolicy } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { asList } from '@/lib/asList';
import { selectIdleSession, type ActiveSession } from '../devices/DeviceUserIdleStat';

/** The GET /devices/:id fields this panel reads (PUBLIC_DEVICE_FIELDS). */
export interface EndpointDevice {
  id: string;
  hostname: string | null;
  displayName: string | null;
  status: string | null;
  osType: string | null;
  osVersion: string | null;
  lastSeenAt: string | null;
  lastUser: string | null;
  uptimeSeconds: number | null;
  pendingReboot: boolean;
  desktopAccess: DesktopAccessState | null;
  isHeadless: boolean;
  remoteAccessPolicy: RemoteAccessPolicy | null;
  helperLifecycleMode: 'always-on' | 'on-demand' | null;
}

export type ActiveAlert = { id: string; title: string; severity: string };

export type DeviceState =
  | { kind: 'loading' }
  | { kind: 'ready'; device: EndpointDevice }
  | { kind: 'denied' } // 403/404: show what the ticket already knows (the hostname)
  | { kind: 'failed' };

export interface TicketEndpoint {
  state: DeviceState;
  /** null until read; `value` null = nobody signed in. */
  session: { value: ActiveSession | null; failed: boolean } | null;
  alerts: ActiveAlert[] | 'failed' | null;
}

function toDevice(raw: Record<string, unknown>): EndpointDevice | null {
  if (typeof raw?.id !== 'string' || raw.id.length === 0) return null;
  const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null);
  const mode = raw.helperLifecycleMode;
  return {
    id: raw.id,
    hostname: str(raw.hostname),
    displayName: str(raw.displayName),
    status: str(raw.status),
    osType: str(raw.osType),
    osVersion: str(raw.osVersion),
    lastSeenAt: str(raw.lastSeenAt),
    lastUser: str(raw.lastUser),
    uptimeSeconds: typeof raw.uptimeSeconds === 'number' ? raw.uptimeSeconds : null,
    pendingReboot: raw.pendingReboot === true,
    desktopAccess: (raw.desktopAccess as DesktopAccessState | null | undefined) ?? null,
    isHeadless: raw.isHeadless === true,
    remoteAccessPolicy: (raw.remoteAccessPolicy as RemoteAccessPolicy | null | undefined) ?? null,
    helperLifecycleMode: mode === 'always-on' || mode === 'on-demand' ? mode : null,
  };
}

/**
 * The live state of a ticket's device: GET /devices/:id, then (only once that
 * answered) the signed-in session and up to three active alerts. Needs
 * devices:read (`enabled`); a 403/404 becomes `denied`, never a fan-out of
 * refusals.
 */
export function useTicketEndpoint(deviceId: string | null, enabled: boolean): TicketEndpoint {
  const [state, setState] = useState<DeviceState>({ kind: 'loading' });
  const [session, setSession] = useState<{ value: ActiveSession | null; failed: boolean } | null>(null);
  const [alerts, setAlerts] = useState<ActiveAlert[] | 'failed' | null>(null);

  useEffect(() => {
    if (!deviceId || !enabled) return;
    let cancelled = false;
    setState({ kind: 'loading' });
    setSession(null);
    setAlerts(null);
    void (async () => {
      try {
        const res = await fetchWithAuth(`/devices/${deviceId}`);
        if (cancelled) return;
        if (res.status === 403 || res.status === 404) { setState({ kind: 'denied' }); return; }
        if (!res.ok) { setState({ kind: 'failed' }); return; }
        const device = toDevice((await res.json()) as Record<string, unknown>);
        if (cancelled) return;
        if (!device) { setState({ kind: 'failed' }); return; }
        setState({ kind: 'ready', device });
      } catch {
        if (!cancelled) setState({ kind: 'failed' });
      }
    })();
    return () => { cancelled = true; };
  }, [deviceId, enabled]);

  // Who is signed in and what is alerting: read only once the device itself
  // answered, so a 403 never fans out into two more refusals.
  const readyId = state.kind === 'ready' ? state.device.id : null;
  useEffect(() => {
    if (!readyId) return;
    let cancelled = false;
    void fetchWithAuth(`/devices/${readyId}/sessions/active`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { data?: { activeUsers?: ActiveSession[] } };
        if (!cancelled) setSession({ value: selectIdleSession(body?.data?.activeUsers ?? []), failed: false });
      })
      .catch(() => { if (!cancelled) setSession({ value: null, failed: true }); });
    void fetchWithAuth(`/devices/${readyId}/alerts?status=active&limit=3`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = asList(await res.json(), 'data') as Array<Record<string, unknown>>;
        const list = raw
          .filter((a) => typeof a?.id === 'string')
          .map((a) => ({
            id: a.id as string,
            // '' = untitled; the renderer supplies the localized fallback.
            title: String(a.title || a.message || a.summary || ''),
            severity: String(a.severity || 'info').toLowerCase(),
          }));
        if (!cancelled) setAlerts(list.slice(0, 3));
      })
      // Never "No active alerts" on a failed read: a false all-clear is the
      // worst answer on a triage surface.
      .catch(() => { if (!cancelled) setAlerts('failed'); });
    return () => { cancelled = true; };
  }, [readyId]);

  return { state, session, alerts };
}
