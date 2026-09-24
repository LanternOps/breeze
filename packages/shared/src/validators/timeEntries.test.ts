import { describe, it, expect } from 'vitest';
import {
  createTimeEntrySchema, updateTimeEntrySchema, startTimerSchema,
  listTimeEntriesQuerySchema, bulkApproveSchema, ticketPartSchema,
  updateTicketPartSchema, billablesExportQuerySchema
} from './timeEntries';

const UUID = '3f2f1d8e-1111-4222-8333-444455556666';

describe('createTimeEntrySchema', () => {
  it('reserves billed for invoice issuance while retaining technician dispositions', () => {
    const base = { startedAt: '2026-06-11T09:00:00Z', endedAt: '2026-06-11T09:30:00Z' };
    expect(createTimeEntrySchema.safeParse({ ...base, billingStatus: 'billed' }).success).toBe(false);
    expect(createTimeEntrySchema.safeParse({ ...base, billingStatus: 'no_charge' }).success).toBe(true);
    expect(createTimeEntrySchema.safeParse({ ...base, billingStatus: 'contract' }).success).toBe(true);
  });
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
  it('reserves billed for invoice issuance while retaining technician dispositions', () => {
    expect(updateTimeEntrySchema.safeParse({ billingStatus: 'billed' }).success).toBe(false);
    expect(updateTimeEntrySchema.safeParse({ billingStatus: 'no_charge' }).success).toBe(true);
    expect(updateTimeEntrySchema.safeParse({ billingStatus: 'contract' }).success).toBe(true);
  });
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
  it('reserves billed for invoice issuance while retaining technician dispositions', () => {
    const base = { description: 'SSD', quantity: 1 };
    expect(ticketPartSchema.safeParse({ ...base, billingStatus: 'billed' }).success).toBe(false);
    expect(ticketPartSchema.safeParse({ ...base, billingStatus: 'no_charge' }).success).toBe(true);
    expect(ticketPartSchema.safeParse({ ...base, billingStatus: 'contract' }).success).toBe(true);
  });
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
  it('reserves billed for invoice issuance while retaining technician dispositions', () => {
    expect(updateTicketPartSchema.safeParse({ billingStatus: 'billed' }).success).toBe(false);
    expect(updateTicketPartSchema.safeParse({ billingStatus: 'no_charge' }).success).toBe(true);
    expect(updateTicketPartSchema.safeParse({ billingStatus: 'contract' }).success).toBe(true);
  });
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

  // Sweep C2: a date-only `to` is inclusive of that whole UTC day, the same
  // rule invoice assembly uses (`${to}T23:59:59Z`, invoiceService.assembleDraftFromOrg).
  // listBillables filters startedAt with gte(from) / lte(to), mirrored here.
  it('includes an entry at 15:00 on the `to` day and excludes the next day', () => {
    const parsed = billablesExportQuerySchema.parse({ from: '2026-06-01', to: '2026-06-30' });
    const inRange = (iso: string) => {
      const t = new Date(iso).getTime();
      return t >= parsed.from.getTime() && t <= parsed.to.getTime();
    };
    expect(parsed.from.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(parsed.to.toISOString()).toBe('2026-06-30T23:59:59.000Z');
    expect(inRange('2026-06-30T15:00:00Z')).toBe(true);
    expect(inRange('2026-07-01T00:00:00Z')).toBe(false);
    expect(inRange('2026-07-01T15:00:00Z')).toBe(false);
  });

  it('accepts a single-day range (from = to)', () => {
    expect(billablesExportQuerySchema.safeParse({ from: '2026-06-30', to: '2026-06-30' }).success).toBe(true);
  });

  it('keeps the 366-day cap on whole calendar days', () => {
    // 366 inclusive days (non-leap year + 1 day) is allowed; 367 is not.
    expect(billablesExportQuerySchema.safeParse({ from: '2026-01-01', to: '2027-01-01' }).success).toBe(true);
    expect(billablesExportQuerySchema.safeParse({ from: '2026-01-01', to: '2027-01-02' }).success).toBe(false);
  });

  it('leaves a full timestamp `to` untouched', () => {
    const parsed = billablesExportQuerySchema.parse({ from: '2026-06-01', to: '2026-06-30T12:00:00Z' });
    expect(parsed.to.toISOString()).toBe('2026-06-30T12:00:00.000Z');
  });
});

// ── W06 (#3900): provenance vocabulary + suggestion routes ───────────────────
import {
  TIME_ENTRY_SOURCES, timeEntrySourceSchema, suggestionsQuerySchema,
  confirmSuggestionSchema, suggestionSignalsSchema
} from './timeEntries';

const SIG = { kind: 'remote_session', id: UUID };

describe('time entry sources (W06)', () => {
  it('is exactly the six-value vocabulary of the source migrations', () => {
    expect([...TIME_ENTRY_SOURCES]).toEqual(['manual', 'timer', 'location', 'remote_session', 'support_session', 'ai_suggested']);
    expect(timeEntrySourceSchema.safeParse('support_session').success).toBe(true);
    expect(timeEntrySourceSchema.safeParse('suggestion').success).toBe(false);
  });

  it('accepts ai_suggested as a source (#4177)', () => {
    expect(timeEntrySourceSchema.parse('ai_suggested')).toBe('ai_suggested');
  });

  it('createTimeEntrySchema / startTimerSchema never accept source (D5)', () => {
    const created = createTimeEntrySchema.safeParse({ startedAt: '2026-06-11T09:00:00Z', endedAt: '2026-06-11T09:30:00Z', source: 'timer' });
    expect(created.success && 'source' in created.data).toBe(false);
    const started = startTimerSchema.safeParse({ source: 'location' });
    expect(started.success && 'source' in started.data).toBe(false);
  });
});

describe('suggestionsQuerySchema', () => {
  it('requires a YYYY-MM-DD date and passes tz/userId through', () => {
    expect(suggestionsQuerySchema.safeParse({ date: '2026-08-29' }).success).toBe(true);
    expect(suggestionsQuerySchema.safeParse({ date: '2026-08-29', tz: 'Europe/Berlin', userId: UUID }).success).toBe(true);
    expect(suggestionsQuerySchema.safeParse({ date: '29/08/2026' }).success).toBe(false);
    expect(suggestionsQuerySchema.safeParse({}).success).toBe(false);
  });
});

describe('confirmSuggestionSchema', () => {
  const base = { signals: [SIG], startedAt: '2026-08-29T14:02:00Z', endedAt: '2026-08-29T14:40:00Z' };
  it('accepts a minimal confirm', () => {
    expect(confirmSuggestionSchema.safeParse(base).success).toBe(true);
  });
  it('is strict: rejects source, orgId and currency', () => {
    for (const extra of [{ source: 'remote_session' }, { orgId: UUID }, { currency: 'USD' }, { currencyCode: 'USD' }]) {
      expect(confirmSuggestionSchema.safeParse({ ...base, ...extra }).success).toBe(false);
    }
  });
  it('bounds signals to 1..20 unique remote_session refs', () => {
    expect(confirmSuggestionSchema.safeParse({ ...base, signals: [] }).success).toBe(false);
    expect(confirmSuggestionSchema.safeParse({ ...base, signals: [SIG, SIG] }).success).toBe(false);
    expect(confirmSuggestionSchema.safeParse({ ...base, signals: [{ kind: 'support_session', id: UUID }] }).success).toBe(false);
    expect(confirmSuggestionSchema.safeParse({ ...base, signals: Array.from({ length: 21 }, (_, i) => ({ kind: 'remote_session', id: `3f2f1d8e-1111-4222-8333-4444555566${String(i).padStart(2, '0')}` })) }).success).toBe(false);
  });
  it('allows endedAt to be omitted (server fills from the signal envelope) but rejects endedAt <= startedAt', () => {
    expect(confirmSuggestionSchema.safeParse({ signals: [SIG], startedAt: base.startedAt }).success).toBe(true);
    expect(confirmSuggestionSchema.safeParse({ ...base, endedAt: base.startedAt }).success).toBe(false);
  });
  it('ticketId may be null (explicit "no ticket")', () => {
    expect(confirmSuggestionSchema.safeParse({ ...base, ticketId: null }).success).toBe(true);
  });
});

describe('suggestionSignalsSchema', () => {
  it('accepts signals only', () => {
    expect(suggestionSignalsSchema.safeParse({ signals: [SIG] }).success).toBe(true);
    expect(suggestionSignalsSchema.safeParse({ signals: [SIG], reason: 'x' }).success).toBe(false);
  });
});

describe('billing override input', () => {
  it.each([null, 0, 30, 2147483647])('preserves minimumMinutes %s on create and update', minimumMinutes => {
    const span = { startedAt: '2026-06-11T09:00:00Z', endedAt: '2026-06-11T09:30:00Z' };
    expect(createTimeEntrySchema.parse({ ...span, minimumMinutes })).toHaveProperty('minimumMinutes', minimumMinutes);
    expect(updateTimeEntrySchema.parse({ minimumMinutes })).toEqual({ minimumMinutes });
  });
  it.each([-1, 0.5, 2147483648, '30'])('rejects invalid minimumMinutes %s', minimumMinutes => {
    expect(updateTimeEntrySchema.safeParse({ minimumMinutes }).success).toBe(false);
  });
  it('preserves resetBilling and rejects non-boolean values', () => {
    expect(updateTimeEntrySchema.parse({ resetBilling: true })).toEqual({ resetBilling: true });
    expect(updateTimeEntrySchema.safeParse({ resetBilling: 'true' }).success).toBe(false);
  });
});
