import { describe, expect, it, vi } from 'vitest';
import { buildReportPdf } from './reportPdf';
import { formatSlaMinutes } from './ticketSlaPerformancePdf';
import {
  emptyTicketSlaPerformanceSummary,
  type TicketSlaBreachRow,
  type TicketSlaPerformanceSummary,
} from '../types/ticketSlaPerformance';

const opts = { reportType: 'ticket_sla_performance', generatedAt: 'Nov 2, 2026', timezone: 'UTC' };

// See reportPdf.identityAccess.test.ts for why WinAnsi bytes are mapped back before matching.
const CP1252_HIGH =
  '€‚ƒ„…†‡'
  + 'ˆ‰Š‹ŒŽ'
  + '‘’“”•–—'
  + '˜™š›œžŸ';
const decodeWinAnsi = (s: string): string =>
  s.replace(/[\x80-\x9f]/g, (ch) => CP1252_HIGH[ch.charCodeAt(0) - 0x80] ?? ch);

function extractText(doc: ReturnType<typeof buildReportPdf>): string {
  return ((doc.internal as unknown as { pages: Array<string[] | undefined> }).pages ?? [])
    .filter((p): p is string[] => Array.isArray(p))
    .map((p) => decodeWinAnsi(p.join('\n')))
    .join('\n');
}

const BREACH: TicketSlaBreachRow = {
  ticketId: 't1', ticketNumber: 'T-1001', subject: 'Printer offline on the third floor',
  priority: 'urgent', target: 'response', targetMinutes: 60,
  createdAt: '2026-10-05T09:00:00.000Z', dueAt: '2026-10-05T10:00:00.000Z',
  completedAt: '2026-10-05T11:05:00.000Z', elapsedSlaMinutes: 125, overByMinutes: 65,
};

function summary(over: Partial<TicketSlaPerformanceSummary> = {}): TicketSlaPerformanceSummary {
  const base = emptyTicketSlaPerformanceSummary('Times are measured on each ticket\'s SLA clock.');
  const urgent = {
    ...base.priorities[0]!,
    ticketsOpened: 12,
    responseTargetMinutes: 60, responseTargetVaries: true,
    responseMeasured: 10, responseMet: 9, responseMissed: 1,
    responseAttainment: 0.9, responseMedianMinutes: 38, responseMeanMinutes: 125, responseTimedSample: 10,
  };
  const priorities = [urgent, base.priorities[1]!, base.priorities[2]!, base.priorities[3]!];
  return {
    ...base,
    period: {
      kind: 'last_full_month', start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z',
      label: 'October 2026', timeZone: 'America/Chicago', measuredThrough: '2026-11-01T00:00:00.000Z',
    },
    org: { orgId: 'o1', orgName: 'Acme Co' },
    overall: { ...urgent, priority: 'all' },
    priorities,
    rows: priorities,
    breaches: { cap: 1000, stored: 1, available: 1, truncated: false, rows: [BREACH] },
    ...over,
  };
}

describe('formatSlaMinutes', () => {
  it("formatSlaMinutes(59)='59 min', (125)='2h 05m', (null)='—'", () => {
    expect(formatSlaMinutes(59)).toBe('59 min');
    expect(formatSlaMinutes(125)).toBe('2h 05m');
    expect(formatSlaMinutes(null)).toBe('—');
  });

  it('the boundaries are unambiguous', () => {
    expect(formatSlaMinutes(0)).toBe('0 min');
    expect(formatSlaMinutes(60)).toBe('1h 00m');
  });
});

describe('buildReportPdf: ticket_sla_performance', () => {
  it('renders the four priority rows and the notes', () => {
    const text = extractText(buildReportPdf([], { ...opts, summary: summary() }));
    expect(text).toContain('Service Level Performance');
    expect(text).toContain('Acme Co');
    expect(text).toContain('October 2026');
    for (const label of ['Urgent', 'High', 'Normal', 'Low']) expect(text).toContain(label);
    expect(text).toContain('90.0%');
    expect(text).toContain('38 min');
    expect(text).toContain('2h 05m');
    // The PDF stream escapes parentheses, so match the word.
    expect(text).toContain('1h 00m');
    expect(text).toContain('varies');
    expect(text).toContain("SLA clock");
  });

  it('prints the breach row by ticket number, with the time over target', () => {
    const text = extractText(buildReportPdf([], { ...opts, summary: summary() }));
    expect(text).toContain('T-1001');
    expect(text).toContain('Response');
    expect(text).toContain('1h 05m');
  });

  it('a period still running says what it was measured through', () => {
    const s = summary();
    const running = { ...s, period: { ...s.period, measuredThrough: '2026-10-15T12:00:00.000Z' } };
    expect(extractText(buildReportPdf([], { ...opts, summary: running }))).toContain('Measured through Oct 15, 2026');
    expect(extractText(buildReportPdf([], { ...opts, summary: s }))).not.toContain('Measured through');
  });

  it('omits the subject column when includeSubjects is false', () => {
    const text = extractText(buildReportPdf([], { ...opts, summary: summary({ includeSubjects: false }) }));
    expect(text).not.toContain('Subject');
    expect(text).not.toContain('Printer offline');
  });

  it('prints the subject column when includeSubjects is true', () => {
    const text = extractText(buildReportPdf([], { ...opts, summary: summary({ includeSubjects: true }) }));
    expect(text).toContain('Subject');
    expect(text).toContain('Printer offline');
  });

  it('a target still open prints as not completed, with no over-by claim', () => {
    const open = { ...BREACH, completedAt: null, elapsedSlaMinutes: null, overByMinutes: null };
    const text = extractText(buildReportPdf([], {
      ...opts,
      summary: summary({ breaches: { cap: 1000, stored: 1, available: 1, truncated: false, rows: [open] } }),
    }));
    expect(text).toContain('Still open');
  });

  it('discloses a truncated breach list against the true total', () => {
    const text = extractText(buildReportPdf([], {
      ...opts,
      summary: summary({ breaches: { cap: 1000, stored: 1, available: 1500, truncated: true, rows: [BREACH] } }),
    }));
    expect(text).toContain('1500');
  });

  it('an empty breach list says so rather than drawing an empty table', () => {
    const text = extractText(buildReportPdf([], {
      ...opts,
      summary: summary({ breaches: { cap: 1000, stored: 0, available: 0, truncated: false, rows: [] } }),
    }));
    expect(text).toContain('No breaches in this period.');
  });

  it('an unmeasured (site-restricted) summary prints its reason and no measured-looking zeros', () => {
    const onRendererFallback = vi.fn();
    const empty = emptyTicketSlaPerformanceSummary('Your access scope is limited to specific sites.');
    const text = extractText(buildReportPdf([], { ...opts, summary: empty, onRendererFallback }));
    expect(onRendererFallback).not.toHaveBeenCalled();
    expect(text).toContain('Your access scope is limited');
    expect(text).not.toContain('Priority');
    expect(text).not.toContain('No breaches in this period.');
  });

  it('a summary with period null falls through without throwing', () => {
    const onRendererFallback = vi.fn();
    const bad = { ...summary(), period: null } as unknown as TicketSlaPerformanceSummary;
    expect(() => buildReportPdf([], { ...opts, summary: bad, onRendererFallback })).not.toThrow();
    expect(onRendererFallback).toHaveBeenCalledWith({ reportType: 'ticket_sla_performance', reason: 'summary_shape_mismatch' });
  });

  it('a missing summary is reported as a designed-renderer fallback', () => {
    const onRendererFallback = vi.fn();
    buildReportPdf([], { ...opts, onRendererFallback });
    expect(onRendererFallback).toHaveBeenCalledWith({ reportType: 'ticket_sla_performance', reason: 'summary_missing' });
  });
});
