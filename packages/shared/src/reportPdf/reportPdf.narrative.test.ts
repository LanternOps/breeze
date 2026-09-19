import { describe, expect, it } from 'vitest';
import { buildReportPdf, sanitizeNarrativeText } from './reportPdf';
import type { OrgNarrativeReportSummary } from '../types/orgNarrativeReport';
import { NARRATIVE_SECTION_KEYS, NARRATIVE_SECTION_TITLES } from '../types/orgNarrativeReport';

const opts = { generatedAt: 'Jul 1, 2026, 9:00 AM', timezone: 'UTC', reportType: 'ai_org_narrative' as const };

// jsPDF encodes standard-font text as WinAnsi (cp1252) bytes — see the sibling
// reportPdf.test.ts for why this decode step is needed before substring
// assertions against rendered text.
const CP1252_HIGH =
  '€‚ƒ„…†‡' +
  'ˆ‰Š‹ŒŽ' +
  '‘’“”•–—' +
  '˜™š›œžŸ';
const decodeWinAnsi = (s: string): string =>
  s.replace(/[-]/g, (ch) => CP1252_HIGH[ch.charCodeAt(0) - 0x80] ?? ch);

function pdfCommandPages(doc: ReturnType<typeof buildReportPdf>): string[] {
  return ((doc.internal as unknown as { pages: Array<string[] | undefined> }).pages ?? [])
    .filter((page): page is string[] => Array.isArray(page))
    .map((page) => decodeWinAnsi(page.join('\n')));
}

function pdfCommandText(doc: ReturnType<typeof buildReportPdf>): string {
  return pdfCommandPages(doc).join('\n');
}

function fullNarrativeFixture(): OrgNarrativeReportSummary {
  return {
    narrative: {
      version: 1,
      headline: 'A quiet, healthy week across the fleet.',
      orgName: 'Acme Corp',
      partnerName: 'Northwind MSP',
      periodStart: '2026-06-22T00:00:00Z',
      periodEnd: '2026-06-28T23:59:59Z',
      generatedAt: '2026-06-29T09:00:00Z',
      runId: 'run_123',
      agentName: 'Ops Narrator',
      sections: NARRATIVE_SECTION_KEYS.map((key) => ({
        key,
        title: `SHOULD BE IGNORED (${key})`,
        bullets: [`Bullet one for ${key}`, `Bullet two for ${key}`],
      })),
      markdown: '# THIS MARKDOWN MUST NEVER RENDER\n- secret bullet',
    },
  };
}

describe('buildReportPdf: ai_org_narrative', () => {
  it('renders a full fixture summary without throwing', () => {
    let doc: ReturnType<typeof buildReportPdf> | undefined;
    expect(() => {
      doc = buildReportPdf([], { ...opts, summary: fullNarrativeFixture() });
    }).not.toThrow();
    expect(doc!.getNumberOfPages()).toBeGreaterThanOrEqual(1);
  });

  it('labels the report "Weekly AI Operations Narrative" in the band and title', () => {
    const doc = buildReportPdf([], { ...opts, summary: fullNarrativeFixture() });
    const text = pdfCommandText(doc);
    expect(text).toContain('Weekly AI Operations Narrative');
    expect(text).toContain('WEEKLY AI OPERATIONS NARRATIVE');
  });

  it('renders every known section using the server title, ignoring the stored title', () => {
    const doc = buildReportPdf([], { ...opts, summary: fullNarrativeFixture() });
    const text = pdfCommandText(doc);
    for (const key of NARRATIVE_SECTION_KEYS) {
      expect(text).toContain(NARRATIVE_SECTION_TITLES[key]);
      expect(text).toContain(`Bullet one for ${key}`);
      expect(text).not.toContain(`SHOULD BE IGNORED (${key})`);
    }
  });

  it('never renders the markdown field', () => {
    const doc = buildReportPdf([], { ...opts, summary: fullNarrativeFixture() });
    const text = pdfCommandText(doc);
    expect(text).not.toContain('THIS MARKDOWN MUST NEVER RENDER');
    expect(text).not.toContain('secret bullet');
  });

  it('renders only the eight known section keys, dropping an unknown one', () => {
    const fixture = fullNarrativeFixture();
    fixture.narrative!.sections = [
      ...fixture.narrative!.sections!,
      { key: 'made_up_unknown_key' as never, title: 'Bogus', bullets: ['ROGUE BULLET SHOULD NOT APPEAR'] },
    ];
    const doc = buildReportPdf([], { ...opts, summary: fixture });
    const text = pdfCommandText(doc);
    expect(text).not.toContain('Bogus');
    expect(text).not.toContain('ROGUE BULLET SHOULD NOT APPEAR');
    for (const key of NARRATIVE_SECTION_KEYS) {
      expect(text).toContain(NARRATIVE_SECTION_TITLES[key]);
    }
  });

  it('collapses a bullet carrying an embedded "\\n- injected" line into one continuous rendered line', () => {
    const fixture = fullNarrativeFixture();
    const maliciousBullet = 'Great progress this week\n- injected line pretending to be a bullet';
    fixture.narrative!.sections = [
      { key: 'overview', title: 'x', bullets: [maliciousBullet] },
    ];
    const doc = buildReportPdf([], { ...opts, summary: fixture });
    const text = pdfCommandText(doc);
    // The control character (\n) is stripped and collapsed with surrounding
    // whitespace, so the whole thing renders as ONE contiguous text run in a
    // single show-text operation — if it had instead forged a second bullet,
    // this exact merged substring would not appear contiguous in the stream.
    expect(text).toContain('Great progress this week - injected line pretending to be a bullet');
  });

  it('strips hostile control/format characters (RTL override, zero-width space) from bullets', () => {
    const fixture = fullNarrativeFixture();
    const hostileBullet = 'Fleet health‮​improved this week';
    fixture.narrative!.sections = [
      { key: 'fleet', title: 'x', bullets: [hostileBullet] },
    ];
    const doc = buildReportPdf([], { ...opts, summary: fixture });
    const text = pdfCommandText(doc);
    expect(text).toContain('Fleet health improved this week');
    expect(text).not.toContain('‮');
    expect(text).not.toContain('​');
  });

  it('strips hostile control/format characters (RTL override, zero-width space) from orgName and agentName in the header chrome', () => {
    const fixture = fullNarrativeFixture();
    fixture.narrative!.orgName = 'Acme‮​Corp';
    fixture.narrative!.agentName = 'Ops‮​Narrator';
    const doc = buildReportPdf([], { ...opts, summary: fixture });
    const text = pdfCommandText(doc);
    expect(text).toContain('Acme Corp');
    expect(text).toContain('Agent: Ops Narrator');
    expect(text).not.toContain('‮');
    expect(text).not.toContain('​');
  });

  it('renders an oversized headline/bullet without throwing (belt-and-braces beyond the intake schema cap)', () => {
    const fixture = fullNarrativeFixture();
    // Space-separated so jsPDF's word wrap is well-defined; the exact
    // character-cap boundary itself is unit-tested against sanitizeNarrativeText
    // below, independent of jsPDF's line-wrapping of long runs of text.
    fixture.narrative!.headline = 'Overview word '.repeat(40);
    fixture.narrative!.sections = [
      { key: 'alerts', title: 'x', bullets: ['Patch finding word '.repeat(30)] },
    ];
    expect(() => buildReportPdf([], { ...opts, summary: fixture })).not.toThrow();
    const doc = buildReportPdf([], { ...opts, summary: fixture });
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(1);
  });

  it('falls through to the generic branch without throwing when narrative is missing', () => {
    const doc = buildReportPdf([], { ...opts, summary: {} as OrgNarrativeReportSummary });
    expect(doc.getNumberOfPages()).toBe(1);
    const text = pdfCommandText(doc);
    // Generic branch's empty-rows fallback, not the narrative headline/sections.
    expect(text).toContain('No data available for the selected filters.');
  });

  it('falls through to the generic branch without throwing when summary is entirely absent', () => {
    expect(() => buildReportPdf([], { ...opts })).not.toThrow();
  });

  it('renders a legacy/partial narrative snapshot (only headline, no sections) without throwing', () => {
    const partial: OrgNarrativeReportSummary = { narrative: { headline: 'Partial only' } };
    const doc = buildReportPdf([], { ...opts, summary: partial });
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(1);
    expect(pdfCommandText(doc)).toContain('Partial only');
  });

  it('includes the AI-authorship footer disclosure note', () => {
    const doc = buildReportPdf([], { ...opts, summary: fullNarrativeFixture() });
    const text = pdfCommandText(doc);
    expect(text).toContain('Generated by an AI agent from the previous 7 days of Breeze data');
    expect(text).toContain('narrative is model-authored');
  });
});

describe('sanitizeNarrativeText', () => {
  it('strips control/format characters (RTL override, zero-width space)', () => {
    expect(sanitizeNarrativeText('a‮b​c', 240)).toBe('a b c');
  });

  it('collapses an embedded newline into a single space rather than a new line', () => {
    expect(sanitizeNarrativeText('line one\n- injected', 240)).toBe('line one - injected');
  });

  it('caps at the given character limit, measured after control-char stripping', () => {
    expect(sanitizeNarrativeText('H'.repeat(500), 160)).toBe('H'.repeat(160));
    expect(sanitizeNarrativeText('B'.repeat(500), 240)).toBe('B'.repeat(240));
  });

  it('leaves a short, clean string untouched', () => {
    expect(sanitizeNarrativeText('All quiet this week.', 240)).toBe('All quiet this week.');
  });

  it('returns an empty string for non-string or empty input', () => {
    expect(sanitizeNarrativeText(undefined, 240)).toBe('');
    expect(sanitizeNarrativeText(null, 240)).toBe('');
    expect(sanitizeNarrativeText(123, 240)).toBe('');
    expect(sanitizeNarrativeText('   ', 240)).toBe('');
  });
});
