export type OccurrenceStatus = 'scheduled' | 'open' | 'awaiting_evidence' | 'delivered' | 'missed' | 'waived';
export type OccurrenceEvent =
  | { type: 'open' }
  | { type: 'deliver'; hasEvidence: boolean; artifactRequired: boolean }
  | { type: 'evidence_added' }
  | { type: 'ticket_resolved'; hasEvidence: boolean; artifactRequired: boolean; completionMode: 'explicit' | 'on_ticket_resolve' }
  | { type: 'ticket_reopened'; deliveredVia: 'explicit' | 'ticket' | null }
  | { type: 'miss' }
  | { type: 'waive' }
  | { type: 'reopen' };
export type Transition = { next: OccurrenceStatus } | { next: null; reason: string };

export class InvalidTransitionError extends Error {
  readonly status = 409;
  readonly code = 'INVALID_OCCURRENCE_TRANSITION';
  constructor(readonly current: OccurrenceStatus, readonly event: OccurrenceEvent['type']) {
    super(`Cannot ${event} an occurrence in status ${current}`);
  }
}

const noop = (reason: string): Transition => ({ next: null, reason });
const ACTIVE: ReadonlySet<OccurrenceStatus> = new Set(['open', 'awaiting_evidence', 'missed']);

export function transition(current: OccurrenceStatus, event: OccurrenceEvent): Transition {
  switch (event.type) {
    case 'open':
      return current === 'scheduled' ? { next: 'open' } : noop('already opened');
    case 'deliver':
      if (!ACTIVE.has(current)) throw new InvalidTransitionError(current, event.type);
      if (event.artifactRequired && !event.hasEvidence) throw new InvalidTransitionError(current, event.type);
      return { next: 'delivered' };
    case 'evidence_added':
      return current === 'awaiting_evidence' ? { next: 'delivered' } : noop('evidence recorded, status unchanged');
    case 'ticket_resolved':
      if (event.completionMode === 'explicit') return noop('explicit completion mode');
      if (current !== 'open' && current !== 'missed') return noop('not open');
      return event.artifactRequired && !event.hasEvidence ? { next: 'awaiting_evidence' } : { next: 'delivered' };
    case 'ticket_reopened':
      return current === 'delivered' && event.deliveredVia === 'ticket' ? { next: 'open' } : noop('not a ticket-driven delivery');
    case 'miss':
      return current === 'open' || current === 'awaiting_evidence' ? { next: 'missed' } : noop('not missable');
    case 'waive':
      if (!ACTIVE.has(current)) throw new InvalidTransitionError(current, event.type);
      return { next: 'waived' };
    case 'reopen':
      if (current !== 'delivered' && current !== 'waived') throw new InvalidTransitionError(current, event.type);
      return { next: 'open' };
  }
}
