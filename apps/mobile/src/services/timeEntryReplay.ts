import type { CreateTimeEntryInput, TimeEntry, UpdateTimeEntryInput } from './timeEntries';
import type { QueuedWrite } from './timeEntryQueue';
import type { ConfirmSuggestionInput, SuggestionSignalRef } from './timeSuggestions';
import { shiftIntoPast } from './timeSpan';

/**
 * Turns a queued write back into the API call that made it.
 *
 * Pure module (no React, no direct transport) so the mapping is unit-testable:
 * `drain` decides what to keep and what to park purely from the status on the
 * error this sender throws, which makes the mapping a correctness surface, not
 * glue.
 *
 * `startTimer` and `stopTimer` are deliberately ABSENT from `ReplaySenders`.
 * Both are server-stamped verbs — the server writes `new Date()` for the bound
 * they set — so replaying one rewrites when the work happened. Their absence
 * from this interface is what makes that a compile error rather than a
 * convention somebody re-reads and re-breaks.
 */

export interface ReplaySenders {
  createTimeEntry: (input: CreateTimeEntryInput) => Promise<TimeEntry>;
  updateTimeEntry: (id: string, input: UpdateTimeEntryInput) => Promise<TimeEntry>;
  /** W06 (#3900). Carries its own startedAt/endedAt, like every other sender here. */
  confirmSuggestion: (input: ConfirmSuggestionInput) => Promise<unknown>;
  dismissSuggestion: (signals: SuggestionSignalRef[]) => Promise<unknown>;
  /** The server's clock (services/serverClock.ts), in ms. */
  serverNow: () => number;
}

function signalRefs(payload: Record<string, unknown>): SuggestionSignalRef[] | undefined {
  const value = payload.signals;
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const refs: SuggestionSignalRef[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const { kind, id } = entry as Partial<SuggestionSignalRef>;
    if (kind !== 'remote_session' || typeof id !== 'string' || id.length === 0) return undefined;
    refs.push({ kind, id });
  }
  return refs;
}

/**
 * A queued row this build cannot send — an unknown `kind` from a newer app
 * version, or a `create` with no time bounds.
 *
 * It carries status 400 deliberately: `drain` treats 400 as a verdict and
 * PARKS the row in needs-attention, reporting it to the caller. The
 * alternative — a bare throw with no status — is read as a transient failure
 * and retried forever, wedging every entry queued behind it, which loses far
 * more billable work than the one unsendable row.
 */
export class UnreplayableWriteError extends Error {
  readonly status = 400;
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = 'UnreplayableWriteError';
  }
}

function optionalString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' ? value : undefined;
}

function optionalBoolean(payload: Record<string, unknown>, key: string): boolean | undefined {
  const value = payload[key];
  return typeof value === 'boolean' ? value : undefined;
}

function compact<T extends object>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}

export function makeReplaySender(senders: ReplaySenders): (write: QueuedWrite) => Promise<void> {
  return async (write: QueuedWrite): Promise<void> => {
    switch (write.kind) {
      case 'create': {
        const storedStart = optionalString(write.payload, 'startedAt');
        const storedEnd = optionalString(write.payload, 'endedAt');
        if (storedStart === undefined || storedEnd === undefined) {
          throw new UnreplayableWriteError('Queued time entry is missing its start or end time');
        }

        // A phone whose clock runs fast produces a span the server refuses as
        // too far in the future, and that 400 is permanent. Shifting BOTH
        // bounds keeps the duration exact while making the span sendable.
        const shifted = shiftIntoPast(storedStart, storedEnd, senders.serverNow());
        // Written back so a retry shifts an already-shifted span by zero rather
        // than chasing a clock that moved again between attempts.
        write.payload.startedAt = shifted.startedAt;
        write.payload.endedAt = shifted.endedAt;

        await senders.createTimeEntry(
          compact({
            startedAt: shifted.startedAt,
            endedAt: shifted.endedAt,
            ticketId: optionalString(write.payload, 'ticketId'),
            description: optionalString(write.payload, 'description'),
            isBillable: optionalBoolean(write.payload, 'isBillable'),
          }) as CreateTimeEntryInput
        );
        return;
      }

      case 'closeEntry': {
        const id = optionalString(write.payload, 'id');
        const endedAt = optionalString(write.payload, 'endedAt');
        if (id === undefined || endedAt === undefined) {
          throw new UnreplayableWriteError('Queued timer stop is missing its entry id or end time');
        }
        // Deliberately NOT shifted: this closes a row the SERVER started, so
        // its `startedAt` is already the server's own stamp and `endedAt`
        // carries no notFarFuture refine. Re-applying the same PATCH is
        // effect-idempotent, which is why an ambiguous transport failure here
        // is recoverable where a retried `/stop` would 404.
        await senders.updateTimeEntry(
          id,
          compact({
            endedAt,
            description: optionalString(write.payload, 'description'),
            isBillable: optionalBoolean(write.payload, 'isBillable'),
          })
        );
        return;
      }

      case 'suggestion.confirm': {
        const signals = signalRefs(write.payload);
        const startedAt = optionalString(write.payload, 'startedAt');
        if (signals === undefined || startedAt === undefined) {
          throw new UnreplayableWriteError('Queued suggestion confirm is missing its signals or start time');
        }
        // Deliberately NOT shifted, unlike `create`. These bounds come from the
        // remote_session rows the SERVER recorded, not from this phone's clock,
        // and the server re-validates the range against those same signals — so
        // a shift would move the window away from the session it describes and
        // be rejected, or worse, bill a window that never happened.
        await senders.confirmSuggestion(
          compact({
            signals,
            startedAt,
            endedAt: optionalString(write.payload, 'endedAt'),
            ticketId: optionalString(write.payload, 'ticketId'),
            description: optionalString(write.payload, 'description'),
          }) as ConfirmSuggestionInput
        );
        return;
      }

      case 'suggestion.dismiss': {
        const signals = signalRefs(write.payload);
        if (signals === undefined) {
          throw new UnreplayableWriteError('Queued suggestion dismiss is missing its signals');
        }
        await senders.dismissSuggestion(signals);
        return;
      }

      default:
        throw new UnreplayableWriteError(
          `Queued time entry has an unknown kind: ${String(write.kind)}`
        );
    }
  };
}
