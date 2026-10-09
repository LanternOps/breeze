# Reliability baseline markers: reset after reimage, mark remediation work (#5876)

**Status:** approved design (2026-10-08)
**Issue:** #5876 (originally "Clear Reliability Score", Discord request)
**Related:** #1908 (curve/band calibration — independent; revisit the provisional threshold there)
**Design review:** advisor quorum (Fable + Codex `xhigh`): AGREE-WITH-CHANGES. The adopted changes are folded in below, and the rejected ones are listed under "Considered and rejected".

## Problem

The device reliability score is rebuilt from up to 90 days of raw agent history
on every run (`computeAndPersistDeviceReliability`,
`apps/api/src/services/reliabilityScoring.ts`). Fault factors look back 30 days, uptime and MTBF look back 90.
That leaves two gaps:

1. **Reimaged or rebuilt devices.** A device rebuilt for a new user keeps the old
   build's crashes, hangs and failures against it for up to 90 days (the Discord report).
2. **Remediation.** After a tech fixes a device, the score only recovers as old
   events age out of the 30-day window. Nobody can tell whether the fix
   worked until a month has passed.

## Goals

- A tech can place a **baseline marker** on a device. Scoring then ignores everything
  before it, so the score reflects health *since* the reimage or fix.
- The score is honest about how little evidence it has right after a marker.
- A tech can see **before vs. since** to judge whether the work helped.
- A completed bare-metal recovery places a marker automatically.
- Markers are auditable and reversible (clearing one recomputes the score from the retained raw history).

## Non-goals

- Deleting raw reliability history. Markers only move the scoring window.
- Linking a marker to a ticket or time entry (possible later).
- AI tools creating markers. They can read markers but not write them.
- Re-tuning weights, k-constants or bands. That work stays on #1908.
- Auto-detecting a reimage from OS-version changes in `device_change_log`. An in-place
  upgrade is not a reimage.

## Product decisions (approved)

| Decision | Choice |
|---|---|
| Reasons | `reimaged`, `remediated`, `hardware_replaced` |
| Backdating | Allowed up to **30 days** back, never in the future (server time, 5-minute skew tolerance) |
| Note | **Required** for a manual `remediated` marker, optional otherwise |
| Provisional threshold | Fewer than **14 reported days** since the marker |
| Who can set or clear | `devices:write` plus device site access. Reading needs `devices:read` |
| Multiple active markers | The one with the latest `baseline_at` wins |
| Clearing | Soft clear (`cleared_at`). The row stays as history |

## Data model

New table `device_reliability_baselines`:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `org_id` | uuid NOT NULL | FK `organizations` |
| `device_id` | uuid NOT NULL | composite FK `(device_id, org_id) → devices(id, org_id)` `ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE` |
| `baseline_at` | timestamptz NOT NULL | the moment scoring restarts from |
| `reason` | text NOT NULL | CHECK in (`reimaged`,`remediated`,`hardware_replaced`) |
| `source` | text NOT NULL | CHECK in (`manual`,`bare_metal_recovery`) |
| `source_ref` | uuid NULL | `bare_metal_recoveries.id` for automatic markers. NULL for manual ones. Soft reference with **no FK**: an FK would have to sort `bare_metal_recoveries` after this table in both delete-ordered lists, and the row only needs to be idempotent, not referentially intact |
| `note` | text NULL | CHECK: non-blank when `reason='remediated' AND source='manual'`. Max length 2000 is enforced in the API |
| `before_snapshot` | jsonb NULL | frozen "before" score; schema below |
| `created_by` | uuid NULL | FK `users` ON DELETE SET NULL. NULL means system (automatic marker) |
| `created_at` | timestamptz NOT NULL default now() | |
| `cleared_at` | timestamptz NULL | |
| `cleared_by` | uuid NULL | FK `users` ON DELETE SET NULL |

Indexes:
- `(device_id, baseline_at DESC) WHERE cleared_at IS NULL` resolves the active marker.
- UNIQUE `(device_id, source_ref) WHERE source_ref IS NOT NULL` makes automatic markers
  idempotent. It deliberately spans cleared rows, so a re-acked recovery never
  re-creates a marker the tech cleared.
- `(org_id)`.

`before_snapshot` shape (validated by a Zod schema in the API, `version: 1`):

```ts
{
  version: 1,
  scorerVersion: string,          // constant bumped when scoring math changes
  asOf: string,                   // = baseline_at
  coverageDays: number,           // days of raw history actually available in [asOf-90d, asOf)
  reliabilityScore: number,
  factors: { uptime, crashes, hangs, serviceFailures, hardwareErrors }: { score: number },
  counts30d: { crashes, hangs, serviceFailures, hardwareErrors }: number,
  weightProfile: 'workstation' | 'infra',
}
```

### Tenancy (shape 1: direct `org_id`)

`org_id NOT NULL` is deliberate. This is a device-owned record, not a config or policy
table, so Partner-Wide First (#2135) does not apply.

Same migration that creates the table:
- `ENABLE` + `FORCE ROW LEVEL SECURITY`, four policies `breeze_org_isolation_{select,insert,update,delete}`
  on `public.breeze_has_org_access(org_id)` (house pattern; template
  `2026-11-10-110000-time-sync-daily.sql`), `GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES … TO breeze_app`
  (UPDATE is needed by the org-move and merge re-point).

Registration in the same PR. Each list is enforced by a contract test:

| List | File |
|---|---|
| `CORE_ORG_CASCADE_DELETE_ORDER` (alphabetical; verify FK children-first) | `services/tenantCascade.ts` |
| `CORE_DEVICE_CASCADE_DELETE_TABLES` | `routes/devices/core.ts` |
| `CORE_DEVICE_ORG_DENORMALIZED_TABLES` | `routes/devices/core.ts` |
| merge policy `repoint` | `services/orgMergeRegistry.ts` |
| `CORE_TENANT_EXPORT_POLICY` (`before_snapshot` → `excludedOpen`; everything else `included`) | `services/tenantExportPolicyRegistry.ts` |

Device org-move: the composite FK uses `ON UPDATE CASCADE`, so markers, notes and snapshots
travel with the device. `moveDeviceOrgInTransaction.ts` needs no change: it re-stamps every
`CORE_DEVICE_ORG_DENORMALIZED_TABLES` entry generically and names only ticket constraints
in its `SET CONSTRAINTS`, exactly as for the peer table `device_time_daily`. Do **not** add the
table to `DEVICE_ORG_FK_CASCADE_TABLES` (pinned to four entries by `moveOrg.coverage.test.ts`).

## Scoring changes

### Pure scorer

Extract the math from `computeAndPersistDeviceReliability` into a pure function:

```ts
scoreDeviceReliability(input: {
  rows: ScoringHistoryRow[];        // caller supplies rows bounded to [windowEnd-90d, windowEnd]
  latest: LatestHistorySnapshot | null; // latest sample with collectedAt <= windowEnd
  deviceRole: string | null;
  enrolledAt: Date | null;
  windowEnd: Date;                  // "now" for live scoring; baseline_at for snapshots
  baselineAt: Date | null;          // effective marker strictly before windowEnd, if any
}): ReliabilityComputation
```

`computeAndPersistDeviceReliability` becomes: lock → load device + active marker →
fetch bounded rows → `scoreDeviceReliability` → upsert. The history query gains an
explicit upper bound (`collected_at <= windowEnd`). Today it uses a wall-clock
lookback with no upper bound, so it cannot produce an as-of score.

### Applying the baseline

When `baselineAt` is set:

1. **Events are cut at event granularity.** Before `mergeRowsIntoDailyBuckets`, drop every
   event (crash, hang, service failure, hardware error) whose own timestamp is
   `< baselineAt`. Filtering rows by `collected_at` is wrong because the agent posts about
   every 24h, so a row collected after the marker can carry pre-marker events.
2. **Samples are cut too.** Rows with `collected_at < baselineAt` contribute no sample to a
   bucket. Otherwise pre-marker days still count as "observed" and dilute the
   rate normalisation.
3. **Window starts are clamped** to `max(fixedWindowStart, enrolledAt, baselineAt)` for
   uptime availability, boot-span credit (`bootSpanUpDayKeys`), observed up-days, trend
   points and MTBF. This generalises the existing `enrolledAt` clamp (#1738).
4. The 14-day rate-normalisation floor (`RELIABILITY_RATE_MIN_DAYS`) is unchanged. A single
   post-marker event is still judged as at least a 14-day rate, so a fresh marker can't hide a
   device that is still failing.

### Provisional state

- `reportedDaysSinceBaseline` counts distinct UTC days with ≥1 agent sample at or after
  `baselineAt`. It deliberately does **not** include days credited by extrapolating the
  current boot span to now, because a device that went silent after the fix must not mature.
- `provisional = baselineAt != null && reportedDaysSinceBaseline < 14`.
- While provisional, `trendDirection = 'stable'` with `trendConfidence = 0`, and
  `mtbfHours = null`. A few hours of exposure counted as a whole up-day would make
  MTBF meaningless. Trend only ever uses post-marker points, so the reset
  jump itself can never read as "improving".
- Persisted on `device_reliability.details.baseline`:
  `{ id, baselineAt, reason, source, reportedDaysSinceBaseline, provisional }`.
  It is a JSONB key, so no column is added to `device_reliability` (no export-policy churn).

Once a marker is more than 30 days old, the fault windows no longer reach it. After 90 days
it has no effect at all. Neither case needs special handling.

### Before snapshot

On marker creation, call `scoreDeviceReliability` with `windowEnd = baselineAt` and
`baselineAt = ` the chronological predecessor marker (latest active marker with
`baseline_at < new.baseline_at`; ties are broken by `created_at`, then `id`). Rows are fetched for
`[baselineAt-90d, baselineAt]`. `coverageDays` records how much of that history still
exists. Retention can be configured down to 30 days
(`RELIABILITY_HISTORY_RETENTION_DAYS`, floor 30, default 120), so the UI renders "based on N
days" rather than implying a full 90-day picture.

Clearing a marker recomputes the *current* score against the next surviving marker (or none).
That is the correct current score. It is not guaranteed to equal the exact number shown before
the marker was placed, because history has kept arriving and ageing out since then.

### Concurrency

A per-device advisory lock was considered and rejected. The nightly org scan scores every device
inside **one** system transaction, so a per-device `pg_advisory_xact_lock` would be held until the
whole org commits. A "Mark work done" click would then block behind the scan.

Instead the `device_reliability` upsert is **compare-and-set** on the marker the run used:

```sql
ON CONFLICT (device_id) DO UPDATE SET …
WHERE (SELECT b.id FROM device_reliability_baselines b
        WHERE b.device_id = $device AND b.cleared_at IS NULL
        ORDER BY b.baseline_at DESC, b.created_at DESC, b.id DESC LIMIT 1)
      IS NOT DISTINCT FROM $baselineIdUsedByThisRun
```

How the possible interleavings resolve:
- **The worker writes after the marker change commits.** The guard sees a different active marker, so the
  stale write is skipped.
- **The worker writes while the marker transaction is still open.** The worker's write lands first. The marker
  transaction's own upsert then blocks on the row lock until the worker commits, and overwrites it with the
  marker-aware score.
- **The first-ever row.** The INSERT path is unguarded. Any later marker change goes through the guarded update.

The marker routes insert or clear the marker and recompute inside the request transaction that
`authMiddleware` already opens, so the marker and the score commit together. A route-path recompute calls
the scorer directly, which bypasses the 10-minute on-demand dedupe.

## Automatic marker on bare-metal recovery

The heartbeat recovery check-in (`routes/agents/heartbeat.ts`, the `recoveryMarker` block)
currently reads the recovery, then updates it with no status predicate. Change it to:

1. A guarded `UPDATE bare_metal_recoveries SET status='checked_in' … WHERE id = $1 AND identity = 'original'
   AND status IN ('restoring','validated','rebooted') RETURNING …`. Only the request that wins the transition
   proceeds. The `identity = 'original'` predicate already exists in the read path and must be kept,
   because a `new`-identity recovery is a different machine.
2. In the same transaction, insert a marker
   `{ reason:'reimaged', source:'bare_metal_recovery', source_ref: recovery.id, baseline_at: checkedInAt }`
   with `ON CONFLICT (device_id, source_ref) DO NOTHING`, computing its before snapshot.
3. Enqueue a device recompute after commit (`runAfterDbContextExit`). The enqueue uses a per-marker
   job id so the 10-minute on-demand dedupe can't swallow it.

An idempotent re-ack (`status = 'checked_in'` already) creates nothing.

## API

All routes are under `apps/api/src/routes/reliability.ts`, require org/partner/system scope, and
check device existence and site access (`getDeviceWithOrgAndSiteCheck`).

| Route | Permission | Behaviour |
|---|---|---|
| `GET /reliability/:deviceId/baselines` | `devices:read` | All markers (active and cleared), newest first, with creator/clearer display names and `before_snapshot` |
| `POST /reliability/:deviceId/baselines` | `devices:write` | Body `{ reason, baselineAt?, note? }`. `baselineAt` defaults to now. Rejects future (>5 min) and older than 30 days with 400. Rejects a blank note for `remediated`. Org, source (`manual`) and actor come from the server. Returns `{ baseline, reliability }` |
| `DELETE /reliability/:deviceId/baselines/:baselineId` | `devices:write` | Soft clear. 404 if not on this device, 409 if already cleared. Returns `{ reliability }` |
| `GET /reliability/:deviceId` (existing) | unchanged | `snapshot` gains `baseline` (from `details.baseline`) and `provisional` |

**Audit:** `device.reliability.baseline_set` and `device.reliability.baseline_cleared`, written with
`writeRouteAudit` / `writeAuditEvent` (the repo's retrying audit path) using `resourceType:'device'` and
`resourceId: deviceId`, so the device activity feed (`routes/devices/events.ts`) picks them up. The awaited
`createAuditLog` was rejected: it opens a second pooled connection while the request transaction is held,
which is the #1105 pool-starvation pattern. Labels
are registered in `events.ts` `actionLabels`. `DeviceActivityFeed.tsx` gets a `device.reliability` entry in
`ACTION_RULES`, because its server-side prefix filter otherwise hides these rows. Automatic markers are attributed to system
with `details.source = 'bare_metal_recovery'` and `details.recoveryId`.

## Other consumers

| Consumer | Change |
|---|---|
| `getDeviceReliabilityHistory` (`/reliability/:deviceId/history`) | Replace the legacy linear formula and un-deduped counting with the shared bucket path (`mergeRowsIntoDailyBuckets` + `scoreDailyBucket`), baseline-aware. Points before the active marker are returned with `beforeBaseline: true` rather than dropped, so a chart can show the cut |
| `getDeviceReliabilityOffenders` | Ignores events before the active marker |
| Device list (`routes/devices/core.ts` reliability join) | Exposes `reliabilityProvisional` |
| Fleet finding `reliability_offenders` (`services/fleetFindings/producers.ts`) | Excludes provisional devices |
| Precision evaluation (`evaluateReliabilityScores`) | Ignores failure labels with `occurredAt` before the device's active marker |
| AI tools (`get_device_hardware_health` `includeReliability` in `aiToolsDevice.ts`, `get_fleet_health` in `aiToolsUserRisk.ts`), `aiAgents/designEvidence.ts`, `runnerPrompt.ts` | Include `baseline` (reason, date, provisional) so the model doesn't read a fresh score as long-term health |

## Web UI (`DeviceReliabilityPanel.tsx`)

- **Action:** a "Mark work done" button opens a form with reason (select), date/time (defaults to now,
  min now−30d, max now), and note (required for "Remediated"). Uses `runAction`. Hidden without
  `devices:write`.
- **Banner** when a marker is active: "Scoring since *Remediated* on Oct 3 by *Alex* — provisional, 4 of 14
  days reported", or "Scoring since … (N days)" once mature. The note is shown inline.
- **Before → since row:** score and the four 30-day fault counts from `before_snapshot` next to the current
  values, plus "before based on N days" when `coverageDays < 90`.
- **Marker history:** collapsible list (reason, date, who, note, cleared state) with a Clear action
  (confirmation, `runAction`).
- Provisional state: score rendered muted with a "Provisional" pill. Trend and MTBF show "—".
- **Device list** reliability column: provisional scores get a muted style and a tooltip.
- All new interactive elements carry `data-testid`.

## Testing

**API unit (Vitest)**
- Pure scorer: event-granularity cut (pre-marker event in a post-marker row is excluded); pre-marker samples
  don't count as observed days; uptime, trend and MTBF windows clamp; 14-day floor still penalises a
  single post-marker crash; provisional is true below 14 *reported* days and ignores boot-span extrapolation;
  `windowEnd` bounds rows and `latest`; equal-timestamp predecessor tie-break.
- No-marker path: results identical to today across the existing scorer fixtures (refactor guard).
- Routes: permission gates, site access, future/30-day/blank-note validation, 404/409 on clear, audit
  emitted with device addressing.
- Heartbeat: guarded transition creates exactly one marker; a re-ack creates none; a cleared automatic
  marker is not re-created.
- `getDeviceReliabilityHistory`: matches the main scorer's dedupe on duplicated rows.
- Cascade and move lists: existing `cascadeDelete.test.ts`, `moveOrg.coverage.test.ts`, and full-suite
  `orgMerge.test.ts`.

**Integration (real Postgres)**
- RLS: cross-org forge insert fails 42501. Org isolation on read.
- `rls-coverage`, `tenantCascade`, `orgMergeRegistry`, `tenant-export-policy`,
  `tenantExportErasureRoundtrip`, and the org-merge "merge contract" (composite FK deferrable).
- Advisory-lock race: concurrent recompute and marker insert end with the marker-aware score.

**Web (Vitest + jsdom)**
- Panel renders banner, provisional and before/after states. Form validation (note required for
  remediated, date bounds). Clear flow. `no-silent-mutations` stays green.

## Delivery

Tracked with feature-lifecycle (parent #5876):

- **W1 — API:** migration plus schema, all registrations, pure-scorer refactor and baseline application,
  advisory lock, routes and audit, heartbeat auto-marker, the consumers in the table above. The
  "Mark work done" capability is API-only until W2.
- **W2 — Web:** panel action, banner, before/after, history and clear, device-list provisional state,
  activity-feed labels.

## Considered and rejected

- **Single column on `devices`:** can't hold multiple markers or clear history, so the before/after view
  across several fixes is impossible.
- **Reusing `ml_feedback_events` (`device.replaced`):** append-only, built for precision evaluation,
  and stays behind during org merges. Wrong lifecycle.
- **Down-weighting pre-marker events instead of a hard cut:** produces scores nobody can explain. A hard cut
  with a provisional label is more legible.
- **Typed snapshot columns:** a frozen derived snapshot fits versioned JSONB. The cost is export
  exclusion (`excludedOpen`), which is acceptable for derived data.
- **Persisting "maturity reached" so expiry can't reverse it (Codex):** unnecessary. Post-marker rows
  outlive the 30-day window in which the marker affects scoring.
- **Baseline-aware report narratives (Codex):** uptime since a marker is still true uptime. No change.
