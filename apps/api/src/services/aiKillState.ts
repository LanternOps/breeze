/**
 * Wave 5 Part A (#3827), Task 2 — the DB-backed sibling of the
 * `BREEZE_AI_AGENTS_ENABLED` env-flag kill switch: a single-row, epoch'd
 * `ai_kill_state` row (schema: `db/schema/aiKillState.ts`; migration
 * `2026-09-16-ai-agents-policy-decide-foundations.sql`), seeded not-killed.
 *
 * Nothing in THIS PR ever sets `killed = true` — the only write surface is
 * `bumpAiKillState` below, called by nobody yet (Part B or an ops runbook),
 * or a direct SQL `UPDATE` by ops. The guardrail gate this module feeds
 * (`aiGuardrails.ts`'s `checkAgentGuardrails`) is therefore a pure
 * pass-through until one of those two paths flips the row.
 *
 * TWO READ SURFACES, deliberately different shapes:
 *
 *   - `readAiKillState()` (async, I/O, 5s TTL cache) — the real read. Called
 *     from async call sites BEFORE they invoke (or trigger) a guardrail
 *     check, so the module-level cached snapshot below is warm: today that
 *     is `isStoppedBeforeStart` (runLoop.ts, run admission),
 *     `revalidateActExecution` (actRevalidation.ts, immediately before an
 *     act-mode dispatch's live guardrail re-run), and
 *     `checkAgentReleaseAuthority` (agentReleaseAuthority.ts, immediately
 *     before the release-time guardrail re-run). All three share the same
 *     TTL-cached snapshot — none of them is isolated from a poisoned read
 *     left behind by one of the others within the 5s window.
 *   - `getCachedAiKillStateSnapshot()` (sync, no I/O, no TTL check) — the
 *     seam `checkAgentGuardrails` itself reads. `checkAgentGuardrails` is a
 *     pure synchronous function (many callers rely on that, and it is
 *     verified by `aiGuardrails.agentPrincipal.contract.test.ts`), so it
 *     cannot await a fresh DB read on every tool dispatch. It reads whatever
 *     `readAiKillState()` last cached instead.
 *
 * STALENESS BOUND: at most 5s stale IF a caller on the hot path calls
 * `readAiKillState()` at least that often (both current callers do, once per
 * run-admission and once per act-mode dispatch). Before the first call in a
 * process's lifetime — or if no caller ever refreshes it — the cached
 * snapshot stays at its default, `{ killed: false, epoch: 0 }`
 * (pass-through). This default is deliberate, not merely "not yet fail
 * closed": `checkAgentGuardrails` is called directly, with no
 * `readAiKillState()` call anywhere upstream, by a large existing test
 * surface (`aiGuardrails.agentPrincipal.contract.test.ts`,
 * `actionIntents/intentService.test.ts`, `aiAgents/redTeam.contract.test.ts`,
 * `aiAgents/runLoop.test.ts`, …) and by every production caller before this
 * PR shipped — defaulting the sync snapshot to "killed" would deny all of
 * them, which is exactly the observable-behavior change the plan's
 * inertness contract forbids. Fail-closed is enforced the other way: once a
 * read is ATTEMPTED (by any caller, anywhere) and it fails, the cache flips
 * to killed and stays there until a read succeeds.
 */
import { eq, sql } from 'drizzle-orm';
import {
  db,
  getCurrentDbAccessContext,
  runOutsideDbContext,
  withSystemDbAccessContext,
} from '../db';
import { aiKillState as aiKillStateTable } from '../db/schema/aiKillState';

export interface AiKillStateSnapshot {
  killed: boolean;
  epoch: number;
}

const CACHE_TTL_MS = 5_000;

/** Default snapshot before any read has ever landed in this process: NOT
 *  killed. See the module header's STALENESS BOUND note for why. */
const DEFAULT_SNAPSHOT: AiKillStateSnapshot = { killed: false, epoch: 0 };

let cachedSnapshot: AiKillStateSnapshot = DEFAULT_SNAPSHOT;
let cachedAt = 0;

function selectGlobalRow() {
  return db
    .select({ killed: aiKillStateTable.killed, epoch: aiKillStateTable.epoch })
    .from(aiKillStateTable)
    .where(eq(aiKillStateTable.id, 'global'))
    .limit(1);
}

/**
 * Same escape-then-system pattern as `enrollmentDefaults.ts` /
 * `ipAllowlist.ts`'s `readPartnerAllowlist` caller: `withSystemDbAccessContext`
 * alone is a no-op inside an already-active request context (it inherits the
 * caller's scope, not the isolation this read needs), so an org/partner-scoped
 * ambient context has to be exited via `runOutsideDbContext` first. When the
 * ambient context is already system-scoped (background jobs, the BullMQ
 * run-loop worker), read in it directly rather than opening a second pooled
 * connection for no benefit.
 */
async function readGlobalRowSystemScoped() {
  const ambientScope = getCurrentDbAccessContext()?.scope;
  const rows = ambientScope === 'system'
    ? await selectGlobalRow()
    : await runOutsideDbContext(() => withSystemDbAccessContext(selectGlobalRow));
  return rows[0];
}

/**
 * Cached, fail-closed read of the DB kill switch. Within the 5s TTL, returns
 * the last-fetched snapshot with no I/O; outside it, re-reads `ai_kill_state`
 * and refreshes the module-level snapshot `getCachedAiKillStateSnapshot`
 * (and therefore `checkAgentGuardrails`) reads.
 *
 * FAIL CLOSED: a DB read error — or an unexpectedly missing seed row —
 * caches (and returns) `{ killed: true, epoch: -1 }`. An unreachable
 * database, or one where the migration's seed insert somehow never landed,
 * must never let agents act unattended. This is the opposite failure mode
 * from the env-flag kill switch, which is a synchronous `process.env` read
 * with no failure surface at all; the DB path introduces a new one (network,
 * pool exhaustion, RLS misconfiguration) that has to fail toward safety, not
 * toward availability. `epoch: -1` is deliberately outside the real epoch's
 * domain (`bumpAiKillState` only ever increments from a `bigint NOT NULL
 * DEFAULT 0` column, so it never goes negative) — it marks "fail-closed
 * synthetic state", not a value that was ever actually persisted.
 */
export async function readAiKillState(): Promise<AiKillStateSnapshot> {
  const now = Date.now();
  if (now - cachedAt < CACHE_TTL_MS) return cachedSnapshot;

  try {
    const row = await readGlobalRowSystemScoped();
    cachedSnapshot = row
      ? { killed: row.killed, epoch: row.epoch }
      : { killed: true, epoch: -1 };
  } catch (error) {
    console.error('[aiKillState] failed to read ai_kill_state — failing closed', { error });
    cachedSnapshot = { killed: true, epoch: -1 };
  }
  cachedAt = now;
  return cachedSnapshot;
}

/**
 * Synchronous read of the last-fetched snapshot — no I/O, no TTL check. This
 * is the seam `checkAgentGuardrails` (itself synchronous) reads; see the
 * module header for the staleness bound and the deliberate not-killed
 * default.
 */
export function getCachedAiKillStateSnapshot(): AiKillStateSnapshot {
  return cachedSnapshot;
}

// Named to avoid colliding with the schema module's `AiKillStateRow`
// ($inferSelect, includes `id`) — this is the admin-facing projection.
export interface AiKillStateAdminRow extends AiKillStateSnapshot {
  reason: string | null;
  updatedBy: string | null;
  updatedAt: Date;
}

/**
 * Full-row, UNCACHED read for the admin surface (wave 6 PR 2, #3828). The
 * TTL-cached `readAiKillState` above is the hot-path read; an operator
 * checking the switch before/after a flip needs the database truth plus the
 * provenance columns, so this bypasses the cache entirely — and deliberately
 * does NOT refresh it (the guardrail seam's staleness contract stays owned
 * by `readAiKillState` alone). No fail-closed synthesis either: a missing
 * seed row here is a deployment bug the admin should see as an error, not a
 * synthetic `killed: true` that reads like a real state.
 */
export async function readAiKillStateRow(): Promise<AiKillStateAdminRow> {
  const query = () =>
    db
      .select({
        killed: aiKillStateTable.killed,
        epoch: aiKillStateTable.epoch,
        reason: aiKillStateTable.reason,
        updatedBy: aiKillStateTable.updatedBy,
        updatedAt: aiKillStateTable.updatedAt,
      })
      .from(aiKillStateTable)
      .where(eq(aiKillStateTable.id, 'global'))
      .limit(1);

  const ambientScope = getCurrentDbAccessContext()?.scope;
  const rows = ambientScope === 'system'
    ? await query()
    : await runOutsideDbContext(() => withSystemDbAccessContext(query));
  const [row] = rows;
  if (!row) {
    throw new Error("aiKillState: seed row (id='global') is missing");
  }
  return row;
}

/**
 * Flip the kill switch. CAS-free: a plain single-row `UPDATE` that
 * increments `epoch` by whatever it currently holds in the database — no
 * optimistic-concurrency check against a caller-supplied expected epoch.
 * This is deliberate parity with the OTHER write surface: an operator
 * flipping the row directly via SQL (`UPDATE ai_kill_state SET killed =
 * true, epoch = epoch + 1 WHERE id = 'global'`) has no CAS either, and the
 * two paths need to behave identically under a race — last write wins,
 * epoch still monotonically increases either way.
 *
 * Called by the platform-admin route (`routes/admin/aiKillState.ts`, wave 6
 * PR 2 #3828 — MFA + audit) and documented for ops in
 * `docs/deploy/ai-kill-switch.md`. Refreshes the local cache eagerly on
 * success so this process's own next guardrail check reflects the flip
 * immediately, without waiting out the TTL.
 */
export async function bumpAiKillState(
  killed: boolean,
  reason?: string | null,
  updatedBy?: string | null,
): Promise<AiKillStateSnapshot> {
  const write = () =>
    db
      .update(aiKillStateTable)
      .set({
        killed,
        epoch: sql`${aiKillStateTable.epoch} + 1`,
        reason: reason ?? null,
        updatedBy: updatedBy ?? null,
        updatedAt: new Date(),
      })
      .where(eq(aiKillStateTable.id, 'global'))
      .returning({ killed: aiKillStateTable.killed, epoch: aiKillStateTable.epoch });

  const ambientScope = getCurrentDbAccessContext()?.scope;
  const rows = ambientScope === 'system'
    ? await write()
    : await runOutsideDbContext(() => withSystemDbAccessContext(write));
  const [row] = rows;

  if (!row) {
    throw new Error("aiKillState: UPDATE affected no row — the seed row (id='global') is missing");
  }

  cachedSnapshot = { killed: row.killed, epoch: row.epoch };
  cachedAt = Date.now();
  return cachedSnapshot;
}

/** Test-only: reset the module-level cache between tests so one test's
 *  kill-state can't leak into the next via the 5s TTL. */
export function _resetAiKillStateCacheForTest(): void {
  cachedSnapshot = DEFAULT_SNAPSHOT;
  cachedAt = 0;
}
