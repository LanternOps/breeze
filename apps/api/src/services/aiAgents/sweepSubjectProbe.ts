// apps/api/src/services/aiAgents/sweepSubjectProbe.ts
/**
 * #5751 W02 (#5753), spec §3.4 — "is THIS ONE subject still bad?", answered in
 * three values.
 *
 * ## Why this is not `sweepEvidence.ts`
 *
 * The kind loaders in `sweepEvidence.ts` are fleet-wide, threshold-bearing,
 * `MAX+1` sampling queries built to *find* candidates. They are not
 * verification APIs. `loadFailedBackups` selects the latest **failed** job
 * inside a 7-day window, so a later SUCCESS never clears the predicate;
 * `loadServiceDown` filters the whole org. Re-using either to answer "is this
 * one subject still bad?" would report a stale predicate as live, and a
 * predicate merely aging out of a 24-hour window as recovered. Neither is
 * true.
 *
 * ## The asymmetry, stated on purpose
 *
 * `unknown` costs a human review. `cleared` costs a wrong `verified` in the
 * graduation ledger — an operation that nothing verified, counted as
 * verification, which is the exact defect this wave exists to close. So every
 * path that cannot answer lands on `unknown`: no row, a row older than
 * `SWEEP_PROBE_FRESHNESS_MS`, a row with no timestamp, a kind with no probe,
 * and any thrown query. **Nothing ever falls back to `cleared`.**
 *
 * ## Tenancy and DB context
 *
 * PRECONDITION: the caller already holds a SYSTEM DB context — both callers
 * (`checkFixWatchPhase1` / `checkFixWatchPhase2`) run inside `fixWatch.ts`'s
 * `inSystemDbContext`. This module deliberately opens none of its own: a
 * nested wrapper would take a SECOND pooled connection while the first is
 * still held (#2417 / #1105), and at concurrency >= pool size that is a hang.
 * That makes the `org_id = $1` predicate on BOTH sides of the join the only
 * thing keeping one tenant's probe out of another tenant's rows — same posture
 * as `sweepEvidence.ts`, pinned by the compiled-SQL assertions in the test.
 *
 * ## Adding a kind
 *
 * The registry is a `Partial<Record<AiSweepKind, Probe>>` and
 * `isActEligibleSweepKind` is DERIVED from it, so adding a kind to
 * `AI_SWEEP_KINDS` (W03's `expiring_certs`) cannot accidentally make it
 * act-eligible — it stays `unknown` until someone writes its probe here.
 */
import { sql } from 'drizzle-orm';

import type { AiSweepKind } from '@breeze/shared';

// Late-bound namespace import (NOT `const { db } = dbModule`): destructuring
// at module scope freezes the binding at import time, before a test's
// `vi.mock('../../db')` factory can be observed. Same idiom as
// `sweepEvidence.ts`.
import * as dbModule from '../../db';
import { captureException } from '../sentry';

/**
 * `present` — the condition the finding was about is still true.
 * `cleared`  — it is demonstrably no longer true.
 * `unknown`  — the probe could not answer. NOT a synonym for either.
 */
export type SweepSubjectVerdict = 'present' | 'cleared' | 'unknown';

/**
 * How recent an observation has to be to count as an answer. A device that is
 * offline, or simply has not run its check since the remediation, produces no
 * row inside this window — and "it has said nothing" is `unknown`, not
 * "recovered". Deliberately a constant, same reasoning as `FIX_HOLD_MINUTES`:
 * making it configurable needs a merge-semantics design across org and
 * partner-wide policies that this wave does not have.
 */
export const SWEEP_PROBE_FRESHNESS_MS = 30 * 60_000;

type SweepSubjectProbe = (
  orgId: string,
  deviceId: string,
  subjectKey: string,
) => Promise<SweepSubjectVerdict>;

/**
 * Statuses `loadServiceDown` (`sweepEvidence.ts`) treats as a live
 * `service_down` finding. The two MUST agree: if the sweep raises a finding on
 * a status this probe does not consider `present`, the probe reads the
 * still-broken condition as `cleared` and credits a wrong `verified` into an
 * immutable ledger — the very defect class this wave exists to close.
 *
 * Exported solely so `sweepSubjectProbe.test.ts` can compile `loadServiceDown`'s
 * real SQL and assert set equality in both directions. That contract test is
 * the enforcement; this comment is only the reason.
 */
export const SERVICE_DOWN_STATUSES: ReadonlySet<string> = new Set(['stopped', 'not_found', 'error']);

type ProbeRow = {
  status: string | null;
  timestamp: Date | string | null;
} & Record<string, unknown>;

/** ms since an observation, or null when it carries no usable timestamp. */
function ageMs(timestamp: Date | string | null | undefined): number | null {
  if (!timestamp) return null;
  const at = timestamp instanceof Date ? timestamp : new Date(timestamp);
  const ms = at.getTime();
  if (!Number.isFinite(ms)) return null;
  return Date.now() - ms;
}

/**
 * The newest service/process check result for exactly ONE (device, service)
 * pair. Subject-pinned and org-pinned on both sides of the join; ephemeral
 * (Quick Support) enrolments are excluded, matching every statement in
 * `sweepEvidence.ts`.
 */
async function probeServiceDown(
  orgId: string,
  deviceId: string,
  subjectKey: string,
): Promise<SweepSubjectVerdict> {
  const rows = await dbModule.db.execute<ProbeRow>(sql`
    SELECT r.status, r.timestamp
    FROM service_process_check_results r
    JOIN devices d ON d.id = r.device_id
    WHERE r.org_id = ${orgId}
      AND d.org_id = ${orgId}
      AND r.device_id = ${deviceId}
      AND r.name = ${subjectKey}
      AND d.is_ephemeral = false
    ORDER BY r.timestamp DESC
    LIMIT 1
  `);

  const [row] = [...rows];
  if (!row) return 'unknown';

  const age = ageMs(row.timestamp);
  if (age === null || age > SWEEP_PROBE_FRESHNESS_MS) return 'unknown';

  return SERVICE_DOWN_STATUSES.has(row.status ?? '') ? 'present' : 'cleared';
}

/**
 * One probe per ACT-ELIGIBLE kind. v1 needs exactly one (`service_down`); the
 * registry exists so the next kind cannot skip it. A `Partial` record, read
 * through `Object.prototype.hasOwnProperty` below so a kind name coming off a
 * stored trigger key can never resolve a prototype member.
 */
const PROBES: Partial<Record<AiSweepKind, SweepSubjectProbe>> = {
  service_down: probeServiceDown,
};

/**
 * True iff the kind can be act-eligible at all — i.e. it has a probe. W04's
 * act gate reads this; keep it the single source of truth. Takes a bare
 * `string` because the kind arrives parsed out of a stored `trigger_key`, so
 * it carries no compile-time guarantee of being in the catalog.
 */
export function isActEligibleSweepKind(kind: string): kind is AiSweepKind {
  return Object.prototype.hasOwnProperty.call(PROBES, kind)
    && typeof PROBES[kind as AiSweepKind] === 'function';
}

/**
 * Re-probe one sweep subject. Never throws: a query failure is captured and
 * returns `unknown`, because the caller grades a watch on this answer and an
 * error is not evidence that a remediation held.
 */
export async function probeSweepSubject(
  kind: AiSweepKind,
  orgId: string,
  deviceId: string,
  subjectKey: string,
): Promise<SweepSubjectVerdict> {
  if (!isActEligibleSweepKind(kind)) return 'unknown';
  const probe = PROBES[kind]!;

  try {
    return await probe(orgId, deviceId, subjectKey);
  } catch (error) {
    // Identifiers only in the message — no subject values beyond the ids this
    // call already carries, and never a raw row.
    captureException(
      new Error(
        `sweep subject probe failed for kind ${kind} on device ${deviceId} (org ${orgId}); grading as unknown`,
        { cause: error },
      ),
    );
    return 'unknown';
  }
}
