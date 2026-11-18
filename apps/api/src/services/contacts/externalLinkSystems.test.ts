/** #8313 W4b: the ticket import's contact link namespace is reserved. */
import { describe, expect, it } from 'vitest';
import {
  assertContactLinkSystemAllowed,
  isReservedContactLinkSystem,
  ReservedContactLinkSystemError,
  ticketImportLinkSystem,
} from './externalLinkSystems';

describe('the ticket-import: contact link namespace', () => {
  it('is what a ticket import source writes', () => {
    expect(ticketImportLinkSystem('src-1')).toBe('ticket-import:src-1');
    expect(isReservedContactLinkSystem(ticketImportLinkSystem('src-1'))).toBe(true);
  });

  it('is reserved whatever the case or surrounding space, and only as a prefix', () => {
    for (const system of ['ticket-import:x', 'Ticket-Import:x', '  TICKET-IMPORT:', 'ticket-import:']) {
      expect(isReservedContactLinkSystem(system), system).toBe(true);
      expect(() => assertContactLinkSystemAllowed(system)).toThrow(ReservedContactLinkSystemError);
    }
    for (const system of ['csv', 'datto_rmm', 'm365', 'google', 'ticket-import', 'my-ticket-import:x', '']) {
      expect(isReservedContactLinkSystem(system), system).toBe(false);
      expect(() => assertContactLinkSystemAllowed(system)).not.toThrow();
    }
    expect(isReservedContactLinkSystem(null)).toBe(false);
  });
});
