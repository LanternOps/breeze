import { describe, expect, it } from 'vitest';
import {
  NARRATIVE_BULLETS_PER_SECTION_MAX,
  NARRATIVE_BULLET_MAX_CHARS,
  NARRATIVE_HEADLINE_MAX_CHARS,
  NARRATIVE_MARKDOWN_MAX_CHARS,
  NARRATIVE_SECTION_KEYS,
  NARRATIVE_SECTION_TITLES,
  type NarrativeSection,
} from '../types/orgNarrativeReport';
import {
  narrativeOutcomeFromSubmission,
  narrativeSubmissionSchema,
  renderNarrativeMarkdown,
  type NarrativeSubmission,
} from './orgNarrative';

/** A well-formed submission with every key present exactly once, in a
 *  DELIBERATELY non-canonical order — the server re-orders, so a happy-path
 *  fixture that is already canonical could not tell the two apart. */
const submission = (over: Partial<NarrativeSubmission> = {}): Record<string, unknown> => ({
  headline: 'A quiet week across 42 devices',
  sections: [...NARRATIVE_SECTION_KEYS].reverse().map((key) => ({ key, bullets: [`bullet for ${key}`] })),
  ...over,
});

/** Replaces the FIRST section's single bullet, leaving the other seven valid. */
const withFirstBullet = (bullet: string): Record<string, unknown> => submission({
  sections: NARRATIVE_SECTION_KEYS.map((key, i) => ({ key, bullets: [i === 0 ? bullet : 'b'] })),
} as Partial<NarrativeSubmission>);

describe('narrativeSubmissionSchema', () => {
  it('accepts a submission carrying all eight sections', () => {
    const parsed = narrativeSubmissionSchema.safeParse(submission());
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.sections).toHaveLength(NARRATIVE_SECTION_KEYS.length);
  });

  it('rejects a submission missing a section and names the missing key', () => {
    const seven = submission({
      sections: NARRATIVE_SECTION_KEYS.filter((k) => k !== 'backups').map((key) => ({ key, bullets: ['b'] })),
    } as Partial<NarrativeSubmission>);
    const result = narrativeSubmissionSchema.safeParse(seven);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('backups');
  });

  it('rejects a duplicated section key and names it', () => {
    const dupes = submission({
      sections: NARRATIVE_SECTION_KEYS.map((key) => ({ key: key === 'backups' ? 'fleet' : key, bullets: ['b'] })),
    } as Partial<NarrativeSubmission>);
    const result = narrativeSubmissionSchema.safeParse(dupes);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain('fleet');
  });

  it('rejects an unknown section key', () => {
    const unknown = submission({
      sections: NARRATIVE_SECTION_KEYS.map((key) => ({ key: key === 'fleet' ? 'budget' : key, bullets: ['b'] })),
    } as Partial<NarrativeSubmission>);
    expect(narrativeSubmissionSchema.safeParse(unknown).success).toBe(false);
  });

  it('is strict — an unknown top-level or per-section key is rejected', () => {
    expect(narrativeSubmissionSchema.safeParse({ ...submission(), markdown: '# forged' }).success).toBe(false);
    const withTitle = submission();
    (withTitle.sections as Array<Record<string, unknown>>)[0]!.title = 'Forged title';
    expect(narrativeSubmissionSchema.safeParse(withTitle).success).toBe(false);
  });

  it('bounds the headline at NARRATIVE_HEADLINE_MAX_CHARS', () => {
    expect(narrativeSubmissionSchema.safeParse(submission({ headline: 'h'.repeat(NARRATIVE_HEADLINE_MAX_CHARS) })).success).toBe(true);
    expect(narrativeSubmissionSchema.safeParse(submission({ headline: 'h'.repeat(NARRATIVE_HEADLINE_MAX_CHARS + 1) })).success).toBe(false);
    expect(narrativeSubmissionSchema.safeParse(submission({ headline: '' })).success).toBe(false);
    expect(narrativeSubmissionSchema.safeParse(submission({ headline: '   ' })).success).toBe(false);
  });

  it('bounds each bullet at NARRATIVE_BULLET_MAX_CHARS', () => {
    expect(narrativeSubmissionSchema.safeParse(withFirstBullet('x'.repeat(NARRATIVE_BULLET_MAX_CHARS))).success).toBe(true);
    expect(narrativeSubmissionSchema.safeParse(withFirstBullet('x'.repeat(NARRATIVE_BULLET_MAX_CHARS + 1))).success).toBe(false);
    expect(narrativeSubmissionSchema.safeParse(withFirstBullet('   ')).success).toBe(false);
  });

  it('bounds the bullets per section at NARRATIVE_BULLETS_PER_SECTION_MAX and requires at least one', () => {
    const withBulletCount = (n: number) => submission({
      sections: NARRATIVE_SECTION_KEYS.map((key, i) => ({ key, bullets: Array.from({ length: i === 0 ? n : 1 }, (_, j) => `b${j}`) })),
    } as Partial<NarrativeSubmission>);
    expect(narrativeSubmissionSchema.safeParse(withBulletCount(NARRATIVE_BULLETS_PER_SECTION_MAX)).success).toBe(true);
    expect(narrativeSubmissionSchema.safeParse(withBulletCount(NARRATIVE_BULLETS_PER_SECTION_MAX + 1)).success).toBe(false);
    expect(narrativeSubmissionSchema.safeParse(withBulletCount(0)).success).toBe(false);
  });

  it('rejects any control or format character in a bullet or the headline', () => {
    // BEL, NUL, a newline (a forged extra markdown line) and RIGHT-TO-LEFT
    // OVERRIDE (visually reorders a rendered line) — all `\p{C}`.
    for (const ch of ['\u0007', '\u0000', '\n', '\u202E']) {
      expect(narrativeSubmissionSchema.safeParse(withFirstBullet(`ok${ch}bad`)).success).toBe(false);
      expect(narrativeSubmissionSchema.safeParse(submission({ headline: `ok${ch}bad` })).success).toBe(false);
    }
  });

  it('rejects a bullet whose only content is a markdown marker', () => {
    // These pass "non-blank" and "no control characters", but the renderer
    // strips the leading marker and is left with nothing — which would give
    // that section an h2 with zero bullets and break the >=1-bullet
    // invariant the schema promises downstream. The SCHEMA is the gate.
    for (const bullet of ['#', '- ', '>', '-', '##', '*', '+', '  >  ']) {
      const result = narrativeSubmissionSchema.safeParse(withFirstBullet(bullet));
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.error?.issues)).toContain('no content');
    }
  });

  it('rejects a section whose ONLY bullet is content-free', () => {
    const onlyMarker = submission({
      sections: NARRATIVE_SECTION_KEYS.map((key) => ({ key, bullets: key === 'backups' ? ['-'] : ['b'] })),
    } as Partial<NarrativeSubmission>);
    expect(narrativeSubmissionSchema.safeParse(onlyMarker).success).toBe(false);
  });

  it('rejects a content-free headline', () => {
    expect(narrativeSubmissionSchema.safeParse(submission({ headline: '#' })).success).toBe(false);
    expect(narrativeSubmissionSchema.safeParse(submission({ headline: '- ' })).success).toBe(false);
  });

  it('still accepts a bullet that merely STARTS with a marker-ish character', () => {
    expect(narrativeSubmissionSchema.safeParse(withFirstBullet('-5% free disk on WS-01')).success).toBe(true);
    expect(narrativeSubmissionSchema.safeParse(withFirstBullet('# 3 tickets closed')).success).toBe(true);
  });

  it('every accepted bullet survives the renderer with content intact', () => {
    // The end-to-end statement of the invariant: parse -> build -> render,
    // and every section still has at least one bullet line.
    const outcome = narrativeOutcomeFromSubmission(narrativeSubmissionSchema.parse(submission()));
    for (const section of outcome.sections) expect(section.bullets.length).toBeGreaterThanOrEqual(1);
    expect(outcome.markdown.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(NARRATIVE_SECTION_KEYS.length);
  });

  it('trims and collapses whitespace in every string it accepts', () => {
    const parsed = narrativeSubmissionSchema.safeParse(submission({
      headline: '  spaced    out  ',
      sections: NARRATIVE_SECTION_KEYS.map((key) => ({ key, bullets: ['  two    spaces  '] })),
    } as Partial<NarrativeSubmission>));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.headline).toBe('spaced out');
    expect(parsed.success && parsed.data.sections[0]!.bullets[0]).toBe('two spaces');
  });
});

describe('narrativeOutcomeFromSubmission', () => {
  it('re-orders to canonical key order, attaches titles, and derives markdown', () => {
    const parsed = narrativeSubmissionSchema.parse(submission());
    const outcome = narrativeOutcomeFromSubmission(parsed);
    expect(outcome.version).toBe(1);
    expect(outcome.sections.map((s) => s.key)).toEqual([...NARRATIVE_SECTION_KEYS]);
    expect(outcome.sections.map((s) => s.title)).toEqual(NARRATIVE_SECTION_KEYS.map((k) => NARRATIVE_SECTION_TITLES[k]));
    expect(outcome.headline).toBe('A quiet week across 42 devices');
    expect(outcome.markdown.startsWith('# A quiet week across 42 devices')).toBe(true);
    expect(outcome.markdown).toContain('## Sweeps & fixes');
    expect(outcome.markdown).toContain('- bullet for overview');
    expect(outcome.markdown.length).toBeLessThanOrEqual(NARRATIVE_MARKDOWN_MAX_CHARS);
  });

  it('is the only producer of markdown — the model never authors it', () => {
    const parsed = narrativeSubmissionSchema.parse(submission());
    const outcome = narrativeOutcomeFromSubmission(parsed);
    expect(outcome.markdown).toBe(renderNarrativeMarkdown(outcome.headline, outcome.sections));
  });
});

describe('renderNarrativeMarkdown', () => {
  const section = (bullets: string[]): NarrativeSection => ({ key: 'overview', title: 'Overview', bullets });

  it('renders the headline as an h1 and each section as an h2 with dashed bullets', () => {
    const md = renderNarrativeMarkdown('Weekly report', [section(['first', 'second'])]);
    expect(md.split('\n')).toEqual(['# Weekly report', '', '## Overview', '- first', '- second']);
  });

  it('flattens a bullet containing a newline into ONE bullet line', () => {
    const md = renderNarrativeMarkdown('H', [section(['a\n- b'])]);
    const bulletLines = md.split('\n').filter((l) => l.startsWith('- '));
    // ONE list item, not two: the embedded newline can no longer start a
    // second one. The inner `- ` survives as literal text — it is only a
    // markdown marker at the START of a line, and dropping it mid-string
    // would silently rewrite what the bullet says.
    expect(bulletLines).toHaveLength(1);
    expect(bulletLines[0]).toBe('- a - b');
    expect(md.split('\n')).toHaveLength(4);
  });

  it('strips leading markdown structure characters so a bullet cannot inject a heading', () => {
    const md = renderNarrativeMarkdown('H', [section(['## Forged heading', '- already dashed', '# h1'])]);
    // The ONLY headings in the document are the ones the server wrote: the
    // h1 headline and the section's own h2 title. No bullet promoted itself.
    expect(md.split('\n').filter((l) => l.startsWith('#'))).toEqual(['# H', '## Overview']);
    expect(md).toContain('- Forged heading');
    expect(md).toContain('- already dashed');
    expect(md).toContain('- h1');
  });

  it('keeps a leading marker character that is NOT a markdown marker', () => {
    // `-5%` and `#3` are not list items / headings in CommonMark (the marker
    // has to be followed by whitespace), so stripping them would silently
    // rewrite what the bullet says. Only real markers are removed.
    const md = renderNarrativeMarkdown('H', [section(['-5% free disk on WS-01', '#3 by ticket volume', '*starred*'])]);
    expect(md).toContain('- -5% free disk on WS-01');
    expect(md).toContain('- #3 by ticket volume');
    expect(md).toContain('- *starred*');
  });

  it('strips a NESTED list marker so a bullet cannot open a sub-list', () => {
    const md = renderNarrativeMarkdown('H', [section(['- - nested', '> quoted', '#'])]);
    expect(md).toContain('- nested');
    expect(md).toContain('- quoted');
    expect(md.split('\n').filter((l) => l.startsWith('- '))).toEqual(['- nested', '- quoted']);
  });

  it('flattens control characters in the headline too', () => {
    const md = renderNarrativeMarkdown('one\ntwo', [section(['b'])]);
    expect(md.split('\n')[0]).toBe('# one two');
  });

  it('caps the output at NARRATIVE_MARKDOWN_MAX_CHARS on a line boundary', () => {
    const bullet = 'x'.repeat(NARRATIVE_BULLET_MAX_CHARS);
    const headline = 'Oversized';
    const sections: NarrativeSection[] = NARRATIVE_SECTION_KEYS.map((key) => ({
      key,
      title: NARRATIVE_SECTION_TITLES[key],
      bullets: Array.from({ length: NARRATIVE_BULLETS_PER_SECTION_MAX }, () => bullet),
    }));
    const md = renderNarrativeMarkdown(headline, sections);
    expect(md.length).toBeGreaterThan(0);
    expect(md.length).toBeLessThanOrEqual(NARRATIVE_MARKDOWN_MAX_CHARS);
    // Truncation actually happened — the untruncated render is well over the cap.
    const untruncated = NARRATIVE_SECTION_KEYS.length * NARRATIVE_BULLETS_PER_SECTION_MAX * (NARRATIVE_BULLET_MAX_CHARS + 3);
    expect(untruncated).toBeGreaterThan(NARRATIVE_MARKDOWN_MAX_CHARS);
    // ...and every surviving line is a WHOLE line, never a mid-line cut.
    const legalLines = new Set<string>([
      '', `# ${headline}`, `- ${bullet}`,
      ...NARRATIVE_SECTION_KEYS.map((k) => `## ${NARRATIVE_SECTION_TITLES[k]}`),
    ]);
    for (const line of md.split('\n')) expect(legalLines.has(line)).toBe(true);
  });
});

describe('NARRATIVE_SECTION_TITLES', () => {
  it('has a title for every key, in canonical order', () => {
    expect(NARRATIVE_SECTION_KEYS).toEqual([
      'overview', 'alerts', 'sweeps_and_fixes', 'tickets',
      'patching_and_security', 'backups', 'fleet', 'recommendations',
    ]);
    expect(NARRATIVE_SECTION_KEYS.map((k) => NARRATIVE_SECTION_TITLES[k])).toEqual([
      'Overview', 'Alerts', 'Sweeps & fixes', 'Tickets',
      'Patching & security', 'Backups', 'Fleet', 'Recommendations',
    ]);
  });
});
