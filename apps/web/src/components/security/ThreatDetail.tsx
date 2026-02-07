import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ComponentType } from 'react';
import { AlertTriangle, CheckCircle2, Clock, Loader2, Shield, ShieldCheck, ShieldOff, Trash2 } from 'lucide-react';

import { fetchWithAuth } from '@/stores/auth';
import { friendlyFetchError } from '@/lib/utils';

type ThreatSeverity = 'low' | 'medium' | 'high' | 'critical';
type ThreatStatus = 'active' | 'quarantined' | 'removed';

type ThreatDetailData = {
  id: string;
  deviceId: string;
  deviceName: string;
  name: string;
  category: string;
  severity: ThreatSeverity;
  status: ThreatStatus;
  detectedAt: string;
  filePath: string;
  providerId?: string;
};

type TimelineEvent = {
  id: string;
  title: string;
  description: string;
  timestamp: string;
  icon: ComponentType<{ className?: string }>;
};

const severityBadge: Record<ThreatSeverity, string> = {
  low: 'bg-blue-500/20 text-blue-700 border-blue-500/30',
  medium: 'bg-yellow-500/20 text-yellow-800 border-yellow-500/40',
  high: 'bg-orange-500/20 text-orange-700 border-orange-500/40',
  critical: 'bg-red-500/20 text-red-700 border-red-500/40'
};

interface ThreatDetailProps {
  threatId?: string;
  timezone?: string;
}

export default function ThreatDetail({ threatId, timezone }: ThreatDetailProps) {
  const [threat, setThreat] = useState<ThreatDetailData | null>(null);
  const [relatedThreats, setRelatedThreats] = useState<ThreatDetailData[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string>();

  const fetchThreat = useCallback(async () => {
    setLoading(true);
    setError(undefined);

    try {
      const listResponse = await fetchWithAuth('/security/threats?limit=100');
      if (!listResponse.ok) throw new Error(`${listResponse.status} ${listResponse.statusText}`);
      const listPayload = await listResponse.json();
      const list: ThreatDetailData[] = Array.isArray(listPayload.data) ? listPayload.data : [];

      const selected = threatId ? list.find((item) => item.id === threatId) : list[0];
      if (!selected) {
        setThreat(null);
        setRelatedThreats([]);
        return;
      }

      setThreat(selected);
      setRelatedThreats(
        list
          .filter((item) => item.id !== selected.id && item.deviceId === selected.deviceId)
          .slice(0, 5)
      );
    } catch (err) {
      setError(friendlyFetchError(err));
    } finally {
      setLoading(false);
    }
  }, [threatId]);

  useEffect(() => {
    fetchThreat();
  }, [fetchThreat]);

  const runAction = async (action: 'quarantine' | 'restore' | 'remove') => {
    if (!threat) return;

    setActing(true);
    setError(undefined);

    try {
      const response = await fetchWithAuth(`/security/threats/${threat.id}/${action}`, { method: 'POST' });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      await fetchThreat();
    } catch (err) {
      setError(friendlyFetchError(err));
    } finally {
      setActing(false);
    }
  };

  const timeline = useMemo<TimelineEvent[]>(() => {
    if (!threat) return [];

    const events: TimelineEvent[] = [
      {
        id: `${threat.id}-detected`,
        title: 'Threat detected',
        description: `${threat.name} was detected on ${threat.deviceName}.`,
        timestamp: threat.detectedAt,
        icon: AlertTriangle
      }
    ];

    if (threat.status === 'quarantined') {
      events.push({
        id: `${threat.id}-quarantined`,
        title: 'Threat quarantined',
        description: 'Threat was moved to quarantine by policy or operator action.',
        timestamp: threat.detectedAt,
        icon: ShieldOff
      });
    }

    if (threat.status === 'removed') {
      events.push({
        id: `${threat.id}-removed`,
        title: 'Threat removed',
        description: 'Threat file was removed from endpoint storage.',
        timestamp: threat.detectedAt,
        icon: ShieldCheck
      });
    }

    events.push({
      id: `${threat.id}-review`,
      title: 'Analyst review',
      description: 'Review remediation completeness and endpoint health.',
      timestamp: threat.detectedAt,
      icon: Clock
    });

    return events;
  }, [threat]);

  const formatDateTime = (value: string): string => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString([], { timeZone: timezone });
  };

  if (loading) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading threat details...
        </div>
      </div>
    );
  }

  if (!threat) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <p className="text-sm text-muted-foreground">No threat selected.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Threat Detail</h1>
        <p className="text-sm text-muted-foreground">Investigate, contain, and resolve this detection.</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">{threat.name}</h2>
                <p className="text-sm capitalize text-muted-foreground">{threat.category}</p>
              </div>
              <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${severityBadge[threat.severity]}`}>
                {threat.severity}
              </span>
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div>
                <p className="text-xs uppercase text-muted-foreground">File Path</p>
                <p className="text-sm font-medium">{threat.filePath || '-'}</p>
              </div>
              <div>
                <p className="text-xs uppercase text-muted-foreground">Provider</p>
                <p className="text-sm font-medium">{threat.providerId ?? 'unknown'}</p>
              </div>
              <div>
                <p className="text-xs uppercase text-muted-foreground">Detected</p>
                <p className="text-sm font-medium">{formatDateTime(threat.detectedAt)}</p>
              </div>
              <div>
                <p className="text-xs uppercase text-muted-foreground">Status</p>
                <p className="text-sm font-medium capitalize">{threat.status}</p>
              </div>
              <div className="sm:col-span-2">
                <p className="text-xs uppercase text-muted-foreground">Threat ID</p>
                <p className="text-sm font-medium">{threat.id}</p>
              </div>
            </div>
            <div className="mt-6 flex flex-wrap gap-3">
              <button
                type="button"
                disabled={acting}
                onClick={() => runAction('quarantine')}
                className="inline-flex items-center gap-2 rounded-md border bg-background px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-60"
              >
                {acting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />}
                Quarantine
              </button>
              <button
                type="button"
                disabled={acting}
                onClick={() => runAction('restore')}
                className="inline-flex items-center gap-2 rounded-md border bg-background px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-60"
              >
                <CheckCircle2 className="h-4 w-4" />
                Restore
              </button>
              <button
                type="button"
                disabled={acting}
                onClick={() => runAction('remove')}
                className="inline-flex items-center gap-2 rounded-md border bg-background px-4 py-2 text-sm font-medium hover:bg-muted disabled:opacity-60"
              >
                <Trash2 className="h-4 w-4" />
                Remove
              </button>
            </div>
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Timeline</h2>
              <Clock className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="mt-4 space-y-4">
              {timeline.map((event) => (
                <div key={event.id} className="flex items-start gap-4 rounded-md border bg-muted/30 px-4 py-3">
                  <div className="rounded-full border bg-background p-2">
                    <event.icon className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">{event.title}</p>
                    <p className="text-xs text-muted-foreground">{event.description}</p>
                    <p className="text-xs text-muted-foreground">{formatDateTime(event.timestamp)}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Device Info</h2>
              <ShieldCheck className="h-5 w-5 text-muted-foreground" />
            </div>
            <div className="mt-4 space-y-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Device</span>
                <span className="font-medium">{threat.deviceName}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Threat status</span>
                <span className="font-medium capitalize">{threat.status}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Severity</span>
                <span className="font-medium capitalize">{threat.severity}</span>
              </div>
            </div>
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Related Threats</h2>
            <p className="text-sm text-muted-foreground">Other detections on this device.</p>
            <div className="mt-4 space-y-3">
              {relatedThreats.length === 0 ? (
                <p className="text-sm text-muted-foreground">No related threats.</p>
              ) : (
                relatedThreats.map((item) => (
                  <div key={item.id} className="flex items-center justify-between rounded-md border bg-muted/30 px-4 py-3">
                    <div>
                      <p className="text-sm font-medium">{item.name}</p>
                      <p className="text-xs text-muted-foreground">{formatDateTime(item.detectedAt)}</p>
                    </div>
                    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${severityBadge[item.severity]}`}>
                      {item.severity}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
