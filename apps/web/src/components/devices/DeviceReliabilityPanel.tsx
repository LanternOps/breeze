import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, AlertTriangle, ChevronDown, Cpu, RefreshCw, Settings, ShieldCheck, Sparkles, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { AiPageContext } from '@breeze/shared';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { fetchWithAuth } from '../../stores/auth';
import { useMlFeatureFlags } from '../../hooks/useMlFeatureFlags';
import { useAiStore } from '../../stores/aiStore';
import HelpTooltip from '../shared/HelpTooltip';
import { formatNumber, formatPercent } from '@/lib/i18n/format';

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
  return formatNumber(value);
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
  crashes: 'crashes',
  hangs: 'hangs',
  services: 'services',
  hardware: 'hardware',
  uptime: 'uptime',
};

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
    `30-day uptime ${formatPercent(snapshot.uptime30d / 100, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}, MTBF ${mtbf}.`,
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
      // The uptime factor is scored from 90-day availability, not the 30d
      // headline — lead with the scored figure so a 0-point row can't sit next
      // to "100.0% in 30d" with no explanation; keep 30d as context.
      const uptime90 = pick('uptime90d');
      const uptime30 = pick('uptime30d') ?? snapshot.uptime30d;
      if (uptime90 !== null) {
        parts.push(`${formatPercent(uptime90 / 100, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} in 90d (scored window)`);
        if (uptime90 !== uptime30) parts.push(`${formatPercent(uptime30 / 100, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${windowPhrase}`);
      } else {
        parts.push(`${formatPercent(uptime30 / 100, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ${windowPhrase}`);
      }
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
                  title={formatNumber(offender.count)}
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
  const { t } = useTranslation('devices');
  const mlFlags = useMlFeatureFlags();
  const [snapshot, setSnapshot] = useState<ReliabilitySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
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
      if (!response.ok) throw new Error(t('deviceReliabilityPanel.errors.loadScore'));
      const json = await response.json();
      setSnapshot(json?.snapshot ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('deviceReliabilityPanel.errors.loadScore'));
    } finally {
      setLoading(false);
    }
  }, [deviceId, t]);

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
      if (!response.ok) throw new Error(t('deviceReliabilityPanel.errors.loadDetail'));
      const json = await response.json();
      // A 200 with a missing/malformed body must not render a blank, retry-less
      // panel — treat it as a failure so the existing error+retry path handles it.
      const data = json?.offenders;
      if (!data || typeof data !== 'object') {
        throw new Error(t('deviceReliabilityPanel.errors.malformedDetail'));
      }
      setOffenders({
        services: Array.isArray(data.services) ? data.services : [],
        hardware: Array.isArray(data.hardware) ? data.hardware : [],
        hangs: Array.isArray(data.hangs) ? data.hangs : [],
      });
    } catch (err) {
      offendersFetchedRef.current = false; // allow a retry on next expand
      setOffendersError(err instanceof Error ? err.message : t('deviceReliabilityPanel.errors.loadDetail'));
    } finally {
      setOffendersLoading(false);
    }
  }, [deviceId, t]);

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
            {t('common:actions.retry')}
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
            <h3 className="text-base font-semibold">{t('deviceReliabilityPanel.title')}</h3>
            <p className="text-sm text-muted-foreground">{t('deviceReliabilityPanel.disabled')}</p>
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
            <h3 className="text-base font-semibold">{t('deviceReliabilityPanel.title')}</h3>
            <p className="text-sm text-muted-foreground">{t('deviceReliabilityPanel.empty')}</p>
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
  const atRiskDragLabel = topDrag?.label ?? (
    snapshot.topIssues[0]
      ? t(/* i18n-dynamic */ `deviceReliabilityPanel.issueLabels.${issueLabels[snapshot.topIssues[0].type]}`)
      : null
  );
  const showTopDragStat = uptimeDriver?.weight === 0 && topDrag !== undefined && topDrag.lostPoints > 0;
  const offenderWindowText = t('deviceReliabilityPanel.lastDays', { count: OFFENDER_WINDOW_DAYS });
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
            <h3 className="text-base font-semibold">{t('deviceReliabilityPanel.title')}</h3>
            {snapshot.reliabilityScore <= 70 && (
              <span className="inline-flex items-center gap-1" data-testid="reliability-atrisk-help">
                <span className="inline-flex items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {t('deviceReliabilityPanel.atRisk')}
                </span>
                <HelpTooltip
                  text={
                    atRiskDragLabel
                      ? t('deviceReliabilityPanel.atRiskTooltipWithDrag', { drag: atRiskDragLabel })
                      : t('deviceReliabilityPanel.atRiskTooltip')
                  }
                />
              </span>
            )}
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-x-5 gap-y-2">
            <div>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                {t('deviceReliabilityPanel.score')}
                <HelpTooltip
                  text={t('deviceReliabilityPanel.scoreTooltip', {
                    score: snapshot.reliabilityScore,
                    band: t(/* i18n-dynamic */ `deviceReliabilityPanel.scoreBands.${scoreBandLabel(snapshot.reliabilityScore)}`),
                  })}
                />
              </div>
              <div className={`text-3xl font-semibold tabular-nums ${scoreClass(snapshot.reliabilityScore)}`}>
                {snapshot.reliabilityScore}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">{t('deviceReliabilityPanel.trend')}</div>
              <div className="text-sm font-medium capitalize">{t(/* i18n-dynamic */ `deviceReliabilityPanel.trends.${snapshot.trendDirection}`)}</div>
            </div>
            {showTopDragStat && topDrag ? (
              <div>
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <span data-testid="reliability-top-drag">{t('deviceReliabilityPanel.biggestDrag')}</span>
                  <HelpTooltip
                    text={t('deviceReliabilityPanel.biggestDragTooltip', {
                      label: topDrag.label,
                      score: topDrag.score,
                      weight: topDrag.weight,
                    })}
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
                  <span data-testid="reliability-uptime-window">{t('deviceReliabilityPanel.uptimeWindow', { days: OFFENDER_WINDOW_DAYS })}</span>
                  {youngDevice && (
                    <HelpTooltip
                      text={t('deviceReliabilityPanel.youngDeviceTooltip', { age: ageDays, days: OFFENDER_WINDOW_DAYS })}
                    />
                  )}
                </div>
                <div className="text-sm font-medium tabular-nums">{formatPercent(snapshot.uptime30d / 100, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</div>
              </div>
            )}
            <div>
              <div className="text-xs text-muted-foreground">{t('deviceReliabilityPanel.mtbf')}</div>
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
              aria-label={t('deviceReliabilityPanel.scoreBreakdownAria', {
                items: scoredFactors
                  .map((driver) => t('deviceReliabilityPanel.scoreBreakdownItem', {
                    label: driver.label,
                    earned: Math.round(earnedPoints(driver)),
                    weight: Math.round(driver.weight),
                  }))
                  .join(', '),
              })}
              className="mt-3 flex h-2 gap-px overflow-hidden rounded-full"
            >
              {scoredFactors.map((driver) => (
                <div
                  key={driver.factor}
                  className="h-2 bg-muted"
                  style={{ width: `${driver.weight}%` }}
                  title={t('deviceReliabilityPanel.factorTitle', {
                    label: driver.label,
                    earned: Math.round(earnedPoints(driver)),
                    weight: Math.round(driver.weight),
                    score: driver.score,
                  })}
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
          <p className="mt-2 text-xs text-muted-foreground">{t('deviceReliabilityPanel.updated', { date: formatDate(snapshot.computedAt) })}</p>
        </div>

        <div className="flex flex-col items-start gap-2 xl:items-end">
          <button
            type="button"
            data-testid="reliability-ask-ai"
            onClick={askAi}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Sparkles className="h-4 w-4" />
            {t('deviceReliabilityPanel.askAi')}
          </button>
          {/* Outcome-feedback UI removed for now: the labels only feed a
              precision evaluation endpoint no UI consumes, and there is no
              learning loop for them to train yet. The POST /reliability/:id/
              feedback route remains for when a real loop exists. */}
        </div>
      </div>

      {factorRows.length > 0 ? (
        <div className="mt-5" data-testid="reliability-factors">
          <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
            {t('deviceReliabilityPanel.scoreFactors')}
            <HelpTooltip
              text={t('deviceReliabilityPanel.scoreFactorsTooltip', { score: snapshot.reliabilityScore })}
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
                      ? t('deviceReliabilityPanel.notScoredTitle', { label: driver.label })
                      : t('deviceReliabilityPanel.scoredTitle', {
                          label: driver.label,
                          score: driver.score,
                          earned: formatNumber(earnedPoints(driver), { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
                          weight: driver.weight,
                        })
                  }
                >
                  <span className={`w-36 shrink-0 text-sm font-medium ${problem ? '' : 'text-muted-foreground'}`}>
                    {driver.label}
                  </span>
                  <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                    {unweighted ? (
                      <>{t('deviceReliabilityPanel.notScoredForType')}{evidenceText ? ` — ${evidenceText}` : ''}</>
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
                            {t('deviceReliabilityPanel.details')}
                          </button>
                        )}
                      </>
                    ) : driver.factor === 'uptime' ? (
                      evidenceText
                    ) : (
                      t('deviceReliabilityPanel.noneInWindow', { window: windowPhrase })
                    )}
                  </span>
                  <span
                    className={`shrink-0 text-sm font-semibold tabular-nums ${
                      unweighted ? 'text-muted-foreground/70' : problem ? scoreClass(driver.score) : 'text-muted-foreground'
                    }`}
                  >
                    {unweighted
                      ? '—'
                      : t('deviceReliabilityPanel.points', {
                          earned: Math.round(earnedPoints(driver)),
                          weight: Math.round(driver.weight),
                        })}
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
              <p className="text-sm font-medium">{t(/* i18n-dynamic */ `deviceReliabilityPanel.issueLabels.${issueLabels[issue.type]}`)}</p>
              <p className="mt-1 text-xs capitalize text-muted-foreground">{t(/* i18n-dynamic */ `deviceReliabilityPanel.severity.${issue.severity}`)}</p>
              <p className="mt-3 text-lg font-semibold tabular-nums" title={formatNumber(issue.count)}>
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
            {offendersOpen
              ? t('deviceReliabilityPanel.hideOffenders')
              : t('deviceReliabilityPanel.showOffenders')}
          </button>

          {offendersOpen && (
            <div data-testid="reliability-offenders" className="mt-3 space-y-4">
              {offendersLoading && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                  {t('deviceReliabilityPanel.loadingDetail')}
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
                    {t('common:actions.retry')}
                  </button>
                </div>
              )}
              {!offendersLoading && !offendersError && offenders && (
                offenders.services.length + offenders.hardware.length + offenders.hangs.length > 0 ? (
                  <>
                    <OffenderGroup
                      testId="reliability-offenders-services"
                      title={t('deviceReliabilityPanel.offenders.topServices')}
                      Icon={Settings}
                      offenders={offenders.services}
                    />
                    <OffenderGroup
                      testId="reliability-offenders-hardware"
                      title={t('deviceReliabilityPanel.offenders.topHardware')}
                      Icon={Cpu}
                      offenders={offenders.hardware}
                    />
                    <OffenderGroup
                      testId="reliability-offenders-hangs"
                      title={t('deviceReliabilityPanel.offenders.topProcesses')}
                      Icon={Activity}
                      offenders={offenders.hangs}
                    />
                    <p className="text-xs text-muted-foreground">
                      {t('deviceReliabilityPanel.distinctEvents', { window: offenderWindowText })}
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t('deviceReliabilityPanel.noOffenders', { window: offenderWindowText })}
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
