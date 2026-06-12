/**
 * Enum parity: assert that the Zod schemas in @breeze/shared and the Drizzle
 * pg enums in the DB schema stay in sync. A drift here means the API would
 * accept values the DB rejects (or vice-versa).
 */
import { describe, it, expect } from 'vitest';
import { ticketStatusSchema, ticketPrioritySchema, ticketSourceSchema } from '@breeze/shared';
import { ticketStatusEnum, ticketPriorityEnum, ticketSourceEnum } from './portal';

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
});
