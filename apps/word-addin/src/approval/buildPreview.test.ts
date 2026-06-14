import { describe, expect, it } from 'vitest';
import { buildWordPreview } from './buildPreview';

describe('buildWordPreview', () => {
  it('summarizes insert_text with its location', async () => {
    const preview = await buildWordPreview('insert_text', { text: 'Hello there', location: 'End' });
    expect(preview.kind).toBe('summary');
    expect(preview.toolName).toBe('insert_text');
    const desc = (preview as { description: string }).description;
    expect(desc).toContain('End');
    expect(desc.toLowerCase()).toContain('insert');
  });

  it('summarizes format_text with the applied keys', async () => {
    const preview = await buildWordPreview('format_text', {
      format: { bold: true, fontSize: 12 },
    });
    expect(preview.kind).toBe('summary');
    const desc = (preview as { description: string }).description;
    expect(desc).toContain('bold');
    expect(desc).toContain('fontSize');
  });

  it('summarizes find_replace with the query and replacement', async () => {
    const preview = await buildWordPreview('find_replace', { query: 'old', replace: 'new' });
    expect(preview.kind).toBe('summary');
    const desc = (preview as { description: string }).description;
    expect(desc).toContain('old');
    expect(desc).toContain('new');
  });

  it('always produces a summary variant (never grid)', async () => {
    for (const tool of ['insert_text', 'format_text', 'find_replace']) {
      const preview = await buildWordPreview(tool, {
        text: 't',
        location: 'End',
        format: { bold: true },
        query: 'q',
        replace: 'r',
      });
      expect(preview.kind).toBe('summary');
    }
  });
});
