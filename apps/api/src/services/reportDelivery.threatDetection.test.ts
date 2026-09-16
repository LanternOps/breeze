/**
 * The SCHEDULED-EMAIL render path for the Threat Detection Review (#5784 W02).
 *
 * Third of the three paths that must reach `buildReportPdf`'s threat detection
 * arm from the same stored result (the portal/server `renderRunPdf` path is
 * proven in `__tests__/integration/threatDetectionEvidence.integration.test.ts`,
 * the staff/browser `exportReport` path in apps/web's
 * `reportExport.threatDetection.test.tsx`).
 *
 * This path is the easiest of the three to lose silently: `emailReportRun`
 * casts `summary` to `PostureSummary | ExecutiveSummary | undefined` on its way
 * into `buildReportPdf`, so nothing here is type-checked against the threat
 * detection shape, and an arm that stopped matching would degrade the
 * attachment to `renderGenericReport` — a plausible PDF with the whole designed
 * body missing — while every other test stayed green.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type SentEmail = { attachments?: Array<{ filename: string; content: Buffer }> };
const sendEmail = vi.fn(async (_payload: SentEmail) => undefined);
vi.mock('./email', () => ({
  getEmailService: () => ({ sendEmail: (payload: SentEmail) => sendEmail(payload) }),
}));

import { emailReportRun } from './reportDelivery';
import type { ThreatDetectionSummary } from '@breeze/shared';
import type { ReportBranding } from '@breeze/shared/reportPdf';

const branding: ReportBranding = { name: 'Breeze', logoDataUrl: null, logoAspect: null };

const COVERAGE_NOTE =
  'The data held starts at 2026-09-14 and so does not cover 2026-09-01 to 2026-09-14.';

const summary: ThreatDetectionSummary = {
  orgId: 'o1',
  orgName: 'Acme Co',
  generatedAt: '2026-09-30T05:18:00.000Z',
  coverage: {
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    coveredFrom: '2026-09-14T00:00:00.000Z',
    coveredTo: '2026-09-30T05:00:00.000Z',
    generatedAt: '2026-09-30T05:18:00.000Z',
    sourceStatus: 'ok',
    lastSyncAt: '2026-09-30T05:00:00.000Z',
    lastSyncStatus: 'ok',
    unattributableExcluded: 0,
    withheld: 0,
    note: COVERAGE_NOTE,
  },
  agentCoverage: {
    huntressAgents: 41, breezeDevices: 43, agentsOffline: 2, devicesWithoutAgent: 2,
  },
  incidents: {
    opened: 3, resolved: 2,
    bySeverity: { critical: 1, low: 2 },
    byStatus: { open: 1, resolved: 2 },
    meanResolveHours: 4.5, medianResolveHours: 3, carriedIn: 1,
  },
  rows: [{
    id: 'i1', reportedAt: '2026-09-20T00:00:00.000Z', hostname: 'SAM4',
    severity: 'critical', category: 'malware', title: 'Suspicious process',
    status: 'resolved', resolvedAt: '2026-09-20T04:30:00.000Z',
    recommendation: 'Isolate the host and reimage.',
  }],
  dataGaps: [COVERAGE_NOTE],
};

async function deliver(over: Partial<Parameters<typeof emailReportRun>[0]> = {}) {
  await emailReportRun({
    reportName: 'Service evidence — Threat detection review',
    reportType: 'threat_detection_review',
    format: 'pdf',
    recipients: ['owner@example.com'],
    rows: [],
    summary: summary as unknown as Record<string, unknown>,
    timezone: 'UTC',
    branding,
    ...over,
  });
  return sendEmail.mock.calls[0]?.[0];
}

beforeEach(() => sendEmail.mockClear());

describe('emailReportRun: threat_detection_review attachment', () => {
  it('attaches a PDF rendered by the threat detection arm, not the generic table', async () => {
    const sent = await deliver();
    const pdf = sent?.attachments?.[0];
    expect(pdf?.filename).toMatch(/threat_detection_review/);
    expect(pdf?.content.byteLength).toBeGreaterThan(0);

    const text = pdf!.content.toString('latin1');
    // Sections only the designed renderer draws.
    expect(text).toContain('Threat Detection Review');
    expect(text).toContain('What this covers');
    expect(text).toContain('Endpoint coverage');
  });

  it('carries the coverage disclosure into the emailed artifact', async () => {
    const sent = await deliver();
    const text = sent!.attachments![0]!.content.toString('latin1');
    expect(text).toContain('does not cover');
  });

  it('renders an unmeasured month as N/A rather than zero', async () => {
    const unmeasured: ThreatDetectionSummary = {
      ...summary,
      coverage: { ...summary.coverage, sourceStatus: 'not_connected', note: 'Huntress is not connected for this partner.' },
      agentCoverage: { huntressAgents: null, breezeDevices: 43, agentsOffline: null, devicesWithoutAgent: null },
      incidents: {
        opened: null, resolved: null, bySeverity: null, byStatus: null,
        meanResolveHours: null, medianResolveHours: null, carriedIn: null,
      },
      rows: [],
      dataGaps: ['Huntress is not connected for this partner.'],
    };
    const sent = await deliver({ summary: unmeasured as unknown as Record<string, unknown> });
    const text = sent!.attachments![0]!.content.toString('latin1');
    expect(text).toContain('not connected');
    expect(text).not.toMatch(/\b0 incidents\b/i);
  });
});
