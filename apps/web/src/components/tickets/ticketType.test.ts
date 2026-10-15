import { describe, expect, it } from 'vitest';
import {
  TICKET_TYPE_ORDER,
  isTicketType,
  ticketTypeFromHash,
  ticketTypeLabelKey,
} from './ticketType';

describe('ticketTypeFromHash', () => {
  it('reads a bare type segment, with or without the leading #', () => {
    expect(ticketTypeFromHash('#type=problem')).toBe('problem');
    expect(ticketTypeFromHash('type=change')).toBe('change');
  });

  it('finds the segment among selection and sort', () => {
    expect(ticketTypeFromHash('#T-2026-0001&sort=updated&type=service_request')).toBe('service_request');
    expect(ticketTypeFromHash('#T-2026-0001&type=incident&sort=newest')).toBe('incident');
  });

  it('returns null when absent, empty, invalid or hostile', () => {
    expect(ticketTypeFromHash('')).toBeNull();
    expect(ticketTypeFromHash('#')).toBeNull();
    expect(ticketTypeFromHash('#T-2026-0001&sort=newest')).toBeNull();
    expect(ticketTypeFromHash('#type=')).toBeNull();
    expect(ticketTypeFromHash('#type=banana')).toBeNull();
    expect(ticketTypeFromHash('#type=Incident')).toBeNull();
    expect(ticketTypeFromHash('#type=__proto__')).toBeNull();
    expect(ticketTypeFromHash('#type=<script>')).toBeNull();
  });

  it('uses the first valid segment when type= is repeated', () => {
    expect(ticketTypeFromHash('#type=bogus&type=problem&type=change')).toBe('problem');
  });

  it('does not treat a selection that merely contains "type=" as a type', () => {
    expect(ticketTypeFromHash('#mytype=problem')).toBeNull();
  });
});

describe('ticketType metadata', () => {
  it('orders the four core types for selects and nav', () => {
    expect([...TICKET_TYPE_ORDER]).toEqual(['incident', 'service_request', 'problem', 'change']);
  });
  it('isTicketType guards unknown values', () => {
    expect(isTicketType('problem')).toBe(true);
    expect(isTicketType('epic')).toBe(false);
    expect(isTicketType(null)).toBe(false);
  });
  it('maps a type to its i18n key', () => {
    expect(ticketTypeLabelKey('service_request')).toBe('ticketType.service_request');
  });
});
