import { describe, it, expect, vi, beforeEach } from 'vitest';

const { executeMock, runOutsideDbContextMock, withSystemDbAccessContextMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
  runOutsideDbContextMock: vi.fn(<T>(fn: () => T) => fn()),
  withSystemDbAccessContextMock: vi.fn(<T>(fn: () => Promise<T>) => fn()),
}));

vi.mock('../db', () => ({
  db: { execute: executeMock },
  runOutsideDbContext: runOutsideDbContextMock,
  withSystemDbAccessContext: withSystemDbAccessContextMock,
}));

import { allocateInternalTicketNumber, formatInternalNumber } from './ticketNumbers';

describe('allocateInternalTicketNumber', () => {
  beforeEach(() => {
    executeMock.mockReset();
    runOutsideDbContextMock.mockReset();
    withSystemDbAccessContextMock.mockReset();
    // Restore pass-through behaviour after each reset
    runOutsideDbContextMock.mockImplementation(<T>(fn: () => T) => fn());
    withSystemDbAccessContextMock.mockImplementation(<T>(fn: () => Promise<T>) => fn());
  });

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

  it('runs the upsert through runOutsideDbContext and withSystemDbAccessContext', async () => {
    executeMock.mockResolvedValue([{ counter: 1 }]);
    await allocateInternalTicketNumber('partner-2', new Date('2026-06-09T00:00:00Z'));
    expect(runOutsideDbContextMock).toHaveBeenCalledTimes(1);
    expect(withSystemDbAccessContextMock).toHaveBeenCalledTimes(1);
  });
});
