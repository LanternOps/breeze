import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { sheetsToXlsx } from './xlsxExport';
import {
  emptyTicketSlaPerformanceSummary,
  TICKET_SLA_PERFORMANCE_ROW_CSV_LABELS,
  type TicketSlaBreachRow,
  type TicketSlaPerformanceSummary,
} from '../types/ticketSlaPerformance';
import { ticketSlaPerformanceSheets } from './ticketSlaPerformanceWorkbook';

const BREACH: TicketSlaBreachRow = {
  ticketId: 't1', ticketNumber: 'T-1', subject: 'Printer', priority: 'urgent', target: 'response', targetMinutes: 60,
  createdAt: '2026-10-05T09:00:00.000Z', dueAt: '2026-10-05T10:00:00.000Z',
  completedAt: '2026-10-05T11:00:00.000Z', elapsedSlaMinutes: 120, overByMinutes: 60,
};

function summary(over: Partial<TicketSlaPerformanceSummary> = {}): TicketSlaPerformanceSummary {
  return {
    ...emptyTicketSlaPerformanceSummary('note'),
    breaches: { cap: 1000, stored: 1, available: 1, truncated: false, rows: [BREACH] },
    ...over,
  };
}

describe('ticketSlaPerformanceSheets', () => {
  it('returns the Priorities, Breaches and Notes sheets in that order', () => {
    const s = summary({ includeSubjects: true });
    const sheets = ticketSlaPerformanceSheets(s.rows, s);
    expect(sheets.map((sheet) => sheet.name)).toEqual(['Priorities', 'Breaches', 'Notes']);
    expect(sheets[0]!.rows).toHaveLength(s.rows.length);
    expect(sheets[1]!.rows).toEqual([BREACH]);
    expect(sheets[2]!.rows).toEqual([{ note: 'note' }]);
  });

  it('leads the notes with the truncation disclosure when the breach list was capped', () => {
    const s = summary({ breaches: { cap: 1000, stored: 1, available: 1400, truncated: true, rows: [BREACH] } });
    const notes = ticketSlaPerformanceSheets(s.rows, s)[2]!.rows as Array<{ note: string }>;
    expect(notes.map((n) => n.note)).toEqual([
      'Breaches: showing 1 of 1400. The stored report keeps at most 1000; totals count all of them.',
      'note',
    ]);
  });

  it('drops the subject column entirely when the report did not opt into subjects', () => {
    const s = summary({ includeSubjects: false });
    const [breach] = ticketSlaPerformanceSheets(s.rows, s)[1]!.rows as Array<Record<string, unknown>>;
    expect(breach).not.toHaveProperty('subject');
    expect(breach).toMatchObject({ ticketNumber: 'T-1', overByMinutes: 60 });
  });
});

describe('ticketSlaPerformanceSheets parity with the CSV', () => {
  it('labels the Priorities columns exactly as the CSV header does', () => {
    const s = summary();
    const [row] = ticketSlaPerformanceSheets(s.rows, s)[0]!.rows as Array<Record<string, unknown>>;
    expect(Object.keys(row!)).toEqual(Object.values(TICKET_SLA_PERFORMANCE_ROW_CSV_LABELS));
    expect(row).toHaveProperty('Priority', 'urgent');
  });

  it('keeps a header row on an empty Breaches sheet (subject only when opted in)', () => {
    const empty = { cap: 1000, stored: 0, available: 0, truncated: false, rows: [] };
    const without = ticketSlaPerformanceSheets([], summary({ breaches: empty, includeSubjects: false }))[1]!;
    expect(without.rows).toEqual([]);
    expect(without.headers).toContain('ticketNumber');
    expect(without.headers).not.toContain('subject');
    const withSubj = ticketSlaPerformanceSheets([], summary({ breaches: empty, includeSubjects: true }))[1]!;
    expect(withSubj.headers).toContain('subject');
  });

  it('writes the header row of an empty sheet into the xlsx', () => {
    const bytes = sheetsToXlsx([{ name: 'Breaches', rows: [], headers: ['ticketNumber', 'priority'] }]);
    const xml = strFromU8(unzipSync(bytes)['xl/worksheets/sheet1.xml']!);
    expect(xml).toContain('ticketNumber');
    expect(xml).toContain('priority');
  });
});
