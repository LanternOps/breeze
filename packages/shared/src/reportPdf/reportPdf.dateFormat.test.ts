/**
 * #12048 (remaining items): the backup-status, ticket-SLA and posture "since"
 * dates format through the report's one date format, and the posture report
 * prints the period it covers. Each report is built for a partner that uses
 * DD/MM/YYYY + 24h so a stray `en-US` / ISO formatter shows up.
 */
import { describe, expect, it } from 'vitest';
import { buildReportPdf, type ReportBranding } from './reportPdf';
import { emptyTicketSlaPerformanceSummary, type TicketSlaPerformanceSummary } from '../types/ticketSlaPerformance';
import type { BackupStatusReportData } from '../types/backupStatusReport';
import type { TicketSlaSummary } from '../types/businessReports';
import type { PostureSummary } from '../types/postureReport';

type Doc = ReturnType<typeof buildReportPdf>;
const CP1252_HIGH = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';
const decodeWinAnsi = (s: string): string =>
  s.replace(/[\u0080-\u009f]/g, (ch) => CP1252_HIGH[ch.charCodeAt(0) - 0x80] ?? ch);
const text = (doc: Doc): string =>
  ((doc.internal as unknown as { pages: Array<string[] | undefined> }).pages ?? [])
    .filter((p): p is string[] => Array.isArray(p))
    .map((p) => decodeWinAnsi(p.join('\n')))
    .join('\n')
    .replace(/\\([()\\])/g, '$1');

const eu: ReportBranding = {
  name: 'Example MSP', logoDataUrl: null, logoAspect: null,
  pageSize: 'letter', dateFormat: 'DD/MM/YYYY', timeFormat: '24h',
};
const GENERATED = new Date('2026-11-09T17:06:00.000Z');
const base = { generatedAt: GENERATED, timezone: 'America/New_York', branding: eu };

describe('backup status report dates (#12048)', () => {
  const data = {
    org: { id: 'o1', name: 'Example Client' },
    asOf: '2026-09-15T12:00:00.000Z',
    generatedAt: '2026-09-15T12:00:00.000Z',
    summary: { endpoints: { total: 1, covered: 0, uncovered: 1 }, providerOnly: 0, m365Accounts: 0, byStatus: {}, byHealth: {}, byRecency: {} },
    statusBuckets: [{ key: 'completed', count: 1, pct: 100 }],
    recencyBuckets: [{ key: 'over_48h', count: 1, pct: 100 }],
    rows: [{
      key: 'breeze:d1', name: 'WS-1', source: 'breeze', providerKey: null, providerLabel: null, orgId: 'o1', orgName: 'Example Client',
      siteId: null, deviceId: 'd1', computerName: 'WS-1', osType: 'workstation', accountType: 'endpoint',
      status: 'completed', health: 'critical', recency: 'over_48h', covered: false, stale: false,
      lastSuccessAt: '2026-03-23T12:00:00.000Z', lastSessionAt: null, selectedBytes: null, usedBytes: null, errorsCount: 0,
      dataSources: [], history28d: [], agentOnline: null,
      verifiedBootableAt: null, verifiedBootable: null, verifiedBootableFailedChecks: null,
    }],
    truncated: false,
    options: { includeDevicesWithoutBackup: true, sources: ['breeze'] },
  } as unknown as BackupStatusReportData;

  it('prints the snapshot time and last-success date in the partner format, with a zone', () => {
    const t = text(buildReportPdf([], { ...base, reportType: 'backup_status', summary: data }));
    expect(t).toContain('Figures as of 15 Sep 2026, 08:00 EDT');
    // The narrow Status column wraps, so assert the pieces.
    for (const piece of ['Last:', '23 Mar']) expect(t).toContain(piece);
    expect(t).not.toContain('Mar 23');
    expect(t).not.toContain('Sep 15, 2026');
  });
});

describe('ticket SLA report dates (#12048)', () => {
  const summary = {
    generatedAt: '2026-09-30T05:18:00.000Z',
    period: { kind: 'last_full_month', start: '2026-09-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z', label: 'September 2026', timeZone: 'America/Chicago' },
    scope: { kind: 'organization', orgId: 'o1', orgName: 'Acme Co' },
    groupBy: 'priority',
    overall: { ticketsTotal: 1, noSlaTickets: 0, responseEligible: 1, responseMet: 0, responseAttainment: 0, resolutionEligible: 1, resolutionMet: 1, resolutionAttainment: 1, breaches: 1 },
    groups: [],
    worstGroupLabel: null,
    stampDiscrepancy: { recomputedBreachNotStamped: 0, stampedNotRecomputedBreach: 0 },
    detail: { cap: 5000, stored: 1, available: 1, truncated: false },
    notes: [],
    rows: [{
      ticketId: 't1', ticketNumber: 'T-1', internalNumber: null, orgId: 'o1', orgName: 'Acme Co',
      subject: 'Server down', priority: 'urgent', category: null, assignedToId: 'u1', assignedToName: 'Jamie Lee',
      createdAt: '2026-09-05T10:00:00.000Z', firstResponseAt: '2026-09-05T12:00:00.000Z',
      resolvedAt: '2026-09-06T10:00:00.000Z', responseSlaMinutes: 60, resolutionSlaMinutes: 480,
      slaPausedMinutes: 0, responseOutcome: 'missed', resolutionOutcome: 'met', stampedBreachReason: null, stampedBreachAt: null,
    }],
  } as unknown as TicketSlaSummary;

  it('prints breach-table created dates in the partner format, not ISO', () => {
    const t = text(buildReportPdf([], { ...base, reportType: 'ticket_sla_attainment', summary }));
    expect(t).toContain('5 Sep 2026');
    expect(t).not.toContain('2026-09-05');
  });

  it('ticket SLA performance prints due/completed instants and "measured through" in the partner format', () => {
    const empty = emptyTicketSlaPerformanceSummary('note');
    const perf: TicketSlaPerformanceSummary = {
      ...empty,
      period: {
        kind: 'last_full_month', start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z',
        label: 'October 2026', timeZone: 'America/Chicago', measuredThrough: '2026-10-15T12:00:00.000Z',
      },
      org: { orgId: 'o1', orgName: 'Acme Co' },
      breaches: {
        cap: 1000, stored: 1, available: 1, truncated: false,
        rows: [{
          ticketId: 't1', ticketNumber: 'T-1001', subject: 'Printer', priority: 'urgent', target: 'response', targetMinutes: 60,
          createdAt: '2026-10-05T09:00:00.000Z', dueAt: '2026-10-05T10:00:00.000Z',
          completedAt: '2026-10-05T11:05:00.000Z', elapsedSlaMinutes: 125, overByMinutes: 65,
        }],
      },
    };
    const t = text(buildReportPdf([], { ...base, reportType: 'ticket_sla_performance', summary: perf }));
    expect(t).toContain('Measured through 15 Oct 2026');
    expect(t).not.toContain('Oct 15, 2026');
    expect(t).toContain('5 Oct 2026, 05:00 CDT');
    expect(t).toContain('5 Oct 2026, 06:05 CDT');
  });
});

describe('security posture report dates and period (#12048)', () => {
  const posture: PostureSummary = {
    org: { id: 'o1', name: 'Example Client' },
    generatedAt: '2026-11-09T17:06:00.000Z',
    deviceCount: 8,
    postureScore: 64,
    controls: { edrCoveragePct: 63, anyAvCoveragePct: 100, encryptionPct: 100, firewallPct: 100, patchCurrentPct: 100, cisIncluded: false },
    privilegedAccess: { windowDays: 30, elevationsInWindow: 0, activePamRules: 0, uacInterceptionEnabled: false, mfaStepUpEnforced: false },
  };
  const run = (extra: Record<string, unknown> = {}, branding: ReportBranding = eu, summary: PostureSummary = posture) =>
    text(buildReportPdf([], { ...base, branding, reportType: 'security_compliance_posture', summary, ...extra }));

  it('prints the period the report covers, in the report date format, labelled UTC', () => {
    expect(run()).toContain('Point-in-time snapshot, elevation activity 10 Oct 2026 – 9 Nov 2026 (UTC)');
    expect(run({}, { ...eu, dateFormat: 'MM/DD/YYYY' })).toContain('elevation activity Oct 10, 2026 – Nov 9, 2026 (UTC)');
  });

  it('says the device state is a point-in-time snapshot rather than inventing a period when none is known', () => {
    const t = run({}, eu, { ...posture, generatedAt: undefined });
    expect(t).not.toContain('elevation activity');
    expect(t).toContain('Point-in-time snapshot');
  });

  it('formats the scorecard "since" label in the partner date format', () => {
    const t = run({ previous: { generatedAt: '2026-10-20T12:00:00.000Z', summary: { postureScore: 50 } } });
    expect(t).toContain('since 20 Oct 2026');
    expect(t).not.toContain('since Oct 20');
  });
});
