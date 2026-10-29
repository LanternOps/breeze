import { describe, expect, it } from 'vitest';
import { blockContentLabel, htmlExcerpt, nearestHeadingAbove, textExcerpt } from './quoteOutlineLabels';
import type { QuoteBlock } from './quoteTypes';

const blk = (id: string, blockType: QuoteBlock['blockType'], content: Record<string, unknown>): QuoteBlock => ({
  id, quoteId: 'q-1', orgId: 'org-1', blockType, content, sortOrder: 0, createdAt: '2026-06-01T00:00:00Z',
});

describe('quoteOutlineLabels (#9867)', () => {
  it('separates adjacent block elements and decodes entities', () => {
    expect(htmlExcerpt('<p>Alpha</p><p>Beta &amp; gamma</p>')).toBe('Alpha Beta & gamma');
  });

  it('cuts long text at a word boundary with an ellipsis', () => {
    expect(textExcerpt('one two three four five six seven eight nine ten', 20)).toBe('one two three four…');
    expect(textExcerpt('short', 20)).toBe('short');
  });

  it('returns empty for whitespace-only content', () => {
    expect(htmlExcerpt('<p> </p><br>')).toBe('');
    expect(blockContentLabel(blk('a', 'image', { imageId: 'x', caption: '   ' }))).toBe('');
  });

  it('uses a callout title, then its body', () => {
    expect(blockContentLabel(blk('a', 'callout', { variant: 'info', title: 'Heads up', html: '<p>Body</p>' }))).toBe('Heads up');
    expect(blockContentLabel(blk('a', 'callout', { variant: 'info', html: '<p>Body text</p>' }))).toBe('Body text');
  });

  it('leaves pricing, heading and contract blocks to the editor (empty here)', () => {
    expect(blockContentLabel(blk('a', 'line_items', { label: 'Services' }))).toBe('');
  });

  it('finds the closest heading above, skipping empty ones', () => {
    const blocks = [
      blk('h1', 'heading', { text: 'Scope' }),
      blk('h2', 'heading', { text: ' ' }),
      blk('img', 'image', { imageId: 'x' }),
    ];
    expect(nearestHeadingAbove(blocks, 2)).toBe('Scope');
    expect(nearestHeadingAbove(blocks, 0)).toBe('');
  });
});
