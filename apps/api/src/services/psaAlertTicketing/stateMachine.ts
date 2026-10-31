import type { psaTicketMappings } from '../../db/schema';
export type TicketMapping = typeof psaTicketMappings.$inferSelect;
export interface TicketAlert { id: string; status: string; acknowledgedAt: Date | null; resolvedAt: Date | null }
export type TicketOperation = 'create' | 'adopt_lookup' | 'close' | 'note' | 'skip_resolved' | 'none';
export interface CreateSnapshot {
  input: import('../psa/types').PSAAlertTicketCreate;
  closeOnResolve: boolean; noteOnAcknowledge: boolean; closedStatusId: number; hourlyCreateCap: number;
  operationAttempts?: Partial<Record<'create' | 'adopt_lookup' | 'close' | 'note', number>>;
  unknownDeadline?: string; duplicateTicketIds?: string[];
}
export function nextOperation(mapping: TicketMapping, alert: TicketAlert | null, now: Date): TicketOperation {
  if (!alert || (mapping.nextAttemptAt && mapping.nextAttemptAt > now) || (mapping.leaseUntil && mapping.leaseUntil > now)) return 'none';
  if (mapping.createState === 'create_in_flight' || mapping.createState === 'create_outcome_unknown') return 'adopt_lookup';
  if (mapping.createState === 'never_attempted') return alert.status === 'resolved' ? 'skip_resolved' : ['active','acknowledged'].includes(alert.status) ? 'create' : 'none';
  if (mapping.createState !== 'created') return 'none';
  const snapshot = mapping.createSnapshot as CreateSnapshot | null;
  if (alert.status === 'resolved' && !['closed','failed'].includes(mapping.closeState)) {
    // An internal resolve note is non-idempotent just like an ack note.
    if (mapping.closeState === 'outcome_unknown' && !snapshot?.closeOnResolve) return 'none';
    return 'close';
  }
  if (alert.acknowledgedAt && snapshot?.noteOnAcknowledge && !['posted','failed','outcome_unknown'].includes(mapping.noteState)) return 'note';
  return 'none';
}
