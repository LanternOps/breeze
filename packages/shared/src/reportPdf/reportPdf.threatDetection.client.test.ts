/**
 * #12046: the Threat Detection Review is read by the customer's office
 * manager. Its coverage tiles must add up, and nothing in it may be a raw
 * integration token (a status of "sent", a vendor's "LOW - ... (Org)" title).
 */
import { describe, expect, it } from 'vitest';
import { buildReportPdf } from './reportPdf';
import type { ThreatDetectionSummary, ThreatIncidentRow } from '../types/threatDetectionReport';

const opts = { reportType: 'threat_detection_review', generatedAt: 'Nov 9, 2026', timezone: 'UTC' };

const CP1252_HIGH =
  '€‚ƒ„…†‡' +
  'ˆ‰Š‹ŒŽ' +
  '‘’“”•–—' +
  '˜™š›œžŸ';
const decodeWinAnsi = (s: string): string =>
  s.replace(/[\x80-\x9f]/g, (ch) => CP1252_HIGH[ch.charCodeAt(0) - 0x80] ?? ch);

function pdfText(summary: ThreatDetectionSummary): string {
  const doc = buildReportPdf([], { ...opts, summary });
  return ((doc.internal as unknown as { pages: Array<string[] | undefined> }).pages ?? [])
    .filter((p): p is string[] => Array.isArray(p))
    .map((p) => decodeWinAnsi(p.join('\n')))
    .join('\n');
}

const ORG = 'Harlow & Pierce P.C.';

const ROW: ThreatIncidentRow = {
  id: 'i1',
  reportedAt: '2026-10-20T00:00:00.000Z',
  hostname: 'SAM4',
  severity: 'low',
  category: 'identity',
  title: `LOW - Incident on SAM4 (${ORG})`,
  status: 'sent',
  resolvedAt: null,
  recommendation: null,
};

const BASE: ThreatDetectionSummary = {
  orgId: 'o1',
  orgName: ORG,
  generatedAt: '2026-11-09T12:00:00.000Z',
  coverage: {
    periodStart: '2026-10-10',
    periodEnd: '2026-11-09',
    coveredFrom: '2026-01-01T00:00:00.000Z',
    coveredTo: '2026-11-09T11:00:00.000Z',
    generatedAt: '2026-11-09T12:00:00.000Z',
    sourceStatus: 'ok',
    lastSyncAt: '2026-11-09T11:00:00.000Z',
    lastSyncStatus: 'ok',
    unattributableExcluded: 0,
    withheld: 0,
    note: '',
  },
  // The issue's org: 8 Huntress agents, 12 managed devices, 4 agents unmatched,
  // and 3 more devices protected by another integrated EDR product.
  agentCoverage: {
    huntressAgents: 8,
    breezeDevices: 12,
    agentsOffline: 0,
    devicesWithoutAgent: 8,
    devicesWithDetectionAgent: 7,
    devicesWithoutDetectionAgent: 5,
    unmatchedAgents: 4,
  },
  incidents: {
    opened: 1, resolved: 0,
    bySeverity: { low: 1 },
    byStatus: { sent: 1 },
    meanResolveHours: null, medianResolveHours: null,
    carriedIn: 0,
  },
  rows: [ROW],
  dataGaps: [],
};

describe('Threat Detection Review PDF: client language (#12046)', () => {
  it('prints coverage tiles that reconcile and names the unmatched agents', () => {
    const text = pdfText(BASE);
    expect(text).toContain('Managed devices with a detection agent');
    expect(text).toContain('Managed devices with no detection agent');
    // The misleading label that counted unmatched agents as endpoints.
    expect(text).not.toContain('Endpoints with a detection agent');
    expect(text).toMatch(/\(7\) Tj[\s\S]*\(5\) Tj/);
    expect(text).toMatch(/4 of the 8 detection agents reported for this organization are not matched to a device Breeze manages/);
  });

  it('derives reconciling tiles from a legacy snapshot without the new fields', () => {
    const text = pdfText({
      ...BASE,
      agentCoverage: { huntressAgents: 8, breezeDevices: 12, agentsOffline: 0, devicesWithoutAgent: 8 },
    });
    expect(text).toContain('Managed devices with a detection agent');
    expect(text).toMatch(/\(4\) Tj[\s\S]*\(8\) Tj/);
    expect(text).toContain('8 detection agents are reported for this organization');
  });

  it('maps a raw "sent" status to client language, in the table and the counts', () => {
    const text = pdfText(BASE);
    expect(text).not.toMatch(/\bsent\b/);
    // The counts line (its em dash is encoded apart from the ASCII run).
    expect(text).toMatch(/Open: 1/);
    expect(text).toContain('(Open) Tj');
  });

  it('strips the vendor severity prefix and org name from the detection title', () => {
    const text = pdfText(BASE);
    expect(text).toContain('(Incident on SAM4) Tj');
    expect(text).not.toContain('LOW - Incident');
    // The org name still heads the report; it is only gone from the title.
    expect(text).not.toMatch(/SAM4 \\\(Harlow/);
  });

  it('never prints an email address carried in a detection title', () => {
    const text = pdfText({
      ...BASE,
      rows: [{ ...ROW, title: `HIGH - Suspicious sign-in for jane.doe@example.com (${ORG})` }],
    });
    expect(text).not.toContain('jane.doe@example.com');
    expect(text).toContain('Suspicious sign-in for a user account');
  });

  it('capitalises severity in the table and the counts line', () => {
    const text = pdfText(BASE);
    expect(text).toContain('(Low) Tj');
    expect(text).toMatch(/Low: 1/);
    expect(text).not.toMatch(/\(low\) Tj/);
  });

  it('drops the "What we advised" column when no row has advice', () => {
    expect(pdfText(BASE)).not.toContain('What we advised');
    expect(pdfText({ ...BASE, rows: [{ ...ROW, recommendation: 'Reset the password.' }] }))
      .toContain('What we advised');
  });

  it('prints how long an unresolved detection has been open and flags a long-open one', () => {
    const text = pdfText({
      ...BASE,
      rows: [ROW, { ...ROW, id: 'i2', reportedAt: '2025-04-12T00:00:00.000Z', carriedIn: true }],
      incidents: { ...BASE.incidents!, carriedIn: 1 },
    });
    expect(text).not.toContain('Not yet');
    expect(text).toContain('Open 20 days');
    expect(text).toContain('Open 576 days');
    expect(text).toMatch(/1 detection has been open for more than 90 days/);
  });

  it('says the typical figure is the median', () => {
    const text = pdfText({ ...BASE, incidents: { ...BASE.incidents!, meanResolveHours: 4, medianResolveHours: 3 } });
    expect(text).toContain('Median time to resolve');
    expect(text).not.toContain('Typical time to resolve');
  });

  it('states the reporting period in the same form as the other reports', () => {
    expect(pdfText(BASE)).toContain('Reporting period 2026-10-10 to 2026-11-09');
  });
});
