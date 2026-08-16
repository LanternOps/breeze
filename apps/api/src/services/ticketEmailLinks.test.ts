import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDb } = vi.hoisted(() => ({
  mockDb: { selectDistinct: vi.fn() },
}));

// The module imports these at load; the query tests below only exercise
// selectDistinct, and the context helpers are simple passthroughs.
vi.mock('../db', () => ({
  db: mockDb,
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

import { findTicketIdsByMessageIds, normalizeMessageId, normalizeMessageIds } from './ticketEmailLinks';

describe('normalizeMessageId', () => {
  it('trims whitespace and preserves angle brackets', () => {
    expect(normalizeMessageId('  <abc@example.com>  ')).toBe('<abc@example.com>');
  });
  it('wraps bare ids in angle brackets', () => {
    expect(normalizeMessageId('abc@example.com')).toBe('<abc@example.com>');
  });
  it('throws on empty input', () => {
    expect(() => normalizeMessageId('   ')).toThrow();
  });
  it('double-wraps an asymmetric-bracket id (documented current behavior)', () => {
    // Only a fully bracketed id counts as already-wrapped; '<abc@x' is treated
    // as a bare id and wrapped again. Malformed either way — what matters for
    // the ledger is that storage and lookup normalize IDENTICALLY.
    expect(normalizeMessageId('<abc@x')).toBe('<<abc@x>');
    expect(normalizeMessageId('abc@x>')).toBe('<abc@x>>');
  });
});

describe('normalizeMessageIds', () => {
  it('filters empty/whitespace entries before normalizing (normalizeMessageId throws on empties)', () => {
    expect(normalizeMessageIds(['', '   ', 'abc@x.test'])).toEqual(['<abc@x.test>']);
  });
  it('normalizes bare and bracketed forms to one stored form and dedupes them', () => {
    expect(normalizeMessageIds(['abc@x.test', '<abc@x.test>', ' <abc@x.test> '])).toEqual([
      '<abc@x.test>',
    ]);
  });
  it('preserves distinct ids', () => {
    expect(normalizeMessageIds(['a@x.test', 'b@x.test'])).toEqual(['<a@x.test>', '<b@x.test>']);
  });
  it('returns [] for an all-empty input', () => {
    expect(normalizeMessageIds(['', ' '])).toEqual([]);
  });
});

describe('findTicketIdsByMessageIds', () => {
  beforeEach(() => {
    mockDb.selectDistinct.mockReset();
  });

  it('short-circuits to [] without querying when every candidate is empty', async () => {
    const result = await findTicketIdsByMessageIds('partner-1', ['', '   ']);
    expect(result).toEqual([]);
    expect(mockDb.selectDistinct).not.toHaveBeenCalled();
  });

  it('maps the distinct rows to ticket ids', async () => {
    mockDb.selectDistinct.mockReturnValue({
      from: () => ({
        where: () => Promise.resolve([{ ticketId: 'ticket-1' }, { ticketId: 'ticket-2' }]),
      }),
    });
    const result = await findTicketIdsByMessageIds('partner-1', ['<a@x.test>', 'a@x.test', 'b@x.test']);
    expect(result).toEqual(['ticket-1', 'ticket-2']);
    expect(mockDb.selectDistinct).toHaveBeenCalledTimes(1);
  });
});
