import { describe, expect, it } from 'vitest';
import { parseTermsSections, readMinutes } from './termsSections';

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

describe('readMinutes', () => {
  it('is words/200 rounded up, min 1', () => {
    expect(readMinutes('a b c')).toBe(1);
    expect(readMinutes('w '.repeat(401))).toBe(3);
  });
});
