import { describe, expect, it } from 'vitest';
import { buildReportPdf } from './reportPdf';
import type { HardwareLifecycleDeviceRow, HardwareLifecycleSummary } from '../types/hardwareLifecycleReport';

const opts = { reportType: 'hardware_lifecycle', generatedAt: 'Jun 10, 2026', timezone: 'UTC' };

// See reportPdf.test.ts for why WinAnsi bytes are mapped back before matching.
const CP1252_HIGH =
  '€‚ƒ„…†‡' +
  'ˆ‰Š‹ŒŽ' +
  '‘’“”•–—' +
  '˜™š›œžŸ';
const decodeWinAnsi = (s: string): string =>
  s.replace(/[-]/g, (ch) => CP1252_HIGH[ch.charCodeAt(0) - 0x80] ?? ch);

function pdfText(doc: ReturnType<typeof buildReportPdf>): string {
  return ((doc.internal as unknown as { pages: Array<string[] | undefined> }).pages ?? [])
    .filter((p): p is string[] => Array.isArray(p))
    .map((p) => decodeWinAnsi(p.join('\n')))
    .join('\n');
}

function row(partial: Partial<HardwareLifecycleDeviceRow> & { name: string }): HardwareLifecycleDeviceRow {
  return {
    id: partial.name, kind: 'device', os: 'Windows 11 Pro', osSupport: 'supported',
    purchaseDate: null, purchaseDateSource: null, warrantyEndDate: null, ageYears: null,
    replaceBy: null, replacement: 'unknown', warrantyExtended: false, lifeUsed: null,
    ...partial,
  };
}

const summary: HardwareLifecycleSummary = {
  org: { id: 'o1', name: 'Liggett & Goodman P.C.' },
  generatedAt: '2026-06-10T12:00:00.000Z',
  replaceAgeYears: 4,
  computers: { total: 3, byReplacement: { replace: 1, due_soon: 1, unknown: 1 }, byOsSupport: { supported: 1, ending: 1, ended: 1 } },
  otherEquipmentCount: 2,
  rows: [
    row({ name: 'SAM4', user: 'CORP\\sam.lee', manufacturer: 'Dell Inc.', model: 'OptiPlex 3050', serialNumber: '255P3W2', os: 'Windows 10 Pro', osSupport: 'ended', purchaseDate: '2019-04-01', purchaseDateSource: 'manual', warrantyEndDate: '2022-04-01', ageYears: 7.1, replaceBy: '2023-04-01', replacement: 'replace', lifeUsed: 1 }),
    row({ name: 'LAW-SRV', deviceKind: 'server', manufacturer: 'Dell Inc.', model: 'PowerEdge T340', os: 'Windows Server 2019', osSupport: 'ending', purchaseDate: '2021-10-01', purchaseDateSource: 'vendor', warrantyEndDate: '2026-11-30', ageYears: 4.7, replaceBy: '2026-11-30', replacement: 'due_soon', warrantyExtended: true, lifeUsed: 0.9 }),
    row({ name: 'MacBook-Air.local', manufacturer: 'Apple Inc.', os: 'macOS 26.3.1' }),
  ],
  other: [
    { id: 'p1', kind: 'manual_asset', name: 'Copier', manufacturer: 'Ricoh', model: 'IM C6010', category: 'printer' },
    { id: 'f1', kind: 'device', name: 'fw', manufacturer: 'SonicWALL', model: 'TZ300', category: 'firewall' },
  ],
  recommendations: [
    'Plan replacements for SAM4 this quarter, starting with SAM4 (7 years old).',
    'LAW-SRV is covered by warranty until November 2026; budget to replace it when coverage ends.',
  ],
};

describe('hardware lifecycle PDF', () => {
  it('renders the cover, plan table, other equipment and recommendations (legacy snapshot: no serverReplaceAgeYears falls back to the server default, not replaceAgeYears)', () => {
    const doc = buildReportPdf([], { ...opts, summary, branding: { name: 'OliveTech', logoDataUrl: null, logoAspect: null, contactEmail: 'pat@olive.example', contactName: 'Pat' } });
    const text = pdfText(doc);
    expect(text).toContain('Hardware Lifecycle Report');
    expect(text).toContain('Liggett & Goodman P.C.');
    expect(text).toContain('The oldest computer due for replacement is 7 years old, and 1 no longer receives security updates.');
    expect(text).toContain('We are confirming purchase dates for 1 computer.');
    // The other-device count lives in the byline and its own section, not the glance paragraph.
    expect(text).not.toContain('We also manage');
    expect(text).toContain('2 other devices');
    // jsPDF escapes parentheses inside text operators.
    expect(text).not.toContain('not yet classified');
    expect(text).toContain('To approve or discuss this plan, contact Pat \\(pat@olive.example\\).');
    expect(text).toContain('Replace now');
    expect(text).toContain('Due soon');
    expect(text).toContain('Purchase date unknown');
    expect(text).toContain('Q4 2026');
    // Status is the word alone; timing lives in the service-life column.
    expect(text).not.toContain('was due');
    expect(text).toMatch(/\d(\.\d)? yr over/);
    expect(text).toContain('Apr 2019');
    expect(text).toContain('Oct 2021 *');
    expect(text).toContain("* Purchase date taken from the manufacturer's ship record.");
    // Identity leads with the person; the hostname rides underneath.
    expect(text).toContain('Sam Lee');
    expect(text).toContain('Dell Inc. OptiPlex 3050');
    expect(text).toContain('SAM4');
    expect(text).toContain('MacBook-Air');
    // OS risk is a word, not only a colour; editions are stripped for the reader.
    expect(text).toContain('No security updates');
    expect(text).toContain('Support ending');
    expect(text).toContain('Windows 10');
    expect(text).not.toContain('Windows 10 Pro');
    expect(text).toMatch(/\d(\.\d)? yr over/);
    expect(text).toContain('We plan to replace a computer 4 years after purchase');
    // Budget scaffold: due now, then by quarter; servers in their own section.
    expect(text).toContain('Replacement schedule');
    expect(text).toContain('Workstations and laptops');
    expect(text).toContain('Servers');
    // summary fixture sets replaceAgeYears: 4 but omits serverReplaceAgeYears
    // entirely (a legacy snapshot predating that field) — the server line
    // must fall back to the documented default (5), never mirror the
    // workstation's 4.
    expect(text).toContain('We plan to replace a server 5 years after purchase');
    expect(text).not.toContain('—');
    expect(text).toContain('Expired Apr 2022');
    expect(text).toContain('Ricoh IM C6010 and SonicWALL TZ300');
    expect(text).toContain('What we recommend');
    expect(text).toContain('budget to replace it when coverage ends');
    expect(text).toContain('Figures come from live device records');
    expect(text).toContain('HARDWARE LIFECYCLE');
  });

  it('uses an explicit serverReplaceAgeYears for the server footer, distinct from the workstation age', () => {
    const doc = buildReportPdf([], { ...opts, summary: { ...summary, serverReplaceAgeYears: 6 } });
    const text = pdfText(doc);
    expect(text).toContain('We plan to replace a computer 4 years after purchase');
    expect(text).toContain('We plan to replace a server 6 years after purchase');
    expect(text).not.toContain('We plan to replace a server 4 years after purchase');
  });

  it('footnotes a row whose warranty lookup failed, distinct from a confirmed "no warranty" row (#5764)', () => {
    const failedLookupRow = row({
      name: 'FAILED-SYNC-PC',
      purchaseDate: '2019-01-01',
      purchaseDateSource: 'manual',
      warrantyEndDate: null,
      warrantyLookupFailed: true,
      ageYears: 7,
      replaceBy: '2023-01-01',
      replacement: 'replace',
    });
    const doc = buildReportPdf([], { ...opts, summary: { ...summary, rows: [failedLookupRow] } });
    const text = pdfText(doc);
    expect(text).toContain('Unable to verify †');
    expect(text).toContain('† Warranty status could not be verified during the last sync attempt.');
  });

  it('does not footnote warranty when no row has a failed lookup', () => {
    const doc = buildReportPdf([], { ...opts, summary });
    const text = pdfText(doc);
    expect(text).not.toContain('could not be verified');
  });

  it('renders an empty snapshot without throwing', () => {
    const doc = buildReportPdf([], { ...opts, summary: { rows: [], other: [], recommendations: ['Nothing needs your attention right now.'] } });
    const text = pdfText(doc);
    expect(text).toContain('No computers to plan for in this scope.');
    expect(text).toContain('Nothing needs your attention right now.');
  });

  it('paginates a large fleet and keeps the chrome on every page', () => {
    const rows = Array.from({ length: 60 }, (_, i) => row({ name: `PC-${i}`, purchaseDate: '2021-01-01', purchaseDateSource: 'manual', ageYears: 5.4, replaceBy: '2025-01-01', replacement: 'replace', lifeUsed: 1 }));
    const doc = buildReportPdf([], { ...opts, summary: { ...summary, rows } });
    expect(doc.getNumberOfPages()).toBeGreaterThan(1);
    const text = pdfText(doc);
    expect(text.match(/HARDWARE LIFECYCLE/g)?.length).toBe(doc.getNumberOfPages());
    // Every continuation page restates the plan heading and the legend.
    const continued = text.match(/Device replacement plan \\\(continued\\\)/g)?.length ?? 0;
    expect(continued).toBeGreaterThanOrEqual(doc.getNumberOfPages() - 2);
    expect(continued).toBeLessThanOrEqual(doc.getNumberOfPages() - 1);
    // A legend where the table starts and on every continuation page (the
    // callout draws its number and label as separate text objects; the table
    // may start on page 2 when the cover is full).
    const legends = text.match(/60 Replace now/g)?.length ?? 0;
    expect(legends).toBeGreaterThanOrEqual(doc.getNumberOfPages() - 1);
    expect(legends).toBeLessThanOrEqual(doc.getNumberOfPages());
    // The closing data note never gets a page of its own.
    expect(text.match(/HARDWARE LIFECYCLE/g)?.length).toBe(doc.getNumberOfPages());
  });

  it('falls back to the generic table when the snapshot has no rows array', () => {
    const doc = buildReportPdf([{ hostname: 'x' }], { ...opts, summary: { org: { name: 'Acme' } } as HardwareLifecycleSummary });
    expect(pdfText(doc)).not.toContain('Device replacement plan');
  });
});
