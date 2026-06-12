import { describe, it, expect } from 'vitest';
import {
  createTimeEntrySchema, updateTimeEntrySchema, startTimerSchema,
  listTimeEntriesQuerySchema, bulkApproveSchema, ticketPartSchema,
  updateTicketPartSchema, billablesExportQuerySchema
} from './timeEntries';

const UUID = '3f2f1d8e-1111-4222-8333-444455556666';

describe('createTimeEntrySchema', () => {
  it('accepts a minimal manual entry', () => {
    const r = createTimeEntrySchema.safeParse({
      startedAt: '2026-06-11T09:00:00Z',
      endedAt: '2026-06-11T09:30:00Z'
    });
    expect(r.success).toBe(true);
  });

  it('rejects endedAt <= startedAt', () => {
    expect(createTimeEntrySchema.safeParse({
      startedAt: '2026-06-11T09:30:00Z',
      endedAt: '2026-06-11T09:00:00Z'
    }).success).toBe(false);
    expect(createTimeEntrySchema.safeParse({
      startedAt: '2026-06-11T09:00:00Z',
      endedAt: '2026-06-11T09:00:00Z'
    }).success).toBe(false);
  });

  it('rejects a negative hourlyRate', () => {
    expect(createTimeEntrySchema.safeParse({
      startedAt: '2026-06-11T09:00:00Z',
      endedAt: '2026-06-11T09:30:00Z',
      hourlyRate: -5
    }).success).toBe(false);
  });

  it('rejects startedAt more than 5 minutes in the future', () => {
    const future = new Date(Date.now() + 10 * 60_000).toISOString();
    const futureEnd = new Date(Date.now() + 40 * 60_000).toISOString();
    expect(createTimeEntrySchema.safeParse({ startedAt: future, endedAt: futureEnd }).success).toBe(false);
  });
});

describe('startTimerSchema', () => {
  it('accepts empty body and optional ticketId/description', () => {
    expect(startTimerSchema.safeParse({}).success).toBe(true);
    expect(startTimerSchema.safeParse({ ticketId: UUID, description: 'debugging' }).success).toBe(true);
  });
});

describe('listTimeEntriesQuerySchema', () => {
  it('coerces running flag and dates', () => {
    const r = listTimeEntriesQuerySchema.safeParse({ running: 'true', from: '2026-06-01', limit: '10' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.running).toBe(true);
      expect(r.data.limit).toBe(10);
    }
  });
});

describe('updateTimeEntrySchema', () => {
  it('rejects empty object (at-least-one-field refine)', () => {
    expect(updateTimeEntrySchema.safeParse({}).success).toBe(false);
  });

  it('accepts a single description field', () => {
    expect(updateTimeEntrySchema.safeParse({ description: 'x' }).success).toBe(true);
  });

  it('accepts ticketId: null (nullable unlink)', () => {
    expect(updateTimeEntrySchema.safeParse({ ticketId: null }).success).toBe(true);
  });
});

describe('bulkApproveSchema', () => {
  it('requires 1-200 ids', () => {
    expect(bulkApproveSchema.safeParse({ ids: [] }).success).toBe(false);
    expect(bulkApproveSchema.safeParse({ ids: [UUID] }).success).toBe(true);
  });

  it('rejects 201 ids (upper bound)', () => {
    const ids = Array.from({ length: 201 }, () => UUID);
    expect(bulkApproveSchema.safeParse({ ids }).success).toBe(false);
  });

  it('rejects duplicate ids', () => {
    expect(bulkApproveSchema.safeParse({ ids: [UUID, UUID] }).success).toBe(false);
  });
});

describe('ticketPartSchema', () => {
  it('accepts a minimal part', () => {
    expect(ticketPartSchema.safeParse({ description: 'SSD 1TB', quantity: 1 }).success).toBe(true);
  });
  it('rejects quantity <= 0 and negative prices', () => {
    expect(ticketPartSchema.safeParse({ description: 'x', quantity: 0 }).success).toBe(false);
    expect(ticketPartSchema.safeParse({ description: 'x', quantity: 1, unitPrice: -1 }).success).toBe(false);
    expect(ticketPartSchema.safeParse({ description: 'x', quantity: 1, costBasis: -1 }).success).toBe(false);
  });
});

describe('updateTicketPartSchema', () => {
  it('rejects empty object (at-least-one-field refine)', () => {
    expect(updateTicketPartSchema.safeParse({}).success).toBe(false);
  });

  it('accepts a single quantity field', () => {
    expect(updateTicketPartSchema.safeParse({ quantity: 2 }).success).toBe(true);
  });

  it('does not inject the unitPrice default from .partial()', () => {
    const r = updateTicketPartSchema.safeParse({ quantity: 2 });
    expect(r.success).toBe(true);
    if (r.success) {
      expect('unitPrice' in r.data).toBe(false);
    }
  });
});

describe('billablesExportQuerySchema', () => {
  it('requires from/to and rejects inverted ranges', () => {
    expect(billablesExportQuerySchema.safeParse({}).success).toBe(false);
    expect(billablesExportQuerySchema.safeParse({ from: '2026-06-01', to: '2026-06-30' }).success).toBe(true);
    expect(billablesExportQuerySchema.safeParse({ from: '2026-06-30', to: '2026-06-01' }).success).toBe(false);
  });

  it('rejects a 2-year range (exceeds 366-day cap)', () => {
    expect(billablesExportQuerySchema.safeParse({ from: '2024-01-01', to: '2026-01-01' }).success).toBe(false);
  });

  it('accepts an 11-month range (within 366-day cap)', () => {
    expect(billablesExportQuerySchema.safeParse({ from: '2026-01-01', to: '2026-12-01' }).success).toBe(true);
  });
});
