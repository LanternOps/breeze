/**
 * Enum parity: assert that the Zod schemas in @breeze/shared and the Drizzle
 * pg enums in the DB schema stay in sync. A drift here means the API would
 * accept values the DB rejects (or vice-versa).
 */
import { describe, it, expect } from 'vitest';
import { ticketStatusSchema, ticketPrioritySchema, ticketSourceSchema, ticketTypeSchema, TICKET_TYPES } from '@breeze/shared';
import { ticketStatusEnum, ticketPriorityEnum, ticketSourceEnum, ticketTypeEnum } from './portal';

describe('ticket enum parity (shared validators ↔ DB schema)', () => {
  it('ticketStatus: Zod options match Drizzle enumValues', () => {
    expect([...ticketStatusSchema.options].sort()).toEqual([...ticketStatusEnum.enumValues].sort());
  });

  it('ticketPriority: Zod options match Drizzle enumValues', () => {
    expect([...ticketPrioritySchema.options].sort()).toEqual([...ticketPriorityEnum.enumValues].sort());
  });

  it('ticketSource: Zod options match Drizzle enumValues', () => {
    expect([...ticketSourceSchema.options].sort()).toEqual([...ticketSourceEnum.enumValues].sort());
  });

  it('ticketType: Zod options match Drizzle enumValues', () => {
    expect([...ticketTypeSchema.options].sort()).toEqual([...ticketTypeEnum.enumValues].sort());
    expect([...TICKET_TYPES].sort()).toEqual([...ticketTypeEnum.enumValues].sort());
  });

  // #7900: the core set is fixed so reporting can rely on it. Adding a value
  // is a deliberate migration (ALTER TYPE ... ADD VALUE), not a drive-by.
  it('ticketType core set is exactly the four ITIL types', () => {
    expect([...ticketTypeEnum.enumValues].sort()).toEqual(['change', 'incident', 'problem', 'service_request']);
  });

  it('ticketType rejects an unknown value', () => {
    expect(ticketTypeSchema.safeParse('outage').success).toBe(false);
  });
});
