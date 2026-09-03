import { describe, it, expect } from 'vitest';

import {
  buildCommentSubmission,
  COMMENT_MODES,
  composerPlaceholder,
  DEFAULT_COMMENT_MODE,
  internalBannerText,
  isPublicForMode,
  modeTabLabel,
  submitLabel,
  type CommentMode,
} from './commentMode';

describe('DEFAULT_COMMENT_MODE', () => {
  // The whole point of the feature. A public comment emails the requester via
  // the notify worker and cannot be recalled; an internal note that should have
  // been a reply costs one extra tap. If this constant ever flips to 'reply',
  // it must be a deliberate product decision, not a refactor accident.
  it('is internal, so the phone never mails a customer by default', () => {
    expect(DEFAULT_COMMENT_MODE).toBe('internal');
  });

  it('produces a non-public submission', () => {
    expect(isPublicForMode(DEFAULT_COMMENT_MODE)).toBe(false);
  });
});

describe('buildCommentSubmission', () => {
  it('derives isPublic:false from the default mode', () => {
    const submission = buildCommentSubmission({
      mode: DEFAULT_COMMENT_MODE,
      text: 'checked the switch, port 12 is dead',
      attachmentIds: [],
    });
    expect(submission.isPublic).toBe(false);
    expect(submission.content).toBe('checked the switch, port 12 is dead');
    expect(submission.attachmentIds).toEqual([]);
  });

  it('derives isPublic:true only when the mode is reply', () => {
    const submission = buildCommentSubmission({
      mode: 'reply',
      text: 'We swapped the switch, you should be back online.',
      attachmentIds: ['att-1', 'att-2'],
    });
    expect(submission.isPublic).toBe(true);
    expect(submission.attachmentIds).toEqual(['att-1', 'att-2']);
  });

  it('trims the text so the screen never has to trim twice', () => {
    expect(
      buildCommentSubmission({ mode: 'internal', text: '  padded  ', attachmentIds: [] }).content
    ).toBe('padded');
  });

  it('keeps an attachment-only submission legal (empty content, ids present)', () => {
    // The API's addTicketCommentSchema refines "text OR at least one
    // attachment", so a whitespace-only body with attachments must survive.
    const submission = buildCommentSubmission({
      mode: 'internal',
      text: '   ',
      attachmentIds: ['att-9'],
    });
    expect(submission.content).toBe('');
    expect(submission.attachmentIds).toEqual(['att-9']);
  });

  it('copies the attachment ids rather than aliasing the caller array', () => {
    const ids = ['att-1'];
    const submission = buildCommentSubmission({ mode: 'reply', text: 'hi', attachmentIds: ids });
    ids.push('att-2');
    expect(submission.attachmentIds).toEqual(['att-1']);
  });
});

describe('isPublicForMode', () => {
  it('maps reply to public and internal to private', () => {
    expect(isPublicForMode('reply')).toBe(true);
    expect(isPublicForMode('internal')).toBe(false);
  });
});

describe('submitLabel', () => {
  it('names the consequence of the tap, not the generic action', () => {
    expect(submitLabel('reply')).toBe('Send reply');
    expect(submitLabel('internal')).toBe('Add internal note');
  });
});

describe('composerPlaceholder', () => {
  it('differs per mode so the field itself says where the text is going', () => {
    const reply = composerPlaceholder('reply');
    const internal = composerPlaceholder('internal');
    expect(reply).not.toBe(internal);
    expect(reply.toLowerCase()).toContain('reply');
    expect(internal.toLowerCase()).toContain('internal');
  });
});

describe('modeTabLabel', () => {
  it('mirrors the web composer tabs', () => {
    expect(modeTabLabel('reply')).toBe('Reply');
    expect(modeTabLabel('internal')).toBe('Internal note');
  });
});

describe('internalBannerText', () => {
  it('says who cannot see the note', () => {
    expect(internalBannerText.toLowerCase()).toContain('not visible to requester');
  });
});

describe('every mode is total', () => {
  it('lists both modes, reply first, matching the web tab order', () => {
    const expected: CommentMode[] = ['reply', 'internal'];
    expect([...COMMENT_MODES]).toEqual(expected);
  });

  it('includes the default', () => {
    expect(COMMENT_MODES).toContain(DEFAULT_COMMENT_MODE);
  });

  it('has a label, a placeholder and a tab name for each mode', () => {
    for (const mode of COMMENT_MODES) {
      expect(submitLabel(mode).length).toBeGreaterThan(0);
      expect(composerPlaceholder(mode).length).toBeGreaterThan(0);
      expect(modeTabLabel(mode).length).toBeGreaterThan(0);
    }
  });
});
