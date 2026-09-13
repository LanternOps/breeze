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
    row({ name: 'LAW-SRV', manufacturer: 'Dell Inc.', model: 'PowerEdge T340', os: 'Windows Server 2019', osSupport: 'ending', purchaseDate: '2021-10-01', purchaseDateSource: 'vendor', warrantyEndDate: '2026-11-30', ageYears: 4.7, replaceBy: '2026-11-30', replacement: 'due_soon', warrantyExtended: true, lifeUsed: 0.9 }),
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
  it('renders the cover, plan table, other equipment and recommendations', () => {
    const doc = buildReportPdf([], { ...opts, summary, branding: { name: 'OliveTech', logoDataUrl: null, logoAspect: null } });
    const text = pdfText(doc);
    expect(text).toContain('Hardware Lifecycle Report');
    expect(text).toContain('Liggett & Goodman P.C.');
    expect(text).toContain('1 of your 3 computers is past due for replacement; the oldest is 7 years old and 1 no longer receives security updates.');
    expect(text).toContain('1 more computer comes due within the year.');
    expect(text).toContain('missing purchase records');
    expect(text).toContain('We also manage');
    // jsPDF escapes parentheses inside text operators.
    expect(text).toContain("Operating systems: 1 current; 1 ending support soon \\(LAW-SRV\\); 1 no longer receiving security updates \\(sam.lee's OptiPlex 3050\\).");
    expect(text).toContain('Replace now');
    expect(text).toContain('Due soon');
    expect(text).toContain('Unknown age');
    expect(text).toContain('Q4 2026');
    // Overdue rows show the date they came due; "Replace now" already says overdue.
    expect(text).toContain('Apr 2023');
    expect(text).toContain('Apr 2019');
    expect(text).toContain('Oct 2021 *');
    expect(text).toContain("* Purchase date taken from the manufacturer's ship record.");
    // Identity leads with the person; the hostname rides underneath.
    expect(text).toContain('sam.lee — OptiPlex 3050');
    expect(text).toContain('SAM4');
    expect(text).toContain('MacBook-Air');
    // OS risk is a word, not only a colour; editions are stripped for the reader.
    expect(text).toContain('No security updates');
    expect(text).toContain('Support ending');
    expect(text).toContain('Windows 10');
    expect(text).not.toContain('Windows 10 Pro');
    expect(text).toContain('No purchase date');
    expect(text).toContain('past due');
    expect(text).toContain('We plan to replace a computer 4 years after purchase');
    expect(text).toContain('Ricoh IM C6010 and SonicWALL TZ300');
    expect(text).toContain('What we recommend');
    expect(text).toContain('budget to replace it when coverage ends');
    expect(text).toContain('Figures come from live device records');
    expect(text).toContain('HARDWARE LIFECYCLE');
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
    expect(text.match(/Device replacement plan \\\(continued\\\)/g)?.length).toBe(doc.getNumberOfPages() - 1);
    expect(text.match(/60 Replace now/g)?.length).toBe(doc.getNumberOfPages());
  });

  it('falls back to the generic table when the snapshot has no rows array', () => {
    const doc = buildReportPdf([{ hostname: 'x' }], { ...opts, summary: { org: { name: 'Acme' } } as HardwareLifecycleSummary });
    expect(pdfText(doc)).not.toContain('Device replacement plan');
  });
});
