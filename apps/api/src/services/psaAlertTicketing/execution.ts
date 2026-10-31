import { randomUUID } from 'node:crypto';
import type { PSAAlertTicketing } from '../psa/types';
import { PsaAdapterError } from '../psa/types';
import {
  nextOperation,
  type TicketMapping,
  type TicketAlert,
  type CreateSnapshot,
  type TicketOperation,
} from './stateMachine';
import type { TicketingErrorId } from './reporting';
import { TicketingLeaseLostError, TicketingRedisError } from './controlErrors';
import { TICKETING_LEASE_MS } from './constants';
export type MappingChanges = Omit<
  Partial<TicketMapping>,
  'id' | 'connectionId' | 'alertId' | 'leaseToken' | 'leaseUntil' | 'createdAt'
>;
export interface TicketingContext {
  mapping: TicketMapping;
  alert: TicketAlert | null;
  connection: {
    id: string;
    partnerId: string | null;
    provider: string;
    alertTicketingPausedReason: string | null;
  };
  canCreate: boolean;
  inactiveReason?: string;
  companyIds: string[];
  snapshot: CreateSnapshot;
  adapter: Pick<
    PSAAlertTicketing,
    'createAlertTicket' | 'findTicketsByMarker' | 'closeTicket' | 'addNote'
  >;
}
export interface TicketingDeps {
  beforeCall?(): Promise<void>;
  beforeCreate?(context: TicketingContext): Promise<boolean>;
  refundCreateBudget?(): Promise<void>;
  renewLease?(id: string, token: string, now: Date): Promise<boolean>;
  load(id: string): Promise<TicketingContext | null>;
  claim(
    expected: TicketMapping,
    token: string,
    changes: MappingChanges,
    now: Date
  ): Promise<boolean>;
  save(id: string, token: string, changes: MappingChanges, now: Date): Promise<boolean>;
  pause(context: TicketingContext): Promise<void>;
  wake(id: string, op: 'create' | 'close' | 'note', at: Date): Promise<void>;
  report(context: TicketingContext, errorId: TicketingErrorId, error?: unknown): void;
}
const hour = 3600000;
function isTicketingControlError(error: unknown) {
  return error instanceof TicketingLeaseLostError || error instanceof TicketingRedisError;
}

function deadline(ctx: TicketingContext, op: TicketOperation, now: Date) {
  const m = ctx.mapping;
  if (op === 'create') return m.deadlineAt ?? new Date(m.createdAt.getTime() + 24 * hour);
  if (op === 'adopt_lookup')
    return new Date(
      m.createSnapshot?.unknownDeadline ??
        (m.updatedAt ?? now).getTime() + 2 * hour
    );
  return new Date(
    ((op === 'close' ? ctx.alert?.resolvedAt : ctx.alert?.acknowledgedAt) ?? now).getTime() +
      (op === 'close' && m.createSnapshot?.closeOnResolve ? 72 : 24) *
        hour
  );
}
export async function executeTicketing(
  mappingId: string,
  deps: TicketingDeps,
  now = new Date()
): Promise<void> {
  const ctx = await deps.load(mappingId);
  if (!ctx) {
    console.warn('[psa-ticketing] context unavailable', { mappingId });
    return; // The loader records a deferred reason when the ledger row still exists.
  }
  if (ctx.connection.alertTicketingPausedReason) return;
  // Clone the observed row: the CAS compares this version, never a mutated reference.
  const m = { ...ctx.mapping };
  const op = nextOperation(m, ctx.alert, now);
  if (op === 'none') {
    const at = m.nextAttemptAt && m.nextAttemptAt > now
      ? m.nextAttemptAt
      : m.leaseUntil && m.leaseUntil > now ? m.leaseUntil : null;
    if (at) await deps.wake(
      mappingId, 'create', new Date(at.getTime() + 1000 + Math.floor(Math.random() * 4001))
    );
    return;
  }
  if (op === 'create' && !ctx.canCreate) {
    const reason = `connection_inactive:${ctx.inactiveReason ?? 'create_disabled'}`;
    const token = randomUUID();
    console.warn('[psa-ticketing] create deferred', {
      mappingId, alertId: m.alertId, connectionId: m.connectionId, reason,
    });
    const at = new Date(now.getTime() + 300000);
    if (await deps.claim(m, token, { lastError: reason, lastErrorClass: 'transient' }, now)) {
      await deps.save(mappingId, token, { lastError: reason, lastErrorClass: 'transient', nextAttemptAt: at }, now);
      await deps.wake(mappingId, 'create', at);
    }
    return;
  }
  const token = randomUUID();
  const snapshot: CreateSnapshot = structuredClone(
    op === 'create' ? ctx.snapshot : (m.createSnapshot ?? ctx.snapshot)
  );
  // Configuration may be rebuilt for a safe retry; retain the ledger's attempt history.
  snapshot.operationAttempts = {
    ...m.createSnapshot?.operationAttempts, ...snapshot.operationAttempts,
  };
  const due = deadline(ctx, op, now);
  if (op !== 'skip_resolved')
    snapshot.operationAttempts = {
      ...snapshot.operationAttempts,
      [op]: (snapshot.operationAttempts?.[op] ?? 0) + 1,
    };
  if (op === 'adopt_lookup' && !snapshot.unknownDeadline)
    snapshot.unknownDeadline = due.toISOString();
  const stateKey = op === 'close' ? 'closeState' : op === 'note' ? 'noteState' : 'createState';
  const claimChanges: MappingChanges = {
    attempts: m.attempts + 1,
    deadlineAt: due,
    createSnapshot: snapshot,
  };
  if (op === 'create') {
    claimChanges.createState = 'create_in_flight';
    snapshot.unknownDeadline = new Date(now.getTime() + 2 * hour).toISOString();
  } else if (op === 'adopt_lookup') claimChanges.createState = 'create_outcome_unknown';
  else if (op === 'close') claimChanges.closeState = 'in_flight';
  else if (op === 'note') claimChanges.noteState = 'in_flight';
  if (!(await deps.claim(m, token, claimChanges, now))) {
    console.warn('[psa-ticketing] claim rejected', { mappingId, alertId: m.alertId, connectionId: m.connectionId, op });
    await deps.wake(mappingId, op === 'close' || op === 'note' ? op : 'create', new Date(now.getTime() + 1000 + Math.floor(Math.random() * 4001)));
    return;
  }
  let adapterCalled = false;
  const finish = async (changes: MappingChanges, at: Date | null = null) => {
    if (await deps.save(mappingId, token, { ...changes, nextAttemptAt: at }, now)) {
      Object.assign(ctx.mapping, changes, { nextAttemptAt: at });
      await deps
        .wake(
          mappingId,
          op === 'close' || op === 'note'
            ? op
            : ctx.alert?.status === 'resolved'
              ? 'close'
              : ctx.alert?.acknowledgedAt
                ? 'note'
                : 'create',
          at ?? now
        )
        .catch((error: unknown) => {
          console.warn('[psa-ticketing] wake failed', {
            mappingId, alertId: m.alertId, connectionId: m.connectionId,
            message: error instanceof Error ? error.message : String(error),
          });
        });
    } else if (adapterCalled) {
      console.error('[psa-ticketing] write-back rejected', { mappingId, op, token });
    }
  };
  if (op === 'skip_resolved') {
    await finish({ createState: 'skipped_resolved_before_create' });
    return;
  }
  // Fixed deadline, anchored to the committed lifecycle timestamp. A retry
  // never extends it, even when resolve preempts an acknowledgement note.
  if (due <= now && op !== 'adopt_lookup') {
    await finish({ [stateKey]: 'failed', lastError: 'operation_deadline_exceeded' });
    deps.report(
      ctx,
      op === 'close' || op === 'note' ? 'PSA_ALERT_TICKET_CLOSE_FAILED' : 'PSA_ALERT_TICKET_CREATE_FAILED'
    );
    return;
  }
  if (op === 'create' && ctx.companyIds.length !== 1) {
    await finish({
      createState: ctx.companyIds.length ? 'skipped_ambiguous_company' : 'skipped_no_company',
    });
    return;
  }
  // A crashed POST is uncertain, never a fresh permission to POST.
  if (
    (op === 'note' && m.noteState === 'in_flight') ||
    (op === 'close' && m.closeState === 'in_flight' && !snapshot.closeOnResolve)
  ) {
    await finish(
      {
        [stateKey]: 'outcome_unknown',
        lastErrorClass: 'unknown_outcome',
        lastError: 'note_outcome_unknown',
      },
      due
    );
    deps.report(ctx, 'PSA_ALERT_TICKET_OUTCOME_UNKNOWN');
    return;
  }
  let reserved = false;
  const refund = async () => {
    if (!reserved) return;
    reserved = false;
    try { await deps.refundCreateBudget?.(); }
    catch (error) {
      console.error('[psa-ticketing] cap refund failed', {
        mappingId, alertId: m.alertId, connectionId: m.connectionId,
        message: error instanceof Error ? error.message : String(error),
      });
      deps.report(ctx, 'PSA_ALERT_TICKET_CREATE_FAILED', error);
    }
  };
  if (op === 'create' && deps.beforeCreate) {
    let allowed: boolean;
    try {
      allowed = await deps.beforeCreate(ctx);
      reserved = allowed;
    } catch (error) {
      console.error('[psa-ticketing] cap check failed', {
        mappingId, alertId: m.alertId, connectionId: m.connectionId,
        message: error instanceof Error ? error.message : String(error),
      });
      await finish(
        { createState: 'never_attempted', lastError: 'redis_unavailable' },
        new Date(now.getTime() + 30000)
      );
      if (!isTicketingControlError(error)) {
        deps.report(ctx, 'PSA_ALERT_TICKET_CREATE_FAILED', error);
        throw error;
      }
      return;
    }
    if (!allowed) {
      const nextHour = new Date(now);
      nextHour.setUTCHours(nextHour.getUTCHours() + 1, 0, 0, 0);
      await finish(
        { createState: 'never_attempted', lastError: 'hourly_create_cap', lastErrorClass: null },
        nextHour
      );
      return;
    }
  }
  const assertOwned = async () => {
    await deps.beforeCall?.();
    if (deps.renewLease && !(await deps.renewLease(mappingId, token, new Date())))
      throw new TicketingLeaseLostError();
  };
  try {
    await assertOwned();
  } catch (error) {
    console.error('[psa-ticketing] ownership check failed', {
      mappingId, alertId: m.alertId, connectionId: m.connectionId,
      message: error instanceof Error ? error.message : String(error),
    });
    await refund();
    await finish(
      {
        [stateKey]:
          op === 'create'
            ? 'never_attempted'
            : op === 'adopt_lookup'
              ? 'create_outcome_unknown'
              : 'pending',
        lastError: 'redis_lease_lost',
      },
      new Date(now.getTime() + 30000)
    );
    if (!isTicketingControlError(error)) {
      deps.report(ctx, 'PSA_ALERT_TICKET_CREATE_FAILED', error);
      throw error;
    }
    return;
  }
  // Renew both fences during long paged lookups as well as immediately before the call.
  const renewal = deps.renewLease ? setInterval(() => {
    void assertOwned().catch((error: unknown) => {
      console.error('[psa-ticketing] lease renewal failed', {
        mappingId, alertId: m.alertId, connectionId: m.connectionId,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }, TICKETING_LEASE_MS / 3) : null;
  renewal?.unref();
  try {
    adapterCalled = true;
    if (op === 'create') {
      const ref = await ctx.adapter.createAlertTicket(snapshot.input);
      await finish({
        createState: 'created',
        externalTicketId: ref.ticketId,
        externalTicketNumber: ref.ticketNumber,
        externalTicketUrl: ref.externalUrl,
        externalCompanyId: snapshot.input.companyId,
        lastError: null,
        lastErrorClass: null,
      });
    } else if (op === 'adopt_lookup') {
      const matches = await ctx.adapter.findTicketsByMarker(m.alertId!);
      matches.sort(
        (a, b) =>
          (Date.parse(a.createdAt ?? '') || 0) - (Date.parse(b.createdAt ?? '') || 0) ||
          a.ticketId.localeCompare(b.ticketId, undefined, { numeric: true })
      );
      const ref = matches[0];
      if (ref) {
        snapshot.duplicateTicketIds = matches.slice(1).map((r) => r.ticketId);
        await finish({
          createState: 'created',
          createSnapshot: snapshot,
          externalTicketId: ref.ticketId,
          externalTicketNumber: ref.ticketNumber,
          externalTicketUrl: ref.externalUrl,
          lastError: matches.length > 1 ? 'multiple_marker_matches' : null,
          lastErrorClass: null,
        });
      } else if (due <= now) {
        await finish({ createState: 'needs_attention', lastError: 'create_outcome_unresolved' });
        deps.report(ctx, 'PSA_ALERT_TICKET_OUTCOME_UNKNOWN');
      } else
        await finish({ createState: 'create_outcome_unknown' }, new Date(now.getTime() + 60000));
    } else {
      if (op === 'close' && snapshot.closeOnResolve)
        await ctx.adapter.closeTicket(m.externalTicketId!, snapshot.closedStatusId);
      else
        await ctx.adapter.addNote(
          m.externalTicketId!,
          op === 'close' ? 'Breeze alert resolved.' : 'Breeze alert acknowledged.'
        );
      await finish(
        op === 'close'
          ? { closeState: 'closed', closedAt: now, lastError: null, lastErrorClass: null }
          : { noteState: 'posted', lastError: null, lastErrorClass: null }
      );
    }
  } catch (error) {
    // Unknown errors after entering a non-idempotent adapter are uncertain too.
    const cls = error instanceof PsaAdapterError ? error.errorClass : 'unknown_outcome';
    console.error('[psa-ticketing] operation failed', {
      mappingId, alertId: m.alertId, connectionId: m.connectionId, op,
      attempt: snapshot.operationAttempts?.[op], errorClass: cls,
      httpStatus: error instanceof PsaAdapterError ? error.httpStatus : undefined,
      message: error instanceof Error ? error.message : String(error),
    });
    const reportError = error instanceof PsaAdapterError ? undefined : error;
    const changes: MappingChanges = { lastErrorClass: cls, lastError: `psa_${cls}` };
    Object.assign(ctx.mapping, changes);
    if (op === 'create' && cls === 'transient') await refund();
    if (op === 'adopt_lookup' && due <= now) {
      await finish({
        ...changes,
        createState: 'needs_attention',
        lastError: 'create_outcome_unresolved',
      });
      deps.report(ctx, 'PSA_ALERT_TICKET_OUTCOME_UNKNOWN', reportError);
      return;
    }
    const retryAt = new Date(
      now.getTime() +
        Math.max(
          30000,
          error instanceof PsaAdapterError ? (error.retryAfterMs ?? 0) : 0,
          Math.min(3600000, 30000 * 2 ** Math.min((snapshot.operationAttempts?.[op] ?? 1) - 1, 7))
        )
    );
    if (cls === 'auth') {
      Object.assign(changes, {
        [stateKey]:
          op === 'create'
            ? 'never_attempted'
            : op === 'adopt_lookup'
              ? 'create_outcome_unknown'
              : 'pending',
      });
      try {
        await deps.pause(ctx);
      } catch (pauseError) {
        console.error('[psa-ticketing] auth pause failed', {
          mappingId, alertId: m.alertId, connectionId: m.connectionId,
          message: pauseError instanceof Error ? pauseError.message : String(pauseError),
        });
        await finish(changes, retryAt);
        deps.report(ctx, 'PSA_ALERT_TICKET_AUTH_PAUSED', pauseError);
        throw pauseError;
      }
      deps.report(ctx, 'PSA_ALERT_TICKET_AUTH_PAUSED', reportError);
    } else if (
      cls === 'unknown_outcome' &&
      op !== 'adopt_lookup' &&
      !(op === 'close' && snapshot.closeOnResolve)
    ) {
      if (op === 'create') changes.createState = 'create_outcome_unknown';
      else if (op === 'close') changes.closeState = 'outcome_unknown';
      else changes.noteState = 'outcome_unknown';
      deps.report(ctx, 'PSA_ALERT_TICKET_OUTCOME_UNKNOWN', reportError);
    } else if (cls === 'rejected') {
      if (op === 'create') changes.createState = 'rejected';
      else if (op === 'adopt_lookup') changes.createState = 'needs_attention';
      else changes[stateKey] = 'failed' as never;
      deps.report(
        ctx,
        op === 'close' || op === 'note' ? 'PSA_ALERT_TICKET_CLOSE_FAILED' : 'PSA_ALERT_TICKET_CREATE_FAILED',
        reportError
      );
    } else {
      if (reportError !== undefined)
        deps.report(ctx, 'PSA_ALERT_TICKET_OUTCOME_UNKNOWN', reportError);
      changes[stateKey] = (
        op === 'create'
          ? 'never_attempted'
          : op === 'adopt_lookup'
            ? 'create_outcome_unknown'
            : 'pending'
      ) as never;
    }
    await finish(
      changes,
      cls === 'unknown_outcome' && (op === 'note' || (op === 'close' && !snapshot.closeOnResolve))
        ? due
        : retryAt
    );
  } finally {
    if (renewal) clearInterval(renewal);
  }
}
