import { describe, expect, it } from 'vitest';
import { defaultTicketTypeForSource } from './ticketType';

describe('defaultTicketTypeForSource (#7900, Open Decision 3)', () => {
  it.each(['portal', 'email', 'alert', 'manual', 'api', 'ai'] as const)('%s -> incident', (source) => {
    expect(defaultTicketTypeForSource(source)).toBe('incident');
  });

  it('planned work -> service_request, whatever the source', () => {
    expect(defaultTicketTypeForSource('api', { plannedWork: true })).toBe('service_request');
    expect(defaultTicketTypeForSource('manual', { plannedWork: true })).toBe('service_request');
  });

  it('plannedWork: false is the same as omitted', () => {
    expect(defaultTicketTypeForSource('api', { plannedWork: false })).toBe('incident');
  });
});
