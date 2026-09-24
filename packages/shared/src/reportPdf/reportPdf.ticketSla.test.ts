import { describe, expect, it, vi } from 'vitest';
import { buildReportPdf } from './reportPdf';
import * as slaPdf from './ticketSlaPdf';
import type { TicketSlaSummary } from '../types/businessReports';

const opts = { reportType: 'ticket_sla_attainment', generatedAt: 'Sep 30, 2026', timezone: 'UTC' };

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

const NOTES = [
  'Attainment is recomputed from ticket timestamps and the SLA targets stored on each ticket, not from the sla_breached_at stamp: the SLA sweep only marks tickets that are still open and unanswered when it runs, so a late-but-eventually-answered ticket is never stamped.',
  'sla_paused_minutes is a lifetime total, so pause time that occurred after first response slightly flatters response attainment.',
  'Tickets with no SLA target are excluded from the attainment denominators and counted separately.',
  'Planned work (work_kind other than support) carries a due date, not an SLA, and is excluded.',
  "The technician axis uses the ticket's CURRENT assignee; reassignment history is not tracked.",
];

const SUMMARY: TicketSlaSummary = {
  generatedAt: '2026-09-30T05:18:00.000Z',
  period: {
    kind: 'last_full_month',
    start: '2026-09-01T00:00:00.000Z',
    end: '2026-10-01T00:00:00.000Z',
    label: 'September 2026',
    timeZone: 'America/Chicago',
  },
  scope: { kind: 'organization', orgId: 'o1', orgName: 'Acme Co' },
  groupBy: 'priority',
  overall: {
    ticketsTotal: 120,
    noSlaTickets: 10,
    responseEligible: 110,
    responseMet: 100,
    responseAttainment: 100 / 110,
    resolutionEligible: 110,
    resolutionMet: 95,
    resolutionAttainment: 95 / 110,
    breaches: 15,
  },
  groups: [
    {
      groupKey: 'urgent', groupLabel: 'Urgent', ticketsTotal: 20, noSlaTickets: 1,
      responseEligible: 19, responseMet: 15, responseAttainment: 15 / 19,
      resolutionEligible: 19, resolutionMet: 16, resolutionAttainment: 16 / 19, breaches: 4,
    },
    {
      groupKey: 'normal', groupLabel: 'Normal', ticketsTotal: 100, noSlaTickets: 9,
      responseEligible: 91, responseMet: 85, responseAttainment: 85 / 91,
      resolutionEligible: 91, resolutionMet: 79, resolutionAttainment: 79 / 91, breaches: 11,
    },
  ],
  worstGroupLabel: 'Urgent',
  stampDiscrepancy: { recomputedBreachNotStamped: 3, stampedNotRecomputedBreach: 1 },
  detail: { cap: 5000, stored: 2, available: 2, truncated: false },
  notes: NOTES,
  rows: [
    {
      ticketId: 't1', ticketNumber: 'T-1', internalNumber: null, orgId: 'o1', orgName: 'Acme Co',
      subject: 'Server down', priority: 'urgent', category: 'infrastructure', assignedToId: 'u1', assignedToName: 'Jamie Lee',
      createdAt: '2026-09-05T10:00:00.000Z', firstResponseAt: '2026-09-05T12:00:00.000Z',
      resolvedAt: '2026-09-06T10:00:00.000Z', responseSlaMinutes: 60, resolutionSlaMinutes: 480,
      slaPausedMinutes: 0, responseOutcome: 'missed', resolutionOutcome: 'met',
      stampedBreachAt: null, stampedBreachReason: null,
    },
    {
      ticketId: 't2', ticketNumber: 'T-2', internalNumber: null, orgId: 'o1', orgName: 'Acme Co',
      subject: 'Password reset', priority: 'normal', category: null, assignedToId: null, assignedToName: null,
      createdAt: '2026-09-10T10:00:00.000Z', firstResponseAt: '2026-09-10T10:30:00.000Z',
      resolvedAt: '2026-09-10T11:00:00.000Z', responseSlaMinutes: 120, resolutionSlaMinutes: 240,
      slaPausedMinutes: 0, responseOutcome: 'met', resolutionOutcome: 'met',
      stampedBreachAt: null, stampedBreachReason: null,
    },
  ],
};

function makeRow(i: number, breached: boolean): TicketSlaSummary['rows'][number] {
  return {
    ticketId: `t${i}`, ticketNumber: `T-${i}`, internalNumber: null, orgId: 'o1', orgName: 'Acme Co',
    subject: `Ticket ${i}`, priority: 'normal', category: null, assignedToId: null, assignedToName: null,
    createdAt: '2026-09-10T10:00:00.000Z', firstResponseAt: '2026-09-10T10:30:00.000Z',
    resolvedAt: '2026-09-10T11:00:00.000Z', responseSlaMinutes: 120, resolutionSlaMinutes: 240,
    slaPausedMinutes: 0,
    responseOutcome: breached ? 'missed' : 'met',
    resolutionOutcome: 'met',
    stampedBreachAt: null, stampedBreachReason: null,
  };
}

describe('buildReportPdf: ticket_sla_attainment', () => {
  it('routes to the SLA renderer, not renderGenericReport', () => {
    const spy = vi.spyOn(slaPdf, 'renderTicketSlaReport');
    buildReportPdf([], { ...opts, summary: SUMMARY });
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('a summary-less result falls through to the generic renderer rather than throwing', () => {
    expect(() => buildReportPdf([], opts)).not.toThrow();
  });

  it('prints the approximation notes verbatim', () => {
    const text = extractText(buildReportPdf([], { ...opts, summary: SUMMARY }));
    expect(text).toContain('lifetime total');
  });

  it('prints N/A, never 0%, for an unmeasured group', () => {
    const s = { ...SUMMARY, groups: [{ ...SUMMARY.groups[0]!, responseEligible: 0, responseMet: 0, responseAttainment: null }] };
    const text = extractText(buildReportPdf([], { ...opts, summary: s }));
    expect(text).toContain('N/A');
  });

  it('discloses truncation with both numbers', () => {
    const s = { ...SUMMARY, detail: { cap: 5000, stored: 5000, available: 9000, truncated: true } };
    expect(extractText(buildReportPdf([], { ...opts, summary: s }))).toMatch(/of 15 breaches/);
  });

  // Fix round item 1: the heading states what is DRAWN, never the stored count.
  it('generator truncation + PDF cap: states the drawn count, the breach total, and both caps', () => {
    const rows = Array.from({ length: 5000 }, (_, i) => makeRow(i, true));
    const s = {
      ...SUMMARY,
      overall: { ...SUMMARY.overall, breaches: 9000 },
      detail: { cap: 5000, stored: 5000, available: 12000, truncated: true },
      rows,
    };
    const text = extractText(buildReportPdf([], { ...opts, summary: s }));
    expect(text).toMatch(/showing 500 of 9000 breaches/);
    expect(text).not.toMatch(/5000 of 12000/);
    expect(text).toMatch(/at most 500 rows/);
    expect(text).toMatch(/at most 5000/);
  });

  // Fix round item 2: the count is BREACHES (overall.breaches), not tickets.
  it('counts breaches, not tickets, when stored breaches are fewer than the breach total', () => {
    const rows = [makeRow(1, true), makeRow(2, true), makeRow(3, false)];
    const s = {
      ...SUMMARY,
      overall: { ...SUMMARY.overall, breaches: 7 },
      detail: { cap: 5000, stored: 3, available: 40, truncated: true },
      rows,
    };
    const text = extractText(buildReportPdf([], { ...opts, summary: s }));
    expect(text).toMatch(/showing 2 of 7 breaches/);
    expect(text).not.toMatch(/of 40/);
  });

  it('no truncation claim when every breach is drawn', () => {
    const rows = [makeRow(1, true), makeRow(2, true), makeRow(3, false)];
    const s = { ...SUMMARY, overall: { ...SUMMARY.overall, breaches: 2 }, detail: { cap: 5000, stored: 3, available: 3, truncated: false }, rows };
    expect(extractText(buildReportPdf([], { ...opts, summary: s }))).not.toMatch(/showing/);
  });

  it('distinguishes an unassigned ticket from an assignee whose name could not be read', () => {
    const rows = [
      { ...makeRow(1, true), assignedToId: null, assignedToName: null },
      { ...makeRow(2, true), assignedToId: 'u-hidden', assignedToName: null },
    ];
    const s = { ...SUMMARY, overall: { ...SUMMARY.overall, breaches: 2 }, rows };
    const text = extractText(buildReportPdf([], { ...opts, summary: s }));
    expect(text).toContain('Unassigned');
    expect(text).toContain('Unknown technician');
  });

  it('does not falsely disclose truncation when the total ticket set exceeds the local cap but the breached subset does not', () => {
    // 600 total detail rows, only 2 breached: the "Breached tickets" table
    // shows every breached ticket, so it must not claim a 500-of-600 cut.
    const rows = [
      ...Array.from({ length: 598 }, (_, i) => makeRow(i, false)),
      makeRow(998, true),
      makeRow(999, true),
    ];
    const s = { ...SUMMARY, overall: { ...SUMMARY.overall, breaches: 2 }, detail: { cap: 5000, stored: 600, available: 600, truncated: false }, rows };
    const text = extractText(buildReportPdf([], { ...opts, summary: s }));
    // jsPDF escapes literal parens in its content stream, so match the digits,
    // not the punctuation — same convention as the "5000 of 9000" case above.
    expect(text).not.toMatch(/showing 500 of/);
  });

  it('discloses truncation, with the breached count, when the breached subset itself exceeds the local cap', () => {
    const rows = Array.from({ length: 600 }, (_, i) => makeRow(i, true));
    const s = { ...SUMMARY, overall: { ...SUMMARY.overall, breaches: 600 }, detail: { cap: 5000, stored: 600, available: 600, truncated: false }, rows };
    const text = extractText(buildReportPdf([], { ...opts, summary: s }));
    expect(text).toMatch(/showing 500 of 600/);
  });
});
