/**
 * D12 (spec §10, decided 2026-10-22) — "Apply to open tickets": move open
 * tickets on an OLDER revision of a calendar to its CURRENT revision and
 * recompute their deadlines exactly. Limited to tickets with no pause history
 * (`sla_paused_business_minutes = 0` and not paused): their business pause
 * minutes were never counted under the old hours, so the recompute is exact.
 * Tickets with pauses keep their revision (re-reading past pauses under other
 * hours cannot be done correctly, quorum C4); the preview counts them.
 * "No pause history" also means no wall-clock pause minutes: a pause that fell
 * outside the old hours counted 0 business minutes but the new hours may
 * count it. Frozen arms keep their deadline. Tickets on a null revision are
 * never on this calendar and are never touched.
 *
 * Behind a preview (eligible / immediately-breached / skipped-paused counts),
 * and applied with an `expectedRevisionId` so an hours edit landing between
 * preview and confirm is refused (409 REVISION_CHANGED) instead of applying
 * hours the operator never saw.
 *
 * Gated like every partner-wide write (canManagePartnerWidePolicies, via
 * loadCalendarForWrite). The apply runs in chunks of APPLY_CHUNK, each in its
 * OWN short caller-scoped transaction (the route is self-managed, so no
 * request transaction holds thousands of ticket row locks), FOR UPDATE SKIP
 * LOCKED; a row a concurrent writer holds is retried a few rounds and then
 * reported as skipped.
 *
 * Merged tombstones (#8972) are excluded from the candidates (cross-wave
 * rebase rule), on top of the open-status filter they already fail.
 */
import type { BusinessCalendarApplyPreviewDto } from '@breeze/shared';
import { db, withDbAccessContext } from '../../db';
import { dbAccessContextFromAuth, type AuthContext } from '../../middleware/auth';
import { requestLikeFromSnapshot, writeAuditEvent } from '../auditEvents';
import { captureException } from '../sentry';
import { computeSlaDeadlines, loadTicketCalendars, slaClockRowOf, type TicketCalendar } from '../ticketSlaDeadlines';
import * as repo from './repository';
import type { ApplyCandidateRow } from './repository';
import { BusinessCalendarError, loadCalendarForWrite, type CalendarAuth } from './service';

export const APPLY_CHUNK = 500;
const MAX_LOCK_ROUNDS = 5;
const OPEN = new Set(['new', 'open', 'pending', 'on_hold']);

type Runner = <T>(fn: () => Promise<T>) => Promise<T>;
export type ApplyOptions = { run?: Runner; now?: Date; sleep?: (ms: number) => Promise<void> };

/**
 * No pause history at all. Business minutes alone are not enough: a pause that
 * fell entirely outside the OLD hours has 0 business minutes but real
 * wall-clock minutes, which the new hours may count — not exact, so skipped.
 */
const neverPaused = (r: Pick<ApplyCandidateRow, 'slaPausedBusinessMinutes' | 'slaPausedMinutes' | 'slaPausedAt'>) =>
  (r.slaPausedBusinessMinutes ?? 0) === 0 && (r.slaPausedMinutes ?? 0) === 0 && r.slaPausedAt == null;

function defaultRunner(auth: CalendarAuth): Runner {
  return (fn) => withDbAccessContext(dbAccessContextFromAuth(auth as AuthContext), fn);
}

async function loadTarget(auth: CalendarAuth, calendarId: string) {
  const calendar = await loadCalendarForWrite(auth, calendarId);
  const current = (await repo.currentRevisions([calendar.id])).get(calendar.id);
  if (!current) throw new BusinessCalendarError('This calendar has no hours yet', 409, 'NO_REVISION');
  const snapshot = (await loadTicketCalendars(db, [current.revision.id])).get(current.revision.id) ?? null;
  if (!snapshot) throw new BusinessCalendarError('This calendar has no hours yet', 409, 'NO_REVISION');
  return {
    calendar,
    target: { id: current.revision.id, revision: current.revision.revision },
    snapshot: snapshot as NonNullable<TicketCalendar>,
  };
}

function patchFor(row: ApplyCandidateRow, targetId: string, snapshot: NonNullable<TicketCalendar>) {
  return { slaCalendarRevisionId: targetId, ...computeSlaDeadlines(slaClockRowOf(row), snapshot) };
}

/** Counts only; writes nothing. Runs in the caller's ambient (request) context. */
export async function previewApplyRevision(
  auth: CalendarAuth,
  calendarId: string,
  now: Date = new Date(),
): Promise<BusinessCalendarApplyPreviewDto> {
  return (async () => {
    const { target, snapshot } = await loadTarget(auth, calendarId);
    let eligibleCount = 0;
    let immediatelyBreachedCount = 0;
    let skippedPausedCount = 0;
    let after: string | null = null;
    for (;;) {
      const rows = await repo.listApplyCandidates(calendarId, target, after, APPLY_CHUNK);
      for (const row of rows) {
        if (!neverPaused(row)) {
          skippedPausedCount++;
          continue;
        }
        eligibleCount++;
        const patch = patchFor(row, target.id, snapshot);
        const breached = [patch.responseDueAt, patch.resolutionDueAt].some((due) => due != null && due.getTime() <= now.getTime());
        if (breached) immediatelyBreachedCount++;
      }
      if (rows.length < APPLY_CHUNK) break;
      after = rows[rows.length - 1]!.id;
    }
    return { revisionId: target.id, eligibleCount, immediatelyBreachedCount, skippedPausedCount };
  })();
}

export async function applyRevision(
  auth: CalendarAuth,
  calendarId: string,
  input: { expectedRevisionId: string },
  opts: ApplyOptions = {},
): Promise<{ updated: number; skippedLocked: number }> {
  const run = opts.run ?? defaultRunner(auth);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const { calendar, target, snapshot } = await run(async () => {
    const loaded = await loadTarget(auth, calendarId);
    if (loaded.target.id !== input.expectedRevisionId) {
      throw new BusinessCalendarError('The calendar hours changed since the preview; review the new preview first', 409, 'REVISION_CHANGED');
    }
    return loaded;
  });

  let updated = 0;
  let skippedPausedCount = 0;
  let after: string | null = null;
  let exhausted = false;
  let carry: string[] = [];
  const rounds = new Map<string, number>();
  let skippedLocked = 0;

  for (;;) {
    let fresh: string[] = [];
    if (!exhausted) {
      const rows: ApplyCandidateRow[] = await run(() => repo.listApplyCandidates(calendarId, target, after, APPLY_CHUNK));
      if (rows.length < APPLY_CHUNK) exhausted = true;
      if (rows.length > 0) after = rows[rows.length - 1]!.id;
      for (const row of rows) {
        if (neverPaused(row)) fresh.push(row.id);
        else skippedPausedCount++;
      }
    }
    const batch = [...carry, ...fresh];
    if (batch.length === 0) {
      if (exhausted) break;
      continue;
    }
    const locked = await run(async () => {
      const rows = await repo.lockApplyBatch(calendarId, target, batch);
      for (const row of rows) {
        // Re-checked under the row lock: still open, still never paused, and
        // still on an OLDER revision of THIS calendar — a ticket a mover
        // re-resolved onto another calendar (or already on the target) since
        // it was listed is left alone.
        if (!OPEN.has(row.status) || row.deletedAt || !neverPaused(row)) continue;
        if (row.revisionCalendarId !== calendarId || row.revisionNumber == null || row.revisionNumber >= target.revision) continue;
        await repo.applyTicketRevision(row.id, patchFor(row, target.id, snapshot));
        updated++;
      }
      return new Set(rows.map((r) => r.id));
    });
    carry = [];
    for (const id of batch) {
      if (locked.has(id)) continue;
      const n = (rounds.get(id) ?? 0) + 1;
      rounds.set(id, n);
      if (n >= MAX_LOCK_ROUNDS) skippedLocked++;
      else carry.push(id);
    }
    if (carry.length > 0 && fresh.length === 0) await sleep(50 * Math.max(...carry.map((id) => rounds.get(id) ?? 1)));
    if (exhausted && carry.length === 0) break;
  }

  try {
    writeAuditEvent(requestLikeFromSnapshot({}), {
      orgId: calendar.orgId,
      ...(calendar.orgId ? {} : { partnerId: calendar.partnerId }),
      actorId: auth.user.id,
      actorEmail: auth.user.email,
      action: 'business_calendar.apply_revision',
      resourceType: 'business_calendar',
      resourceId: calendar.id,
      resourceName: calendar.name,
      result: 'success',
      details: { revisionId: target.id, revision: target.revision, updated, skippedPausedCount, skippedLocked },
    });
  } catch (err) {
    console.error('[businessCalendars] apply-revision audit write failed', err);
    captureException(err);
  }
  return { updated, skippedLocked };
}
