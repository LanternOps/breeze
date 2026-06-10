import { describe, it, expect, vi, beforeEach } from 'vitest';

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock('../db', () => ({
  db: { execute: executeMock }
}));

import { allocateInternalTicketNumber, formatInternalNumber } from './ticketNumbers';

describe('allocateInternalTicketNumber', () => {
  beforeEach(() => executeMock.mockReset());

  it('formats T-YYYY-NNNN with zero padding', () => {
    expect(formatInternalNumber(2026, 7)).toBe('T-2026-0007');
    expect(formatInternalNumber(2026, 12345)).toBe('T-2026-12345'); // grows past 4 digits, never truncates
  });

  it('returns the upserted counter as a formatted number', async () => {
    executeMock.mockResolvedValue([{ counter: 42 }]);
    const n = await allocateInternalTicketNumber('partner-1', new Date('2026-06-09T12:00:00Z'));
    expect(n).toBe('T-2026-0042');
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it('throws when the DB returns no counter', async () => {
    executeMock.mockResolvedValue([]);
    await expect(allocateInternalTicketNumber('partner-1')).rejects.toThrow(/allocate/i);
  });
});
