import { describe, expect, it } from 'vitest';
import {
  resolveIntentTargetDevice,
  resolveIntentTargetTicket,
  effectiveTargetDeviceId,
  assertArgsMatchScope,
  assertArgsMatchTicketScope,
  IntentScopeArgumentMismatchError,
} from './intentTargetScope';

const D = '22222222-2222-4222-8222-222222222222';
const T = '33333333-3333-4333-8333-333333333333';

describe('resolveIntentTargetDevice', () => {
  it('falls back to the run device when no scope is set', () => {
    expect(resolveIntentTargetDevice({ scopeKind: null, scopeDeviceId: null, scopeTicketId: null }, { deviceId: D })).toEqual({ kind: 'run', deviceId: D });
    expect(resolveIntentTargetDevice({ scopeKind: null, scopeDeviceId: null, scopeTicketId: null }, { deviceId: null })).toEqual({ kind: 'run', deviceId: null });
  });
  it('prefers the explicit scope over the run device', () => {
    expect(resolveIntentTargetDevice({ scopeKind: 'device', scopeDeviceId: D, scopeTicketId: null }, { deviceId: 'other' })).toEqual({ kind: 'scope', deviceId: D });
  });
  it('reports a tombstone when the scoped device was deleted', () => {
    const t = resolveIntentTargetDevice({ scopeKind: 'device', scopeDeviceId: null, scopeTicketId: null }, { deviceId: D });
    expect(t).toEqual({ kind: 'tombstone' });
    expect(effectiveTargetDeviceId(t)).toBeNull();
  });
  it('falls back to the run device for a ticket-scoped intent (ticket is not a device target)', () => {
    expect(resolveIntentTargetDevice({ scopeKind: 'ticket', scopeDeviceId: null, scopeTicketId: T }, { deviceId: D })).toEqual({ kind: 'run', deviceId: D });
  });
});

describe('resolveIntentTargetTicket', () => {
  it('reports no ticket target when scopeKind is null', () => {
    expect(resolveIntentTargetTicket({ scopeKind: null, scopeDeviceId: null, scopeTicketId: null })).toEqual({ kind: 'none' });
  });
  it('reports no ticket target for a device-scoped intent', () => {
    expect(resolveIntentTargetTicket({ scopeKind: 'device', scopeDeviceId: D, scopeTicketId: null })).toEqual({ kind: 'none' });
  });
  it('resolves the explicit ticket scope', () => {
    expect(resolveIntentTargetTicket({ scopeKind: 'ticket', scopeDeviceId: null, scopeTicketId: T })).toEqual({ kind: 'scope', ticketId: T });
  });
  it('reports a tombstone when scope_ticket_id was cleared', () => {
    expect(resolveIntentTargetTicket({ scopeKind: 'ticket', scopeDeviceId: null, scopeTicketId: null })).toEqual({ kind: 'tombstone' });
  });
});

describe('assertArgsMatchScope', () => {
  it('accepts matching deviceId / deviceIds and absent device args', () => {
    expect(() => assertArgsMatchScope('manage_services', { action: 'restart', deviceId: D }, D)).not.toThrow();
    expect(() => assertArgsMatchScope('manage_patches', { deviceIds: [D] }, D)).not.toThrow();
    expect(() => assertArgsMatchScope('remediate_vulnerability', { deviceVulnerabilityIds: [D] }, D)).not.toThrow();
  });
  it('rejects a divergent deviceId or an extra deviceIds member', () => {
    expect(() => assertArgsMatchScope('manage_services', { deviceId: 'x' }, D)).toThrow(/scope_argument_mismatch/);
    expect(() => assertArgsMatchScope('manage_patches', { deviceIds: [D, 'x'] }, D)).toThrow(/scope_argument_mismatch/);
  });
});

// I2 (final review #4191): the ticket mirror of assertArgsMatchScope.
describe('assertArgsMatchTicketScope', () => {
  it('accepts a matching ticketId', () => {
    expect(() => assertArgsMatchTicketScope('manage_tickets', { ticketId: T, action: 'move_org' }, T)).not.toThrow();
  });
  it('accepts a tool call carrying no ticketId at all — the scope IS the binding for those calls', () => {
    expect(() => assertArgsMatchTicketScope('manage_tickets', { action: 'add_comment', content: 'x' }, T)).not.toThrow();
    expect(() => assertArgsMatchTicketScope('manage_tickets', { ticketId: null }, T)).not.toThrow();
    expect(() => assertArgsMatchTicketScope('manage_tickets', { ticketId: undefined }, T)).not.toThrow();
  });
  it('rejects a divergent ticketId, throwing IntentScopeArgumentMismatchError with code scope_argument_mismatch', () => {
    let caught: unknown;
    try {
      assertArgsMatchTicketScope('manage_tickets', { ticketId: 'some-other-ticket' }, T);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IntentScopeArgumentMismatchError);
    expect((caught as IntentScopeArgumentMismatchError).code).toBe('scope_argument_mismatch');
    expect((caught as Error).message).toMatch(/scope_argument_mismatch/);
  });
  it('rejects a non-string ticketId', () => {
    expect(() => assertArgsMatchTicketScope('manage_tickets', { ticketId: 42 }, T)).toThrow(/scope_argument_mismatch/);
  });
});
