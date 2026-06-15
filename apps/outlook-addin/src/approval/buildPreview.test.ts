import { describe, expect, it } from 'vitest';
import { buildOutlookPreview } from './buildPreview';

describe('buildOutlookPreview', () => {
  it('returns a text variant carrying the full reply body for draft_reply', async () => {
    const body = 'Thanks, I will get back to you tomorrow.';
    const preview = await buildOutlookPreview('draft_reply', { body });
    expect(preview.kind).toBe('text');
    expect(preview.toolName).toBe('draft_reply');
    // The user approves the ACTUAL email prose, not a truncated summary.
    expect((preview as { after: string }).after).toBe(body);
    // No existing draft → no before block.
    expect((preview as { before?: string }).before).toBeUndefined();
  });

  it('keeps the full body even when long (not truncated to a snippet)', async () => {
    const body = 'A'.repeat(500);
    const preview = await buildOutlookPreview('draft_reply', { body });
    expect(preview.kind).toBe('text');
    expect((preview as { after: string }).after).toBe(body);
    expect((preview as { after: string }).after.length).toBe(500);
  });

  it('marks a reply-all draft in the text target', async () => {
    const preview = await buildOutlookPreview('draft_reply', {
      body: 'Reply to everyone.',
      replyAll: true,
    });
    expect(preview.kind).toBe('text');
    expect((preview as { target: string }).target.toLowerCase()).toContain('all');
  });

  it('uses a plain Reply target when not reply-all', async () => {
    const preview = await buildOutlookPreview('draft_reply', { body: 'Hi' });
    expect(preview.kind).toBe('text');
    expect((preview as { target: string }).target).toBe('Reply');
  });

  it('falls back to a summary variant for unknown tools', async () => {
    const preview = await buildOutlookPreview('some_other_tool', {});
    expect(preview.kind).toBe('summary');
    expect((preview as { description: string }).description.toLowerCase()).toContain('run');
  });
});
