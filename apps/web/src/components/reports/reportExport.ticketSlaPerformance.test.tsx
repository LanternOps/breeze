import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyTicketSlaPerformanceSummary, type TicketSlaBreachRow, type TicketSlaPerformanceSummary } from '@breeze/shared';

const blobs: Blob[] = [];
vi.mock('@/lib/downloadBlob', () => ({ downloadBlob: (b: Blob) => { blobs.push(b); } }));

const sheetsToXlsx = vi.hoisted(() => vi.fn((_sheets: unknown) => new Uint8Array([1])));
vi.mock('@breeze/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@breeze/shared')>()),
  sheetsToXlsx,
}));

import { exportReport } from './reportExport';

const BREACH: TicketSlaBreachRow = {
  ticketId: 't1', ticketNumber: 'T-1', subject: null, priority: 'urgent', target: 'response', targetMinutes: 60,
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

const sheets = () => sheetsToXlsx.mock.calls[0]![0] as Array<{ name: string; rows: Record<string, unknown>[] }>;

describe('exportReport: ticket_sla_performance', () => {
  beforeEach(() => {
    blobs.length = 0;
    sheetsToXlsx.mockClear();
  });

  it('export produces a priorities sheet and a breaches sheet', async () => {
    const s = summary();
    await exportReport(s.rows, { format: 'excel', reportType: 'ticket_sla_performance', timezone: 'UTC', summary: s });
    expect(sheets().map((sheet) => sheet.name)).toEqual(['Priorities', 'Breaches', 'Notes']);
    expect(sheets()[0]!.rows).toEqual(s.rows);
    expect(sheets()[1]!.rows).toHaveLength(1);
    expect(sheets()[1]!.rows[0]).toMatchObject({ ticketNumber: 'T-1', overByMinutes: 60 });
    expect(blobs).toHaveLength(1);
  });

  it('the Notes sheet carries the report notes, and a truncated breach list says so', async () => {
    const s = summary({ breaches: { cap: 1000, stored: 1, available: 1400, truncated: true, rows: [BREACH] } });
    await exportReport(s.rows, { format: 'excel', reportType: 'ticket_sla_performance', timezone: 'UTC', summary: s });
    const notes = sheets()[2]!.rows.map((r) => r.note);
    expect(notes[0]).toBe('Breaches: showing 1 of 1400. The stored report keeps at most 1000; totals count all of them.');
    expect(notes).toContain('note');
  });

  it('an untruncated breach list adds no truncation line', async () => {
    const s = summary();
    await exportReport(s.rows, { format: 'excel', reportType: 'ticket_sla_performance', timezone: 'UTC', summary: s });
    expect(sheets()[2]!.rows.map((r) => r.note)).toEqual(['note']);
  });

  it('refuses an Excel export whose summary is missing, rather than dropping the breaches sheet', async () => {
    const s = summary();
    await expect(exportReport(s.rows, { format: 'excel', reportType: 'ticket_sla_performance', timezone: 'UTC' }))
      .rejects.toThrow(/breach/i);
    expect(sheetsToXlsx).not.toHaveBeenCalled();
    expect(blobs).toHaveLength(0);
  });

  it('a report without subjects has no subject column at all', async () => {
    const s = summary({ includeSubjects: false });
    await exportReport(s.rows, { format: 'excel', reportType: 'ticket_sla_performance', timezone: 'UTC', summary: s });
    expect(sheets()[1]!.rows[0]).not.toHaveProperty('subject');
  });

  it('a report with subjects keeps the column', async () => {
    const s = summary({
      includeSubjects: true,
      breaches: { cap: 1000, stored: 1, available: 1, truncated: false, rows: [{ ...BREACH, subject: 'Printer' }] },
    });
    await exportReport(s.rows, { format: 'excel', reportType: 'ticket_sla_performance', timezone: 'UTC', summary: s });
    expect(sheets()[1]!.rows[0]).toMatchObject({ subject: 'Printer' });
  });

  it('CSV stays one table of priority rows', async () => {
    const s = summary();
    await exportReport(s.rows, { format: 'csv', reportType: 'ticket_sla_performance', timezone: 'UTC', summary: s });
    const csv = await blobs[0]!.text();
    expect(csv.split('\n')[0]).toContain('responseMedianMinutes');
    expect(csv).toContain('urgent');
    expect(csv).not.toContain('T-1');
    expect(sheetsToXlsx).not.toHaveBeenCalled();
  });

  it('with no measured rows there is nothing to export, rather than a sheet of zeros', async () => {
    const s = summary();
    await expect(exportReport([], { format: 'excel', reportType: 'ticket_sla_performance', timezone: 'UTC', summary: s }))
      .rejects.toThrow('No data to export');
    expect(sheetsToXlsx).not.toHaveBeenCalled();
  });
});
