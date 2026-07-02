import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, AlertTriangle, ChevronDown, Cpu, RefreshCw, Settings, ShieldCheck, Sparkles, Wrench, XCircle } from 'lucide-react';

import type { AiPageContext } from '@breeze/shared';
import { runAction, handleActionError } from '../../lib/runAction';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { fetchWithAuth } from '../../stores/auth';
import { useMlFeatureFlags } from '../../hooks/useMlFeatureFlags';
import { useClickOutside } from '../../hooks/useClickOutside';
import { useAiStore } from '../../stores/aiStore';
import HelpTooltip from '../shared/HelpTooltip';

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
  enrolledAt?: string | null;
};

type ReliabilityOffender = {
  key: string;
  label: string;
  count: number;
  lastOccurrence: string | null;
  detail?: string;
};

type ReliabilityOffenders = {
  services: ReliabilityOffender[];
  hardware: ReliabilityOffender[];
  hangs: ReliabilityOffender[];
};

// The window the panel summarizes events over (matches the API offenders default).
const OFFENDER_WINDOW_DAYS = 30;
// Counts at or above this read as "machine on fire / number is broken" noise in a
// summary tile (issue #1907); cap the tile and keep the exact figure in the
// title + the per-offender drill-down.
const COUNT_CAP = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Cap large summary counts so a tile shows "999+" instead of a 4-digit wall.
function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value >= COUNT_CAP) return `${COUNT_CAP - 1}+`;
  return value.toLocaleString();
}

// Observed device age in whole days, or null when enrollment time is unknown.
// Used only to add a "windows span less than 30d" tooltip on young devices —
// labels always use the fixed window.
function deviceAgeDays(enrolledAt?: string | null): number | null {
  if (!enrolledAt) return null;
  const ms = Date.parse(enrolledAt);
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.floor((Date.now() - ms) / DAY_MS));
}

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
  description: string;
  Icon: typeof AlertTriangle;
  iconClass: string;
}> = [
  {
    outcome: 'failure_confirmed',
    label: 'Device failed',
    description: 'It broke down or needed major repair — the risk was real.',
    Icon: AlertTriangle,
    iconClass: 'text-destructive',
  },
  {
    outcome: 'replaced',
    label: 'Device replaced',
    description: 'You retired or swapped it because of reliability problems.',
    Icon: Wrench,
    iconClass: 'text-muted-foreground',
  },
  {
    outcome: 'false_alarm',
    label: 'False alarm',
    description: 'The device is fine — this score overstated the risk.',
    Icon: XCircle,
    iconClass: 'text-muted-foreground',
  },
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

// The factor most responsible for dragging the score down — the first driver
// (already ordered by lost points) or, when no drivers exist, the first top
// issue. Used by the "At risk" explainer tooltip.
function topDragLabel(snapshot: ReliabilitySnapshot): string | null {
  const driver = (snapshot.drivers ?? [])[0];
  if (driver) return driver.label;
  const issue = snapshot.topIssues[0];
  return issue ? issueLabels[issue.type] : null;
}

// 30-day raw count backing a fault factor, for the "Biggest drag" headline stat.
// Uptime has no count (it's a percentage) and unknown factors return null.
function factorCount30d(snapshot: ReliabilitySnapshot, factor: string): number | null {
  switch (factor) {
    case 'crashes': return snapshot.crashCount30d;
    case 'hangs': return snapshot.hangCount30d;
    case 'serviceFailures': return snapshot.serviceFailureCount30d;
    case 'hardwareErrors': return snapshot.hardwareErrorCount30d;
    default: return null;
  }
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

// Points a factor currently contributes to the overall score (weight × health).
// Display rounds to whole points; exact value goes in the row's title attribute.
function earnedPoints(driver: ReliabilityDriver): number {
  return (driver.weight * driver.score) / 100;
}

// One human-readable evidence line per factor row, window-aware ("11 in last 7d
// · 24 in 30d · 0 recovered"), replacing the old machine-generated key dump
// ("service failure count7d"). Reads the driver's evidence payload with the
// snapshot's headline counts as fallback so legacy payload shapes still render.
function factorEvidenceText(
  driver: ReliabilityDriver,
  snapshot: ReliabilitySnapshot,
  windowPhrase: string
): string | null {
  const evidence = driver.evidence;
  const pick = (...keys: string[]): number | null => {
    for (const key of keys) {
      const value = evidence[key];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    }
    return null;
  };

  const parts: string[] = [];
  switch (driver.factor) {
    case 'crashes': {
      const count30 = pick('crashCount30d') ?? snapshot.crashCount30d;
      const count7 = pick('crashCount7d');
      parts.push(`${formatCount(count30)} ${windowPhrase}`);
      if (count7 !== null) parts.push(`${formatCount(count7)} in last 7d`);
      break;
    }
    case 'hangs': {
      const count30 = pick('hangCount30d') ?? snapshot.hangCount30d;
      const unresolved = pick('unresolvedHangCount30d');
      parts.push(`${formatCount(count30)} ${windowPhrase}`);
      if (unresolved) parts.push(`${formatCount(unresolved)} unresolved`);
      break;
    }
    case 'serviceFailures': {
      const count30 = pick('serviceFailureCount30d', 'serviceFailure30d') ?? snapshot.serviceFailureCount30d;
      const count7 = pick('serviceFailureCount7d');
      const recovered = pick('recoveredServiceCount30d');
      const self = pick('selfServiceFailureCount30d');
      parts.push(`${formatCount(count30)} ${windowPhrase}`);
      if (count7 !== null) parts.push(`${formatCount(count7)} in last 7d`);
      if (recovered !== null) parts.push(`${formatCount(recovered)} recovered`);
      if (self) parts.push(`${formatCount(self)} from Breeze services, not scored`);
      break;
    }
    case 'hardwareErrors': {
      const count30 = pick('hardwareErrorCount30d') ?? snapshot.hardwareErrorCount30d;
      const critical = pick('criticalHardwareCount30d');
      parts.push(`${formatCount(count30)} ${windowPhrase}`);
      if (critical) parts.push(`${formatCount(critical)} critical`);
      break;
    }
    case 'uptime': {
      const uptime30 = pick('uptime30d') ?? snapshot.uptime30d;
      parts.push(`${uptime30.toFixed(1)}% ${windowPhrase}`);
      break;
    }
    default:
      return null;
  }
  return parts.join(' · ');
}

// Factors whose raw events appear in the offenders drill-down.
const OFFENDER_FACTORS = new Set(['serviceFailures', 'hardwareErrors', 'hangs']);

function formatOffenderWhen(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return formatDateTime(date, { month: 'short', day: 'numeric' });
}

function OffenderGroup({
  title,
  Icon,
  offenders,
  testId,
}: {
  title: string;
  Icon: typeof Wrench;
  offenders: ReliabilityOffender[];
  testId: string;
}) {
  if (offenders.length === 0) return null;
  return (
    <div data-testid={testId}>
      <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {title}
      </div>
      <ul className="mt-2 space-y-1.5">
        {offenders.map((offender) => {
          const when = formatOffenderWhen(offender.lastOccurrence);
          return (
            <li key={offender.key} className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">
                <span className="font-medium">{offender.label}</span>
                {offender.detail && (
                  <span className="ml-2 text-xs text-muted-foreground">{offender.detail}</span>
                )}
              </span>
              <span className="flex shrink-0 items-center gap-2 text-xs tabular-nums text-muted-foreground">
                {when && <span>{when}</span>}
                <span
                  className="rounded bg-muted px-1.5 py-0.5 font-semibold text-foreground"
                  title={offender.count.toLocaleString()}
                >
                  {formatCount(offender.count)}×
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
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

  // Every factor, problems first (lost points desc, then weight desc so a
  // 0-weight uptime row lands last). The API pre-sorts by lost points; the
  // re-sort here is a defensive no-op for well-formed payloads.
  const factorRows = useMemo(() => {
    const list = [...(snapshot?.drivers ?? [])];
    list.sort((left, right) => (right.lostPoints - left.lostPoints) || (right.weight - left.weight));
    return list;
  }, [snapshot?.drivers]);
  const scoredFactors = useMemo(() => factorRows.filter((driver) => driver.weight > 0), [factorRows]);
  // The segmented bar only reads correctly when the segments account for
  // (essentially) the whole score; legacy snapshots with partial driver lists
  // keep the plain single-fill bar.
  const scoredWeightTotal = scoredFactors.reduce((sum, driver) => sum + driver.weight, 0);

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

  // Offenders drill-down (issue #1907): lazily fetched on first expand so the
  // initial panel render stays a single request and healthy devices pay nothing.
  const [offendersOpen, setOffendersOpen] = useState(false);
  const [offenders, setOffenders] = useState<ReliabilityOffenders | null>(null);
  const [offendersLoading, setOffendersLoading] = useState(false);
  const [offendersError, setOffendersError] = useState<string>();
  const offendersFetchedRef = useRef(false);

  const loadOffenders = useCallback(async () => {
    offendersFetchedRef.current = true;
    setOffendersLoading(true);
    setOffendersError(undefined);
    try {
      const response = await fetchWithAuth(`/reliability/${deviceId}/offenders`);
      if (!response.ok) throw new Error('Failed to load reliability detail');
      const json = await response.json();
      // A 200 with a missing/malformed body must not render a blank, retry-less
      // panel — treat it as a failure so the existing error+retry path handles it.
      const data = json?.offenders;
      if (!data || typeof data !== 'object') {
        throw new Error('Reliability detail response was malformed');
      }
      setOffenders({
        services: Array.isArray(data.services) ? data.services : [],
        hardware: Array.isArray(data.hardware) ? data.hardware : [],
        hangs: Array.isArray(data.hangs) ? data.hangs : [],
      });
    } catch (err) {
      offendersFetchedRef.current = false; // allow a retry on next expand
      setOffendersError(err instanceof Error ? err.message : 'Failed to load reliability detail');
    } finally {
      setOffendersLoading(false);
    }
  }, [deviceId]);

  // Reset the drill-down when the panel is pointed at a different device, so a
  // stale offender list (and the fetched-once guard) can't bleed across devices.
  useEffect(() => {
    setOffendersOpen(false);
    setOffenders(null);
    setOffendersError(undefined);
    setOffendersLoading(false);
    offendersFetchedRef.current = false;
  }, [deviceId]);

  const toggleOffenders = useCallback(() => {
    const next = !offendersOpen;
    setOffendersOpen(next);
    if (next && !offendersFetchedRef.current) void loadOffenders();
  }, [offendersOpen, loadOffenders]);

  // Open (never close) the drill-down — used by the per-factor "details" links.
  const expandOffenders = useCallback(() => {
    if (offendersOpen) return;
    setOffendersOpen(true);
    if (!offendersFetchedRef.current) void loadOffenders();
  }, [offendersOpen, loadOffenders]);

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
          ? 'Marked as false alarm — this helps tune future scores'
          : outcome === 'replaced'
            ? 'Marked as replaced — this helps tune future scores'
            : 'Marked as failed — this helps tune future scores',
      });
    } catch (err) {
      handleActionError(err, 'Could not save reliability feedback');
    } finally {
      setLabeling(null);
    }
  }

  if (loading) {
    return (
      <div className="rounded-lg border bg-card p-5 shadow-xs">
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
      <div className="rounded-lg border bg-card p-5 shadow-xs">
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
      <div className="rounded-lg border bg-card p-5 shadow-xs">
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

  const ageDays = deviceAgeDays(snapshot.enrolledAt);
  // Workstation-profile devices score uptime at 0% weight (they sleep/reboot by
  // design), so a perfect uptime% next to a low score reads as a contradiction —
  // "why is the score low when uptime is 100%?". When uptime carries no weight
  // AND some factor is actually losing points, give the headline slot to that
  // factor instead. drivers are already sorted by lost points (API-side).
  const uptimeDriver = (snapshot.drivers ?? []).find((driver) => driver.factor === 'uptime');
  const topDrag = (snapshot.drivers ?? [])[0];
  const topDragCount = topDrag ? factorCount30d(snapshot, topDrag.factor) : null;
  const showTopDragStat = uptimeDriver?.weight === 0 && topDrag !== undefined && topDrag.lostPoints > 0;
  const offenderWindowText = `last ${OFFENDER_WINDOW_DAYS} days`;
  // Short form for inline evidence: "24 in 30d".
  const windowPhrase = `in ${OFFENDER_WINDOW_DAYS}d`;
  // Young devices haven't lived a full window yet; a tooltip carries that
  // context instead of relabeling every window (the old "since enroll · Nd").
  const youngDevice = ageDays !== null && ageDays < OFFENDER_WINDOW_DAYS;
  const offenderEventTotal =
    snapshot.serviceFailureCount30d + snapshot.hardwareErrorCount30d + snapshot.hangCount30d;

  return (
    <div className="rounded-lg border bg-card p-5 shadow-xs">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-muted-foreground" />
            <h3 className="text-base font-semibold">Reliability</h3>
            {snapshot.reliabilityScore <= 70 && (
              <span className="inline-flex items-center gap-1" data-testid="reliability-atrisk-help">
                <span className="inline-flex items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  At risk
                </span>
                <HelpTooltip
                  text={
                    topDragLabel(snapshot)
                      ? `Shown when the reliability score is ≤ 70. Biggest drag: ${topDragLabel(snapshot)}.`
                      : 'Shown when the reliability score is ≤ 70.'
                  }
                />
              </span>
            )}
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-x-5 gap-y-2">
            <div>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                Score
                <HelpTooltip
                  text={`Reliability score ${snapshot.reliabilityScore}/100 — ${scoreBandLabel(snapshot.reliabilityScore)}. Bands: ≤50 critical, ≤70 poor, ≤85 fair, else good.`}
                />
              </div>
              <div className={`text-3xl font-semibold tabular-nums ${scoreClass(snapshot.reliabilityScore)}`}>
                {snapshot.reliabilityScore}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Trend</div>
              <div className="text-sm font-medium capitalize">{snapshot.trendDirection}</div>
            </div>
            {showTopDragStat && topDrag ? (
              <div>
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <span data-testid="reliability-top-drag">Biggest drag</span>
                  <HelpTooltip
                    text={`Uptime isn't scored for this device type (workstations sleep and reboot by design), so the factor costing the most points is shown instead. ${topDrag.label}: health ${topDrag.score}/100, ${topDrag.weight}% of the score.`}
                  />
                </div>
                <div className="text-sm font-medium">
                  {topDrag.label}
                  {topDragCount !== null && (
                    <span className="text-muted-foreground"> · {formatCount(topDragCount)} {windowPhrase}</span>
                  )}
                </div>
              </div>
            ) : (
              <div>
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <span data-testid="reliability-uptime-window">{OFFENDER_WINDOW_DAYS}d uptime</span>
                  {youngDevice && (
                    <HelpTooltip
                      text={`This device enrolled ${ageDays} day${ageDays === 1 ? '' : 's'} ago, so the ${OFFENDER_WINDOW_DAYS}-day windows only span its lifetime so far.`}
                    />
                  )}
                </div>
                <div className="text-sm font-medium tabular-nums">{snapshot.uptime30d.toFixed(1)}%</div>
              </div>
            )}
            <div>
              <div className="text-xs text-muted-foreground">MTBF</div>
              <div className="text-sm font-medium tabular-nums">
                {snapshot.mtbfHours === null ? '—' : `${Math.round(snapshot.mtbfHours)}h`}
              </div>
            </div>
          </div>
          {scoredWeightTotal >= 99 ? (
            // Weight-segmented score bar: one segment per scored factor, segment
            // width = factor weight, fill = factor health — the filled area IS
            // the score, so the arithmetic is visible at a glance. Ordered to
            // match the factor rows below (problems first).
            <div
              data-testid="reliability-score-bar-segmented"
              role="img"
              aria-label={`Score breakdown: ${scoredFactors
                .map((driver) => `${driver.label} ${Math.round(earnedPoints(driver))} of ${Math.round(driver.weight)} points`)
                .join(', ')}`}
              className="mt-3 flex h-2 gap-px overflow-hidden rounded-full"
            >
              {scoredFactors.map((driver) => (
                <div
                  key={driver.factor}
                  className="h-2 bg-muted"
                  style={{ width: `${driver.weight}%` }}
                  title={`${driver.label} — ${Math.round(earnedPoints(driver))} of ${Math.round(driver.weight)} pts (health ${driver.score}/100)`}
                >
                  <div className={`h-2 ${scoreBarClass(driver.score)}`} style={{ width: `${driver.score}%` }} />
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-3 h-2 rounded-full bg-muted">
              <div
                className={`h-2 rounded-full ${scoreBarClass(snapshot.reliabilityScore)}`}
                style={{ width: `${snapshot.reliabilityScore}%` }}
              />
            </div>
          )}
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
          {/* Feedback resolves the At-risk PREDICTION, not the ongoing score —
              a healthy device has no prediction to resolve, so the affordance
              only exists while the card shows the At-risk chip. Labels feed the
              model's precision evaluation (was the at-risk call real?). */}
          {snapshot.reliabilityScore <= 70 && (
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
              Was this right?
              <ChevronDown className="h-3.5 w-3.5" />
            </button>

            {outcomeMenuOpen && (
              <div
                role="menu"
                data-testid="reliability-outcome-menu"
                className="absolute right-0 top-9 z-30 w-72 rounded-md border bg-popover p-1 shadow-lg"
              >
                <p className="px-2 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">
                  This device is flagged at risk. What actually happened?
                </p>
                {OUTCOME_ITEMS.map(({ outcome, label, description, Icon, iconClass }) => (
                  <button
                    key={outcome}
                    type="button"
                    data-testid={`reliability-outcome-${outcome}`}
                    disabled={labeling !== null}
                    onClick={() => handleOutcome(outcome)}
                    className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${iconClass}`} />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{label}</span>
                      <span className="block text-xs text-muted-foreground">{description}</span>
                    </span>
                  </button>
                ))}
                <hr className="my-1" />
                <p className="px-2 pb-1.5 pt-0.5 text-xs text-muted-foreground">
                  Your answer trains the scoring model. It doesn't change this device or its score.
                </p>
              </div>
            )}
          </div>
          )}
        </div>
      </div>

      {factorRows.length > 0 ? (
        <div className="mt-5" data-testid="reliability-factors">
          <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
            Score factors
            <HelpTooltip
              text={`Each factor's health (0–100) × its weight contributes points; the points add up to the ${snapshot.reliabilityScore} score. Values are rounded for display — hover a row for exact figures.`}
            />
          </div>
          <div className="mt-1 divide-y divide-border/60">
            {factorRows.map((driver) => {
              const unweighted = driver.weight === 0;
              const problem = !unweighted && driver.lostPoints > 0;
              const evidenceText = factorEvidenceText(driver, snapshot, windowPhrase);
              const showDetailsLink =
                problem && OFFENDER_FACTORS.has(driver.factor) && offenderEventTotal > 0 && !offendersOpen;
              return (
                <div
                  key={driver.factor}
                  data-testid={`reliability-factor-${driver.factor}`}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2"
                  title={
                    unweighted
                      ? `${driver.label} — not scored for this device type`
                      : `${driver.label} — health ${driver.score}/100, earns ${earnedPoints(driver).toFixed(1)} of ${driver.weight} points`
                  }
                >
                  <span className={`w-36 shrink-0 text-sm font-medium ${problem ? '' : 'text-muted-foreground'}`}>
                    {driver.label}
                  </span>
                  <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                    {unweighted ? (
                      <>Not scored for this device type{evidenceText ? ` — ${evidenceText}` : ''}</>
                    ) : problem ? (
                      <>
                        {evidenceText}
                        {showDetailsLink && (
                          <button
                            type="button"
                            data-testid={`reliability-factor-details-${driver.factor}`}
                            onClick={expandOffenders}
                            className="ml-2 underline decoration-dotted underline-offset-2 hover:text-foreground"
                          >
                            details
                          </button>
                        )}
                      </>
                    ) : driver.factor === 'uptime' ? (
                      evidenceText
                    ) : (
                      `None ${windowPhrase}`
                    )}
                  </span>
                  <span
                    className={`shrink-0 text-sm font-semibold tabular-nums ${
                      unweighted ? 'text-muted-foreground/70' : problem ? scoreClass(driver.score) : 'text-muted-foreground'
                    }`}
                  >
                    {unweighted ? '—' : `${Math.round(earnedPoints(driver))} / ${Math.round(driver.weight)} pts`}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="mt-5 grid gap-3 lg:grid-cols-3">
          {snapshot.topIssues.slice(0, 3).map((issue) => (
            <div key={issue.type} className="rounded-md border p-3">
              <p className="text-sm font-medium">{issueLabels[issue.type]}</p>
              <p className="mt-1 text-xs capitalize text-muted-foreground">{issue.severity}</p>
              <p className="mt-3 text-lg font-semibold tabular-nums" title={issue.count.toLocaleString()}>
                {formatCount(issue.count)}
              </p>
            </div>
          ))}
        </div>
      )}

      {offenderEventTotal > 0 && (
        <div className="mt-4 border-t pt-3">
          <button
            type="button"
            data-testid="reliability-offenders-toggle"
            aria-expanded={offendersOpen}
            onClick={toggleOffenders}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            <ChevronDown className={`h-4 w-4 transition-transform ${offendersOpen ? 'rotate-180' : ''}`} />
            {offendersOpen ? 'Hide' : 'Show'} offending services &amp; components
          </button>

          {offendersOpen && (
            <div data-testid="reliability-offenders" className="mt-3 space-y-4">
              {offendersLoading && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                  Loading detail…
                </div>
              )}
              {offendersError && (
                <div className="flex flex-col gap-2 text-sm sm:flex-row sm:items-center sm:justify-between">
                  <span className="text-destructive">{offendersError}</span>
                  <button
                    type="button"
                    onClick={() => void loadOffenders()}
                    className="inline-flex items-center gap-1.5 self-start rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-muted"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Retry
                  </button>
                </div>
              )}
              {!offendersLoading && !offendersError && offenders && (
                offenders.services.length + offenders.hardware.length + offenders.hangs.length > 0 ? (
                  <>
                    <OffenderGroup
                      testId="reliability-offenders-services"
                      title="Top services"
                      Icon={Settings}
                      offenders={offenders.services}
                    />
                    <OffenderGroup
                      testId="reliability-offenders-hardware"
                      title="Top hardware components"
                      Icon={Cpu}
                      offenders={offenders.hardware}
                    />
                    <OffenderGroup
                      testId="reliability-offenders-hangs"
                      title="Top processes"
                      Icon={Activity}
                      offenders={offenders.hangs}
                    />
                    <p className="text-xs text-muted-foreground">
                      Distinct events from the {offenderWindowText}.
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No offending services or components recorded in the {offenderWindowText}.
                  </p>
                )
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
