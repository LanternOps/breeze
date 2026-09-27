import { describe, expect, it } from 'vitest';
import { htmlReadMinutes, parseTermsSections, textReadMinutes } from './documentTerms';

describe('parseTermsSections', () => {
  it('detects numbered and ALL-CAPS headings, the rest are paragraphs', () => {
    const r = parseTermsSections('1. Payment\nInvoices are due net 30.\n2.1 Late fees\nAccrue monthly.\nCONFIDENTIALITY:\nKeep it secret.');
    expect(r.sectionCount).toBe(3);
    expect(r.blocks.map((b) => b.kind)).toEqual(['heading', 'para', 'heading', 'para', 'heading', 'para']);
    expect(r.blocks[0]).toMatchObject({ kind: 'heading', text: '1. Payment' });
  });

  it('gives headings unique anchor ids', () => {
    const r = parseTermsSections('1. A\nx\n1. A\ny');
    const ids = r.blocks.filter((b) => b.kind === 'heading').map((b) => (b as { id: string }).id);
    expect(new Set(ids).size).toBe(2);
  });

  it('reports zero sections for plain prose (caller falls back to pre-wrap)', () => {
    const r = parseTermsSections('Just some plain text without numbering.');
    expect(r.sectionCount).toBe(0);
  });

  it('does not treat a long numbered sentence as a heading', () => {
    const long = '1. ' + 'word '.repeat(60);
    expect(parseTermsSections(long).sectionCount).toBe(0);
  });
});

describe('textReadMinutes', () => {
  it('is words/200 rounded up, min 1', () => {
    expect(textReadMinutes('a b c')).toBe(1);
    expect(textReadMinutes('w '.repeat(401))).toBe(3);
  });
});

describe('htmlReadMinutes', () => {
  it('counts the words of the text, not the markup', () => {
    // 401 words split across tags that would otherwise glue words together
    // ("</p><p>") or add fake words (attribute soup).
    const html = `<h3 class="x y z">Scope</h3><p>${'w '.repeat(200)}</p><p><strong>${'w '.repeat(200)}</strong></p>`;
    expect(htmlReadMinutes(html)).toBe(3);
  });

  it('is never below one minute, even for empty markup', () => {
    expect(htmlReadMinutes('<p></p>')).toBe(1);
  });

  it('stays linear on an unclosed run of "<" (CodeQL js/polynomial-redos)', () => {
    // The tag-stripping regex must not backtrack quadratically on adversarial
    // input such as a contract body pasted with many stray '<' and no '>'.
    // A vulnerable /<[^>]*>/g takes >1s at n=40000; a fixed regex is instant.
    const malicious = '<'.repeat(60000);
    const start = Date.now();
    htmlReadMinutes(malicious);
    expect(Date.now() - start).toBeLessThan(500);
  });
});
