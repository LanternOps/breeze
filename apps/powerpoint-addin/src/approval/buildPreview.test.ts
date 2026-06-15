import { describe, expect, it } from 'vitest';
import { buildPptPreview } from './buildPreview';

describe('buildPptPreview', () => {
  it('summarizes add_slide with its layout', async () => {
    const preview = await buildPptPreview('add_slide', { layoutName: 'Title Slide' });
    expect(preview.kind).toBe('summary');
    expect(preview.toolName).toBe('add_slide');
    const desc = (preview as { description: string }).description;
    expect(desc.toLowerCase()).toContain('slide');
    expect(desc).toContain('Title Slide');
  });

  it('summarizes insert_text_box with its text and slide', async () => {
    const preview = await buildPptPreview('insert_text_box', {
      text: 'Hello caption',
      slideIndex: 2,
    });
    expect(preview.kind).toBe('summary');
    const desc = (preview as { description: string }).description;
    expect(desc.toLowerCase()).toContain('insert');
    expect(desc).toContain('Hello caption');
  });

  it('summarizes format_selection with the applied keys', async () => {
    const preview = await buildPptPreview('format_selection', {
      format: { bold: true, fontSize: 12 },
    });
    expect(preview.kind).toBe('summary');
    const desc = (preview as { description: string }).description;
    expect(desc).toContain('bold');
    expect(desc).toContain('fontSize');
  });

  it('always produces a summary variant (never grid)', async () => {
    for (const tool of ['add_slide', 'insert_text_box', 'format_selection']) {
      const preview = await buildPptPreview(tool, {
        text: 't',
        slideIndex: 0,
        layoutName: 'Blank',
        format: { bold: true },
      });
      expect(preview.kind).toBe('summary');
    }
  });
});
