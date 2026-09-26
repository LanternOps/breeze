import { and, eq, lt, ne } from 'drizzle-orm';
import { db } from '../../db';
import { logCorrelationRules, logCorrelations, type LogCorrelationAffectedDevice } from '../../db/schema/eventLogs';
import { devices } from '../../db/schema/devices';
import { metricAnomalyEpisodes } from '../../db/schema/metricAnomalyEpisodes';
import { deviceReliability } from '../../db/schema/reliability';
import { metricFamilyLabel } from '../metricAnomalyEpisodeKeys';
import type { CandidateFinding, CandidateMember } from './types';

// Anomaly scores are sigma-like; >=4 matches the detectors' own hard-threshold
// tier for "critical" (see spec §5 / task-4 brief judgment calls).
const ANOMALY_MIN_DEVICES = 2;
const ANOMALY_CRITICAL_SCORE = 4;
const RELIABILITY_WARN_THRESHOLD = 50;
const RELIABILITY_ERROR_THRESHOLD = 25;
// Evidence is a bounded preview for the UI, not the source of truth — the
// junction table (`members`) always carries every affected device.
const MAX_EVIDENCE_SAMPLES = 20;

/**
 * The devices a fleet finding is allowed to name: real, still-managed machines.
 * `isEphemeral = false` is the codebase-standard Quick Support exclusion used
 * throughout services/*.ts; decommissioned devices are retired hardware, not
 * fleet hygiene offenders, and nothing can be remediated on them. Every
 * producer applies BOTH predicates so `fleet_findings.device_count`
 * (candidate.members.length) matches what `getFleetFinding` renders — that
 * reader innerJoins `devices`, so an ineligible member would make the feed
 * badge and the drawer disagree.
 */
async function loadEligibleDeviceIds(orgId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: devices.id })
    .from(devices)
    .where(and(
      eq(devices.orgId, orgId),
      eq(devices.isEphemeral, false),
      ne(devices.status, 'decommissioned'),
    ));
  return new Set(rows.map((r) => r.id));
}

/**
 * Groups OPEN `metric_anomaly_episodes` by (anomaly_type, metric_family) into
 * fleet-wide candidate findings. A group only becomes a candidate once at
 * least ANOMALY_MIN_DEVICES distinct devices are affected — a single device
 * spiking isn't a fleet pattern.
 *
 * Episodes, not raw `metric_anomalies` rows (#6650 follow-up): raw rows never
 * assembled into an episode (the pre-release backlog) stay `open` forever and
 * kept findings alive for days, and the raw grain split one pattern across the
 * `_sum`/`_max` metric pair that an episode family already folds into one.
 * Episodes auto-resolve, so a finding clears when its episodes do. Snoozed
 * episodes are `dismissed`, so `status = 'open'` excludes them too.
 *
 * The semantic key is `episode:<anomaly_type>:<metric_family>`. Moving off the
 * old `metric:<metric_name>:<anomaly_type>` form deliberately did NOT bump
 * FLEET_FINDINGS_ALGORITHM_VERSION: reconcile resolves every live row of the
 * current version that no candidate re-emits (`source_cleared`), which closes
 * the old-key rows on the first pass. A version bump would hide them from
 * reconcile (its live query is version-scoped) while the feed, which is not,
 * kept showing them — open forever.
 *
 * Ineligible devices are dropped by the `devices` innerJoin, BEFORE the
 * ANOMALY_MIN_DEVICES test — a pattern that only holds because two Quick
 * Support boxes spiked is not a fleet pattern at all.
 */
export async function produceMetricAnomalyPatterns(orgId: string): Promise<CandidateFinding[]> {
  const rows = await db
    .select({
      id: metricAnomalyEpisodes.id,
      deviceId: metricAnomalyEpisodes.deviceId,
      anomalyType: metricAnomalyEpisodes.anomalyType,
      metricFamily: metricAnomalyEpisodes.metricFamily,
      peakMetricName: metricAnomalyEpisodes.peakMetricName,
      peakScore: metricAnomalyEpisodes.peakScore,
      peakValue: metricAnomalyEpisodes.peakValue,
      peakBaselineValue: metricAnomalyEpisodes.peakBaselineValue,
    })
    .from(metricAnomalyEpisodes)
    .innerJoin(devices, eq(metricAnomalyEpisodes.deviceId, devices.id))
    .where(and(
      eq(metricAnomalyEpisodes.orgId, orgId),
      eq(metricAnomalyEpisodes.status, 'open'),
      eq(devices.isEphemeral, false),
      ne(devices.status, 'decommissioned'),
    ));

  type EpisodeRow = (typeof rows)[number];

  const groups = new Map<string, EpisodeRow[]>();
  for (const row of rows) {
    const key = `${row.anomalyType}:${row.metricFamily}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  const candidates: CandidateFinding[] = [];
  for (const groupRows of groups.values()) {
    // At most one OPEN episode exists per (device, episode_key), but the key
    // also carries source_table, so one (anomaly_type, family) pair can still
    // map to several episodes on a device — collapse to one member per device,
    // keeping the worst (highest peak_score) so the finding-devices junction
    // never sees a duplicate (finding_id, device_id) pair.
    const byDevice = new Map<string, EpisodeRow>();
    for (const row of groupRows) {
      const existing = byDevice.get(row.deviceId);
      if (!existing || row.peakScore > existing.peakScore) byDevice.set(row.deviceId, row);
    }
    const deviceRows = [...byDevice.values()];
    if (deviceRows.length < ANOMALY_MIN_DEVICES) continue;

    const { metricFamily, anomalyType } = deviceRows[0]!;
    const maxScore = Math.max(...deviceRows.map((r) => r.peakScore));
    const severity: CandidateFinding['severity'] = maxScore >= ANOMALY_CRITICAL_SCORE ? 'critical' : 'warning';
    const familyLabel = metricFamilyLabel(metricFamily);

    const members: CandidateMember[] = deviceRows.map((r) => ({
      deviceId: r.deviceId,
      sourceKind: 'metric_anomaly_episode',
      sourceRowId: r.id,
      memberEvidence: {
        score: r.peakScore,
        observedValue: r.peakValue,
        baselineValue: r.peakBaselineValue,
        metricName: r.peakMetricName,
        metricFamily: r.metricFamily,
      },
    }));

    const samples = [...deviceRows]
      .sort((a, b) => b.peakScore - a.peakScore)
      .slice(0, MAX_EVIDENCE_SAMPLES)
      .map((r) => ({
        deviceId: r.deviceId,
        score: r.peakScore,
        observedValue: r.peakValue,
        baselineValue: r.peakBaselineValue,
        metricName: r.peakMetricName,
      }));

    candidates.push({
      kind: 'metric_anomaly_pattern',
      semanticKey: `episode:${anomalyType}:${metricFamily}`,
      severity,
      title: `${familyLabel} ${anomalyType} pattern on ${deviceRows.length} devices`,
      summary: `${deviceRows.length} devices have an open ${anomalyType} episode on ${familyLabel} (max score ${maxScore.toFixed(2)}).`,
      evidence: { totalDevices: deviceRows.length, metricFamily, anomalyType, maxScore, samples },
      members,
    });
  }

  return candidates;
}

/**
 * Maps active `log_correlations` rows onto candidate findings, one per rule
 * (spec: "1:1", grouped defensively by rule id in case more than one active
 * correlation row exists concurrently for the same rule).
 *
 * Unlike the other two producers this one CANNOT innerJoin `devices`:
 * `log_correlations` has no device_id column at all — its affected devices live
 * in the `affected_devices` jsonb snapshot, written once when the correlation
 * fired. That snapshot has no FK, so it is also the only producer input that
 * can still name a DELETED device. Filtering the decoded members against
 * loadEligibleDeviceIds is the set-membership equivalent of the join.
 */
export async function produceLogCorrelationFindings(orgId: string): Promise<CandidateFinding[]> {
  const rows = await db
    .select({
      id: logCorrelations.id,
      ruleId: logCorrelations.ruleId,
      pattern: logCorrelations.pattern,
      occurrences: logCorrelations.occurrences,
      affectedDevices: logCorrelations.affectedDevices,
      ruleName: logCorrelationRules.name,
      ruleSeverity: logCorrelationRules.severity,
    })
    .from(logCorrelations)
    .innerJoin(logCorrelationRules, eq(logCorrelations.ruleId, logCorrelationRules.id))
    .where(and(eq(logCorrelations.orgId, orgId), eq(logCorrelations.status, 'active')));

  if (rows.length === 0) return [];

  const eligibleDeviceIds = await loadEligibleDeviceIds(orgId);

  type CorrelationRow = (typeof rows)[number];

  const groups = new Map<string, CorrelationRow[]>();
  for (const row of rows) {
    const group = groups.get(row.ruleId);
    if (group) group.push(row);
    else groups.set(row.ruleId, [row]);
  }

  const candidates: CandidateFinding[] = [];
  for (const [ruleId, groupRows] of groups) {
    const byDevice = new Map<string, { deviceId: string; hostname: string | null; count: number; sourceRowId: string }>();
    for (const row of groupRows) {
      const affected = (row.affectedDevices ?? []) as LogCorrelationAffectedDevice[];
      for (const device of affected) {
        if (!eligibleDeviceIds.has(device.deviceId)) continue;
        const existing = byDevice.get(device.deviceId);
        if (existing) existing.count += device.count;
        else byDevice.set(device.deviceId, { deviceId: device.deviceId, hostname: device.hostname, count: device.count, sourceRowId: row.id });
      }
    }
    const deviceEntries = [...byDevice.values()];
    if (deviceEntries.length === 0) continue;

    const first = groupRows[0]!;
    const totalOccurrences = groupRows.reduce((sum, r) => sum + r.occurrences, 0);
    const label = first.ruleName ?? first.pattern;

    const members: CandidateMember[] = deviceEntries.map((d) => ({
      deviceId: d.deviceId,
      sourceKind: 'log_correlation',
      sourceRowId: d.sourceRowId,
      memberEvidence: { hostname: d.hostname, count: d.count },
    }));

    const samples = [...deviceEntries]
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_EVIDENCE_SAMPLES)
      .map((d) => ({ deviceId: d.deviceId, hostname: d.hostname, count: d.count }));

    candidates.push({
      kind: 'log_correlation',
      semanticKey: `logcorr:${ruleId}`,
      severity: first.ruleSeverity,
      title: `Log pattern: ${label}`,
      summary: `${deviceEntries.length} devices matched "${label}" (${totalOccurrences} occurrences).`,
      evidence: { totalDevices: deviceEntries.length, totalOccurrences, samples },
      members,
    });
  }

  return candidates;
}

/**
 * A single org-wide finding for devices whose reliability score has dropped
 * below RELIABILITY_WARN_THRESHOLD. Ephemeral (Quick Support) and
 * decommissioned devices are excluded via the same predicates every producer
 * applies (see loadEligibleDeviceIds). Note this producer is STRICTER than its
 * own data source: reliabilityScoring.ts scores ephemeral devices too (it carries no
 * ephemeral filter), so `device_reliability` legitimately holds rows this
 * query drops. Do not "fix" the discrepancy by removing the filter — a Quick
 * Support device that existed for ten minutes is not a fleet hygiene offender.
 */
export async function produceReliabilityOffenders(orgId: string): Promise<CandidateFinding[]> {
  const rows = await db
    .select({
      deviceId: deviceReliability.deviceId,
      reliabilityScore: deviceReliability.reliabilityScore,
    })
    .from(deviceReliability)
    .innerJoin(devices, eq(deviceReliability.deviceId, devices.id))
    .where(and(
      eq(deviceReliability.orgId, orgId),
      lt(deviceReliability.reliabilityScore, RELIABILITY_WARN_THRESHOLD),
      eq(devices.isEphemeral, false),
      ne(devices.status, 'decommissioned'),
    ));

  if (rows.length === 0) return [];

  const severity: CandidateFinding['severity'] = rows.some((r) => r.reliabilityScore < RELIABILITY_ERROR_THRESHOLD)
    ? 'error'
    : 'warning';

  const members: CandidateMember[] = rows.map((r) => ({
    deviceId: r.deviceId,
    sourceKind: 'device_reliability',
    sourceRowId: null,
    memberEvidence: { reliabilityScore: r.reliabilityScore },
  }));

  const samples = [...rows]
    .sort((a, b) => a.reliabilityScore - b.reliabilityScore)
    .slice(0, MAX_EVIDENCE_SAMPLES)
    .map((r) => ({ deviceId: r.deviceId, reliabilityScore: r.reliabilityScore }));

  return [{
    kind: 'reliability_offenders',
    semanticKey: 'reliability:offenders',
    severity,
    title: `Low reliability: ${rows.length} devices below ${RELIABILITY_WARN_THRESHOLD}`,
    summary: `${rows.length} devices have a reliability score below ${RELIABILITY_WARN_THRESHOLD}.`,
    evidence: { totalDevices: rows.length, threshold: RELIABILITY_WARN_THRESHOLD, samples },
    members,
  }];
}
