import { describe, expect, it, vi } from 'vitest';
import { buildReportPdf } from './reportPdf';
import * as techPdf from './technicianTimePdf';
import type { TechnicianTimeSummary } from '../types/businessReports';

const opts = { reportType: 'technician_time_billability', generatedAt: 'Sep 30, 2026', timezone: 'UTC' };

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
  'Utilization assumes a uniform 40h week prorated over 21 working days; PTO, part-time schedules and public holidays are not modelled.',
  'Billing conversion is approved-and-billed minutes over billable minutes. It is not financial realization — no fee-schedule baseline exists to compute one.',
  "Billable, included and non-billable minutes follow each entry's coverage; entries recorded before billing profiles fall back to their billable flag. Running timers are not counted.",
  'Organization-scoped: ticket-linked time only. Time entries with no organization are not included, and technicians who logged none of this organization\'s time do not appear.',
  'Time entries are partner-internal records: an organization-scoped sign-in cannot read them, so when this report runs under one it shows no time at all. Run it from the partner to see this organization\'s time.',
];

const SUMMARY: TechnicianTimeSummary = {
  generatedAt: '2026-09-30T05:18:00.000Z',
  period: {
    kind: 'last_full_month',
    start: '2026-09-01T00:00:00.000Z',
    end: '2026-10-01T00:00:00.000Z',
    label: 'September 2026',
    timeZone: 'America/Chicago',
  },
  scope: { kind: 'organization', orgId: 'o1', orgName: 'Acme Co' },
  groupBy: 'technician',
  weeklyCapacityHours: 40,
  workingDays: 21,
  overall: {
    loggedMinutes: 5000, capacityMinutes: 5040, utilization: 5000 / 5040,
    billableMinutes: 4000, includedMinutes: 500, nonBillableMinutes: 500,
    billablePercent: 4000 / 5000, billedMinutes: 3800, billingConversion: 3800 / 4000,
    billableValue: [{ currencyCode: 'USD', amount: '1234.56' }],
    averageRate: [{ currencyCode: 'USD', amount: '95.00' }],
  },
  groups: [
    {
      groupKey: 'u1', groupLabel: 'Jamie Lee',
      loggedMinutes: 2500, capacityMinutes: 2520, utilization: 2500 / 2520,
      billableMinutes: 2000, includedMinutes: 250, nonBillableMinutes: 250,
      billablePercent: 2000 / 2500, billedMinutes: 1900, billingConversion: 1900 / 2000,
      billableValue: [{ currencyCode: 'USD', amount: '617.28' }],
      averageRate: [{ currencyCode: 'USD', amount: '95.00' }],
    },
    {
      groupKey: 'u2', groupLabel: 'Morgan Diaz',
      loggedMinutes: 2500, capacityMinutes: null, utilization: null,
      billableMinutes: 2000, includedMinutes: 250, nonBillableMinutes: 250,
      billablePercent: 0.8, billedMinutes: 1900, billingConversion: 0.95,
      billableValue: [{ currencyCode: 'USD', amount: '617.28' }],
      averageRate: [{ currencyCode: 'USD', amount: '95.00' }],
    },
  ],
  zeroTimeTechnicians: 1,
  unpricedBillable: { minutes: 0, entries: 0 },
  detail: { cap: 5000, stored: 2, available: 2, truncated: false },
  notes: NOTES,
  rows: [
    {
      entryId: 'e1', startedAt: '2026-09-05T10:00:00.000Z', userId: 'u1', userName: 'Jamie Lee',
      orgId: 'o1', orgName: 'Acme Co', workTypeName: 'Support', durationMinutes: 60,
      billableMinutes: 60, coverage: 'billable', billingStatus: 'billed', isApproved: true,
      hourlyRate: '95.00', currencyCode: 'USD',
    },
    {
      entryId: 'e2', startedAt: '2026-09-06T10:00:00.000Z', userId: 'u2', userName: 'Morgan Diaz',
      orgId: 'o1', orgName: 'Acme Co', workTypeName: 'Project', durationMinutes: 30,
      billableMinutes: null, coverage: 'non_billable', billingStatus: 'not_billable', isApproved: false,
      hourlyRate: null, currencyCode: null,
    },
  ],
};

describe('buildReportPdf: technician_time_billability', () => {
  it('routes to the technician time renderer, not renderGenericReport', () => {
    const spy = vi.spyOn(techPdf, 'renderTechnicianTimeReport');
    buildReportPdf([], { ...opts, summary: SUMMARY });
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('a summary-less result falls through to the generic renderer rather than throwing', () => {
    expect(() => buildReportPdf([], opts)).not.toThrow();
  });

  it('prints the approximation notes verbatim', () => {
    const text = extractText(buildReportPdf([], { ...opts, summary: SUMMARY }));
    expect(text).toContain('not financial realization');
  });

  it('prints N/A, never 0%, for an unmeasured group utilization', () => {
    const text = extractText(buildReportPdf([], { ...opts, summary: SUMMARY }));
    expect(text).toContain('N/A');
  });

  it('discloses truncation: drawn count, available count, and both caps', () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({ ...SUMMARY.rows[0]!, entryId: `e${i}` }));
    const s = { ...SUMMARY, detail: { cap: 5000, stored: 5000, available: 9000, truncated: true }, rows };
    const text = extractText(buildReportPdf([], { ...opts, summary: s }));
    expect(text).toMatch(/showing 500 of 9000/);
    expect(text).not.toMatch(/5000 of 9000/);
    expect(text).toMatch(/at most 500 rows/);
    expect(text).toMatch(/at most 5000/);
  });

  // Fix round item 3.
  it('never says "no billable value" when billable minutes exist but are unpriced', () => {
    const s = {
      ...SUMMARY,
      overall: { ...SUMMARY.overall, billableValue: [], averageRate: [] },
      unpricedBillable: { minutes: 95, entries: 3 },
    };
    const text = extractText(buildReportPdf([], { ...opts, summary: s }));
    expect(text).not.toMatch(/No billable value recorded/);
    expect(text).toMatch(/95 billable minutes/);
  });

  it('still says "no billable value" when there is genuinely none', () => {
    const s = {
      ...SUMMARY,
      overall: { ...SUMMARY.overall, billableValue: [], averageRate: [] },
      unpricedBillable: { minutes: 0, entries: 0 },
    };
    expect(extractText(buildReportPdf([], { ...opts, summary: s }))).toMatch(/No billable value recorded/);
  });

  it('labels an entry whose organization name could not be read as unknown, not "No organization"', () => {
    const s = { ...SUMMARY, rows: [{ ...SUMMARY.rows[0]!, orgId: 'o-hidden', orgName: null }] };
    const text = extractText(buildReportPdf([], { ...opts, summary: s }));
    expect(text).toContain('Unknown organization');
    expect(text).not.toContain('No organization');
  });
});
