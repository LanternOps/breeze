import { randomUUID } from 'node:crypto';
import type { PSAAlertTicketing } from '../psa/types';
import { PsaAdapterError } from '../psa/types';
import { nextOperation, type TicketMapping, type TicketAlert, type CreateSnapshot, type TicketOperation } from './stateMachine';
export type MappingChanges = Partial<TicketMapping>;
export interface TicketingContext {
  mapping: TicketMapping; alert: TicketAlert | null;
  connection: { id: string; partnerId: string | null; provider: string; alertTicketingPausedReason: string | null };
  canCreate: boolean; companyIds: string[]; snapshot: CreateSnapshot;
  adapter: Pick<PSAAlertTicketing, 'createAlertTicket' | 'findTicketsByMarker' | 'closeTicket' | 'addNote'>;
}
export interface TicketingDeps {
  beforeCreate?(context: TicketingContext): Promise<boolean>;
  load(id: string): Promise<TicketingContext | null>;
  claim(expected: TicketMapping, token: string, changes: MappingChanges, now: Date): Promise<boolean>;
  save(id: string, token: string, changes: MappingChanges, now: Date): Promise<boolean>;
  pause(context: TicketingContext): Promise<void>;
  wake(id: string, op: 'create' | 'close' | 'note', at: Date): Promise<void>;
  report(context: TicketingContext, errorId: string): void;
}
const hour = 3600000;
function deadline(ctx: TicketingContext, op: TicketOperation, now: Date) {
  const m = ctx.mapping;
  if (op === 'create') return m.deadlineAt ?? new Date(m.createdAt.getTime()+24*hour);
  if (op === 'adopt_lookup') return new Date((m.createSnapshot as CreateSnapshot | null)?.unknownDeadline ?? (m.updatedAt ?? now).getTime()+2*hour);
  return new Date(((op === 'close' ? ctx.alert?.resolvedAt : ctx.alert?.acknowledgedAt) ?? now).getTime() + (op === 'close' ? 72 : 24)*hour);
}
export async function executeTicketing(mappingId: string, deps: TicketingDeps, now = new Date()): Promise<void> {
  const ctx = await deps.load(mappingId);
  if (!ctx || ctx.connection.alertTicketingPausedReason) return;
  // Clone the observed row: the CAS compares this version, never a mutated reference.
  const m = { ...ctx.mapping };
  const op = nextOperation(m, ctx.alert, now);
  if (op === 'none') return;
  if (op === 'create' && !ctx.canCreate) return;
  const token = randomUUID();
  const snapshot: CreateSnapshot = structuredClone((m.createSnapshot as CreateSnapshot | null) ?? ctx.snapshot);
  const due = deadline(ctx, op, now);
  if (op !== 'skip_resolved') snapshot.operationAttempts = { ...snapshot.operationAttempts, [op]: (snapshot.operationAttempts?.[op] ?? 0)+1 };
  if (op === 'adopt_lookup' && !snapshot.unknownDeadline) snapshot.unknownDeadline = due.toISOString();
  const stateKey = op === 'close' ? 'closeState' : op === 'note' ? 'noteState' : 'createState';
  const claimChanges: MappingChanges = { attempts: m.attempts+1, deadlineAt: due, createSnapshot: snapshot };
  if (op === 'create') { claimChanges.createState = 'create_in_flight'; snapshot.unknownDeadline = new Date(now.getTime()+2*hour).toISOString(); }
  else if (op === 'adopt_lookup') claimChanges.createState = 'create_outcome_unknown';
  else if (op === 'close') claimChanges.closeState = 'in_flight';
  else if (op === 'note') claimChanges.noteState = 'in_flight';
  if (!await deps.claim(m, token, claimChanges, now)) return;
  const finish = async (changes: MappingChanges, at: Date | null = null) => {
    if (await deps.save(mappingId, token, { ...changes, nextAttemptAt: at }, now)) {
      await deps.wake(mappingId, op === 'close' || op === 'note' ? op : 'create', at ?? now).catch(() => {});
    }
  };
  if (op === 'skip_resolved') { await finish({ createState: 'skipped_resolved_before_create' }); return; }
  // Fixed deadline, anchored to the committed lifecycle timestamp. A retry
  // never extends it, even when resolve preempts an acknowledgement note.
  if (due <= now && op !== 'adopt_lookup') { await finish({ [stateKey]: 'failed', lastError: 'operation_deadline_exceeded' }); deps.report(ctx, op==='close' ? 'PSA_ALERT_TICKET_CLOSE_FAILED' : 'PSA_ALERT_TICKET_CREATE_FAILED'); return; }
  if (op === 'create' && ctx.companyIds.length !== 1) {
    await finish({ createState: ctx.companyIds.length ? 'skipped_ambiguous_company' : 'skipped_no_company' }); return;
  }
  // A crashed POST is uncertain, never a fresh permission to POST.
  if ((op === 'note' && m.noteState === 'in_flight') || (op === 'close' && m.closeState === 'in_flight' && !snapshot.closeOnResolve)) {
    await finish({ [stateKey]: 'outcome_unknown', lastErrorClass: 'unknown_outcome', lastError: 'note_outcome_unknown' }); return;
  }
  if (op === 'create' && deps.beforeCreate) {
    let allowed: boolean;
    try { allowed = await deps.beforeCreate(ctx); }
    catch {
      await finish({ createState: 'never_attempted', lastError: 'redis_unavailable' }, new Date(now.getTime()+30000)); return;
    }
    if (!allowed) {
      const nextHour = new Date(now); nextHour.setUTCHours(nextHour.getUTCHours()+1,0,0,0);
      await finish({ createState: 'never_attempted', lastError: 'hourly_create_cap', lastErrorClass: null }, nextHour); return;
    }
  }
  try {
    if (op === 'create') {
      const ref = await ctx.adapter.createAlertTicket(snapshot.input);
      await finish({ createState: 'created', externalTicketId: ref.ticketId, externalTicketNumber: ref.ticketNumber,
        externalTicketUrl: ref.externalUrl, externalCompanyId: snapshot.input.companyId, lastError: null, lastErrorClass: null });
    } else if (op === 'adopt_lookup') {
      const matches = await ctx.adapter.findTicketsByMarker(m.alertId!);
      matches.sort((a,b) => (Date.parse(a.createdAt ?? '') || 0) - (Date.parse(b.createdAt ?? '') || 0) || a.ticketId.localeCompare(b.ticketId, undefined, { numeric: true }));
      const ref = matches[0];
      if (ref) {
        snapshot.duplicateTicketIds = matches.slice(1).map(r => r.ticketId);
        await finish({ createState: 'created', createSnapshot: snapshot, externalTicketId: ref.ticketId,
          externalTicketNumber: ref.ticketNumber, externalTicketUrl: ref.externalUrl, lastError: matches.length>1 ? 'multiple_marker_matches' : null, lastErrorClass: null });
      } else if (due <= now) {
        await finish({ createState: 'needs_attention', lastError: 'create_outcome_unresolved' });
        deps.report(ctx, 'PSA_ALERT_TICKET_OUTCOME_UNKNOWN');
      } else await finish({ createState: 'create_outcome_unknown' }, new Date(now.getTime()+60000));
    } else {
      if (op === 'close' && snapshot.closeOnResolve) await ctx.adapter.closeTicket(m.externalTicketId!, snapshot.closedStatusId);
      else await ctx.adapter.addNote(m.externalTicketId!, op === 'close' ? 'Breeze alert resolved.' : 'Breeze alert acknowledged.');
      await finish(op === 'close' ? { closeState: 'closed', closedAt: now, lastError: null, lastErrorClass: null }
        : { noteState: 'posted', lastError: null, lastErrorClass: null });
    }
  } catch (error) {
    // Unknown errors after entering a non-idempotent adapter are uncertain too.
    const cls = error instanceof PsaAdapterError ? error.errorClass : 'unknown_outcome';
    const changes: MappingChanges = { lastErrorClass: cls, lastError: `psa_${cls}` };
    const retryAt = new Date(now.getTime()+Math.max(30000, error instanceof PsaAdapterError ? error.retryAfterMs ?? 0 : 0,
      Math.min(3600000, 30000 * 2 ** Math.min(op === 'skip_resolved' ? 0 : (snapshot.operationAttempts?.[op] ?? 1)-1,7))));
    if (cls === 'auth') {
      Object.assign(changes, { [stateKey]: op === 'create' ? 'never_attempted' : op === 'adopt_lookup' ? 'create_outcome_unknown' : 'pending' });
      await deps.pause(ctx); deps.report(ctx, 'PSA_ALERT_TICKET_AUTH_PAUSED');
    } else if (cls === 'unknown_outcome' && op !== 'adopt_lookup' && !(op === 'close' && snapshot.closeOnResolve)) {
      if (op === 'create') changes.createState = 'create_outcome_unknown';
      else if (op === 'close') changes.closeState = 'outcome_unknown';
      else changes.noteState = 'outcome_unknown';
      deps.report(ctx, 'PSA_ALERT_TICKET_OUTCOME_UNKNOWN');
    } else if (cls === 'rejected') {
      if (op === 'create') changes.createState = 'rejected';
      else if (op === 'adopt_lookup') changes.createState = 'needs_attention';
      else changes[stateKey] = 'failed' as never;
      deps.report(ctx, op === 'close' ? 'PSA_ALERT_TICKET_CLOSE_FAILED' : 'PSA_ALERT_TICKET_CREATE_FAILED');
    } else {
      changes[stateKey] = (op === 'create' ? 'never_attempted' : op === 'adopt_lookup' ? 'create_outcome_unknown' : 'pending') as never;
    }
    await finish(changes, retryAt);
  }
}
