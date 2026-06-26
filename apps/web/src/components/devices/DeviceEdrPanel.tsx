import { useCallback, useEffect, useState } from 'react';
import { Loader2, ShieldAlert, Activity } from 'lucide-react';
import { formatDateTime as formatUserDateTime } from '@/lib/dateTimeFormat';
import { friendlyFetchError } from '../../lib/utils';
import {
  fetchS1Threats,
  fetchHuntressIncidents,
  isolateDevice,
  runS1ThreatAction,
  type S1Threat,
  type HuntressIncident,
  type S1ThreatActionType,
} from '../../lib/edr';
import { ActionError } from '../../lib/runAction';

const severityBadge: Record<string, string> = {
  low: 'bg-blue-500/20 text-blue-700 border-blue-500/30',
  medium: 'bg-yellow-500/20 text-yellow-800 border-yellow-500/40',
  high: 'bg-orange-500/20 text-orange-700 border-orange-500/40',
  critical: 'bg-red-500/20 text-red-700 border-red-500/40',
};

function sevClass(sev: string | null): string {
  return severityBadge[(sev ?? '').toLowerCase()] ?? 'bg-muted text-muted-foreground border-border';
}

function fmt(value: string | null, timezone?: string): string {
  if (!value) return '-';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '-' : formatUserDateTime(d, timezone ? { timeZone: timezone } : undefined);
}

type Props = { deviceId: string; orgId: string; timezone?: string };

export default function DeviceEdrPanel({ deviceId, orgId, timezone }: Props) {
  const [threats, setThreats] = useState<S1Threat[]>([]);
  const [incidents, setIncidents] = useState<HuntressIncident[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [confirmIsolate, setConfirmIsolate] = useState(false);
  const [isolating, setIsolating] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [s1, hi] = await Promise.all([
        fetchS1Threats(orgId, deviceId),
        fetchHuntressIncidents(orgId, deviceId),
      ]);
      setThreats(s1);
      setIncidents(hi);
    } catch (err) {
      setError(friendlyFetchError(err));
    } finally {
      setLoading(false);
    }
  }, [orgId, deviceId]);

  const doIsolate = async () => {
    setIsolating(true);
    try {
      await isolateDevice(orgId, deviceId, true);
      setConfirmIsolate(false);
      await load();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      // non-401 ActionError already toasted by runAction
    } finally {
      setIsolating(false);
    }
  };

  const doThreatAction = async (threatId: string, action: S1ThreatActionType) => {
    setActingId(threatId);
    try {
      await runS1ThreatAction(orgId, threatId, action);
      await load();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
    } finally {
      setActingId(null);
    }
  };

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="rounded-lg border bg-card p-6 shadow-sm" data-testid="device-edr-panel">
      <div className="mb-4 flex items-center gap-2">
        <ShieldAlert className="h-4 w-4 text-primary" />
        <h3 className="text-lg font-semibold">Endpoint Protection (EDR)</h3>
        <button
          type="button"
          data-testid="edr-isolate-btn"
          onClick={() => setConfirmIsolate(true)}
          className="ml-auto inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
        >
          Isolate device
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* SentinelOne threats */}
        <div>
          <h4 className="mb-3 text-sm font-semibold">SentinelOne Threats</h4>
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
          ) : threats.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="edr-s1-empty">No SentinelOne threats for this device.</p>
          ) : (
            <div className="space-y-3">
              {threats.map((t) => (
                <div key={t.id} className="rounded-md border bg-background p-3" data-testid="edr-s1-row">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium">{t.threatName}</p>
                    <div className="flex items-center gap-2">
                      <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${sevClass(t.severity)}`}>{t.severity ?? 'unknown'}</span>
                      <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold bg-muted text-muted-foreground border-border">{t.status}</span>
                    </div>
                  </div>
                  {t.filePath && <p className="mt-1 text-xs text-muted-foreground" title={t.filePath}>{t.filePath}</p>}
                  <p className="mt-1 text-xs text-muted-foreground">Detected: {fmt(t.detectedAt, timezone)}</p>
                  {t.status === 'active' && (
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {(['kill', 'quarantine', 'rollback'] as const).map((action) => (
                        <button
                          key={action}
                          type="button"
                          data-testid={`edr-threat-${action}-${t.id}`}
                          onClick={() => doThreatAction(t.id, action)}
                          disabled={actingId === t.id}
                          className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium capitalize hover:bg-muted disabled:opacity-60"
                        >
                          {actingId === t.id && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{action}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Huntress incidents (read-only this pillar) */}
        <div>
          <h4 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Activity className="h-4 w-4" />Huntress Incidents</h4>
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
          ) : incidents.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="edr-huntress-empty">No Huntress incidents for this device.</p>
          ) : (
            <div className="space-y-3">
              {incidents.map((i) => (
                <div key={i.id} className="rounded-md border bg-background p-3" data-testid="edr-huntress-row">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium">{i.title}</p>
                    <div className="flex items-center gap-2">
                      <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${sevClass(i.severity)}`}>{i.severity}</span>
                      <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold bg-muted text-muted-foreground border-border">{i.status}</span>
                    </div>
                  </div>
                  {i.recommendation && <p className="mt-1 text-xs text-muted-foreground">{i.recommendation}</p>}
                  <p className="mt-1 text-xs text-muted-foreground">Reported: {fmt(i.reportedAt, timezone)}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {confirmIsolate && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="edr-isolate-dialog-title"
        >
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-lg">
            <h4 id="edr-isolate-dialog-title" className="text-base font-semibold">Isolate this device?</h4>
            <p className="mt-2 text-sm text-muted-foreground">
              SentinelOne will cut the device off the network until you remove isolation. Active sessions will drop.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirmIsolate(false)} className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted">Cancel</button>
              <button
                type="button"
                data-testid="edr-isolate-confirm"
                onClick={doIsolate}
                disabled={isolating}
                className="inline-flex items-center gap-2 rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground hover:opacity-90 disabled:opacity-60"
              >
                {isolating && <Loader2 className="h-4 w-4 animate-spin" />}Isolate
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
