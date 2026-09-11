import { describe, expect, it } from 'vitest';
import { transition, InvalidTransitionError } from './serviceDeliverableState';

describe('occurrence state machine (spec §4.2)', () => {
  it('scheduled → open on open', () => expect(transition('scheduled', { type: 'open' })).toEqual({ next: 'open' }));
  it('open on open is a no-op', () => expect(transition('open', { type: 'open' }).next).toBeNull());

  it('deliver requires evidence when artifact_required', () => {
    expect(() => transition('open', { type: 'deliver', hasEvidence: false, artifactRequired: true })).toThrow(InvalidTransitionError);
    expect(transition('open', { type: 'deliver', hasEvidence: true, artifactRequired: true })).toEqual({ next: 'delivered' });
    expect(transition('open', { type: 'deliver', hasEvidence: false, artifactRequired: false })).toEqual({ next: 'delivered' });
  });

  it('missed → delivered (late) is allowed', () =>
    expect(transition('missed', { type: 'deliver', hasEvidence: true, artifactRequired: true })).toEqual({ next: 'delivered' }));

  it('ticket resolve with on_ticket_resolve: awaiting_evidence when evidence missing, delivered otherwise', () => {
    expect(transition('open', { type: 'ticket_resolved', hasEvidence: false, artifactRequired: true, completionMode: 'on_ticket_resolve' })).toEqual({ next: 'awaiting_evidence' });
    expect(transition('open', { type: 'ticket_resolved', hasEvidence: true, artifactRequired: true, completionMode: 'on_ticket_resolve' })).toEqual({ next: 'delivered' });
    expect(transition('open', { type: 'ticket_resolved', hasEvidence: false, artifactRequired: false, completionMode: 'on_ticket_resolve' })).toEqual({ next: 'delivered' });
  });

  it('ticket resolve with explicit mode changes nothing', () =>
    expect(transition('open', { type: 'ticket_resolved', hasEvidence: true, artifactRequired: false, completionMode: 'explicit' }).next).toBeNull());

  it('evidence_added completes awaiting_evidence only', () => {
    expect(transition('awaiting_evidence', { type: 'evidence_added' })).toEqual({ next: 'delivered' });
    expect(transition('open', { type: 'evidence_added' }).next).toBeNull();
  });

  it('ticket reopen undoes a ticket-driven delivery but never an explicit one', () => {
    expect(transition('delivered', { type: 'ticket_reopened', deliveredVia: 'ticket' })).toEqual({ next: 'open' });
    expect(transition('delivered', { type: 'ticket_reopened', deliveredVia: 'explicit' }).next).toBeNull();
  });

  it('miss applies to open and awaiting_evidence only', () => {
    expect(transition('open', { type: 'miss' })).toEqual({ next: 'missed' });
    expect(transition('awaiting_evidence', { type: 'miss' })).toEqual({ next: 'missed' });
    expect(transition('delivered', { type: 'miss' }).next).toBeNull();
  });

  it('waive from open, awaiting_evidence, missed; not from delivered', () => {
    expect(transition('missed', { type: 'waive' })).toEqual({ next: 'waived' });
    expect(() => transition('delivered', { type: 'waive' })).toThrow(InvalidTransitionError);
  });

  it('reopen from delivered or waived only', () => {
    expect(transition('delivered', { type: 'reopen' })).toEqual({ next: 'open' });
    expect(transition('waived', { type: 'reopen' })).toEqual({ next: 'open' });
    expect(() => transition('open', { type: 'reopen' })).toThrow(InvalidTransitionError);
  });
});
