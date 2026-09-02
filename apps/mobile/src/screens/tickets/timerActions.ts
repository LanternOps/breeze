import type { RunningTimer, TimeEntry } from '../../services/timeEntries';
import type { LocalTimer } from '../../services/localTimer';
import type { NeedsAttentionRow } from '../../services/timeEntryQueue';
import { closeLocalSpan, type SpanStop } from '../../services/timeSpan';
import {
  classifyTimeEntryDenial,
  type TimeEntryDenial,
} from '../../services/timeEntryAccess';

/**
 * Start/stop, decided once, outside React.
 *
 * The load-bearing rule: NOTHING is enqueued at start time, ever, and a `stop`
 * is never enqueued at all. `POST /time-entries/start` and `/stop` stamp their
 * timestamps server-side at request time, so a queued one records when the
 * phone reconnected rather than when the technician worked. A timer started
 * offline is therefore a purely local record (services/localTimer.ts) that
 * becomes exactly one `create` — carrying its real bounds — when Stop is
 * tapped, and a timer the SERVER started is closed by PATCHing the true end
 * time onto its own row.
 */

export type StartOutcome =
  | { ok: true; entry: TimeEntry }
  /** Ticking on this device only. It is not queued; stopping it is what queues it. */
  | { ok: 'local'; timer: LocalTimer }
  | {
      ok: false;
      reason: 'already-running' | 'denied' | 'unknown';
      message: string;
      denial?: TimeEntryDenial;
    };

export type StopOutcome =
  | { ok: true; entry: TimeEntry }
  | { ok: 'queued' }
  | {
      ok: false;
      reason: 'not-running' | 'denied' | 'unknown' | 'unusable-clock';
      message: string;
      denial?: TimeEntryDenial;
    };

export interface Stamp {
  localId: string;
  wallMs: number;
  monoMs: number | null;
  monoEpochId: string;
}

export interface StartDeps {
  startTimer: (input: { ticketId?: string }) => Promise<TimeEntry>;
  writeLocalTimer: (timer: LocalTimer) => Promise<void>;
  clearLocalTimer: () => Promise<void>;
  isConnected: () => boolean;
  stamp: () => Stamp;
}

export interface StopDeps {
  stopTimer: (input: { description?: string; isBillable?: boolean }) => Promise<TimeEntry>;
  enqueue: (w: {
    kind: 'create' | 'closeEntry';
    payload: Record<string, unknown>;
  }) => Promise<unknown>;
  readLocalTimer: () => Promise<LocalTimer | null>;
  clearLocalTimer: () => Promise<void>;
  parkNeedsAttention: (row: NeedsAttentionRow) => Promise<boolean>;
  isConnected: () => boolean;
  stamp: () => Stamp;
}

const SAVE_FAILED_START =
  'Could not save the timer on this device. Note the time and enter it from the timesheet.';
const SAVE_FAILED_STOP =
  'Could not save the stop offline. Note the time and re-enter it from the timesheet.';
const CLOCK_MOVED =
  'The device clock changed while this timer ran, so its length is unknown. Enter it manually from the timesheet.';

function errorField(error: unknown, field: string): unknown {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  return (error as Record<string, unknown>)[field];
}

function getStatus(error: unknown): number | undefined {
  const status = errorField(error, 'status');
  if (typeof status === 'number') {
    return status;
  }

  const statusCode = errorField(error, 'statusCode');
  return typeof statusCode === 'number' ? statusCode : undefined;
}

function getCode(error: unknown): string | undefined {
  const code = errorField(error, 'code');
  return typeof code === 'string' ? code : undefined;
}

function getMessage(error: unknown, fallback: string): string {
  const message = errorField(error, 'message');
  return typeof message === 'string' && message.length > 0 ? message : fallback;
}

function stopStop(stamp: Stamp): SpanStop {
  return { wallMs: stamp.wallMs, monoMs: stamp.monoMs, monoEpochId: stamp.monoEpochId };
}

export async function startForTicket(
  ticketId: string,
  deps: StartDeps
): Promise<StartOutcome> {
  const stamp = deps.stamp();
  const timer: LocalTimer = {
    localId: stamp.localId,
    ticketId,
    serverEntryId: null,
    startedAtWall: new Date(stamp.wallMs).toISOString(),
    startedAtMono: stamp.monoMs,
    monoEpochId: stamp.monoEpochId,
    // Nothing has been asked of the server yet, so a start MAY be about to land.
    startConfirmed: false,
    description: null,
  };

  // Persisted BEFORE any network call. If the app is killed between the tap and
  // the response, the record of when the technician started still exists.
  try {
    await deps.writeLocalTimer(timer);
  } catch {
    return { ok: false, reason: 'unknown', message: SAVE_FAILED_START };
  }

  if (!deps.isConnected()) {
    // No request was made, so no server entry can exist: the start is confirmed
    // absent, which is exactly as certain as confirmed present.
    const offline: LocalTimer = { ...timer, startConfirmed: true };
    try {
      await deps.writeLocalTimer(offline);
    } catch {
      return { ok: false, reason: 'unknown', message: SAVE_FAILED_START };
    }
    return { ok: 'local', timer: offline };
  }

  try {
    const entry = await deps.startTimer({ ticketId });
    // The server's stamp is authoritative from here on.
    const owned: LocalTimer = {
      ...timer,
      serverEntryId: entry.id,
      startedAtWall: entry.startedAt,
      startConfirmed: true,
      description: entry.description,
    };
    try {
      await deps.writeLocalTimer(owned);
    } catch {
      // The entry exists on the server and the store adopts it either way; the
      // only loss is the offline `closeEntry` shortcut, which falls back to the
      // running timer's own id.
    }
    return { ok: true, entry };
  } catch (error) {
    const code = getCode(error);
    if (code === 'ENTRY_RUNNING') {
      await deps.clearLocalTimer().catch(() => undefined);
      return {
        ok: false,
        reason: 'already-running',
        // `startTimer` auto-stops the caller's previous timer before
        // inserting, so this 409 is only ever a lost insert race — never the
        // ordinary "a timer is already running" case. Telling the technician
        // to stop something first would send them after a phantom.
        message: 'Another timer change landed first. Try again.',
      };
    }

    const status = getStatus(error);
    if (status === undefined) {
      // The request may or may not have reached the server. The timer keeps
      // ticking locally with `startConfirmed: false`, and the reconciler
      // (services/timerReconcile.ts) resolves the ambiguity against
      // GET /time-entries/running rather than guessing.
      return { ok: 'local', timer };
    }

    // A verdict: no server entry was created, so neither is a local one.
    await deps.clearLocalTimer().catch(() => undefined);

    if (status === 403) {
      const denial = classifyTimeEntryDenial(error);
      if (denial !== null) {
        return { ok: false, reason: 'denied', denial, message: denial.message };
      }
    }

    return {
      ok: false,
      reason: 'unknown',
      message: getMessage(error, 'Could not start the timer.'),
    };
  }
}

export async function stopRunningTimer(
  input: { description?: string; isBillable?: boolean; running: RunningTimer | null },
  deps: StopDeps
): Promise<StopOutcome> {
  const stamp = deps.stamp();
  const local = await deps.readLocalTimer().catch(() => null);
  const serverEntryId = input.running?.id ?? local?.serverEntryId ?? null;

  return serverEntryId === null
    ? closeLocalTimer(input, deps, stamp, local)
    : closeServerTimer(input, deps, stamp, serverEntryId);
}

/**
 * A timer the server does not have. `/time-entries/stop` cannot close it — it
 * is a CAS on "whatever entry this user has running", which is either nothing
 * or somebody else's row — so this path is identical online and offline: one
 * `create` carrying the real span, replayed by the drain.
 */
async function closeLocalTimer(
  input: { description?: string; isBillable?: boolean; running: RunningTimer | null },
  deps: StopDeps,
  stamp: Stamp,
  local: LocalTimer | null
): Promise<StopOutcome> {
  const startedAtWall = local?.startedAtWall ?? input.running?.startedAt ?? null;
  if (startedAtWall === null) {
    return { ok: false, reason: 'not-running', message: 'No timer is running.' };
  }

  const span = closeLocalSpan(
    {
      startedAtWall,
      startedAtMono: local?.startedAtMono ?? null,
      monoEpochId: local?.monoEpochId ?? null,
    },
    stopStop(stamp)
  );

  const ticketId = local?.ticketId ?? input.running?.ticketId ?? null;
  const description = input.description ?? local?.description ?? undefined;

  if ('unusable' in span) {
    // Inventing a duration would be inventing a bill. Park the record so the
    // work is still visible and the technician can enter it by hand.
    await deps
      .parkNeedsAttention({
        write: {
          id: local?.localId ?? `local-${stamp.wallMs}`,
          kind: 'create',
          payload: {
            startedAtWall,
            ...(ticketId === null ? {} : { ticketId }),
            ...(description === undefined ? {} : { description }),
          },
          queuedAt: new Date(stamp.wallMs).toISOString(),
          attempts: 0,
        },
        status: 0,
        code: 'CLOCK_WENT_BACKWARDS',
        message: CLOCK_MOVED,
        failedAt: new Date(stamp.wallMs).toISOString(),
      })
      .catch(() => false);
    await deps.clearLocalTimer().catch(() => undefined);
    return { ok: false, reason: 'unusable-clock', message: CLOCK_MOVED };
  }

  try {
    // An unguarded rejection here is a silent no-op that loses the whole entry:
    // `readQueue` really does reject on an AsyncStorage failure by design, and
    // every caller invokes this as `void onStop()` inside try/finally with no
    // catch, so the technician would work the job believing time was tracked.
    await deps.enqueue({
      kind: 'create',
      payload: {
        startedAt: span.startedAt,
        endedAt: span.endedAt,
        ...(ticketId === null ? {} : { ticketId }),
        ...(description === undefined ? {} : { description }),
        ...(input.isBillable === undefined ? {} : { isBillable: input.isBillable }),
        // The reconciler needs to know a start request may have landed before
        // it posts what could be a second entry for the same work.
        ...(local !== null && !local.startConfirmed ? { unconfirmedStart: true } : {}),
      },
    });
  } catch {
    return { ok: false, reason: 'unknown', message: SAVE_FAILED_STOP };
  }

  await deps.clearLocalTimer().catch(() => undefined);
  return { ok: 'queued' };
}

/** A timer the server owns, closed either now or by a targeted PATCH later. */
async function closeServerTimer(
  input: { description?: string; isBillable?: boolean },
  deps: StopDeps,
  stamp: Stamp,
  serverEntryId: string
): Promise<StopOutcome> {
  const queueClose = async (): Promise<StopOutcome> => {
    try {
      // NOT a `stop`: the server stamps `endedAt = now` on that endpoint, so a
      // 15:00 stop replayed at 18:00 bills three extra hours. A targeted PATCH
      // is also effect-idempotent, where a retried `/stop` 404s and is reported
      // to the technician as work that could not be saved when in fact it was.
      await deps.enqueue({
        kind: 'closeEntry',
        payload: {
          id: serverEntryId,
          endedAt: new Date(stamp.wallMs).toISOString(),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.isBillable === undefined ? {} : { isBillable: input.isBillable }),
        },
      });
    } catch {
      return { ok: false, reason: 'unknown', message: SAVE_FAILED_STOP };
    }
    await deps.clearLocalTimer().catch(() => undefined);
    return { ok: 'queued' };
  };

  if (!deps.isConnected()) return queueClose();

  try {
    const entry = await deps.stopTimer({
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.isBillable === undefined ? {} : { isBillable: input.isBillable }),
    });
    await deps.clearLocalTimer().catch(() => undefined);
    return { ok: true, entry };
  } catch (error) {
    const code = getCode(error);
    if (code === 'NO_RUNNING_TIMER') {
      await deps.clearLocalTimer().catch(() => undefined);
      return { ok: false, reason: 'not-running', message: 'No timer is running.' };
    }

    const status = getStatus(error);
    if (status === 403) {
      const denial = classifyTimeEntryDenial(error);
      if (denial !== null) {
        return { ok: false, reason: 'denied', denial, message: denial.message };
      }
    }

    if (status === undefined) {
      // Only a transport failure is safe to replay. Queued 4xx verdicts would
      // be parked or wedge the queue head, while a technician's billable
      // minutes must survive a failed connection.
      return queueClose();
    }

    return {
      ok: false,
      reason: 'unknown',
      message: getMessage(error, 'Could not stop the timer.'),
    };
  }
}
