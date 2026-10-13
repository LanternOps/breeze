import { describe, expect, it } from 'vitest';
import { buildReportPdf } from './reportPdf';
import type { ThreatDetectionSummary } from '../types/threatDetectionReport';

const opts = { reportType: 'threat_detection_review', generatedAt: 'Sep 30, 2026', timezone: 'UTC' };

function pdfText(doc: ReturnType<typeof buildReportPdf>): string {
  return ((doc.internal as unknown as { pages: Array<string[] | undefined> }).pages ?? [])
    .filter((p): p is string[] => Array.isArray(p))
    .map((p) => p.join('\n'))
    .join('\n');
}

const BASE: ThreatDetectionSummary = {
  orgId: 'o1',
  orgName: 'Acme',
  generatedAt: '2026-09-30T05:18:00.000Z',
  coverage: {
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    coveredFrom: '2026-09-01T00:00:00.000Z',
    coveredTo: '2026-09-30T05:00:00.000Z',
    generatedAt: '2026-09-30T05:18:00.000Z',
    sourceStatus: 'ok',
    lastSyncAt: '2026-09-30T05:00:00.000Z',
    lastSyncStatus: 'ok',
    unattributableExcluded: 0,
    withheld: 0,
    note: '',
  },
  agentCoverage: { huntressAgents: 4, breezeDevices: 5, agentsOffline: 0, devicesWithoutAgent: 1 },
  incidents: {
    opened: 0, resolved: 0, bySeverity: {}, byStatus: {},
    meanResolveHours: null, medianResolveHours: null, carriedIn: 0,
  },
  rows: [],
  dataGaps: [],
};

describe('threat detection PDF: EDR fields (#8164)', () => {
  it('renders nothing EDR-related when the EDR fields are absent', () => {
    const text = pdfText(buildReportPdf([], { ...opts, summary: BASE }));
    expect(text).not.toContain('Managed endpoint protection');
  });

  it('a null EDR field renders identically to an absent one', () => {
    const absent = pdfText(buildReportPdf([], { ...opts, summary: BASE }));
    const nulled = pdfText(buildReportPdf([], {
      ...opts,
      summary: {
        ...BASE,
        agentCoverage: { ...BASE.agentCoverage!, edrEndpoints: null },
        edrDetections: null,
      },
    }));
    expect(nulled).toBe(absent);
  });

  it('prints the EDR endpoint count and open detections by severity when present', () => {
    const text = pdfText(buildReportPdf([], {
      ...opts,
      summary: {
        ...BASE,
        agentCoverage: { ...BASE.agentCoverage!, edrEndpoints: 7 },
        edrDetections: { open: 3, bySeverity: { critical: 1, high: 2 } },
      },
    }));
    expect(text).toContain('Managed endpoint protection: 7 endpoints');
    expect(text).toContain('open now: 3');
    expect(text).toContain('critical: 1');
    expect(text).toContain('high: 2');
  });

  it('prints a measured zero for open detections when the org has EDR endpoints', () => {
    const text = pdfText(buildReportPdf([], {
      ...opts,
      summary: {
        ...BASE,
        agentCoverage: { ...BASE.agentCoverage!, edrEndpoints: 2 },
        edrDetections: { open: 0, bySeverity: {} },
      },
    }));
    expect(text).toContain('open now: 0');
  });
});
