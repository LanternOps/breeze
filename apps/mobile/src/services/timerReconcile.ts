import type { LocalTimer } from './localTimer';
import type { RunningTimer, TimeEntry, UpdateTimeEntryInput } from './timeEntries';
import type { QueuedWrite } from './timeEntryQueue';

/**
 * Resolves what the server actually has against what this device believes.
 *
 * Two situations need it, both created by an ambiguous transport failure:
 *
 *  - a start request whose response never arrived, so a server entry MAY exist
 *    for a timer this device is still ticking locally;
 *  - the queued `create` that such a timer became when it was stopped, which
 *    would post a SECOND entry for the same work.
 *
 * Both are resolved by one `GET /time-entries/running` and matching on
 * (ticketId, startedAt). Pure module: no storage, no transport.
 */

/** The server stamps its own startedAt, so the two clocks are never identical. */
const MATCH_WINDOW_MS = 10 * 60_000;
/** Bounds within this of an existing entry mean the write already landed. */
const DUPLICATE_WINDOW_MS = 60_000;

export interface TimerCandidate {
  ticketId: string | null;
  startedAtMs: number;
}

export function matchesServerTimer(candidate: TimerCandidate, server: RunningTimer): boolean {
  if ((server.ticketId ?? null) !== candidate.ticketId) return false;
  const serverStartMs = Date.parse(server.startedAt);
  if (Number.isNaN(serverStartMs) || Number.isNaN(candidate.startedAtMs)) return false;
  return Math.abs(serverStartMs - candidate.startedAtMs) <= MATCH_WINDOW_MS;
}

export interface CloseSubstitution {
  /** The queued `create` this replaces. */
  writeId: string;
  entryId: string;
  endedAt: string;
  description?: string;
  isBillable?: boolean;
}

export interface ReconcilePlan {
  /** Adopt the local timer under the server's identity, or null. */
  adopt: { serverEntryId: string; startedAt: string } | null;
  /** Send this `closeEntry` instead of the named queued `create`, or null. */
  substitute: CloseSubstitution | null;
}

const NO_PLAN: ReconcilePlan = { adopt: null, substitute: null };

/** True when something on this device might be shadowing a real server timer. */
export function needsReconciliation(
  localTimer: LocalTimer | null,
  queue: readonly QueuedWrite[]
): boolean {
  if (localTimer !== null && localTimer.serverEntryId === null && !localTimer.startConfirmed) {
    return true;
  }
  return queue.some((write) => write.kind === 'create' && write.payload.unconfirmedStart === true);
}

export function planReconciliation(input: {
  localTimer: LocalTimer | null;
  queue: readonly QueuedWrite[];
  server: RunningTimer | null;
}): ReconcilePlan {
  const { localTimer, queue, server } = input;
  if (server === null || server.id === null) return NO_PLAN;

  if (
    localTimer !== null &&
    localTimer.serverEntryId === null &&
    !localTimer.startConfirmed &&
    matchesServerTimer(
      { ticketId: localTimer.ticketId, startedAtMs: Date.parse(localTimer.startedAtWall) },
      server
    )
  ) {
    // The start DID land. The server's stamp is authoritative from here on.
    return { adopt: { serverEntryId: server.id, startedAt: server.startedAt }, substitute: null };
  }

  for (const write of queue) {
    if (write.kind !== 'create' || write.payload.unconfirmedStart !== true) continue;
    const startedAt = write.payload.startedAt;
    const endedAt = write.payload.endedAt;
    if (typeof startedAt !== 'string' || typeof endedAt !== 'string') continue;
    const ticketId = typeof write.payload.ticketId === 'string' ? write.payload.ticketId : null;
    if (!matchesServerTimer({ ticketId, startedAtMs: Date.parse(startedAt) }, server)) continue;

    // The start landed after all, so the server already holds an OPEN row for
    // this work. Creating a second entry would double-bill it and leave the
    // first running forever; closing the one that exists records the true end
    // and clears the phantom in a single call.
    return {
      adopt: null,
      substitute: {
        writeId: write.id,
        entryId: server.id,
        endedAt,
        ...(typeof write.payload.description === 'string'
          ? { description: write.payload.description }
          : {}),
        ...(typeof write.payload.isBillable === 'boolean'
          ? { isBillable: write.payload.isBillable }
          : {}),
      },
    };
  }

  return NO_PLAN;
}

/**
 * Whether this week's timesheet already contains the entry a retried `create`
 * would post.
 *
 * A create whose response was lost may already be on the server. Best effort by
 * design: the caller sends when this cannot be answered, because a duplicate is
 * correctable from the timesheet while a lost entry is unbilled work.
 */
export function findDeliveredDuplicate(
  entries: readonly TimeEntry[],
  candidate: { ticketId: string | null; startedAt: string; endedAt: string }
): TimeEntry | null {
  const startMs = Date.parse(candidate.startedAt);
  const endMs = Date.parse(candidate.endedAt);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null;

  for (const entry of entries) {
    if ((entry.ticketId ?? null) !== candidate.ticketId) continue;
    if (entry.endedAt === null) continue;
    const entryStart = Date.parse(entry.startedAt);
    const entryEnd = Date.parse(entry.endedAt);
    if (Number.isNaN(entryStart) || Number.isNaN(entryEnd)) continue;
    if (
      Math.abs(entryStart - startMs) <= DUPLICATE_WINDOW_MS &&
      Math.abs(entryEnd - endMs) <= DUPLICATE_WINDOW_MS
    ) {
      return entry;
    }
  }
  return null;
}

export interface ReconciledSenderDeps {
  /** The ordinary replay sender (services/timeEntryReplay.ts). */
  base: (write: QueuedWrite) => Promise<void>;
  plan: ReconcilePlan;
  updateTimeEntry: (id: string, input: UpdateTimeEntryInput) => Promise<unknown>;
  /**
   * Entries the server already holds for the week containing this write, or
   * null when that could not be established. Only consulted for a RETRIED
   * create, so the ordinary drain costs no extra request.
   */
  lookupWeekEntries: (write: QueuedWrite) => Promise<readonly TimeEntry[] | null>;
}

/**
 * Wraps the replay sender with everything that depends on what the server
 * already has. Kept here, and pure, because both branches decide whether a
 * customer gets billed twice — that is not glue.
 */
export function makeReconciledSender(
  deps: ReconciledSenderDeps
): (write: QueuedWrite) => Promise<void> {
  return async (write: QueuedWrite): Promise<void> => {
    const substitute = deps.plan.substitute;
    if (substitute !== null && substitute.writeId === write.id) {
      // The start landed after all, so the server already holds an OPEN row for
      // this work. Closing it records the true end AND clears the phantom;
      // posting the create would double-bill the job and leave the phantom
      // running forever.
      await deps.updateTimeEntry(substitute.entryId, {
        endedAt: substitute.endedAt,
        ...(substitute.description === undefined ? {} : { description: substitute.description }),
        ...(substitute.isBillable === undefined ? {} : { isBillable: substitute.isBillable }),
      });
      return;
    }

    if (write.kind === 'create' && write.attempts > 0) {
      const startedAt = write.payload.startedAt;
      const endedAt = write.payload.endedAt;
      if (typeof startedAt === 'string' && typeof endedAt === 'string') {
        // Best effort by design: when the week cannot be read we SEND, because
        // a duplicate is correctable from the timesheet while a lost entry is
        // simply unbilled work.
        const entries = await deps.lookupWeekEntries(write).catch(() => null);
        if (entries !== null) {
          const ticketId = typeof write.payload.ticketId === 'string' ? write.payload.ticketId : null;
          if (findDeliveredDuplicate(entries, { ticketId, startedAt, endedAt }) !== null) return;
        }
      }
    }

    await deps.base(write);
  };
}
