import { describe, expect, it } from 'vitest';
import { buildOutlookPreview } from './buildPreview';

describe('buildOutlookPreview', () => {
  it('summarizes draft_reply with the draft body', async () => {
    const preview = await buildOutlookPreview('draft_reply', {
      body: 'Thanks, I will get back to you tomorrow.',
    });
    expect(preview.kind).toBe('summary');
    expect(preview.toolName).toBe('draft_reply');
    const desc = (preview as { description: string }).description;
    expect(desc.toLowerCase()).toContain('reply');
  });

  it('marks a reply-all draft in the summary target', async () => {
    const preview = await buildOutlookPreview('draft_reply', {
      body: 'Reply to everyone.',
      replyAll: true,
    });
    expect(preview.kind).toBe('summary');
    expect((preview as { target: string }).target.toLowerCase()).toContain('all');
  });

  it('always produces a summary variant (never grid)', async () => {
    const preview = await buildOutlookPreview('draft_reply', { body: 'Hi' });
    expect(preview.kind).toBe('summary');
  });
});
