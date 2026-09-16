import { describe, expect, it } from 'vitest';
import { buildReportPdf } from './reportPdf';
import type { EndpointManagementSummary } from '../types/endpointManagementReport';
import {
  ENDPOINT_MANAGEMENT_NO_SITES_GAP, emptyEndpointManagementSummary,
} from '../utils/endpointManagement';

const opts = { reportType: 'endpoint_management_review', generatedAt: 'Sep 30, 2026', timezone: 'UTC' };

// See reportPdf.test.ts for why WinAnsi bytes are mapped back before matching.
const CP1252_HIGH =
  '€‚ƒ„…†‡' +
  'ˆ‰Š‹ŒŽ' +
  '‘’“”•–—' +
  '˜™š›œžŸ';
const decodeWinAnsi = (s: string): string =>
  s.replace(/[-]/g, (ch) => CP1252_HIGH[ch.charCodeAt(0) - 0x80] ?? ch);

function pdfText(doc: ReturnType<typeof buildReportPdf>): string {
  return ((doc.internal as unknown as { pages: Array<string[] | undefined> }).pages ?? [])
    .filter((p): p is string[] => Array.isArray(p))
    .map((p) => decodeWinAnsi(p.join('\n')))
    .join('\n');
}

const SUMMARY: EndpointManagementSummary = {
  orgId: 'o1',
  orgName: 'Liggett & Goodman P.C.',
  generatedAt: '2026-09-30T06:00:00.000Z',
  period: { start: '2026-09-01', end: '2026-09-30' },
  freshness: {
    intune_devices: { asOf: '2026-09-30T04:00:00.000Z', lastStatus: 'success', truncated: false, stale: false, note: '' },
    skus: { asOf: '2026-09-30T04:00:00.000Z', lastStatus: 'success', truncated: false, stale: false, note: '' },
  },
  enrolment: { intuneDevices: 42, breezeDevices: 45, breezeWithoutIntune: 4, intuneWithoutBreezeLink: 1 },
  compliance: {
    byState: { compliant: 38, noncompliant: 2, inGracePeriod: 1, unknown: 1 },
    trend: [
      { date: '2026-09-01', compliant: 34, noncompliant: 5, inGrace: 2, unknown: 1 },
      { date: '2026-09-30', compliant: 38, noncompliant: 2, inGrace: 1, unknown: 1 },
    ],
  },
  staleEnrolments: { count: 3, thresholdDays: 14 },
  licences: [
    { skuPartNumber: 'SPE_E3', consumedUnits: 40, prepaidEnabled: 45, prepaidWarning: 0, prepaidSuspended: 0, capabilityStatus: 'Enabled' },
  ],
  rows: [
    {
      id: 'a', deviceName: 'LT-001', operatingSystem: 'Windows', osVersion: '10.0.22631',
      userPrincipalName: 'sam@acme.test', ownerType: 'company',
      lastIntuneSyncAt: '2026-09-30T03:00:00.000Z', complianceState: 'noncompliant',
      jailBroken: 'Unknown', breezeDeviceId: 'd1',
    },
  ],
  dataGaps: [],
  historyCaveat: 'Shows current inventory and daily trend; device-level change history is not available.',
};

describe('endpoint management PDF', () => {
  // buildReportPdf's final `else` falls through to renderGenericReport, which
  // prints the rows as a plain table and DROPS the whole designed summary. A
  // type with no arm therefore produces a plausible-looking, wrong PDF on the
  // portal (server-side renderRunPdf) and the scheduled-email path. These
  // assertions are the only thing that catches it.
  it('routes to the endpoint management renderer, not renderGenericReport', () => {
    const text = pdfText(buildReportPdf([], { ...opts, summary: SUMMARY }));
    // Section headings only the dedicated renderer emits:
    expect(text).toContain('Enrolment coverage');
    expect(text).toContain('Compliance');
    expect(text).toContain('Licence seats');
    // And the designed summary's own numbers, which the generic table cannot
    // reach because it only ever renders `records`.
    expect(text).toContain('42');
    expect(text).toContain('SPE_E3');
  });

  it('labels the report type without losing its wording', () => {
    const text = pdfText(buildReportPdf([], { ...opts, summary: SUMMARY }));
    expect(text).toContain('Endpoint Management Review');
    expect(text).toContain('Liggett & Goodman P.C.');
  });

  it('prints the freshness note and the history caveat', () => {
    const doc = buildReportPdf([], {
      ...opts,
      summary: {
        ...SUMMARY,
        freshness: { intune_devices: { note: 'Intune inventory is 29 days old.' } },
        historyCaveat: 'Shows current inventory and daily trend; device-level change history is not available.',
      },
    });
    const text = pdfText(doc);
    expect(text).toMatch(/29 days old/);
    expect(text).toMatch(/change history is not available/);
  });

  it('renders an unmeasured section as N/A, never as zero', () => {
    const doc = buildReportPdf([], {
      ...opts,
      summary: {
        ...SUMMARY,
        enrolment: { intuneDevices: null, breezeDevices: null, breezeWithoutIntune: null, intuneWithoutBreezeLink: null },
        compliance: { byState: null },
        rows: [],
        dataGaps: ['intune_devices: consent has not been granted.'],
      },
    });
    const text = pdfText(doc);
    expect(text).toMatch(/N\/A/);
    // The real regression guard: an unmeasured population must not render as a
    // zero tile. A bare "0" appears elsewhere legitimately, so assert the tile
    // label is present AND that the section says in words it was not measured.
    expect(text).toMatch(/Devices enrolled in Intune/);
    expect(text).toMatch(/not measured for this period/);
    expect(text).toMatch(/consent has not been granted/);
  });

  // The shape `zeroSafeReport` hands back for a restricted authority with no
  // permitted sites. It MUST still enter this arm: with no summary at all the
  // artifact degrades to renderGenericReport's single line, "No data available
  // for the selected filters", which reads as "nothing to report / all clear"
  // to a technician whose real situation is "your access scope has no sites".
  it('renders the designed page for the restricted-empty zero-safe summary', () => {
    const doc = buildReportPdf([], {
      ...opts,
      summary: emptyEndpointManagementSummary({
        orgId: 'o1',
        generatedAt: '2026-09-30T06:00:00.000Z',
        thresholdDays: 14,
        dataGap: ENDPOINT_MANAGEMENT_NO_SITES_GAP,
      }),
    });
    const text = pdfText(doc);
    expect(text).toMatch(/Enrolment coverage/);
    expect(text).toMatch(/N\/A/);
    expect(text).toMatch(/No sites are in scope/);
    expect(text).toMatch(/About this report/);
    expect(text).not.toMatch(/No data available for the selected filters/);
  });

  it('says a measured, empty licence list was measured — not that it was skipped', () => {
    const doc = buildReportPdf([], { ...opts, summary: { ...SUMMARY, licences: [] } });
    const text = pdfText(doc);
    expect(text).toMatch(/This was measured, not skipped/);
    expect(text).not.toMatch(/Licence seats were not measured/);
  });

  it('says an UNMEASURED licence domain was not measured', () => {
    const doc = buildReportPdf([], { ...opts, summary: { ...SUMMARY, licences: null } });
    expect(pdfText(doc)).toMatch(/Licence seats were not measured/);
  });

  it('falls through to the generic renderer when the summary is absent', () => {
    const text = pdfText(buildReportPdf([{ alpha: 1 }], { ...opts }));
    expect(text).not.toContain('Enrolment coverage');
    expect(text).toContain('Alpha');
  });
});
