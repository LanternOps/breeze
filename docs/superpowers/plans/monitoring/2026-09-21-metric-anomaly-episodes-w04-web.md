# Metric Anomaly Episodes — W04 Web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `DeviceAnomaliesPanel` and its supporting web code against the episode API (W02) so
a tech sees one sentence card per event instead of one row per 5-minute bucket, with filters,
recurrence/snooze/promotion chips, a lazily-loaded member table, and an alert deep link that
prefers the episode over the bucket.

**Architecture:** Split the existing 716-line `DeviceAnomaliesPanel.tsx` into a thin container
(`DeviceAnomaliesPanel.tsx`: fetch, filter state, empty/error/loading states, compact mode) plus two
new presentational files (`AnomalyEpisodeCard.tsx`, `AnomalyEpisodeMembers.tsx`) and one new pure
formatting module (`anomalyEpisodeSentence.ts`, unit-tested in isolation, no React/fetch). A small,
targeted change lands in `alertMlContext.ts` and the two alert-detail screens so an alert created by
promotion links to `#anomalies/<episodeId>` instead of the bucket id.

**Tech Stack:** React + TypeScript (Astro island), Vitest + `@testing-library/react` + jsdom,
`react-i18next`, Tailwind, `lucide-react`, `runAction`/`fetchWithAuth`.

**Spec:** `docs/superpowers/specs/monitoring/2026-09-21-metric-anomaly-episodes-design.md`
(cited as §N below). Cross-wave interface contract:
`docs/superpowers/plans/monitoring/2026-09-21-metric-anomaly-episodes.md`.

## Global Constraints

- All mutations go through `runAction`/`handleActionError` (`apps/web/src/lib/runAction.ts`) —
  every PATCH in this plan is wrapped; no bare `fetchWithAuth` mutation. New files that call a
  mutating `fetchWithAuth` must be added to `TARGET_GLOBS` in
  `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (Task 6).
- No query-param UI state; `window.location.hash` only, and only for what already lives there
  (`#anomalies/<id>`, parsed by `anomalyIdFromHash` in `DeviceDetails.tsx`, untouched by this plan).
  The new Open/Recently-closed/All filter is local `useState`, not hash — noted as a decision, not
  a rule violation, in Task 5's step notes.
- `data-testid` on every card, chip, and action per the repo's e2e convention (`e2e-tests/README.md`)
  even though no e2e spec exists yet for this panel (confirmed: `grep -rln metric-anomaly
  e2e-tests/` found nothing to update).
- Every locale file under `apps/web/src/locales/*/devices.json` must carry the same key set
  (`localeParity.test.ts`) with real, non-English text where the source string has translatable
  content (`translationCoverage.test.ts` caps new English-identical duplicates per namespace).
- Copy lives under `deviceAnomaliesPanel.*` in `devices.json`, matching the existing panel's keys.
- `formatEpisodeSentence(episode, t) → { headline: string; attributionLine: string }` (plain
  strings, no markdown) is the exact signature fixed by the cross-wave contract — do not change it.
- Treat W01 + W02 deliverables as already merged and **import, never redefine**, their shared
  types from `@breeze/shared` (`packages/shared/src/types/metricAnomalyEpisodes.ts`; pattern:
  `apps/web/src/components/devices/DeviceAiActivitySignal.tsx:5`, `DeviceScriptHistory.tsx:25,28`):
  W01 `MetricAnomalyStatus`, `MetricAnomalyEpisodeStatus`, `EpisodeCloseReason`,
  `AttributionDimension`, `AttributionSnapshot`, `EpisodeAttribution`; W02 `MetricAnomalyEpisodeDto`
  (incl. `rangeMin`/`rangeMax: number | null`, `peakAnomalyId: string | null`),
  `MetricAnomalyEpisodeMemberDto`, `MetricAnomalyEpisodeDetailDto`,
  `MetricAnomalyEpisodeListResponse`, `EpisodeAction`, `EPISODE_DETAIL_MEMBER_LIMIT`.
- The endpoints are registered on the existing `anomaliesRoutes` (`apps/api/src/routes/devices/anomalies.ts`,
  W02 deviation D-3 — there is no `anomalyEpisodesRoutes`). Exact envelopes (W02 Task 6):
  - `GET /devices/:id/anomaly-episodes?status=open|closed|all&limit=1..100&ref=<uuid>` →
    `MetricAnomalyEpisodeListResponse` = `{ data: MetricAnomalyEpisodeDto[]; focusedEpisodeId: string | null }`.
    `focusedEpisodeId` is the episode `ref` resolved to (always `data[0]` when non-null) — `ref` may be
    an episode id **or** a member anomaly id (legacy alert deep links), so the focus ring keys on
    `focusedEpisodeId`, never on `ref` itself.
  - `GET /devices/:id/anomaly-episodes/:episodeId` → `{ data: MetricAnomalyEpisodeDetailDto }`
    (DTO + `members` ≤ 200 by `window_start` + `membersTruncated`).
  - `PATCH /devices/:id/anomaly-episodes/:episodeId` `{ action, note?, resolveAlert? }` →
    `{ data: MetricAnomalyEpisodeDto; meta: { alertId: string | null; alertResolved: boolean; labelledMembers: number } }`;
    `409 { error, reason }` when the episode changed underneath (closed, already promoted, not
    snoozed) — `runAction` toasts `error`; the card then asks the panel to refetch.

## Spec deviations / assumptions (flag for review)

1. **"N detections" = `bucketCount` = distinct anomalous 5-minute buckets** (W01 deviation 4), not
   member rows. The cpu/ram process pairs write two member rows per bucket, so the expanded member
   table can hold more rows than the chip's number; the table therefore shows a Metric column. The
   spec's example ("17 detections") is unchanged.
2. **Remediation keys on the peak member, not the episode.** Spec §13 item 4 renders remediation
   suggestions inside an open card; `RemediationSuggestionsPanel` is keyed `sourceType: 'anomaly'` +
   a `metric_anomalies.id`. The card passes W02's `peakAnomalyId` (W02 deviation D-9) and renders
   nothing when it is null.
3. **Filter selection (Open/Recently closed/All) is local `useState`, not `window.location.hash`.**
   CLAUDE.md's hash-state rule is aimed at state that should survive a reload/share; the hash
   position after `#anomalies/` is already reserved for the focused episode id by
   `anomalyIdFromHash` in `DeviceDetails.tsx`, and overloading it with a second segment would need a
   parser change outside this plan's stated scope (`DeviceDetails.tsx` mounts, listed as read-only
   context). Reversible, low-risk, noted per CLAUDE.md's "proceed without asking" guidance.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/web/src/components/devices/anomalyEpisodeSentence.ts` | **New.** Pure formatting: `formatEpisodeSentence`, `formatMetricValue`, `formatDuration`, `familyLabel`, `ordinal`. No React, no fetch — fully unit-testable. |
| `apps/web/src/components/devices/anomalyEpisodeSentence.test.ts` | **New.** Exhaustive per-family/per-type cases (spec §16). |
| `apps/web/src/components/devices/AnomalyEpisodeMembers.tsx` | **New.** Lazy-loaded member table for one episode. |
| `apps/web/src/components/devices/AnomalyEpisodeMembers.test.tsx` | **New.** |
| `apps/web/src/components/devices/AnomalyEpisodeCard.tsx` | **New.** One episode: sentence, attribution line, chips, actions (`runAction`), remediation/v1-shadow gating, member table toggle. |
| `apps/web/src/components/devices/AnomalyEpisodeCard.test.tsx` | **New.** |
| `apps/web/src/components/devices/DeviceAnomaliesPanel.tsx` | **Rewritten** (was per-row list; becomes the container: fetch episodes, filter pills, empty/error/loading, compact mode, refresh). |
| `apps/web/src/components/devices/DeviceAnomaliesPanel.test.tsx` | **Rewritten** against the episode API. |
| `apps/web/src/components/alerts/alertMlContext.ts` | **Modified.** `episodeId` on `MetricAnomalyAlertContext`; parsed in `normalizeMetricAnomalyContext`. |
| `apps/web/src/components/alerts/alertMlContext.test.ts` | **New** (none exists today — confirmed by `find`). |
| `apps/web/src/components/alerts/AlertDetails.tsx` | **Modified.** Deep link prefers `episodeId`. |
| `apps/web/src/components/alerts/AlertDetailPage.tsx` | **Modified.** Same. |
| `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` | **Modified.** Add `AnomalyEpisodeCard.tsx` to `TARGET_GLOBS`. |
| `apps/web/src/locales/en/devices.json` (+ 7 other locales) | **Modified.** New `deviceAnomaliesPanel.*` keys. |

---

### Task 1: `anomalyEpisodeSentence.ts` — pure sentence + value formatting

**Files:**
- Create: `apps/web/src/components/devices/anomalyEpisodeSentence.ts`
- Create: `apps/web/src/components/devices/anomalyEpisodeSentence.test.ts`

**Interfaces:**
- Consumes: nothing new (pure functions over primitives + `MetricAnomalyEpisodeDto` fields).
- Produces:
  - `formatEpisodeSentence(episode: EpisodeSentenceInput, t: TFunction): { headline: string; attributionLine: string }`
  - `formatMetricValue(metricName: string, value: number): string`
  - `formatDuration(seconds: number, t: TFunction): string`
  - `familyLabel(metricFamily: string, t: TFunction): string`
  - `ordinal(n: number): string` (1 → '1st', 2 → '2nd', 3 → '3rd', 4 → '4th', 11 → '11th', ...)
  - `type EpisodeSentenceInput` — `Pick<MetricAnomalyEpisodeDto, 'anomalyType' | 'metricFamily' |
    'peakMetricName' | 'rangeMin' | 'rangeMax' | 'peakValue' | 'peakBaselineValue' |
    'durationSeconds'> & { attribution: { opened?: AttributionSnapshotLike; peak?: AttributionSnapshotLike } | null }`,
    where `AttributionSnapshotLike = Pick<AttributionSnapshot, 'dimension' | 'processes'>` (W01's
    shared type minus `sampledAt`, so a full `MetricAnomalyEpisodeDto` is assignable and test
    fixtures stay short). `rangeMin`/`rangeMax` are `number | null` (W02 DTO); the formatter falls
    back to `peakValue` when either is null.
  - Later tasks (2-5) import all of the above from this file.

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/web/src/components/devices/anomalyEpisodeSentence.test.ts
import { describe, expect, it } from 'vitest';
import {
  formatDuration,
  formatEpisodeSentence,
  formatMetricValue,
  ordinal,
} from './anomalyEpisodeSentence';
import { i18n } from '../../lib/i18n';
import '../../lib/i18n';

const t = i18n.getFixedT('en', 'devices');

describe('formatMetricValue', () => {
  it('formats a percent metric', () => {
    expect(formatMetricValue('cpu_percent', 96.4)).toBe('96.4%');
  });
  it('formats a bps metric in MB/s', () => {
    expect(formatMetricValue('disk_write_bps', 86_000_000)).toBe('86.0 MB/s');
  });
  it('formats a bps metric in KB/s', () => {
    expect(formatMetricValue('bandwidth_out_bps', 200_000)).toBe('200.0 KB/s');
  });
  it('formats an mb metric', () => {
    expect(formatMetricValue('top_process_ram_mb_max', 2355)).toBe('2355 MB');
  });
  it('formats a gb metric', () => {
    expect(formatMetricValue('disk_used_gb', 6.4)).toBe('6.4 GB');
  });
  it('falls back to a plain number', () => {
    expect(formatMetricValue('process_count', 214)).toBe('214');
  });
  it('treats a non-finite value as zero', () => {
    expect(formatMetricValue('cpu_percent', NaN)).toBe('0');
  });
});

describe('formatDuration', () => {
  it('formats minutes under an hour', () => {
    expect(formatDuration(25 * 60, t)).toBe('25 m');
  });
  it('formats hours and minutes', () => {
    expect(formatDuration(80 * 60, t)).toBe('1 h 20 m');
  });
  it('formats an exact hour with no minute remainder', () => {
    expect(formatDuration(3600, t)).toBe('1 h');
  });
  it('formats under a minute', () => {
    expect(formatDuration(40, t)).toBe('<1 m');
  });
});

describe('ordinal', () => {
  it.each([
    [1, '1st'], [2, '2nd'], [3, '3rd'], [4, '4th'],
    [11, '11th'], [12, '12th'], [13, '13th'], [21, '21st'], [22, '22nd'], [23, '23rd'],
  ])('formats %i as %s', (n, expected) => {
    expect(ordinal(n)).toBe(expected);
  });
});

describe('formatEpisodeSentence', () => {
  it('spike on a plain device_metrics family, range of values', () => {
    const { headline, attributionLine } = formatEpisodeSentence({
      anomalyType: 'spike',
      metricFamily: 'disk_write',
      peakMetricName: 'disk_write_bps',
      rangeMin: 86_000_000,
      rangeMax: 153_000_000,
      peakValue: 153_000_000,
      peakBaselineValue: 6_000_000,
      durationSeconds: 80 * 60,
      attribution: null,
    }, t);
    expect(headline).toBe('Disk write has been 86.0–153.0 MB/s for 1 h 20 m, normally 6.0 MB/s.');
    expect(attributionLine).toBe('Process detail not available for this metric.');
  });

  it('single-bucket range prints one value, not a dash range', () => {
    const { headline } = formatEpisodeSentence({
      anomalyType: 'spike',
      metricFamily: 'cpu',
      peakMetricName: 'cpu_percent',
      rangeMin: 96.4,
      rangeMax: 96.4,
      peakValue: 96.4,
      peakBaselineValue: 42.2,
      durationSeconds: 5 * 60,
      attribution: null,
    }, t);
    expect(headline).toBe('CPU has been 96.4% for 5 m, normally 42.2%.');
  });

  it('network_egress uses the spike template', () => {
    const { headline } = formatEpisodeSentence({
      anomalyType: 'network_egress',
      metricFamily: 'net_out',
      peakMetricName: 'bandwidth_out_bps',
      rangeMin: 1_000_000,
      rangeMax: 1_000_000,
      peakValue: 1_000_000,
      peakBaselineValue: 100_000,
      durationSeconds: 10 * 60,
      attribution: null,
    }, t);
    expect(headline).toBe('Network out has been 1.0 MB/s for 10 m, normally 100.0 KB/s.');
  });

  it('process_runaway on a _max family reads "one process"', () => {
    const { headline } = formatEpisodeSentence({
      anomalyType: 'process_runaway',
      metricFamily: 'process_ram',
      peakMetricName: 'top_process_ram_mb_max',
      rangeMin: 1932.5,
      rangeMax: 2355,
      peakValue: 2355,
      peakBaselineValue: 614,
      durationSeconds: 15 * 60,
      attribution: null,
    }, t);
    expect(headline).toBe('One process reached 2355 MB, normally 614 MB.');
  });

  it('process_runaway on a _sum family reads "top processes together"', () => {
    const { headline } = formatEpisodeSentence({
      anomalyType: 'process_runaway',
      metricFamily: 'process_ram',
      peakMetricName: 'top_process_ram_mb_sum',
      rangeMin: 5200,
      rangeMax: 6500,
      peakValue: 6500,
      peakBaselineValue: 3200,
      durationSeconds: 15 * 60,
      attribution: null,
    }, t);
    expect(headline).toBe('Top processes together used 6500 MB, normally 3200 MB.');
  });

  it('drop', () => {
    const { headline } = formatEpisodeSentence({
      anomalyType: 'drop',
      metricFamily: 'cpu',
      peakMetricName: 'cpu_percent',
      rangeMin: 3,
      rangeMax: 3,
      peakValue: 3,
      peakBaselineValue: 41,
      durationSeconds: 25 * 60,
      attribution: null,
    }, t);
    expect(headline).toBe('CPU dropped to 3.0% for 25 m, normally 41.0%.');
  });

  it('memory_growth', () => {
    const { headline } = formatEpisodeSentence({
      anomalyType: 'memory_growth',
      metricFamily: 'ram_used',
      peakMetricName: 'ram_used_mb',
      rangeMin: 3100,
      rangeMax: 6400,
      peakValue: 6400,
      peakBaselineValue: null,
      durationSeconds: 45 * 60,
      attribution: null,
    }, t);
    expect(headline).toBe('RAM used grew from 3100 MB to 6400 MB over 45 m.');
  });

  it('disk_growth', () => {
    const { headline } = formatEpisodeSentence({
      anomalyType: 'disk_growth',
      metricFamily: 'disk_used',
      peakMetricName: 'disk_used_gb',
      rangeMin: 40,
      rangeMax: 88,
      peakValue: 88,
      peakBaselineValue: null,
      durationSeconds: 3 * 3600,
      attribution: null,
    }, t);
    expect(headline).toBe('Disk used grew from 40.0 GB to 88.0 GB over 3 h.');
  });

  it('attribution line renders the peak snapshot when present', () => {
    const { attributionLine } = formatEpisodeSentence({
      anomalyType: 'process_runaway',
      metricFamily: 'process_ram',
      peakMetricName: 'top_process_ram_mb_max',
      rangeMin: 1932.5,
      rangeMax: 2355,
      peakValue: 2355,
      peakBaselineValue: 614,
      durationSeconds: 15 * 60,
      attribution: {
        opened: { dimension: 'ramMb', processes: [{ name: 'chrome.exe', pid: 1, value: 900 }] },
        peak: {
          dimension: 'ramMb',
          processes: [
            { name: 'chrome.exe', pid: 4120, value: 1932.5 },
            { name: 'MsMpEng.exe', pid: 88, value: 400 },
            { name: 'Teams.exe', pid: 12, value: 300 },
          ],
        },
      },
    }, t);
    expect(attributionLine).toBe(
      'Top by RAM at peak: chrome.exe 1932.5 MB · MsMpEng.exe 400 MB · Teams.exe 300 MB',
    );
  });

  it('attribution line falls back to the opened snapshot when there is no peak snapshot', () => {
    const { attributionLine } = formatEpisodeSentence({
      anomalyType: 'spike',
      metricFamily: 'cpu',
      peakMetricName: 'cpu_percent',
      rangeMin: 96.4,
      rangeMax: 96.4,
      peakValue: 96.4,
      peakBaselineValue: 42.2,
      durationSeconds: 5 * 60,
      attribution: {
        opened: { dimension: 'cpu', processes: [{ name: 'python.exe', pid: 55, value: 88 }] },
      },
    }, t);
    expect(attributionLine).toBe('Top by CPU at peak: python.exe 88%');
  });

  it('attribution line says detail unavailable when the dimension has no processes', () => {
    const { attributionLine } = formatEpisodeSentence({
      anomalyType: 'spike',
      metricFamily: 'disk',
      peakMetricName: 'disk_percent',
      rangeMin: 90,
      rangeMax: 90,
      peakValue: 90,
      peakBaselineValue: 60,
      durationSeconds: 5 * 60,
      attribution: { peak: { dimension: 'diskBps', processes: [] } },
    }, t);
    expect(attributionLine).toBe('Process detail not available for this metric.');
  });

  it('null range (W02 found no member of the peak metric) prints the peak value alone', () => {
    const { headline } = formatEpisodeSentence({
      anomalyType: 'spike',
      metricFamily: 'cpu',
      peakMetricName: 'cpu_percent',
      rangeMin: null,
      rangeMax: null,
      peakValue: 96.4,
      peakBaselineValue: 42.2,
      durationSeconds: 5 * 60,
      attribution: null,
    }, t);
    expect(headline).toBe('CPU has been 96.4% for 5 m, normally 42.2%.');
  });

  it('an unmapped family falls back to its raw name, title-cased', () => {
    const { headline } = formatEpisodeSentence({
      anomalyType: 'spike',
      metricFamily: 'some_future_metric',
      peakMetricName: 'some_future_metric',
      rangeMin: 10,
      rangeMax: 10,
      peakValue: 10,
      peakBaselineValue: 5,
      durationSeconds: 60,
      attribution: null,
    }, t);
    expect(headline).toBe('Some future metric has been 10 for <1 m, normally 5.');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && npx vitest run src/components/devices/anomalyEpisodeSentence.test.ts`
Expected: FAIL — `Cannot find module './anomalyEpisodeSentence'`.

- [ ] **Step 3: Implement**

```typescript
// apps/web/src/components/devices/anomalyEpisodeSentence.ts
import type { TFunction } from 'i18next';
import type { AttributionDimension, AttributionSnapshot, MetricAnomalyEpisodeDto } from '@breeze/shared';
import { formatNumber, formatPercent } from '@/lib/i18n/format';

/** W01's snapshot minus `sampledAt` — the formatter never reads the time. */
export type AttributionSnapshotLike = Pick<AttributionSnapshot, 'dimension' | 'processes'>;

/** The subset of W02's DTO the formatter reads; a full MetricAnomalyEpisodeDto is assignable. */
export type EpisodeSentenceInput = Pick<
  MetricAnomalyEpisodeDto,
  | 'anomalyType'
  | 'metricFamily'
  | 'peakMetricName'
  | 'rangeMin'
  | 'rangeMax'
  | 'peakValue'
  | 'peakBaselineValue'
  | 'durationSeconds'
> & {
  attribution: { opened?: AttributionSnapshotLike; peak?: AttributionSnapshotLike } | null;
};

// Friendly labels for episode-key metric families (spec §4.2). Raw metric-name
// labels (cpu_percent → "CPU") already exist in the legacy panel; families are
// a different, smaller vocabulary (cpu, disk_write, process_ram, ...), so this
// map is new rather than reused.
const FAMILY_LABELS: Record<string, string> = {
  cpu: 'CPU',
  ram: 'RAM',
  ram_used: 'RAM used',
  disk: 'Disk',
  disk_used: 'Disk used',
  disk_read: 'Disk read',
  disk_write: 'Disk write',
  net_in: 'Network in',
  net_out: 'Network out',
  process_count: 'Process count',
  process_cpu: 'Process CPU',
  process_ram: 'Process RAM',
  process_disk: 'Process disk I/O',
  process_net: 'Process network I/O',
  process_count_top: 'Top process count',
};

const DIMENSION_LABELS: Record<AttributionDimension, string> = {
  cpu: 'CPU',
  ramMb: 'RAM',
  diskBps: 'disk I/O',
  netBps: 'network I/O',
};

export function familyLabel(metricFamily: string, _t: TFunction): string {
  return FAMILY_LABELS[metricFamily] ?? titleCase(metricFamily.replace(/_/g, ' '));
}

function titleCase(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

export function formatMetricValue(metricName: string, value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (metricName.endsWith('_percent'))
    return formatPercent(value / 100, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  if (metricName.includes('_bps')) {
    if (value >= 1_000_000_000)
      return `${formatNumber(value / 1_000_000_000, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} GB/s`;
    if (value >= 1_000_000)
      return `${formatNumber(value / 1_000_000, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB/s`;
    if (value >= 1_000)
      return `${formatNumber(value / 1_000, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} KB/s`;
    return `${Math.round(value)} B/s`;
  }
  if (metricName.endsWith('_mb')) return `${Math.round(value)} MB`;
  if (metricName.endsWith('_gb'))
    return `${formatNumber(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} GB`;
  return formatNumber(
    value,
    value >= 100 ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 1, maximumFractionDigits: 1 },
  );
}

export function formatDuration(seconds: number, _t: TFunction): string {
  if (!Number.isFinite(seconds) || seconds < 60) return '<1 m';
  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} m`;
  if (minutes === 0) return `${hours} h`;
  return `${hours} h ${minutes} m`;
}

export function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

function formatRange(metricName: string, min: number, max: number): string {
  if (min === max) return formatMetricValue(metricName, max);
  return `${formatMetricValue(metricName, min)}–${formatMetricValue(metricName, max)}`;
}

const PROCESS_PAIR_FAMILIES = new Set(['process_cpu', 'process_ram']);

export function formatEpisodeSentence(
  episode: EpisodeSentenceInput,
  t: TFunction,
): { headline: string; attributionLine: string } {
  const metric = familyLabel(episode.metricFamily, t);
  const duration = formatDuration(episode.durationSeconds, t);
  // W02 returns null when no member of the peak metric was found; one value then.
  const rangeMin = episode.rangeMin ?? episode.peakValue;
  const rangeMax = episode.rangeMax ?? episode.peakValue;
  const baseline = episode.peakBaselineValue == null
    ? t('deviceAnomaliesPanel.text')
    : formatMetricValue(episode.peakMetricName, episode.peakBaselineValue);

  let headline: string;
  if (PROCESS_PAIR_FAMILIES.has(episode.metricFamily) && episode.peakMetricName.endsWith('_max')) {
    headline = t('deviceAnomaliesPanel.sentence.processMax', {
      value: formatMetricValue(episode.peakMetricName, episode.peakValue),
      baseline,
      defaultValue: 'One process reached {{value}}, normally {{baseline}}.',
    });
  } else if (PROCESS_PAIR_FAMILIES.has(episode.metricFamily) && episode.peakMetricName.endsWith('_sum')) {
    headline = t('deviceAnomaliesPanel.sentence.processSum', {
      value: formatMetricValue(episode.peakMetricName, episode.peakValue),
      baseline,
      defaultValue: 'Top processes together used {{value}}, normally {{baseline}}.',
    });
  } else if (episode.anomalyType === 'drop') {
    headline = t('deviceAnomaliesPanel.sentence.drop', {
      metric,
      value: formatRange(episode.peakMetricName, rangeMin, rangeMax),
      duration,
      baseline,
      defaultValue: '{{metric}} dropped to {{value}} for {{duration}}, normally {{baseline}}.',
    });
  } else if (episode.anomalyType === 'memory_growth' || episode.anomalyType === 'disk_growth') {
    headline = t('deviceAnomaliesPanel.sentence.growth', {
      metric,
      from: formatMetricValue(episode.peakMetricName, rangeMin),
      to: formatMetricValue(episode.peakMetricName, rangeMax),
      duration,
      defaultValue: '{{metric}} grew from {{from}} to {{to}} over {{duration}}.',
    });
  } else {
    // spike / network_egress / process_runaway on a non-pair family.
    headline = t('deviceAnomaliesPanel.sentence.spike', {
      metric,
      range: formatRange(episode.peakMetricName, rangeMin, rangeMax),
      duration,
      baseline,
      defaultValue: '{{metric}} has been {{range}} for {{duration}}, normally {{baseline}}.',
    });
  }

  const snapshot = episode.attribution?.peak ?? episode.attribution?.opened ?? null;
  let attributionLine: string;
  if (!snapshot || snapshot.processes.length === 0) {
    attributionLine = t('deviceAnomaliesPanel.processDetailNotAvailable', {
      defaultValue: 'Process detail not available for this metric.',
    });
  } else {
    const dimensionLabel = DIMENSION_LABELS[snapshot.dimension];
    const list = snapshot.processes
      .map((p) => `${p.name} ${formatMetricValue(dimensionMetricName(snapshot.dimension), p.value)}`)
      .join(' · ');
    attributionLine = t('deviceAnomaliesPanel.topByAtPeak', {
      dimension: dimensionLabel,
      list,
      defaultValue: 'Top by {{dimension}} at peak: {{list}}',
    });
  }

  return { headline, attributionLine };
}

// formatMetricValue keys off a metric *name* suffix (_percent/_bps/_mb/_gb), not
// a dimension — pick a representative name per dimension so attribution values
// format the same way the sentence's own numbers do.
function dimensionMetricName(dimension: AttributionDimension): string {
  switch (dimension) {
    case 'cpu': return 'cpu_percent';
    case 'ramMb': return 'x_mb';
    case 'diskBps': return 'x_bps';
    case 'netBps': return 'x_bps';
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && npx vitest run src/components/devices/anomalyEpisodeSentence.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/devices/anomalyEpisodeSentence.ts apps/web/src/components/devices/anomalyEpisodeSentence.test.ts
git commit -m "$(cat <<'EOF'
feat(web): pure episode sentence formatter for the anomalies panel rewrite

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `alertMlContext.ts` — episode-preferring alert deep link

**Files:**
- Modify: `apps/web/src/components/alerts/alertMlContext.ts`
- Create: `apps/web/src/components/alerts/alertMlContext.test.ts`
- Modify: `apps/web/src/components/alerts/AlertDetails.tsx:236`
- Modify: `apps/web/src/components/alerts/AlertDetailPage.tsx:436`

**Interfaces:**
- Consumes: nothing new.
- Produces: `MetricAnomalyAlertContext.episodeId: string | null`, read by `AlertDetails.tsx` and
  `AlertDetailPage.tsx` to build the deep-link href.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/src/components/alerts/alertMlContext.test.ts
import { describe, expect, it } from 'vitest';
import { normalizeMetricAnomalyContext } from './alertMlContext';

describe('normalizeMetricAnomalyContext', () => {
  it('returns null for a non-metric_anomaly context', () => {
    expect(normalizeMetricAnomalyContext({ source: 'other' })).toBeNull();
    expect(normalizeMetricAnomalyContext(null)).toBeNull();
    expect(normalizeMetricAnomalyContext(undefined)).toBeNull();
  });

  it('parses episodeId alongside the legacy anomalyId', () => {
    const result = normalizeMetricAnomalyContext({
      source: 'metric_anomaly',
      anomalyId: 'anomaly-1',
      episodeId: 'episode-1',
      metricName: 'cpu_percent',
      metricType: 'system',
      anomalyType: 'spike',
      observedValue: 96.4,
      baselineValue: 42.2,
      confidence: 0.91,
      score: 8.1,
      modelVersion: null,
    });
    expect(result).toMatchObject({ anomalyId: 'anomaly-1', episodeId: 'episode-1' });
  });

  it('defaults episodeId to null when absent (pre-W02 alerts)', () => {
    const result = normalizeMetricAnomalyContext({
      source: 'metric_anomaly',
      anomalyId: 'anomaly-1',
    });
    expect(result?.episodeId).toBeNull();
  });

  it('rejects a non-string episodeId', () => {
    const result = normalizeMetricAnomalyContext({ source: 'metric_anomaly', episodeId: 42 });
    expect(result?.episodeId).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/alerts/alertMlContext.test.ts`
Expected: FAIL — `episodeId` not present on the returned object / TS error on `episodeId` field
under `toMatchObject` is a runtime assertion, so it fails at `expect(result?.episodeId).toBe(...)`
with `undefined !== 'episode-1'`.

- [ ] **Step 3: Implement**

```typescript
// apps/web/src/components/alerts/alertMlContext.ts — full file after the change
import { formatNumber, formatPercent } from '@/lib/i18n/format';

export type MetricAnomalyAlertContext = {
  source: 'metric_anomaly';
  anomalyId: string | null;
  episodeId: string | null;
  metricName: string | null;
  metricType: string | null;
  anomalyType: string | null;
  observedValue: number | null;
  baselineValue: number | null;
  confidence: number | null;
  score: number | null;
  modelVersion: string | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function normalizeMetricAnomalyContext(value: unknown): MetricAnomalyAlertContext | null {
  const context = asRecord(value);
  if (context.source !== 'metric_anomaly') return null;

  return {
    source: 'metric_anomaly',
    anomalyId: stringOrNull(context.anomalyId),
    // W02 stamps promoted alerts' context with episodeId (spec §12); alerts
    // promoted before that ships (or through the legacy per-row route) have
    // none, so this stays null rather than throwing on old data.
    episodeId: stringOrNull(context.episodeId),
    metricName: stringOrNull(context.metricName),
    metricType: stringOrNull(context.metricType),
    anomalyType: stringOrNull(context.anomalyType),
    observedValue: numberOrNull(context.observedValue),
    baselineValue: numberOrNull(context.baselineValue),
    confidence: numberOrNull(context.confidence),
    score: numberOrNull(context.score),
    modelVersion: stringOrNull(context.modelVersion),
  };
}

export function formatAnomalyType(value: string | null): string {
  return value ? value.replace(/_/g, ' ') : 'anomaly';
}

export function formatAnomalyValue(value: number | null): string {
  if (value === null) return 'n/a';
  return formatNumber(value, Number.isInteger(value) ? {} : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatAnomalyConfidence(value: number | null): string {
  if (value === null) return 'n/a';
  return formatPercent(value, { maximumFractionDigits: 0 });
}

/** `#anomalies/<episodeId>` when the alert was promoted under the episode
 *  system (W02+); falls back to the legacy `#anomalies/<anomalyId>` bucket
 *  deep link, then to the bare tab with no focus target. */
export function anomalyDeepLinkHash(context: MetricAnomalyAlertContext): string {
  const id = context.episodeId ?? context.anomalyId;
  return id ? `anomalies/${id}` : 'anomalies';
}
```

Now update the two call sites to use the helper instead of hand-building the hash inline (both
currently do `#anomalies${alert.anomalyContext.anomalyId ? `/${alert.anomalyContext.anomalyId}` : ''}`):

```typescript
// apps/web/src/components/alerts/AlertDetails.tsx — replace the href at line 236
import { anomalyDeepLinkHash, formatAnomalyConfidence, formatAnomalyType, formatAnomalyValue } from './alertMlContext';
// ...
              <a
                href={`/devices/${alert.deviceId}#${anomalyDeepLinkHash(alert.anomalyContext)}`}
                className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-sky-700 hover:underline"
              >
```

```typescript
// apps/web/src/components/alerts/AlertDetailPage.tsx — replace the href at line 436
              href={`/devices/${alert.deviceId}#${anomalyDeepLinkHash(alert.anomalyContext)}`}
```

(Add `anomalyDeepLinkHash` to `AlertDetailPage.tsx`'s existing import from `./alertMlContext` —
check the top-of-file import list before editing; it already imports `formatAnomalyType` etc. per
the earlier grep of both files.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && npx vitest run src/components/alerts/alertMlContext.test.ts`
Expected: PASS.

Then run the existing alert suites to confirm the href change didn't regress them:

Run: `cd apps/web && npx vitest run src/components/alerts/AlertDetails.test.tsx src/components/alerts/AlertDetailPage.test.tsx`
Expected: PASS (or, if either test asserts the exact old href string literally, update that
assertion to the new `anomalyDeepLinkHash` output — same value when `episodeId` is absent, so most
existing fixtures need no change).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/alerts/alertMlContext.ts apps/web/src/components/alerts/alertMlContext.test.ts apps/web/src/components/alerts/AlertDetails.tsx apps/web/src/components/alerts/AlertDetailPage.tsx
git commit -m "$(cat <<'EOF'
feat(web): prefer episode id over anomaly id in the alert deep link

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `AnomalyEpisodeMembers.tsx` — lazy-loaded member table

**Files:**
- Create: `apps/web/src/components/devices/AnomalyEpisodeMembers.tsx`
- Create: `apps/web/src/components/devices/AnomalyEpisodeMembers.test.tsx`

**Interfaces:**
- Consumes: `formatMetricValue` from `./anomalyEpisodeSentence` (Task 1); `fetchWithAuth` from
  `../../stores/auth`; `formatDateTime` from `@/lib/dateTimeFormat`; W02's
  `MetricAnomalyEpisodeDetailDto` / `MetricAnomalyEpisodeMemberDto` (`@breeze/shared`, type-only).
  No local member type — the row type is W02's `MetricAnomalyEpisodeMemberDto` (`id, metricName,
  anomalyType, status: MetricAnomalyStatus, windowStart, windowEnd, observedValue, baselineValue,
  baselineMax, score, confidence, linkedAlertId`).
- Produces:
  - `export default function AnomalyEpisodeMembers({ deviceId, episodeId }: { deviceId: string; episodeId: string })` — fetches `GET /devices/:deviceId/anomaly-episodes/:episodeId` on mount, reads `json.data.members` / `json.data.membersTruncated` (envelope `{ data: MetricAnomalyEpisodeDetailDto }`), and renders the member table (window, metric, observed, baseline, score) plus a "showing the first N" note when truncated. Read-only: no actions here (spec §12: legacy per-row PATCH stays server-side for alert deep links, but "the web UI stops offering per-row actions").

- [ ] **Step 1: Write the failing test**

```typescript
// apps/web/src/components/devices/AnomalyEpisodeMembers.test.tsx
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AnomalyEpisodeMembers from './AnomalyEpisodeMembers';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

describe('AnomalyEpisodeMembers', () => {
  beforeEach(() => vi.clearAllMocks());

  const member = {
    id: 'anomaly-1', metricName: 'cpu_percent', anomalyType: 'spike', status: 'cleared',
    windowStart: '2026-06-18T12:00:00.000Z', windowEnd: '2026-06-18T12:05:00.000Z',
    observedValue: 96.4, baselineValue: 42.2, baselineMax: 60, score: 8.1, confidence: 0.91, linkedAlertId: null,
  };

  it('fetches the W02 detail envelope and renders member rows on mount', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({
      data: { id: 'episode-1', members: [member], membersTruncated: false },
    }));

    render(<AnomalyEpisodeMembers deviceId="dev-1" episodeId="episode-1" />);

    expect(fetchWithAuthMock).toHaveBeenCalledWith('/devices/dev-1/anomaly-episodes/episode-1');
    expect(await screen.findByTestId('anomaly-episode-member-anomaly-1')).toBeTruthy();
    expect(screen.getByText('96.4%')).toBeTruthy();
    expect(screen.getByText('42.2%')).toBeTruthy();
    expect(screen.queryByTestId('anomaly-episode-members-truncated')).toBeNull();
  });

  it('says so when W02 truncated the member list at 200', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({
      data: { id: 'episode-1', members: [member], membersTruncated: true },
    }));

    render(<AnomalyEpisodeMembers deviceId="dev-1" episodeId="episode-1" />);

    expect(await screen.findByTestId('anomaly-episode-members-truncated')).toBeTruthy();
  });

  it('renders an error state on a failed fetch', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ error: 'boom' }, false, 500));

    render(<AnomalyEpisodeMembers deviceId="dev-1" episodeId="episode-1" />);

    expect(await screen.findByTestId('anomaly-episode-members-error')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/web && npx vitest run src/components/devices/AnomalyEpisodeMembers.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// apps/web/src/components/devices/AnomalyEpisodeMembers.tsx
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MetricAnomalyEpisodeDetailDto, MetricAnomalyEpisodeMemberDto } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { formatMetricValue } from './anomalyEpisodeSentence';
import '../../lib/i18n';

type AnomalyEpisodeMembersProps = { deviceId: string; episodeId: string };

export default function AnomalyEpisodeMembers({ deviceId, episodeId }: AnomalyEpisodeMembersProps) {
  const { t } = useTranslation('devices');
  const [members, setMembers] = useState<MetricAnomalyEpisodeMemberDto[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetchWithAuth(`/devices/${deviceId}/anomaly-episodes/${episodeId}`);
        if (!response.ok) throw new Error('failed');
        // W02 envelope: { data: MetricAnomalyEpisodeDetailDto } (members ≤ 200, window_start asc).
        const json = (await response.json()) as { data?: Partial<MetricAnomalyEpisodeDetailDto> };
        if (cancelled) return;
        setMembers(Array.isArray(json?.data?.members) ? json.data.members : []);
        setTruncated(json?.data?.membersTruncated === true);
      } catch {
        if (!cancelled) setError(t('deviceAnomaliesPanel.failedToLoadDetections'));
      }
    })();
    return () => { cancelled = true; };
  }, [deviceId, episodeId, t]);

  if (error) {
    return (
      <p data-testid="anomaly-episode-members-error" className="mt-3 text-sm text-destructive">
        {error}
      </p>
    );
  }

  if (members === null) {
    return <div className="mt-3 h-16 animate-pulse rounded bg-muted" data-testid="anomaly-episode-members-loading" />;
  }

  return (
    <div className="mt-3 overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-2 text-left font-medium">{t('deviceAnomaliesPanel.membersColumns.window')}</th>
            <th className="px-3 py-2 text-left font-medium">{t('deviceAnomaliesPanel.membersColumns.metric')}</th>
            <th className="px-3 py-2 text-left font-medium">{t('deviceAnomaliesPanel.observed')}</th>
            <th className="px-3 py-2 text-left font-medium">{t('deviceAnomaliesPanel.baseline')}</th>
            <th className="px-3 py-2 text-left font-medium">{t('deviceAnomaliesPanel.membersColumns.score')}</th>
          </tr>
        </thead>
        <tbody>
          {members.map((member) => (
            <tr key={member.id} data-testid={`anomaly-episode-member-${member.id}`} className="border-t">
              <td className="px-3 py-2 tabular-nums">
                {formatDateTime(new Date(member.windowStart), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </td>
              <td className="px-3 py-2 font-mono text-xs">{member.metricName}</td>
              <td className="px-3 py-2 font-medium tabular-nums">
                {formatMetricValue(member.metricName, member.observedValue)}
              </td>
              <td className="px-3 py-2 tabular-nums">
                {member.baselineValue == null ? t('deviceAnomaliesPanel.text') : formatMetricValue(member.metricName, member.baselineValue)}
              </td>
              <td className="px-3 py-2 tabular-nums">{member.score.toFixed(1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && (
        <p data-testid="anomaly-episode-members-truncated" className="border-t px-3 py-2 text-xs text-muted-foreground">
          {t('deviceAnomaliesPanel.membersTruncated', { count: members.length })}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && npx vitest run src/components/devices/AnomalyEpisodeMembers.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/devices/AnomalyEpisodeMembers.tsx apps/web/src/components/devices/AnomalyEpisodeMembers.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): lazy-loaded member table for an anomaly episode card

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `AnomalyEpisodeCard.tsx` — one episode card

**Files:**
- Create: `apps/web/src/components/devices/AnomalyEpisodeCard.tsx`
- Create: `apps/web/src/components/devices/AnomalyEpisodeCard.test.tsx`
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (add this file to `TARGET_GLOBS` — done here since this is the file introducing the mutations, per the guideline "fold setup into the task whose deliverable needs it")

**Interfaces:**
- Consumes: `formatEpisodeSentence`, `ordinal` (Task 1); `AnomalyEpisodeMembers` (Task 3);
  `runAction`, `handleActionError` (`../../lib/runAction`); `useMlFeatureFlags`
  (`../../hooks/useMlFeatureFlags`); `RemediationSuggestionsPanel`
  (`../remediation/RemediationSuggestionsPanel`); `formatDateTime` (`@/lib/dateTimeFormat`);
  `MetricAnomalyEpisodeDto`, `EpisodeAction` from `@breeze/shared`.
- Produces: `export default function AnomalyEpisodeCard({ deviceId, episode, focused, compact, onChanged, onStale }: AnomalyEpisodeCardProps)` where `onChanged: (updated: MetricAnomalyEpisodeDto) => void` fires with the PATCH response's `data` after a successful action so the container (Task 5) can splice the list, `onStale?: () => void` fires on a W02 `409 { error, reason }` (the episode closed, was promoted, or stopped snoozing underneath — `runAction` already toasted `error`) so the container refetches, and `AnomalyEpisodeCardProps` is exported for Task 5's typing.

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/web/src/components/devices/AnomalyEpisodeCard.test.tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AnomalyEpisodeCard from './AnomalyEpisodeCard';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import type { MetricAnomalyEpisodeDto } from '@breeze/shared';

const showToast = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: (input: unknown) => showToast(input) }));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

function baseEpisode(overrides: Partial<MetricAnomalyEpisodeDto> = {}): MetricAnomalyEpisodeDto {
  return {
    id: 'episode-1', orgId: 'org-1', deviceId: 'dev-1',
    episodeKey: 'device_metrics:spike:disk_write', sourceTable: 'device_metrics',
    anomalyType: 'spike', metricFamily: 'disk_write', metricNames: ['disk_write_bps'],
    status: 'open', closeReason: null,
    firstSeenAt: '2026-06-18T22:35:00.000Z', lastSeenAt: '2026-06-18T23:55:00.000Z',
    bucketCount: 17, peakValue: 153_000_000, peakMetricName: 'disk_write_bps',
    peakBaselineValue: 6_000_000, peakScore: 9.1, peakAt: '2026-06-18T23:50:00.000Z',
    recurrenceCount: 0, attribution: null, linkedAlertId: null, snoozedUntil: null,
    resolvedAt: null, resolvedByUserId: null, note: null,
    createdAt: '2026-06-18T22:35:00.000Z', updatedAt: '2026-06-18T23:55:00.000Z',
    durationSeconds: 4800, ongoing: true, promoted: false, snoozed: false,
    rangeMin: 86_000_000, rangeMax: 153_000_000, peakAnomalyId: 'anomaly-peak',
    ...overrides,
  } as MetricAnomalyEpisodeDto;
}

const patchMeta = { alertId: null, alertResolved: false, labelledMembers: 17 };

const flags = (remediationEnabled = false, shadowEnabled = false) => ({
  mlFeatureFlags: {
    'ml.anomalies.enabled': { flag: 'ml.anomalies.enabled', enabled: true, defaultEnabled: false, source: 'org_settings' },
    'ml.remediation_suggestions.enabled': { flag: 'ml.remediation_suggestions.enabled', enabled: remediationEnabled, defaultEnabled: false, source: 'org_settings' },
    'ml.anomalies.v1_shadow.enabled': { flag: 'ml.anomalies.v1_shadow.enabled', enabled: shadowEnabled, defaultEnabled: false, source: 'org_settings' },
  },
});

describe('AnomalyEpisodeCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    showToast.mockReset();
    useOrgStore.setState({ currentOrgId: 'org-1' });
    fetchWithAuthMock.mockImplementation((input) => {
      if (String(input) === '/config/ml-feature-flags') return Promise.resolve(makeJsonResponse(flags()));
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${input}` }, false, 404));
    });
  });

  it('renders the sentence headline and an ongoing chip for an open episode', async () => {
    render(<AnomalyEpisodeCard deviceId="dev-1" episode={baseEpisode()} onChanged={vi.fn()} />);
    expect(await screen.findByText(/Disk write has been/)).toBeTruthy();
    expect(screen.getByTestId('anomaly-episode-chip-ongoing')).toBeTruthy();
  });

  it('shows a recurrence chip when recurrenceCount >= 1', async () => {
    render(<AnomalyEpisodeCard deviceId="dev-1" episode={baseEpisode({ recurrenceCount: 2 })} onChanged={vi.fn()} />);
    expect(await screen.findByText('3rd time in 7 days')).toBeTruthy();
  });

  it('dismiss calls the PATCH action via runAction and reports the update', async () => {
    const onChanged = vi.fn();
    fetchWithAuthMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url === '/config/ml-feature-flags') return Promise.resolve(makeJsonResponse(flags()));
      if (url === '/devices/dev-1/anomaly-episodes/episode-1' && init?.method === 'PATCH') {
        expect(init.body).toBe(JSON.stringify({ action: 'dismiss' }));
        return Promise.resolve(makeJsonResponse({ data: baseEpisode({ status: 'dismissed', closeReason: 'user', ongoing: false }), meta: patchMeta }));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${url}` }, false, 404));
    });

    render(<AnomalyEpisodeCard deviceId="dev-1" episode={baseEpisode()} onChanged={onChanged} />);
    fireEvent.click(await screen.findByRole('button', { name: /dismiss for 7 days/i }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ status: 'dismissed' })));
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('a 409 { error, reason } asks the panel to refetch and does not report an update', async () => {
    const onChanged = vi.fn();
    const onStale = vi.fn();
    fetchWithAuthMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url === '/config/ml-feature-flags') return Promise.resolve(makeJsonResponse(flags()));
      if (url === '/devices/dev-1/anomaly-episodes/episode-1' && init?.method === 'PATCH') {
        return Promise.resolve(makeJsonResponse({ error: 'This anomaly has already closed', reason: 'episode_closed' }, false, 409));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${url}` }, false, 404));
    });

    render(<AnomalyEpisodeCard deviceId="dev-1" episode={baseEpisode()} onChanged={onChanged} onStale={onStale} />);
    fireEvent.click(await screen.findByRole('button', { name: /^resolve$/i }));

    await waitFor(() => expect(onStale).toHaveBeenCalledTimes(1));
    expect(onChanged).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'This anomaly has already closed' }));
  });

  it('shows Stop snoozing for a dismissed-and-snoozed episode instead of Dismiss/Resolve', async () => {
    render(
      <AnomalyEpisodeCard
        deviceId="dev-1"
        episode={baseEpisode({ status: 'dismissed', closeReason: 'snoozed', ongoing: false, snoozed: true, snoozedUntil: '2026-09-28T00:00:00.000Z' })}
        onChanged={vi.fn()}
      />,
    );
    expect(await screen.findByRole('button', { name: /stop snoozing/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^dismiss for 7 days$/i })).toBeNull();
    expect(screen.getByText(/Dismissed/)).toBeTruthy();
  });

  it('shows Open alert instead of Promote when already promoted', async () => {
    render(
      <AnomalyEpisodeCard deviceId="dev-1" episode={baseEpisode({ linkedAlertId: 'alert-1', promoted: true })} onChanged={vi.fn()} />,
    );
    expect(await screen.findByRole('link', { name: /open alert/i })).toHaveAttribute('href', '/alerts/alert-1');
    expect(screen.queryByRole('button', { name: /promote to alert/i })).toBeNull();
  });

  it('renders no actions in compact mode', async () => {
    render(<AnomalyEpisodeCard deviceId="dev-1" episode={baseEpisode()} compact onChanged={vi.fn()} />);
    await screen.findByText(/Disk write has been/);
    expect(screen.queryByRole('button', { name: /dismiss/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /resolve/i })).toBeNull();
  });

  it('hides the remediation block when the flag is off and shows it when on', async () => {
    const { rerender } = render(<AnomalyEpisodeCard deviceId="dev-1" episode={baseEpisode()} onChanged={vi.fn()} />);
    await screen.findByText(/Disk write has been/);
    expect(screen.queryByText('Remediation suggestions')).toBeNull();

    fetchWithAuthMock.mockImplementation((input) => {
      if (String(input) === '/config/ml-feature-flags') return Promise.resolve(makeJsonResponse(flags(true)));
      if (String(input).startsWith('/remediation-suggestions')) return Promise.resolve(makeJsonResponse({ data: [] }));
      return Promise.resolve(makeJsonResponse({ error: 'unexpected' }, false, 404));
    });
    rerender(<AnomalyEpisodeCard deviceId="dev-1" episode={baseEpisode()} onChanged={vi.fn()} />);
    expect(await screen.findByText('Remediation suggestions')).toBeTruthy();
    // Keyed on the peak MEMBER (sourceType 'anomaly'), never the episode id.
    expect(fetchWithAuthMock).toHaveBeenCalledWith(expect.stringContaining('sourceId=anomaly-peak'));
  });

  it('toggles the member table on the detections chip', async () => {
    fetchWithAuthMock.mockImplementation((input) => {
      const url = String(input);
      if (url === '/config/ml-feature-flags') return Promise.resolve(makeJsonResponse(flags()));
      if (url === '/devices/dev-1/anomaly-episodes/episode-1') {
        return Promise.resolve(makeJsonResponse({
          data: {
            ...baseEpisode(),
            members: [{
              id: 'm-1', metricName: 'disk_write_bps', anomalyType: 'spike', status: 'cleared',
              windowStart: '2026-06-18T22:35:00.000Z', windowEnd: '2026-06-18T22:40:00.000Z',
              observedValue: 86_000_000, baselineValue: 6_000_000, baselineMax: 11_000_000,
              score: 8.1, confidence: 0.9, linkedAlertId: null,
            }],
            membersTruncated: false,
          },
        }));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${url}` }, false, 404));
    });

    render(<AnomalyEpisodeCard deviceId="dev-1" episode={baseEpisode()} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /17 detections/i }));
    expect(await screen.findByTestId('anomaly-episode-member-m-1')).toBeTruthy();
  });

  it('gets the focused ring when focused is true', async () => {
    render(<AnomalyEpisodeCard deviceId="dev-1" episode={baseEpisode()} focused onChanged={vi.fn()} />);
    expect(await screen.findByTestId('anomaly-episode-episode-1')).toHaveClass('ring-2');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && npx vitest run src/components/devices/AnomalyEpisodeCard.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// apps/web/src/components/devices/AnomalyEpisodeCard.tsx
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle, CheckCircle, Clock, ExternalLink, RefreshCw, XCircle,
} from 'lucide-react';
import type { EpisodeAction, MetricAnomalyEpisodeDto } from '@breeze/shared';
import { ActionError, runAction, handleActionError } from '../../lib/runAction';
import { fetchWithAuth } from '../../stores/auth';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { useMlFeatureFlags } from '../../hooks/useMlFeatureFlags';
import RemediationSuggestionsPanel from '../remediation/RemediationSuggestionsPanel';
import AnomalyEpisodeMembers from './AnomalyEpisodeMembers';
import { formatEpisodeSentence, ordinal } from './anomalyEpisodeSentence';
import '../../lib/i18n';

export type AnomalyEpisodeCardProps = {
  deviceId: string;
  episode: MetricAnomalyEpisodeDto;
  focused?: boolean;
  compact?: boolean;
  onChanged: (updated: MetricAnomalyEpisodeDto) => void;
  /** W02 answered 409 { error, reason }: the episode changed underneath; refetch. */
  onStale?: () => void;
};

/** W02 PATCH envelope (routes/devices/anomalies.ts). */
type EpisodeActionResponse = {
  data: MetricAnomalyEpisodeDto;
  meta: { alertId: string | null; alertResolved: boolean; labelledMembers: number };
};

const CLOSE_REASON_LABEL_KEY: Record<string, string> = {
  cleared: 'deviceAnomaliesPanel.closeReason.cleared',
  expired_offline: 'deviceAnomaliesPanel.closeReason.expiredOffline',
  expired_no_data: 'deviceAnomaliesPanel.closeReason.expiredNoData',
  user: 'deviceAnomaliesPanel.closeReason.user',
  snoozed: 'deviceAnomaliesPanel.closeReason.snoozed',
};

function formatWhen(value: string): string {
  return formatDateTime(new Date(value), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function AnomalyEpisodeCard({
  deviceId, episode, focused = false, compact = false, onChanged, onStale,
}: AnomalyEpisodeCardProps) {
  const { t } = useTranslation('devices');
  const mlFlags = useMlFeatureFlags();
  const [updating, setUpdating] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const remediationEnabled = mlFlags.flags['ml.remediation_suggestions.enabled']?.enabled === true;
  const shadowEnabled = mlFlags.flags['ml.anomalies.v1_shadow.enabled']?.enabled === true;

  const { headline, attributionLine } = formatEpisodeSentence(episode, t);

  async function applyAction(action: EpisodeAction) {
    setUpdating(true);
    try {
      const result = await runAction<EpisodeActionResponse>({
        request: () => fetchWithAuth(`/devices/${deviceId}/anomaly-episodes/${episode.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        }),
        errorFallback: t('deviceAnomaliesPanel.couldNotUpdateEpisode'),
        successMessage:
          action === 'dismiss' ? t('deviceAnomaliesPanel.episodeDismissed')
          : action === 'resolve' ? t('deviceAnomaliesPanel.episodeResolved')
          : action === 'promote' ? t('deviceAnomaliesPanel.episodePromoted')
          : t('deviceAnomaliesPanel.snoozeStopped'),
      });
      onChanged(result.data);
    } catch (err) {
      // 409 { error, reason } (episode_closed | already_promoted | not_snoozed |
      // no_promotable_member | promotion_disabled): runAction already toasted
      // W02's message; the card's copy of the episode is stale, so refetch.
      if (err instanceof ActionError && err.status === 409) {
        onStale?.();
        return;
      }
      handleActionError(err, t('deviceAnomaliesPanel.couldNotUpdateEpisode'));
    } finally {
      setUpdating(false);
    }
  }

  return (
    <div
      data-testid={`anomaly-episode-${episode.id}`}
      className={`rounded-md border p-4 ${focused ? 'border-primary/60 bg-primary/5 ring-2 ring-primary/20' : ''}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning">
          <AlertTriangle className="h-3.5 w-3.5" />
          {episode.anomalyType.replace(/_/g, ' ')}
        </span>
        {focused && (
          <span className="inline-flex rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
            {t('deviceAnomaliesPanel.linkedFromAlert')}
          </span>
        )}
      </div>

      <p className="mt-2 text-sm font-medium">{headline}</p>
      <p className="mt-1 text-xs text-muted-foreground">{attributionLine}</p>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        {episode.ongoing ? (
          <span data-testid="anomaly-episode-chip-ongoing" className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-muted-foreground">
            <Clock className="h-3 w-3" />
            {t('deviceAnomaliesPanel.ongoingSince', { when: formatWhen(episode.firstSeenAt) })}
          </span>
        ) : (
          <span data-testid="anomaly-episode-chip-closed" className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-muted-foreground">
            {episode.closeReason === 'expired_offline' || episode.closeReason === 'expired_no_data'
              ? t(CLOSE_REASON_LABEL_KEY[episode.closeReason]!)
              : `${formatWhen(episode.firstSeenAt)} – ${formatWhen(episode.lastSeenAt)} · ${t(CLOSE_REASON_LABEL_KEY[episode.closeReason ?? 'user']!)}`}
          </span>
        )}
        {episode.recurrenceCount >= 1 && (
          <span className="inline-flex rounded-full border bg-muted px-2 py-0.5 text-muted-foreground">
            {t('deviceAnomaliesPanel.recurrenceNth', { nth: ordinal(episode.recurrenceCount + 1) })}
          </span>
        )}
        {episode.snoozed && episode.snoozedUntil && (
          <span className="inline-flex rounded-full border bg-muted px-2 py-0.5 text-muted-foreground">
            {t('deviceAnomaliesPanel.dismissedSnoozedUntil', { when: formatWhen(episode.snoozedUntil) })}
          </span>
        )}
        {episode.promoted && episode.linkedAlertId && (
          <a href={`/alerts/${episode.linkedAlertId}`} className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 font-medium text-primary hover:underline">
            <ExternalLink className="h-3 w-3" />
            {t('deviceAnomaliesPanel.openAlert')}
          </a>
        )}
        {!compact && (
          // bucketCount = distinct anomalous 5-minute buckets (W01 deviation 4) —
          // one "detection" per bucket; the member table may list two rows per
          // bucket for the cpu/ram process pairs.
          <button
            type="button"
            data-testid="anomaly-episode-chip-detections"
            onClick={() => setMembersOpen((v) => !v)}
            className="rounded-full border px-2 py-0.5 text-muted-foreground hover:bg-muted"
          >
            {t('deviceAnomaliesPanel.detectionsCount', { count: episode.bucketCount })}
          </button>
        )}
      </div>

      {!compact && episode.status === 'open' && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" disabled={updating} onClick={() => void applyAction('dismiss')}
            className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60">
            <XCircle className="h-4 w-4" />
            {t('deviceAnomaliesPanel.dismissFor7Days')}
          </button>
          <button type="button" disabled={updating} onClick={() => void applyAction('resolve')}
            className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60">
            <CheckCircle className="h-4 w-4" />
            {t('deviceAnomaliesPanel.resolve')}
          </button>
          {!episode.promoted && (
            <button type="button" disabled={updating} onClick={() => void applyAction('promote')}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60">
              <ExternalLink className="h-4 w-4" />
              {t('deviceAnomaliesPanel.promoteToAlert')}
            </button>
          )}
        </div>
      )}
      {!compact && episode.status === 'dismissed' && episode.snoozed && (
        <div className="mt-3">
          <button type="button" disabled={updating} onClick={() => void applyAction('unsnooze')}
            className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60">
            <RefreshCw className="h-4 w-4" />
            {t('deviceAnomaliesPanel.stopSnoozing')}
          </button>
        </div>
      )}

      {membersOpen && <AnomalyEpisodeMembers deviceId={deviceId} episodeId={episode.id} />}

      {!compact && episode.status === 'open' && remediationEnabled && episode.peakAnomalyId && (
        // Suggestions are keyed by a metric_anomalies id (sourceType 'anomaly'),
        // never an episode id — W02's peakAnomalyId (D-9).
        <RemediationSuggestionsPanel sourceType="anomaly" sourceId={episode.peakAnomalyId} deviceId={deviceId} />
      )}
      {!compact && shadowEnabled && (
        <div className="mt-3 text-xs text-muted-foreground">{t('deviceAnomaliesPanel.v1ShadowPerEpisodeNote')}</div>
      )}
    </div>
  );
}
```

Note on `detectionsCount` button text: the test asserts a role name match of `/17 detections/i`; the
key `deviceAnomaliesPanel.detectionsCount` must interpolate `count` as `"{{count}} detections"` (see
Task 6). React-i18next's default English plural resolves `deviceAnomaliesPanel.detectionsCount` (or
`_other` for `count !== 1`) — the JSON only needs the base key since English has just singular/plural
and Task 6's copy is written directly as `"{{count}} detections"` (no pluralization branching needed
for count>=2 in every test fixture used here; add a `_one` form in Task 6 for the count===1 case per
existing `t()`-with-count conventions in this codebase — check `keyUsage.test.ts` requirements before
finalizing plural forms).

Now update the mutation guard:

```typescript
// apps/web/src/lib/__tests__/no-silent-mutations.test.ts — add to TARGET_GLOBS
  // Metric anomaly episodes W04: card actions (dismiss/resolve/promote/unsnooze)
  // are the only mutation surface for the rewritten panel.
  'src/components/devices/AnomalyEpisodeCard.tsx',
```
(Insert alphabetically-near or logically-near the other `src/components/devices/*` entries already
in `TARGET_GLOBS`; read the current array in `no-silent-mutations.test.ts` before editing to match
its existing ordering convention.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && npx vitest run src/components/devices/AnomalyEpisodeCard.test.tsx`
Expected: PASS. (Some assertions depend on Task 6's i18n keys existing with the exact English text
used in the test's regex matchers — if Task 6 hasn't landed yet in execution order, run Task 6's
`en/devices.json` additions before this step, or accept a transient red here in an out-of-order
execution and re-run after Task 6.)

Run: `cd apps/web && npx vitest run src/lib/__tests__/no-silent-mutations.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/devices/AnomalyEpisodeCard.tsx apps/web/src/components/devices/AnomalyEpisodeCard.test.tsx apps/web/src/lib/__tests__/no-silent-mutations.test.ts
git commit -m "$(cat <<'EOF'
feat(web): episode card with sentence, chips, and runAction-wrapped actions

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `DeviceAnomaliesPanel.tsx` rewrite — container

**Files:**
- Modify (full rewrite): `apps/web/src/components/devices/DeviceAnomaliesPanel.tsx`
- Modify (full rewrite): `apps/web/src/components/devices/DeviceAnomaliesPanel.test.tsx`

**Interfaces:**
- Consumes: `AnomalyEpisodeCard` (Task 4), `useMlFeatureFlags`, `fetchWithAuth`,
  `MetricAnomalyEpisodeDto` from `@breeze/shared`.
- Produces: same public props as today —
  `export default function DeviceAnomaliesPanel({ deviceId, compact, focusedAnomalyId }:
  DeviceAnomaliesPanelProps)` — **unchanged signature**, so `DeviceDetails.tsx` (both mount sites,
  `:875` and `:899`ish per the earlier read) needs no edit. `focusedAnomalyId` (whatever id the
  `#anomalies/<id>` hash carries — an episode id from new alerts, a member anomaly id from alerts
  promoted before W02) is passed through to the list fetch as the `ref` query param (spec §12: `ref`
  matches either kind and forces `status=all`). The focus ring goes on the card whose id equals the
  response's `focusedEpisodeId` (W02 `MetricAnomalyEpisodeListResponse`), never on `ref` directly —
  a member anomaly id never equals an episode id.

- [ ] **Step 1: Write the failing tests**

```typescript
// apps/web/src/components/devices/DeviceAnomaliesPanel.test.tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DeviceAnomaliesPanel from './DeviceAnomaliesPanel';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const flagsResponse = makeJsonResponse({
  mlFeatureFlags: {
    'ml.anomalies.enabled': { flag: 'ml.anomalies.enabled', enabled: true, defaultEnabled: false, source: 'org_settings' },
    'ml.remediation_suggestions.enabled': { flag: 'ml.remediation_suggestions.enabled', enabled: false, defaultEnabled: false, source: 'org_settings' },
    'ml.anomalies.v1_shadow.enabled': { flag: 'ml.anomalies.v1_shadow.enabled', enabled: false, defaultEnabled: false, source: 'org_settings' },
  },
});

function episode(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id, orgId: 'org-1', deviceId: 'dev-1', episodeKey: 'device_metrics:spike:cpu', sourceTable: 'device_metrics',
    anomalyType: 'spike', metricFamily: 'cpu', metricNames: ['cpu_percent'], status: 'open', closeReason: null,
    firstSeenAt: '2026-06-18T12:00:00.000Z', lastSeenAt: '2026-06-18T12:10:00.000Z', bucketCount: 2,
    peakValue: 96.4, peakMetricName: 'cpu_percent', peakBaselineValue: 42.2, peakScore: 8.1, peakAt: '2026-06-18T12:05:00.000Z',
    recurrenceCount: 0, attribution: null, linkedAlertId: null, snoozedUntil: null, resolvedAt: null, resolvedByUserId: null,
    note: null, createdAt: '2026-06-18T12:00:00.000Z', updatedAt: '2026-06-18T12:10:00.000Z',
    durationSeconds: 600, ongoing: true, promoted: false, snoozed: false, rangeMin: 90, rangeMax: 96.4,
    ...overrides,
  };
}

describe('DeviceAnomaliesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOrgStore.setState({ currentOrgId: 'org-1' });
  });

  it('loads and renders open episodes by default', async () => {
    fetchWithAuthMock.mockImplementation((input) => {
      const url = String(input);
      if (url === '/config/ml-feature-flags') return Promise.resolve(flagsResponse);
      if (url === '/devices/dev-1/anomaly-episodes?status=open&limit=25') {
        return Promise.resolve(makeJsonResponse({ data: [episode('episode-1')], focusedEpisodeId: null }));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${url}` }, false, 404));
    });

    render(<DeviceAnomaliesPanel deviceId="dev-1" />);

    expect(await screen.findByText('Anomalies')).toBeTruthy();
    expect(await screen.findByTestId('anomaly-episode-episode-1')).toBeTruthy();
  });

  it('switches to the recently-closed filter', async () => {
    fetchWithAuthMock.mockImplementation((input) => {
      const url = String(input);
      if (url === '/config/ml-feature-flags') return Promise.resolve(flagsResponse);
      if (url === '/devices/dev-1/anomaly-episodes?status=open&limit=25') return Promise.resolve(makeJsonResponse({ data: [], focusedEpisodeId: null }));
      if (url === '/devices/dev-1/anomaly-episodes?status=closed&limit=1') return Promise.resolve(makeJsonResponse({ data: [], focusedEpisodeId: null }));
      if (url === '/devices/dev-1/anomaly-episodes?status=closed&limit=25') {
        return Promise.resolve(makeJsonResponse({ data: [episode('episode-2', { status: 'resolved', closeReason: 'cleared', ongoing: false })], focusedEpisodeId: null }));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${url}` }, false, 404));
    });

    render(<DeviceAnomaliesPanel deviceId="dev-1" />);
    await screen.findByText('No open anomalies');
    fireEvent.click(screen.getByRole('button', { name: /recently closed/i }));
    expect(await screen.findByTestId('anomaly-episode-episode-2')).toBeTruthy();
  });

  it('empty state offers a "show recently closed" link when closed episodes exist', async () => {
    fetchWithAuthMock.mockImplementation((input) => {
      const url = String(input);
      if (url === '/config/ml-feature-flags') return Promise.resolve(flagsResponse);
      if (url === '/devices/dev-1/anomaly-episodes?status=open&limit=25') return Promise.resolve(makeJsonResponse({ data: [], focusedEpisodeId: null }));
      // "Recently closed" = W02's status=closed (resolved/dismissed in the last 7 days).
      if (url === '/devices/dev-1/anomaly-episodes?status=closed&limit=1') return Promise.resolve(makeJsonResponse({ data: [episode('episode-3', { status: 'resolved', closeReason: 'cleared', ongoing: false })], focusedEpisodeId: null }));
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${url}` }, false, 404));
    });

    render(<DeviceAnomaliesPanel deviceId="dev-1" />);
    expect(await screen.findByRole('button', { name: /show recently closed/i })).toBeTruthy();
  });

  it('passes focusedAnomalyId through as ref (status=all) and rings the episode W02 resolved it to', async () => {
    // A legacy alert deep link carries a MEMBER anomaly id; W02 resolves it to
    // its episode and returns that as focusedEpisodeId (always data[0]).
    fetchWithAuthMock.mockImplementation((input) => {
      const url = String(input);
      if (url === '/config/ml-feature-flags') return Promise.resolve(flagsResponse);
      if (url === '/devices/dev-1/anomaly-episodes?status=all&limit=100&ref=anomaly-77') {
        return Promise.resolve(makeJsonResponse({
          data: [
            episode('episode-9', { promoted: true, linkedAlertId: 'alert-1' }),
            episode('episode-10'),
          ],
          focusedEpisodeId: 'episode-9',
        }));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${url}` }, false, 404));
    });

    render(<DeviceAnomaliesPanel deviceId="dev-1" focusedAnomalyId="anomaly-77" />);
    expect(await screen.findByTestId('anomaly-episode-episode-9')).toHaveClass('ring-2');
    expect(screen.getByTestId('anomaly-episode-episode-10')).not.toHaveClass('ring-2');
  });

  it('an unknown ref rings nothing (focusedEpisodeId null)', async () => {
    fetchWithAuthMock.mockImplementation((input) => {
      const url = String(input);
      if (url === '/config/ml-feature-flags') return Promise.resolve(flagsResponse);
      if (url === '/devices/dev-1/anomaly-episodes?status=all&limit=100&ref=gone-1') {
        return Promise.resolve(makeJsonResponse({ data: [episode('episode-1')], focusedEpisodeId: null }));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${url}` }, false, 404));
    });

    render(<DeviceAnomaliesPanel deviceId="dev-1" focusedAnomalyId="gone-1" />);
    expect(await screen.findByTestId('anomaly-episode-episode-1')).not.toHaveClass('ring-2');
  });

  it('compact mode caps at 3 open episodes and fetches limit=3', async () => {
    fetchWithAuthMock.mockImplementation((input) => {
      const url = String(input);
      if (url === '/config/ml-feature-flags') return Promise.resolve(flagsResponse);
      if (url === '/devices/dev-1/anomaly-episodes?status=open&limit=3') {
        return Promise.resolve(makeJsonResponse({ data: [episode('e1'), episode('e2'), episode('e3'), episode('e4')], focusedEpisodeId: null }));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${url}` }, false, 404));
    });

    render(<DeviceAnomaliesPanel deviceId="dev-1" compact />);
    await screen.findByTestId('anomaly-episode-e1');
    expect(screen.queryByTestId('anomaly-episode-e4')).toBeNull();
  });

  it('disabled state shows no episodes and skips the fetch', async () => {
    fetchWithAuthMock.mockImplementation((input) => {
      const url = String(input);
      if (url === '/config/ml-feature-flags') {
        return Promise.resolve(makeJsonResponse({
          mlFeatureFlags: { 'ml.anomalies.enabled': { flag: 'ml.anomalies.enabled', enabled: false, defaultEnabled: false, source: 'org_settings' } },
        }));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${url}` }, false, 404));
    });

    render(<DeviceAnomaliesPanel deviceId="dev-1" />);
    await screen.findByText('Anomaly detection disabled');
    expect(fetchWithAuthMock).not.toHaveBeenCalledWith(expect.stringContaining('/anomaly-episodes'));
  });

  it('splices an updated episode out of the open list after a resolve', async () => {
    fetchWithAuthMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url === '/config/ml-feature-flags') return Promise.resolve(flagsResponse);
      if (url === '/devices/dev-1/anomaly-episodes?status=open&limit=25') return Promise.resolve(makeJsonResponse({ data: [episode('episode-1')], focusedEpisodeId: null }));
      if (url === '/devices/dev-1/anomaly-episodes?status=closed&limit=1') return Promise.resolve(makeJsonResponse({ data: [], focusedEpisodeId: null }));
      if (url === '/devices/dev-1/anomaly-episodes/episode-1' && init?.method === 'PATCH') {
        return Promise.resolve(makeJsonResponse({
          data: episode('episode-1', { status: 'resolved', closeReason: 'user', ongoing: false }),
          meta: { alertId: null, alertResolved: false, labelledMembers: 2 },
        }));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${url}` }, false, 404));
    });

    render(<DeviceAnomaliesPanel deviceId="dev-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /^resolve$/i }));
    await waitFor(() => expect(screen.queryByTestId('anomaly-episode-episode-1')).toBeNull());
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/web && npx vitest run src/components/devices/DeviceAnomaliesPanel.test.tsx`
Expected: FAIL — old component/tests still reference `/anomalies` and per-row fields.

- [ ] **Step 3: Implement**

```typescript
// apps/web/src/components/devices/DeviceAnomaliesPanel.tsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, TrendingUp } from 'lucide-react';
import type { MetricAnomalyEpisodeDto, MetricAnomalyEpisodeListResponse } from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { useMlFeatureFlags } from '../../hooks/useMlFeatureFlags';
import { useTranslation } from 'react-i18next';
import AnomalyEpisodeCard from './AnomalyEpisodeCard';
import '../../lib/i18n';

type DeviceAnomaliesPanelProps = {
  deviceId: string;
  compact?: boolean;
  focusedAnomalyId?: string;
};

type Filter = 'open' | 'closed' | 'all';

export default function DeviceAnomaliesPanel({
  deviceId, compact = false, focusedAnomalyId,
}: DeviceAnomaliesPanelProps) {
  const { t } = useTranslation('devices');
  const mlFlags = useMlFeatureFlags();
  const [filter, setFilter] = useState<Filter>('open');
  const [episodes, setEpisodes] = useState<MetricAnomalyEpisodeDto[]>([]);
  // W02 resolves `ref` (episode id OR member anomaly id) to the episode to ring.
  const [focusedEpisodeId, setFocusedEpisodeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [hasClosed, setHasClosed] = useState(false);
  const anomaliesDisabled = mlFlags.isDisabled('ml.anomalies.enabled');

  const effectiveFilter: Filter = focusedAnomalyId ? 'all' : filter;
  const limit = focusedAnomalyId ? 100 : compact ? 3 : 25;

  const fetchEpisodes = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const params = new URLSearchParams({ status: effectiveFilter, limit: String(limit) });
      if (focusedAnomalyId) params.set('ref', focusedAnomalyId);
      const response = await fetchWithAuth(`/devices/${deviceId}/anomaly-episodes?${params.toString()}`);
      if (!response.ok) throw new Error(t('deviceAnomaliesPanel.failedToLoadMetricAnomalies'));
      const json = (await response.json()) as Partial<MetricAnomalyEpisodeListResponse>;
      setEpisodes(Array.isArray(json?.data) ? json.data : []);
      setFocusedEpisodeId(typeof json?.focusedEpisodeId === 'string' ? json.focusedEpisodeId : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('deviceAnomaliesPanel.failedToLoadMetricAnomalies'));
    } finally {
      setLoading(false);
    }
  }, [deviceId, effectiveFilter, limit, focusedAnomalyId, t]);

  const checkHasClosed = useCallback(async () => {
    try {
      // Same predicate the "Recently closed" pill uses (W02 status=closed:
      // resolved/dismissed within the last 7 days), so the link never leads to
      // an empty list.
      const response = await fetchWithAuth(`/devices/${deviceId}/anomaly-episodes?status=closed&limit=1`);
      if (!response.ok) return;
      const json = (await response.json()) as Partial<MetricAnomalyEpisodeListResponse>;
      setHasClosed(Array.isArray(json?.data) && json.data.length > 0);
    } catch {
      // Best-effort; the "show recently closed" link simply stays hidden.
    }
  }, [deviceId]);

  useEffect(() => {
    if (!mlFlags.loaded) return;
    if (anomaliesDisabled) {
      setEpisodes([]);
      setError(undefined);
      setLoading(false);
      return;
    }
    void fetchEpisodes();
  }, [anomaliesDisabled, fetchEpisodes, mlFlags.loaded]);

  useEffect(() => {
    if (!mlFlags.loaded || anomaliesDisabled || compact || effectiveFilter !== 'open' || episodes.length > 0) return;
    void checkHasClosed();
  }, [anomaliesDisabled, checkHasClosed, compact, effectiveFilter, episodes.length, mlFlags.loaded]);

  const visible = useMemo(
    () => (compact ? episodes.filter((e) => e.ongoing).slice(0, 3) : episodes),
    [compact, episodes],
  );

  function handleChanged(updated: MetricAnomalyEpisodeDto) {
    setEpisodes((current) => {
      const next = current.map((e) => (e.id === updated.id ? updated : e));
      // A resolve/dismiss/unsnooze can move the episode out of the current
      // filter's membership (e.g. Open no longer includes a just-resolved
      // row); drop it from the visible list in that case.
      if (effectiveFilter === 'open' && !updated.ongoing) return next.filter((e) => e.id !== updated.id);
      return next;
    });
  }

  if (loading) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-xs">
        <div className="flex items-center justify-center py-8">
          <div className="h-7 w-7 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-destructive">{error}</p>
          <button type="button" onClick={() => void fetchEpisodes()}
            className="inline-flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium hover:bg-muted">
            <RefreshCw className="h-4 w-4" />
            {t('deviceAnomaliesPanel.retry')}
          </button>
        </div>
      </div>
    );
  }

  if (anomaliesDisabled) {
    return (
      <div className={`rounded-lg border bg-card shadow-xs ${compact ? 'p-4' : 'p-6'}`}>
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-lg font-semibold">{t('deviceAnomaliesPanel.metricAnomalies')}</h3>
        </div>
        <div className="mt-5 rounded-md border border-dashed p-6 text-center">
          <p className="text-sm font-medium">{t('deviceAnomaliesPanel.anomalyDetectionDisabled')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`rounded-lg border bg-card shadow-xs ${compact ? 'p-4' : 'p-6'}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-lg font-semibold">{t('deviceAnomaliesPanel.metricAnomalies')}</h3>
        </div>
        {!compact && (
          <div className="flex items-center gap-2">
            <div className="flex rounded-md border p-0.5 text-sm">
              {(['open', 'closed', 'all'] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFilter(f)}
                  className={`rounded px-2 py-1 ${filter === f && !focusedAnomalyId ? 'bg-muted font-medium' : 'text-muted-foreground'}`}
                >
                  {f === 'open' ? t('deviceAnomaliesPanel.filterOpen') : f === 'closed' ? t('deviceAnomaliesPanel.filterRecentlyClosed') : t('deviceAnomaliesPanel.filterAll')}
                </button>
              ))}
            </div>
            <button type="button" onClick={() => void fetchEpisodes()}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border text-muted-foreground hover:bg-muted hover:text-foreground"
              title={t('deviceAnomaliesPanel.refreshAnomalies')} aria-label={t('deviceAnomaliesPanel.refreshAnomalies')}>
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>

      {visible.length === 0 ? (
        <div className="mt-5 rounded-md border border-dashed p-6 text-center">
          <p className="text-sm font-medium">{t('deviceAnomaliesPanel.noOpenAnomalies')}</p>
          {!compact && <p className="text-sm text-muted-foreground">{t('deviceAnomaliesPanel.recentMetricRollupsAreWithinBaseline')}</p>}
          {!compact && effectiveFilter === 'open' && hasClosed && (
            <button type="button" onClick={() => setFilter('closed')} className="mt-3 text-sm font-medium text-primary hover:underline">
              {t('deviceAnomaliesPanel.showRecentlyClosed')}
            </button>
          )}
        </div>
      ) : (
        <div className="mt-5 space-y-3">
          {visible.map((ep) => (
            <AnomalyEpisodeCard
              key={ep.id}
              deviceId={deviceId}
              episode={ep}
              compact={compact}
              focused={focusedEpisodeId !== null && ep.id === focusedEpisodeId}
              onChanged={handleChanged}
              onStale={() => void fetchEpisodes()}
            />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/web && npx vitest run src/components/devices/DeviceAnomaliesPanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/devices/DeviceAnomaliesPanel.tsx apps/web/src/components/devices/DeviceAnomaliesPanel.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): rewrite DeviceAnomaliesPanel against the episode API

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: i18n — `deviceAnomaliesPanel.*` keys across all locales

**Files:**
- Modify: `apps/web/src/locales/en/devices.json`
- Modify: `apps/web/src/locales/de-DE/devices.json`
- Modify: `apps/web/src/locales/es-419/devices.json`
- Modify: `apps/web/src/locales/fr-CA/devices.json`
- Modify: `apps/web/src/locales/fr-FR/devices.json`
- Modify: `apps/web/src/locales/it-IT/devices.json`
- Modify: `apps/web/src/locales/pt-BR/devices.json`
- Modify: `apps/web/src/locales/tr-TR/devices.json`

**Interfaces:**
- Consumes: nothing (data files).
- Produces: every `t('deviceAnomaliesPanel.*')` call added in Tasks 1, 3, 4, 5.

- [ ] **Step 1: Run the parity/coverage tests to see the current (pre-change) baseline pass**

Run: `cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts`
Expected: PASS (confirms the baseline before this task's edits, so a later failure is attributable
to this task).

- [ ] **Step 2: Add the new keys to `en/devices.json`, replacing removed legacy keys**

The existing `deviceAnomaliesPanel` block (read in full above) keeps every key still used by Tasks
3-5 (`retry`, `metricAnomalies`, `observed`, `baseline`, `text`, `resolve`, `refreshAnomalies`,
`anomalyDetectionDisabled`, `noOpenAnomalies`, `recentMetricRollupsAreWithinBaseline`,
`linkedFromAlert`, `openAlert`, `failedToLoadMetricAnomalies`). Keys for the removed per-row
promote/dismiss flow (`anomalyDismissed`, `anomalyPromoted`, `anomalyPromotedButNoAlertLink`,
`anomalyPromotedToAlert`, `showingTheLinkedAnomalyAndRecent`, `openSignalsDetectedFromMetricRollups`,
`linkedAnomalyNotFound`, `confidence`, `dismiss`, `promote`, `on`, v1-shadow-populated keys `candidates`/`overlap`/`v1Only`/`v0Only`/`overlapRate`,
`v1ShadowComparison`, `shadowModelDisabledForThisOrganization`, `noV1ShadowCandidatesInThe`,
`failedToLoadShadowModelComparison`, `anomalyDetectionIsDisabledForThis`, `all`, `open`) are dead
after this rewrite — leave them in place rather than deleting (no test asserts unused keys are
absent, and removing them is a separate cleanup with its own review surface; note as a follow-up in
the PR description, not scope-creep here).

Add this to the `deviceAnomaliesPanel` object in `apps/web/src/locales/en/devices.json`:

```json
{
  "deviceAnomaliesPanel": {
    "filterOpen": "Open",
    "filterRecentlyClosed": "Recently closed",
    "filterAll": "All",
    "showRecentlyClosed": "Show recently closed",
    "couldNotUpdateEpisode": "Could not update anomaly",
    "episodeDismissed": "Dismissed for 7 days",
    "episodeResolved": "Anomaly resolved",
    "episodePromoted": "Anomaly promoted to alert",
    "snoozeStopped": "Snoozing stopped",
    "dismissFor7Days": "Dismiss for 7 days",
    "promoteToAlert": "Promote to alert",
    "stopSnoozing": "Stop snoozing",
    "ongoingSince": "Ongoing since {{when}}",
    "recurrenceNth": "{{nth}} time in 7 days",
    "dismissedSnoozedUntil": "Dismissed · snoozed until {{when}}",
    "detectionsCount": "{{count}} detections",
    "closeReason": {
      "cleared": "cleared",
      "expiredOffline": "expired: device not seen",
      "expiredNoData": "expired: no data for this metric",
      "user": "resolved",
      "snoozed": "snoozed"
    },
    "processDetailNotAvailable": "Process detail not available for this metric.",
    "topByAtPeak": "Top by {{dimension}} at peak: {{list}}",
    "sentence": {
      "spike": "{{metric}} has been {{range}} for {{duration}}, normally {{baseline}}.",
      "processMax": "One process reached {{value}}, normally {{baseline}}.",
      "processSum": "Top processes together used {{value}}, normally {{baseline}}.",
      "drop": "{{metric}} dropped to {{value}} for {{duration}}, normally {{baseline}}.",
      "growth": "{{metric}} grew from {{from}} to {{to}} over {{duration}}."
    },
    "membersColumns": {
      "window": "Window",
      "metric": "Metric",
      "score": "Score"
    },
    "membersTruncated": "Showing the first {{count}} detections.",
    "failedToLoadDetections": "Failed to load detections"
  }
}
```

Merge this into the existing object (do not replace it) — the pre-existing keys listed above stay.

- [ ] **Step 3: Add the equivalent keys, translated, to the other seven locales**

```json
// de-DE
{
  "deviceAnomaliesPanel": {
    "filterOpen": "Offen",
    "filterRecentlyClosed": "Kürzlich geschlossen",
    "filterAll": "Alle",
    "showRecentlyClosed": "Kürzlich geschlossene anzeigen",
    "couldNotUpdateEpisode": "Anomalie konnte nicht aktualisiert werden",
    "episodeDismissed": "7 Tage lang verworfen",
    "episodeResolved": "Anomalie behoben",
    "episodePromoted": "Anomalie zu Alarm hochgestuft",
    "snoozeStopped": "Stummschaltung beendet",
    "dismissFor7Days": "7 Tage verwerfen",
    "promoteToAlert": "Zu Alarm hochstufen",
    "stopSnoozing": "Stummschaltung beenden",
    "ongoingSince": "Andauernd seit {{when}}",
    "recurrenceNth": "{{nth}} Mal in 7 Tagen",
    "dismissedSnoozedUntil": "Verworfen · stummgeschaltet bis {{when}}",
    "detectionsCount": "{{count}} Erkennungen",
    "closeReason": {
      "cleared": "behoben",
      "expiredOffline": "abgelaufen: Gerät nicht gesehen",
      "expiredNoData": "abgelaufen: keine Daten für diese Metrik",
      "user": "aufgelöst",
      "snoozed": "stummgeschaltet"
    },
    "processDetailNotAvailable": "Prozessdetails für diese Metrik nicht verfügbar.",
    "topByAtPeak": "Top nach {{dimension}} beim Höchstwert: {{list}}",
    "sentence": {
      "spike": "{{metric}} lag {{duration}} lang bei {{range}}, normal {{baseline}}.",
      "processMax": "Ein Prozess erreichte {{value}}, normal {{baseline}}.",
      "processSum": "Die Top-Prozesse zusammen nutzten {{value}}, normal {{baseline}}.",
      "drop": "{{metric}} fiel {{duration}} lang auf {{value}}, normal {{baseline}}.",
      "growth": "{{metric}} stieg über {{duration}} von {{from}} auf {{to}}."
    },
    "membersColumns": {
      "window": "Zeitfenster",
      "metric": "Metrik",
      "score": "Punktzahl"
    },
    "membersTruncated": "Die ersten {{count}} Erkennungen werden angezeigt.",
    "failedToLoadDetections": "Erkennungen konnten nicht geladen werden"
  }
}

// es-419
{
  "deviceAnomaliesPanel": {
    "filterOpen": "Abiertas",
    "filterRecentlyClosed": "Cerradas recientemente",
    "filterAll": "Todas",
    "showRecentlyClosed": "Mostrar cerradas recientemente",
    "couldNotUpdateEpisode": "No se pudo actualizar la anomalía",
    "episodeDismissed": "Descartada por 7 días",
    "episodeResolved": "Anomalía resuelta",
    "episodePromoted": "Anomalía convertida en alerta",
    "snoozeStopped": "Silencio detenido",
    "dismissFor7Days": "Descartar por 7 días",
    "promoteToAlert": "Convertir en alerta",
    "stopSnoozing": "Detener silencio",
    "ongoingSince": "En curso desde {{when}}",
    "recurrenceNth": "{{nth}} vez en 7 días",
    "dismissedSnoozedUntil": "Descartada · silenciada hasta {{when}}",
    "detectionsCount": "{{count}} detecciones",
    "closeReason": {
      "cleared": "resuelta",
      "expiredOffline": "vencida: dispositivo no visto",
      "expiredNoData": "vencida: sin datos para esta métrica",
      "user": "resuelta",
      "snoozed": "silenciada"
    },
    "processDetailNotAvailable": "Detalle de proceso no disponible para esta métrica.",
    "topByAtPeak": "Principales por {{dimension}} en el pico: {{list}}",
    "sentence": {
      "spike": "{{metric}} estuvo en {{range}} durante {{duration}}, normalmente {{baseline}}.",
      "processMax": "Un proceso alcanzó {{value}}, normalmente {{baseline}}.",
      "processSum": "Los procesos principales juntos usaron {{value}}, normalmente {{baseline}}.",
      "drop": "{{metric}} cayó a {{value}} durante {{duration}}, normalmente {{baseline}}.",
      "growth": "{{metric}} creció de {{from}} a {{to}} en {{duration}}."
    },
    "membersColumns": {
      "window": "Ventana",
      "metric": "Métrica",
      "score": "Puntuación"
    },
    "membersTruncated": "Se muestran las primeras {{count}} detecciones.",
    "failedToLoadDetections": "No se pudieron cargar las detecciones"
  }
}

// fr-FR
{
  "deviceAnomaliesPanel": {
    "filterOpen": "Ouvertes",
    "filterRecentlyClosed": "Fermées récemment",
    "filterAll": "Toutes",
    "showRecentlyClosed": "Afficher les fermées récemment",
    "couldNotUpdateEpisode": "Impossible de mettre à jour l'anomalie",
    "episodeDismissed": "Ignorée pendant 7 jours",
    "episodeResolved": "Anomalie résolue",
    "episodePromoted": "Anomalie promue en alerte",
    "snoozeStopped": "Sourdine arrêtée",
    "dismissFor7Days": "Ignorer pendant 7 jours",
    "promoteToAlert": "Promouvoir en alerte",
    "stopSnoozing": "Arrêter la sourdine",
    "ongoingSince": "En cours depuis {{when}}",
    "recurrenceNth": "{{nth}} fois en 7 jours",
    "dismissedSnoozedUntil": "Ignorée · en sourdine jusqu'au {{when}}",
    "detectionsCount": "{{count}} détections",
    "closeReason": {
      "cleared": "résolue",
      "expiredOffline": "expirée : appareil non vu",
      "expiredNoData": "expirée : aucune donnée pour cette métrique",
      "user": "résolue",
      "snoozed": "en sourdine"
    },
    "processDetailNotAvailable": "Détails du processus indisponibles pour cette métrique.",
    "topByAtPeak": "Principaux par {{dimension}} au pic : {{list}}",
    "sentence": {
      "spike": "{{metric}} est resté à {{range}} pendant {{duration}}, normalement {{baseline}}.",
      "processMax": "Un processus a atteint {{value}}, normalement {{baseline}}.",
      "processSum": "Les principaux processus ont utilisé ensemble {{value}}, normalement {{baseline}}.",
      "drop": "{{metric}} est tombé à {{value}} pendant {{duration}}, normalement {{baseline}}.",
      "growth": "{{metric}} est passé de {{from}} à {{to}} en {{duration}}."
    },
    "membersColumns": {
      "window": "Fenêtre",
      "metric": "Métrique",
      "score": "Score"
    },
    "membersTruncated": "Affichage des {{count}} premières détections.",
    "failedToLoadDetections": "Impossible de charger les détections"
  }
}

// fr-CA — same content as fr-FR, per this repo's existing fr-CA/fr-FR near-duplication convention
// (confirm by diffing a few existing keys in both files before pasting; if fr-CA already diverges in
// wording for adjacent panels, match that register instead of a blind copy).

// it-IT
{
  "deviceAnomaliesPanel": {
    "filterOpen": "Aperte",
    "filterRecentlyClosed": "Chiuse di recente",
    "filterAll": "Tutte",
    "showRecentlyClosed": "Mostra chiuse di recente",
    "couldNotUpdateEpisode": "Impossibile aggiornare l'anomalia",
    "episodeDismissed": "Ignorata per 7 giorni",
    "episodeResolved": "Anomalia risolta",
    "episodePromoted": "Anomalia promossa ad avviso",
    "snoozeStopped": "Silenziamento interrotto",
    "dismissFor7Days": "Ignora per 7 giorni",
    "promoteToAlert": "Promuovi ad avviso",
    "stopSnoozing": "Interrompi silenziamento",
    "ongoingSince": "In corso dalle {{when}}",
    "recurrenceNth": "{{nth}} volta in 7 giorni",
    "dismissedSnoozedUntil": "Ignorata · silenziata fino al {{when}}",
    "detectionsCount": "{{count}} rilevamenti",
    "closeReason": {
      "cleared": "risolta",
      "expiredOffline": "scaduta: dispositivo non rilevato",
      "expiredNoData": "scaduta: nessun dato per questa metrica",
      "user": "risolta",
      "snoozed": "silenziata"
    },
    "processDetailNotAvailable": "Dettagli del processo non disponibili per questa metrica.",
    "topByAtPeak": "Principali per {{dimension}} al picco: {{list}}",
    "sentence": {
      "spike": "{{metric}} è rimasto a {{range}} per {{duration}}, normalmente {{baseline}}.",
      "processMax": "Un processo ha raggiunto {{value}}, normalmente {{baseline}}.",
      "processSum": "I processi principali insieme hanno usato {{value}}, normalmente {{baseline}}.",
      "drop": "{{metric}} è sceso a {{value}} per {{duration}}, normalmente {{baseline}}.",
      "growth": "{{metric}} è cresciuto da {{from}} a {{to}} in {{duration}}."
    },
    "membersColumns": {
      "window": "Finestra",
      "metric": "Metrica",
      "score": "Punteggio"
    },
    "membersTruncated": "Visualizzazione dei primi {{count}} rilevamenti.",
    "failedToLoadDetections": "Impossibile caricare i rilevamenti"
  }
}

// pt-BR
{
  "deviceAnomaliesPanel": {
    "filterOpen": "Abertas",
    "filterRecentlyClosed": "Fechadas recentemente",
    "filterAll": "Todas",
    "showRecentlyClosed": "Mostrar fechadas recentemente",
    "couldNotUpdateEpisode": "Não foi possível atualizar a anomalia",
    "episodeDismissed": "Descartada por 7 dias",
    "episodeResolved": "Anomalia resolvida",
    "episodePromoted": "Anomalia promovida a alerta",
    "snoozeStopped": "Silenciamento interrompido",
    "dismissFor7Days": "Descartar por 7 dias",
    "promoteToAlert": "Promover a alerta",
    "stopSnoozing": "Interromper silenciamento",
    "ongoingSince": "Em andamento desde {{when}}",
    "recurrenceNth": "{{nth}} vez em 7 dias",
    "dismissedSnoozedUntil": "Descartada · silenciada até {{when}}",
    "detectionsCount": "{{count}} detecções",
    "closeReason": {
      "cleared": "resolvida",
      "expiredOffline": "expirada: dispositivo não visto",
      "expiredNoData": "expirada: sem dados para esta métrica",
      "user": "resolvida",
      "snoozed": "silenciada"
    },
    "processDetailNotAvailable": "Detalhe de processo não disponível para esta métrica.",
    "topByAtPeak": "Principais por {{dimension}} no pico: {{list}}",
    "sentence": {
      "spike": "{{metric}} ficou em {{range}} por {{duration}}, normalmente {{baseline}}.",
      "processMax": "Um processo atingiu {{value}}, normalmente {{baseline}}.",
      "processSum": "Os principais processos juntos usaram {{value}}, normalmente {{baseline}}.",
      "drop": "{{metric}} caiu para {{value}} por {{duration}}, normalmente {{baseline}}.",
      "growth": "{{metric}} cresceu de {{from}} para {{to}} em {{duration}}."
    },
    "membersColumns": {
      "window": "Janela",
      "metric": "Métrica",
      "score": "Pontuação"
    },
    "membersTruncated": "Exibindo as primeiras {{count}} detecções.",
    "failedToLoadDetections": "Não foi possível carregar as detecções"
  }
}

// tr-TR
{
  "deviceAnomaliesPanel": {
    "filterOpen": "Açık",
    "filterRecentlyClosed": "Son kapatılanlar",
    "filterAll": "Tümü",
    "showRecentlyClosed": "Son kapatılanları göster",
    "couldNotUpdateEpisode": "Anomali güncellenemedi",
    "episodeDismissed": "7 gün boyunca yoksayıldı",
    "episodeResolved": "Anomali çözüldü",
    "episodePromoted": "Anomali uyarıya yükseltildi",
    "snoozeStopped": "Erteleme durduruldu",
    "dismissFor7Days": "7 gün yoksay",
    "promoteToAlert": "Uyarıya yükselt",
    "stopSnoozing": "Ertelemeyi durdur",
    "ongoingSince": "{{when}} tarihinden beri sürüyor",
    "recurrenceNth": "7 günde {{nth}} kez",
    "dismissedSnoozedUntil": "Yoksayıldı · {{when}} tarihine kadar ertelendi",
    "detectionsCount": "{{count}} tespit",
    "closeReason": {
      "cleared": "temizlendi",
      "expiredOffline": "süresi doldu: cihaz görülmedi",
      "expiredNoData": "süresi doldu: bu metrik için veri yok",
      "user": "çözüldü",
      "snoozed": "ertelendi"
    },
    "processDetailNotAvailable": "Bu metrik için işlem ayrıntısı yok.",
    "topByAtPeak": "Zirvede {{dimension}} bazında en yüksek: {{list}}",
    "sentence": {
      "spike": "{{metric}}, {{duration}} boyunca {{range}} seviyesindeydi, normalde {{baseline}}.",
      "processMax": "Bir işlem {{value}} değerine ulaştı, normalde {{baseline}}.",
      "processSum": "En üst işlemler birlikte {{value}} kullandı, normalde {{baseline}}.",
      "drop": "{{metric}}, {{duration}} boyunca {{value}} değerine düştü, normalde {{baseline}}.",
      "growth": "{{metric}}, {{duration}} içinde {{from}} değerinden {{to}} değerine yükseldi."
    },
    "membersColumns": {
      "window": "Pencere",
      "metric": "Metrik",
      "score": "Skor"
    },
    "membersTruncated": "İlk {{count}} tespit gösteriliyor.",
    "failedToLoadDetections": "Tespitler yüklenemedi"
  }
}
```

Merge each block into the existing `deviceAnomaliesPanel` object in that locale's `devices.json`
(do not replace the file or the object — every pre-existing key must survive).

- [ ] **Step 4: Run the parity, coverage, and key-usage tests**

Run: `cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts src/lib/i18n/translationCoverage.test.ts src/lib/i18n/keyUsage.test.ts`
Expected: PASS. If `translationCoverage.test.ts` reports a new duplicate over a locale's baseline
(e.g. a genuine cognate like `"Score"` in Italian/`"Punteggio"` differing is fine, but something
like `membersColumns.window: "Window"` left untranslated would trip it), either translate the
flagged key for real or add a reviewed exception per that test's documented pattern (see the
`namespaceDuplicateBaselines` comments read earlier in this plan's research) — do not silently raise
a baseline number without a review-quality reason.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/locales/*/devices.json
git commit -m "$(cat <<'EOF'
feat(web): i18n keys for the episode-based anomalies panel, all locales

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Full verification, manual check, PR notes

**Files:** none new; this task runs the suites and records results.

- [ ] **Step 1: Run every test file touched or added by this plan**

Run:
```bash
cd apps/web && npx vitest run \
  src/components/devices/anomalyEpisodeSentence.test.ts \
  src/components/devices/AnomalyEpisodeMembers.test.tsx \
  src/components/devices/AnomalyEpisodeCard.test.tsx \
  src/components/devices/DeviceAnomaliesPanel.test.tsx \
  src/components/alerts/alertMlContext.test.ts \
  src/components/alerts/AlertDetails.test.tsx \
  src/components/alerts/AlertDetailPage.test.tsx \
  src/lib/__tests__/no-silent-mutations.test.ts \
  src/lib/i18n/localeParity.test.ts \
  src/lib/i18n/translationCoverage.test.ts \
  src/lib/i18n/keyUsage.test.ts
; echo "exit=$?"
```
Expected: every file PASS, `exit=0`.

- [ ] **Step 2: Run the full web unit suite once, to catch any cross-file regression**

Run: `cd apps/web && npx vitest run ; echo "exit=$?"`
Expected: `exit=0`. (Per CLAUDE.md's trap notes: this is `npx vitest run <path...>`, never
`pnpm --filter @breeze/api test -- --run`, and never a bare `pnpm --filter @breeze/web test` with no
`run` subcommand.)

- [ ] **Step 3: Web typecheck**

Find the command CI actually uses before running one from memory:

```bash
cat apps/web/package.json | grep -A2 '"typecheck"\|"check"'
cat turbo.json 2>/dev/null | grep -B2 -A5 '"typecheck"'
```

Then run whatever that resolves to for the `web` package (commonly `pnpm --filter @breeze/web
typecheck` or `astro check` — confirm the exact script name in `apps/web/package.json` rather than
guessing), redirecting to a file and checking the exit code explicitly since CLAUDE.md warns a piped
`tail` can mask a heap OOM as a false green:

```bash
cd apps/web && npx tsc --noEmit -p . > /tmp/w04-typecheck.log 2>&1 ; echo "exit=$?" ; tail -n 60 /tmp/w04-typecheck.log
```
Expected: `exit=0`, no errors referencing `AnomalyEpisodeCard.tsx`, `AnomalyEpisodeMembers.tsx`,
`anomalyEpisodeSentence.ts`, `DeviceAnomaliesPanel.tsx`, `alertMlContext.ts`, `AlertDetails.tsx`, or
`AlertDetailPage.tsx`.

- [ ] **Step 4: Confirm `DeviceDetails.tsx` needed no changes**

`DeviceAnomaliesPanel`'s exported prop signature (`deviceId`, `compact?`, `focusedAnomalyId?`) is
unchanged, so its two mount sites in `DeviceDetails.tsx` (`activeTab === 'anomalies'` and
`activeTab === 'performance'`) require no edits. Confirm with:

```bash
git diff --stat apps/web/src/components/devices/DeviceDetails.tsx
```
Expected: empty (no changes).

- [ ] **Step 5: Manual check note (record in the PR body, do not skip)**

This plan does not include a live manual check as a plan step (no seeded device with a real episode
exists yet — episodes only exist once W01+W02 are deployed and the detector has run), so the PR
description must say so explicitly and name the follow-up: *"Manually verified against the
worktree-stack once W01/W02 land and a device has at least one open, one closed, and one
promoted-and-snoozed episode — screenshot via Playwright MCP (`mcp__plugin_playwright_playwright__browser_navigate`
+ `browser_take_screenshot`) of the device Anomalies tab, the Performance tab's compact block, and
an alert's deep link landing on the focused card."* If W01/W02 are already merged by the time this
task executes, perform that check now instead of deferring it: `pnpm wt-stack up`, seed a device with
synthetic `metric_anomalies` rows across the three states, run the detector's episode/resolve stages
(or insert episode rows directly for a UI-only check), then screenshot as above before writing the
PR.

- [ ] **Step 6: PR notes**

PR title: `feat(web): rewrite device anomalies panel against episode API (W04)`

PR body must include:
- `Closes #<W04 sub-issue>` (from `feature-lifecycle`; get the number via `get_feature_status` if
  not already known from this session).
- A one-line settings-audit-style note is NOT required (this isn't a `pages/settings/**` change),
  but per CLAUDE.md's "Web Mutation Handlers" section, state explicitly: *"All new mutations
  (dismiss/resolve/promote/unsnooze) go through `runAction`; `AnomalyEpisodeCard.tsx` added to
  `no-silent-mutations` `TARGET_GLOBS`."*
- The three **Spec deviations / assumptions** from the top of this plan (detections = buckets,
  remediation keyed on `peakAnomalyId`, filter in component state), and a line confirming the
  envelopes match W02's merged routes (`MetricAnomalyEpisodeListResponse` with `focusedEpisodeId`,
  `{ data: MetricAnomalyEpisodeDetailDto }`, PATCH `{ data, meta }`, 409 `{ error, reason }`).
- The **Task 5 execution-order note**: Task 4's tests assume Task 6's English copy exists; if tasks
  ran out of order, re-run Task 4's suite after Task 6.
- Dead i18n keys left in `en/devices.json` (and other locales) from the old per-row panel, flagged
  as a follow-up cleanup, not fixed in this PR.

---

## Self-Review

**1. Spec coverage** (§13, §16 Web bullet, D12):
- Filter pills Open/Recently closed/All — Task 5. ✅.
- Sentence cards per family/type — Task 1 (formatter) + Task 4 (renders `headline`). ✅.
- Attribution line incl. "Process detail not available" — Task 1 + Task 4. ✅.
- Chips: ongoing/closed+reason/recurrence/snoozed/alert link/detections toggle — Task 4. ✅.
- Actions Dismiss-for-7-days/Resolve/Promote-or-Open-alert/Stop-snoozing via `runAction` — Task 4. ✅.
- Member table lazy-loaded on first expand — Task 3 + Task 4's `membersOpen` toggle. ✅.
- Focused ring from `ref` — Task 4 (`focused` prop) + Task 5 (`ep.id === focusedEpisodeId` from W02's list response, so a member-anomaly `ref` rings its episode). ✅.
- Empty state with "Show recently closed" link — Task 5. ✅.
- Remediation block only when flag on — Task 4 (`remediationEnabled` gate, keyed on `peakAnomalyId`,
  replacing the always-on panel mount). ✅.
- v1-shadow block only when flag on, no "disabled" placeholder otherwise — Task 4 (renders nothing
  when `shadowEnabled` is false, no placeholder branch at all, unlike the removed
  `anomaly-v1-shadow-disabled` block). ✅.
- Compact mode: open only, max 3, sentence+chips, no actions — Task 5 (`visible` memo) + Task 4
  (`compact` suppresses the action row and remediation/shadow blocks). ✅.
- `alertMlContext` prefers `#anomalies/<episodeId>` — Task 2. ✅.
- `ref` passed from hash, forces `status=all` — Task 5 (`effectiveFilter`). ✅.
- `data-testid`s — every card/chip/action in Task 4, member rows in Task 3. ✅.
- i18n keys under `deviceAnomaliesPanel.*` — Task 6. ✅.
- Component tests for spec §16's states (open/closed/all filters, each chip, actions call
  `runAction`, hidden blocks when flags off, compact cap) — Tasks 3-5 test files. ✅.

**2. Placeholder scan:** no "TBD"/"implement later"/bare prose steps; every code step has a full
code block; the one deferred item (Step 5's manual screenshot) is explicitly conditioned and
explained, not hand-waved, per the instruction that a *documented, reasoned* deferral is different
from a placeholder.

**3. Type consistency:** `formatEpisodeSentence(episode, t) → { headline, attributionLine }` is
identical across Task 1's implementation, Task 1's export list, and Task 4's call site.
No wave-local copy of a W01/W02 type exists: members are W02's `MetricAnomalyEpisodeMemberDto`,
the sentence input is a `Pick` of `MetricAnomalyEpisodeDto`, attribution uses W01's `AttributionSnapshot`
/ `AttributionDimension`, and all envelopes are W02's (reconciled 2026-09-22). `AnomalyEpisodeCardProps.onChanged` matches Task 5's `handleChanged` signature exactly
(`(updated: MetricAnomalyEpisodeDto) => void`). `EpisodeAction` values used in Task 4
(`'dismiss'|'resolve'|'promote'|'unsnooze'`) match the cross-wave contract's `EpisodeAction` type
verbatim.

## Execution note carried from the index doc

Codex was at its usage limit when the parent spec/index were written (until 2026-09-26); this is a
low/mechanical web change per the user's global skill-rigor calibration (CRUD-shaped component
rewrite, not concurrency/auth/tenancy/migrations), so it proceeds directly — write the assertion
first and watch it fail, implement, typecheck, run the relevant tests — no brainstorming/plan-review
ceremony beyond this plan itself and the one independent review round already budgeted by
CLAUDE.md's "Efficient coding & review" section.
