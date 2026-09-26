import { randomUUID } from 'node:crypto';

import { episodeKeyFor, type AttributionDimensionOrNull } from './metricAnomalyEpisodeKeys';

/**
 * Pure planner for the `episodes` stage (spec §5, §6). No DB, no clock.
 *
 * Per (device, episode_key) it sweeps the unassigned rows, plus the key's
 * current anchor episode as a pseudo-interval, into ISLANDS: a new island
 * starts when an item's start is more than `gapMinutes` after the running max
 * end. The gap is measured end-to-start in both directions (plan deviation 2).
 *
 *  - The island that contains the anchor attaches its rows to the anchor.
 *  - The LAST island, if it is not the anchor's, becomes the new open episode
 *    (or a snoozed successor while a snooze is live) and supersedes an open
 *    anchor — the partial unique index allows one open episode per key.
 *  - Every other island is created already closed ('historical'): a backfill
 *    orphan older than the anchor, or an older burst in the same batch.
 *    `cleanUntil` (the next island's start) bounds the clean-data check that
 *    decides its close_reason in SQL.
 *
 * Persistence gate (`minBuckets`): an island that would CREATE an episode
 * needs at least `minBuckets` distinct buckets. A shorter island is left
 * unassigned (pending) while another bucket could still join it, and becomes
 * a TRANSIENT once none can: its rows are closed `cleared` with no episode.
 * Rows that join an existing anchor are never gated. Prod (2026-09-26) had
 * 72% of episodes as single 5-minute blips — Defender scans, Windows Update,
 * indexers — which buried the sustained ones.
 */

export interface UnassignedAnomalyRow {
  id: string;
  deviceId: string;
  sourceTable: string;
  anomalyType: string;
  metricName: string;
  windowStart: Date;
  windowEnd: Date;
  score: number;
  observedValue: number;
  baselineValue: number | null;
}

export interface AnchorEpisode {
  id: string;
  deviceId: string;
  episodeKey: string;
  /** 'open', or a live snoozed successor (status dismissed, close_reason snoozed). */
  status: 'open' | 'dismissed';
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export type PlannedDisposition = 'open' | 'snoozed' | 'historical';
export type MemberStatus = 'open' | 'dismissed' | 'cleared';

export interface PlannedAttach {
  anomalyId: string;
  episodeId: string;
  memberStatus: MemberStatus;
  attributionDimension: AttributionDimensionOrNull;
}

export interface PlannedSupersede {
  episodeId: string;
  /** Start of the island that superseded it; clean data is counted up to here. */
  cleanUntil: Date;
}

export interface PlannedEpisode {
  id: string;
  deviceId: string;
  episodeKey: string;
  sourceTable: string;
  anomalyType: string;
  metricFamily: string;
  attributionDimension: AttributionDimensionOrNull;
  metricNames: string[];
  firstSeenAt: Date;
  lastSeenAt: Date;
  bucketCount: number;
  peakValue: number;
  peakMetricName: string;
  peakBaselineValue: number | null;
  peakScore: number;
  peakAt: Date;
  disposition: PlannedDisposition;
  snoozedUntil: Date | null;
  cleanUntil: Date | null;
  /** Closed episodes created earlier in this same batch for this key (added to the SQL recurrence count). */
  priorInBatch: number;
  memberIds: string[];
}

export interface EpisodeAssemblyPlan {
  anchorAttaches: PlannedAttach[];
  creates: PlannedEpisode[];
  supersedes: PlannedSupersede[];
  /** Rows of settled islands shorter than `minBuckets`: closed `cleared`, no episode. */
  transients: string[];
}

export interface PlanEpisodeAssemblyInput {
  rows: readonly UnassignedAnomalyRow[];
  anchors: readonly AnchorEpisode[];
  /** groupKeyOf(deviceId, episodeKey) -> snoozed_until of a live user snooze. */
  activeSnoozes: ReadonlyMap<string, Date>;
  gapMinutes: number;
  /** Distinct buckets an island needs before it may create an episode. */
  minBuckets: number;
  /**
   * End of the completed detection range. An island is settled (no bucket
   * can still join it) once its end + gap + one bucket <= this — the same
   * bound episode-resolve uses (A4). NULL: every island counts as settled.
   */
  settledBefore: Date | null;
  newId?: () => string;
}

export function groupKeyOf(deviceId: string, episodeKey: string): string {
  return `${deviceId}|${episodeKey}`;
}

export function memberStatusFor(disposition: PlannedDisposition): MemberStatus {
  if (disposition === 'open') return 'open';
  if (disposition === 'snoozed') return 'dismissed';
  return 'cleared';
}

interface GroupMeta {
  deviceId: string;
  sourceTable: string;
  anomalyType: string;
  episodeKey: string;
  metricFamily: string;
  attributionDimension: AttributionDimensionOrNull;
}

type IslandItem =
  | { kind: 'row'; row: UnassignedAnomalyRow; start: number; end: number }
  | { kind: 'anchor'; anchor: AnchorEpisode; start: number; end: number };

function chooseAnchor(candidates: readonly AnchorEpisode[]): AnchorEpisode | undefined {
  const open = candidates.find((candidate) => candidate.status === 'open');
  if (open) return open;
  return [...candidates].sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())[0];
}

function summarize(rows: readonly UnassignedAnomalyRow[]) {
  const first = rows[0]!;
  let firstSeen = first.windowStart;
  let lastSeen = first.windowEnd;
  let peak = first;
  const names = new Set<string>();
  const buckets = new Set<number>();
  for (const candidate of rows) {
    if (candidate.windowStart < firstSeen) firstSeen = candidate.windowStart;
    if (candidate.windowEnd > lastSeen) lastSeen = candidate.windowEnd;
    if (candidate.score > peak.score || (candidate.score === peak.score && candidate.windowStart < peak.windowStart)) {
      peak = candidate;
    }
    names.add(candidate.metricName);
    buckets.add(candidate.windowStart.getTime());
  }
  return {
    metricNames: [...names].sort(),
    firstSeenAt: firstSeen,
    lastSeenAt: lastSeen,
    bucketCount: buckets.size,
    peakValue: peak.observedValue,
    peakMetricName: peak.metricName,
    peakBaselineValue: peak.baselineValue,
    peakScore: peak.score,
    peakAt: peak.windowStart,
    memberIds: rows.map((candidate) => candidate.id),
  };
}

const BUCKET_MS = 5 * 60_000;

export function planEpisodeAssembly(input: PlanEpisodeAssemblyInput): EpisodeAssemblyPlan {
  const gapMs = input.gapMinutes * 60_000;
  const newId = input.newId ?? randomUUID;
  const settledBefore = input.settledBefore?.getTime() ?? Number.POSITIVE_INFINITY;

  const groups = new Map<string, { meta: GroupMeta; rows: UnassignedAnomalyRow[] }>();
  for (const candidate of input.rows) {
    const key = episodeKeyFor(candidate.sourceTable, candidate.anomalyType, candidate.metricName);
    const groupKey = groupKeyOf(candidate.deviceId, key.episodeKey);
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        meta: {
          deviceId: candidate.deviceId,
          sourceTable: candidate.sourceTable,
          anomalyType: candidate.anomalyType,
          episodeKey: key.episodeKey,
          metricFamily: key.metricFamily,
          attributionDimension: key.attributionDimension,
        },
        rows: [],
      };
      groups.set(groupKey, group);
    }
    group.rows.push(candidate);
  }

  const anchorsByGroup = new Map<string, AnchorEpisode[]>();
  for (const candidate of input.anchors) {
    const groupKey = groupKeyOf(candidate.deviceId, candidate.episodeKey);
    anchorsByGroup.set(groupKey, [...(anchorsByGroup.get(groupKey) ?? []), candidate]);
  }

  const plan: EpisodeAssemblyPlan = { anchorAttaches: [], creates: [], supersedes: [], transients: [] };

  for (const groupKey of [...groups.keys()].sort()) {
    const { meta, rows } = groups.get(groupKey)!;
    const current = chooseAnchor(anchorsByGroup.get(groupKey) ?? []);

    const items: IslandItem[] = rows.map((candidate) => ({
      kind: 'row' as const,
      row: candidate,
      start: candidate.windowStart.getTime(),
      end: candidate.windowEnd.getTime(),
    }));
    if (current) {
      items.push({ kind: 'anchor', anchor: current, start: current.firstSeenAt.getTime(), end: current.lastSeenAt.getTime() });
    }
    items.sort((a, b) => a.start - b.start || (a.kind === b.kind ? 0 : a.kind === 'anchor' ? -1 : 1));

    const islands: IslandItem[][] = [];
    let runningEnd = Number.NEGATIVE_INFINITY;
    for (const item of items) {
      if (islands.length === 0 || item.start > runningEnd + gapMs) islands.push([]);
      islands[islands.length - 1]!.push(item);
      runningEnd = Math.max(runningEnd, item.end);
    }

    const anchorIdx = islands.findIndex((island) => island.some((item) => item.kind === 'anchor'));
    // Islands too short to open an episode drop out here: transient once
    // settled, otherwise pending (left unassigned for the next tick). Neither
    // supersedes the anchor nor counts toward recurrence.
    const eligible = islands.filter((island, idx) => {
      if (idx === anchorIdx) return true;
      const islandRows = island.flatMap((item) => (item.kind === 'row' ? [item.row] : []));
      if (new Set(islandRows.map((candidate) => candidate.windowStart.getTime())).size >= input.minBuckets) return true;
      const islandEnd = Math.max(...island.map((item) => item.end));
      const settled = idx < islands.length - 1 || islandEnd + gapMs + BUCKET_MS <= settledBefore;
      if (settled) plan.transients.push(...islandRows.map((candidate) => candidate.id));
      return false;
    });
    islands.splice(0, islands.length, ...eligible);
    const anchorIdxAfter = islands.findIndex((island) => island.some((item) => item.kind === 'anchor'));
    const lastIdx = islands.length - 1;
    const snoozedUntil = input.activeSnoozes.get(groupKey) ?? null;
    let createdInGroup = 0;

    islands.forEach((island, idx) => {
      const islandRows = island.flatMap((item) => (item.kind === 'row' ? [item.row] : []));
      if (idx === anchorIdxAfter && current) {
        const memberStatus: MemberStatus = current.status === 'open' ? 'open' : 'dismissed';
        for (const candidate of islandRows) {
          plan.anchorAttaches.push({
            anomalyId: candidate.id,
            episodeId: current.id,
            memberStatus,
            attributionDimension: meta.attributionDimension,
          });
        }
        return;
      }

      const isHead = idx === lastIdx;
      if (isHead && current && current.status === 'open' && anchorIdxAfter >= 0 && anchorIdxAfter < idx) {
        plan.supersedes.push({ episodeId: current.id, cleanUntil: new Date(island[0]!.start) });
      }
      // A3: only the HEAD island can become a snoozed successor. An older
      // island (backfill orphan, earlier burst in this batch) is history even
      // while a snooze is live — it closed before the snooze mattered.
      const disposition: PlannedDisposition = isHead ? (snoozedUntil ? 'snoozed' : 'open') : 'historical';
      plan.creates.push({
        id: newId(),
        ...meta,
        ...summarize(islandRows),
        disposition,
        snoozedUntil: disposition === 'snoozed' ? snoozedUntil : null,
        cleanUntil: disposition === 'historical' ? new Date(islands[idx + 1]![0]!.start) : null,
        priorInBatch: createdInGroup,
      });
      createdInGroup += 1;
    });
  }

  return plan;
}
