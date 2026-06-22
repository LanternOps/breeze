import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, RefreshCw, ShieldCheck, Sparkles, Wrench, XCircle } from 'lucide-react';

import type { AiPageContext } from '@breeze/shared';
import { runAction, handleActionError } from '../../lib/runAction';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { fetchWithAuth } from '../../stores/auth';
import { useMlFeatureFlags } from '../../hooks/useMlFeatureFlags';
import { useClickOutside } from '../../hooks/useClickOutside';
import { useAiStore } from '../../stores/aiStore';

type ReliabilityTopIssue = {
  type: 'crashes' | 'hangs' | 'services' | 'hardware' | 'uptime';
  count: number;
  severity: 'critical' | 'error' | 'warning' | 'info';
  lastOccurrence?: string;
};

type ReliabilityDriver = {
  factor: string;
  label: string;
  score: number;
  weight: number;
  lostPoints: number;
  evidence: Record<string, number>;
};

type ReliabilitySnapshot = {
  deviceId: string;
  hostname?: string;
  osType?: 'windows' | 'macos' | 'linux';
  status?: string;
  reliabilityScore: number;
  trendDirection: 'improving' | 'stable' | 'degrading';
  trendConfidence: number;
  uptime30d: number;
  crashCount30d: number;
  hangCount30d: number;
  serviceFailureCount30d: number;
  hardwareErrorCount30d: number;
  mtbfHours: number | null;
  topIssues: ReliabilityTopIssue[];
  drivers?: ReliabilityDriver[];
  computedAt: string;
};

type DeviceReliabilityPanelProps = {
  deviceId: string;
};

const issueLabels: Record<ReliabilityTopIssue['type'], string> = {
  crashes: 'Crashes',
  hangs: 'Application hangs',
  services: 'Service failures',
  hardware: 'Hardware errors',
  uptime: 'Uptime',
};

const OUTCOME_ITEMS: Array<{
  outcome: 'failure_confirmed' | 'replaced' | 'false_alarm';
  label: string;
  Icon: typeof AlertTriangle;
  iconClass: string;
}> = [
  { outcome: 'failure_confirmed', label: 'Device failed', Icon: AlertTriangle, iconClass: 'text-destructive' },
  { outcome: 'replaced', label: 'Device replaced', Icon: Wrench, iconClass: 'text-muted-foreground' },
  { outcome: 'false_alarm', label: 'False alarm', Icon: XCircle, iconClass: 'text-muted-foreground' },
];

function scoreClass(score: number): string {
  if (score <= 50) return 'text-destructive';
  if (score <= 70) return 'text-warning';
  if (score <= 85) return 'text-info';
  return 'text-success';
}

function scoreBarClass(score: number): string {
  if (score <= 50) return 'bg-destructive';
  if (score <= 70) return 'bg-warning';
  if (score <= 85) return 'bg-info';
  return 'bg-success';
}

function scoreBandLabel(score: number): string {
  if (score <= 50) return 'critical';
  if (score <= 70) return 'poor';
  if (score <= 85) return 'fair';
  return 'good';
}

function buildReliabilitySeedPrompt(snapshot: ReliabilitySnapshot, drivers: ReliabilityDriver[]): string {
  const mtbf = snapshot.mtbfHours === null ? 'unknown' : `${Math.round(snapshot.mtbfHours)}h`;
  const driverText = drivers.length > 0
    ? drivers.map((d) => `${d.label} (score ${d.score})`).join('; ')
    : 'none flagged';
  return [
    `Review this device's reliability and recommend what to do.`,
    `Score ${snapshot.reliabilityScore}/100 (${scoreBandLabel(snapshot.reliabilityScore)}), trend ${snapshot.trendDirection}.`,
    `30-day uptime ${snapshot.uptime30d.toFixed(1)}%, MTBF ${mtbf}.`,
    `Top factors dragging the score: ${driverText}.`,
    `What are the likely root causes, and what remediation — scripts, checks, or a ticket — do you recommend?`,
  ].join(' ');
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatDateTime(date, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatEvidenceKey(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase();
}

function formatEvidenceValue(key: string, value: number): string {
  if (key.toLowerCase().includes('uptime')) return `${value.toFixed(1)}%`;
  return Number.isInteger(value) ? value.toLocaleString() : value.toFixed(1);
}

export default function DeviceReliabilityPanel({ deviceId }: DeviceReliabilityPanelProps) {
  const mlFlags = useMlFeatureFlags();
  const [snapshot, setSnapshot] = useState<ReliabilitySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [labeling, setLabeling] = useState<string | null>(null);
  const reliabilityDisabled = mlFlags.isDisabled('ml.device_reliability.enabled');

  const fetchReliability = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetchWithAuth(`/reliability/${deviceId}`);
      if (response.status === 404) {
        setSnapshot(null);
        return;
      }
      if (!response.ok) throw new Error('Failed to load reliability score');
      const json = await response.json();
      setSnapshot(json?.snapshot ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load reliability score');
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    if (!mlFlags.loaded) return;
    if (reliabilityDisabled) {
      setSnapshot(null);
      setError(undefined);
      setLoading(false);
      return;
    }
    void fetchReliability();
  }, [fetchReliability, mlFlags.loaded, reliabilityDisabled]);

  const drivers = useMemo(() => (snapshot?.drivers ?? []).slice(0, 3), [snapshot?.drivers]);

  const startDeviceTask = useAiStore((s) => s.startDeviceTask);

  const askAi = useCallback(() => {
    if (!snapshot) return;
    const ctx: AiPageContext = {
      type: 'device',
      id: deviceId,
      hostname: snapshot.hostname ?? deviceId,
      os: snapshot.osType,
      status: snapshot.status,
    };
    void startDeviceTask(deviceId, ctx, buildReliabilitySeedPrompt(snapshot, drivers));
  }, [snapshot, deviceId, drivers, startDeviceTask]);

  const [outcomeMenuOpen, setOutcomeMenuOpen] = useState(false);
  const outcomeMenuRef = useRef<HTMLDivElement>(null);
  useClickOutside(outcomeMenuOpen, outcomeMenuRef, () => setOutcomeMenuOpen(false));

  function handleOutcome(outcome: 'failure_confirmed' | 'replaced' | 'false_alarm') {
    setOutcomeMenuOpen(false);
    void submitFeedback(outcome);
  }

  async function submitFeedback(outcome: 'failure_confirmed' | 'replaced' | 'false_alarm') {
    setLabeling(outcome);
    try {
      await runAction({
        request: () => fetchWithAuth(`/reliability/${deviceId}/feedback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ outcome, snapshotComputedAt: snapshot?.computedAt }),
        }),
        errorFallback: 'Could not save reliability feedback',
        successMessage: outcome === 'false_alarm'
          ? 'False alarm label saved'
          : outcome === 'replaced'
            ? 'Replacement label saved'
            : 'Failure label saved',
      });
    } catch (err) {
      handleActionError(err, 'Could not save reliability feedback');
    } finally {
      setLabeling(null);
    }
  }

  if (loading) {
    return (
      <div className="rounded-lg border bg-card p-5 shadow-sm">
        <div className="flex items-center justify-center py-6">
          <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-destructive">{error}</p>
          <button
            type="button"
            onClick={() => void fetchReliability()}
            className="inline-flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted"
          >
            <RefreshCw className="h-4 w-4" />
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (reliabilityDisabled) {
    return (
      <div className="rounded-lg border bg-card p-5 shadow-sm">
        <div className="flex items-center gap-3">
          <ShieldCheck className="h-5 w-5 text-muted-foreground" />
          <div>
            <h3 className="text-base font-semibold">Reliability</h3>
            <p className="text-sm text-muted-foreground">Reliability scoring is disabled for this organization.</p>
          </div>
        </div>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="rounded-lg border bg-card p-5 shadow-sm">
        <div className="flex items-center gap-3">
          <ShieldCheck className="h-5 w-5 text-muted-foreground" />
          <div>
            <h3 className="text-base font-semibold">Reliability</h3>
            <p className="text-sm text-muted-foreground">No reliability snapshot available yet.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-5 shadow-sm">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-muted-foreground" />
            <h3 className="text-base font-semibold">Reliability</h3>
            {snapshot.reliabilityScore <= 70 && (
              <span className="inline-flex items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning">
                <AlertTriangle className="h-3.5 w-3.5" />
                At risk
              </span>
            )}
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-x-5 gap-y-2">
            <div>
              <div className="text-xs text-muted-foreground">Score</div>
              <div className={`text-3xl font-semibold tabular-nums ${scoreClass(snapshot.reliabilityScore)}`}>
                {snapshot.reliabilityScore}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Trend</div>
              <div className="text-sm font-medium capitalize">{snapshot.trendDirection}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">30d uptime</div>
              <div className="text-sm font-medium tabular-nums">{snapshot.uptime30d.toFixed(1)}%</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">MTBF</div>
              <div className="text-sm font-medium tabular-nums">
                {snapshot.mtbfHours === null ? '—' : `${Math.round(snapshot.mtbfHours)}h`}
              </div>
            </div>
          </div>
          <div className="mt-3 h-2 rounded-full bg-muted">
            <div
              className={`h-2 rounded-full ${scoreBarClass(snapshot.reliabilityScore)}`}
              style={{ width: `${snapshot.reliabilityScore}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">Updated {formatDate(snapshot.computedAt)}</p>
        </div>

        <div className="flex flex-col items-start gap-2 xl:items-end">
          <button
            type="button"
            data-testid="reliability-ask-ai"
            onClick={askAi}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Sparkles className="h-4 w-4" />
            Ask AI about reliability
          </button>
          <div ref={outcomeMenuRef} className="relative">
            <button
              type="button"
              data-testid="reliability-outcome-trigger"
              aria-haspopup="true"
              aria-expanded={outcomeMenuOpen}
              disabled={labeling !== null}
              onClick={() => setOutcomeMenuOpen((o) => !o)}
              className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
            >
              Mark outcome
              <ChevronDown className="h-3.5 w-3.5" />
            </button>

            {outcomeMenuOpen && (
              <div
                role="menu"
                data-testid="reliability-outcome-menu"
                className="absolute right-0 top-9 z-30 w-64 rounded-md border bg-popover p-1 shadow-lg"
              >
                <p className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Was this accurate?
                </p>
                {OUTCOME_ITEMS.map(({ outcome, label, Icon, iconClass }) => (
                  <button
                    key={outcome}
                    type="button"
                    data-testid={`reliability-outcome-${outcome}`}
                    disabled={labeling !== null}
                    onClick={() => handleOutcome(outcome)}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <Icon className={`h-4 w-4 shrink-0 ${iconClass}`} />
                    {label}
                  </button>
                ))}
                <hr className="my-1" />
                <p className="px-2 pb-1.5 pt-0.5 text-xs text-muted-foreground">
                  These train the reliability model — they don't change the device.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="mt-5 grid gap-3 lg:grid-cols-3">
        {drivers.length > 0 ? drivers.map((driver) => (
          <div key={driver.factor} className="rounded-md border p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{driver.label}</p>
                <p className="text-xs text-muted-foreground">{driver.weight}% weight</p>
              </div>
              <span className={`text-sm font-semibold tabular-nums ${scoreClass(driver.score)}`}>{driver.score}</span>
            </div>
            <div className="mt-3 space-y-1 text-xs text-muted-foreground">
              {Object.entries(driver.evidence).slice(0, 3).map(([key, value]) => (
                <div key={key} className="flex justify-between gap-3">
                  <span className="truncate">{formatEvidenceKey(key)}</span>
                  <span className="shrink-0 tabular-nums">{formatEvidenceValue(key, value)}</span>
                </div>
              ))}
              {Object.keys(driver.evidence).length === 0 && <span>No factor detail</span>}
            </div>
          </div>
        )) : snapshot.topIssues.slice(0, 3).map((issue) => (
          <div key={issue.type} className="rounded-md border p-3">
            <p className="text-sm font-medium">{issueLabels[issue.type]}</p>
            <p className="mt-1 text-xs capitalize text-muted-foreground">{issue.severity}</p>
            <p className="mt-3 text-lg font-semibold tabular-nums">{issue.count}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
