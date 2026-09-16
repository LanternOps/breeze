import { describe, expect, it, vi } from 'vitest';
import { buildReportPdf } from './reportPdf';
import * as threat from './threatDetectionPdf';
import type { ThreatDetectionSummary } from '../types/threatDetectionReport';

const opts = { reportType: 'threat_detection_review', generatedAt: 'Sep 30, 2026', timezone: 'UTC' };

// See reportPdf.test.ts for why WinAnsi bytes are mapped back before matching.
const CP1252_HIGH =
  '€‚ƒ„…†‡' +
  'ˆ‰Š‹ŒŽ' +
  '‘’“”•–—' +
  '˜™š›œžŸ';
const decodeWinAnsi = (s: string): string =>
  s.replace(/[\x80-\x9f]/g, (ch) => CP1252_HIGH[ch.charCodeAt(0) - 0x80] ?? ch);

function pdfText(doc: ReturnType<typeof buildReportPdf>): string {
  return ((doc.internal as unknown as { pages: Array<string[] | undefined> }).pages ?? [])
    .filter((p): p is string[] => Array.isArray(p))
    .map((p) => decodeWinAnsi(p.join('\n')))
    .join('\n');
}

const SUMMARY: ThreatDetectionSummary = {
  orgId: 'o1',
  orgName: 'Liggett & Goodman P.C.',
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
  agentCoverage: {
    huntressAgents: 41, breezeDevices: 43, agentsOffline: 2, devicesWithoutAgent: 2,
  },
  incidents: {
    opened: 3, resolved: 2,
    bySeverity: { critical: 1, low: 2 },
    byStatus: { open: 1, resolved: 2 },
    meanResolveHours: 4.5, medianResolveHours: 3,
    carriedIn: 1,
  },
  rows: [
    {
      id: 'i1', reportedAt: '2026-09-10T00:00:00.000Z', hostname: 'SAM4',
      severity: 'critical', category: 'malware', title: 'Suspicious process',
      status: 'resolved', resolvedAt: '2026-09-10T04:30:00.000Z',
      recommendation: 'Isolate the host and reimage.',
    },
  ],
  dataGaps: [],
};

describe('buildReportPdf: threat_detection_review', () => {
  it('routes to the threat detection renderer, not renderGenericReport', () => {
    const spy = vi.spyOn(threat, 'renderThreatDetectionReport');
    buildReportPdf([], { ...opts, summary: SUMMARY });
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('labels the report and names the org', () => {
    const text = pdfText(buildReportPdf([], { ...opts, summary: SUMMARY }));
    expect(text).toContain('Threat Detection Review');
    expect(text).toContain('Liggett & Goodman P.C.');
  });

  it('prints the coverage window on the cover, verbatim from summary.coverage.note', () => {
    const note = 'Covers 2026-09-14 to 2026-09-30; the period began before Huntress was connected.';
    const text = pdfText(buildReportPdf([], {
      ...opts,
      summary: { ...SUMMARY, coverage: { ...SUMMARY.coverage, note } },
    }));
    expect(text).toContain('began before Huntress was connected');
  });

  it('renders an unmeasured section as N/A, never as zero', () => {
    const text = pdfText(buildReportPdf([], {
      ...opts,
      summary: {
        ...SUMMARY,
        coverage: { ...SUMMARY.coverage, sourceStatus: 'not_connected', note: 'Huntress is not connected for this partner.' },
        rows: [],
        incidents: {
          opened: null, resolved: null, bySeverity: null, byStatus: null,
          meanResolveHours: null, medianResolveHours: null, carriedIn: null,
        },
      },
    }));
    expect(text).toMatch(/N\/A/);
    expect(text).not.toMatch(/\b0 incidents\b/i);
    expect(text).toContain('not connected');
  });

  it('states the artifact is generated evidence, not an assertion that a human reviewed it', () => {
    const text = pdfText(buildReportPdf([], { ...opts, summary: SUMMARY }));
    expect(text.toLowerCase()).toContain('generated');
  });

  it('never prints a raw details payload that a legacy snapshot smuggled in', () => {
    const text = pdfText(buildReportPdf([], {
      ...opts,
      summary: {
        ...SUMMARY,
        rows: [{ ...SUMMARY.rows![0]!, details: { secret: 'do-not-render' } } as never],
      },
    }));
    expect(text).not.toContain('do-not-render');
  });

  // `typeof null === 'object'`, so an explicit `coverage: null` would sail past
  // a bare typeof guard and land in the renderer, where the missing note prints
  // the reassuring "covers the whole of this period" default — worse than the
  // generic renderer, which at least claims no coverage it cannot vouch for.
  it('does NOT enter the arm when coverage is explicitly null', () => {
    const spy = vi.spyOn(threat, 'renderThreatDetectionReport');
    const doc = buildReportPdf([{ a: 1 }], {
      ...opts,
      summary: { ...SUMMARY, coverage: null } as never,
    });
    expect(spy).not.toHaveBeenCalled();
    expect(pdfText(doc)).not.toContain('covers the whole of this period');
    spy.mockRestore();
  });

  it('says a switched-off carried-in section is a setting, not a finding', () => {
    const text = pdfText(buildReportPdf([], {
      ...opts,
      summary: {
        ...SUMMARY,
        coverage: { ...SUMMARY.coverage, carriedInIncluded: false },
        incidents: { ...SUMMARY.incidents!, carriedIn: null },
      },
    }));
    expect(text).toContain('setting, not a finding');
  });

  it('says an unmeasurable carried-in section could not be measured', () => {
    const text = pdfText(buildReportPdf([], {
      ...opts,
      summary: {
        ...SUMMARY,
        coverage: { ...SUMMARY.coverage, carriedInIncluded: true },
        incidents: { ...SUMMARY.incidents!, carriedIn: null },
      },
    }));
    expect(text).toContain('could not be measured');
    expect(text).not.toContain('setting, not a finding');
  });

  it('falls through to the generic renderer when the summary is absent', () => {
    const spy = vi.spyOn(threat, 'renderThreatDetectionReport');
    buildReportPdf([{ a: 1 }], { ...opts });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
