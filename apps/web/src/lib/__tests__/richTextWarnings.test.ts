import { describe, it, expect } from 'vitest';
import { strippedTagsFrom } from '../richTextWarnings';

// Issue #3520: block/version writes answer `{ data, warnings }` when the API's
// rich-text subset had to discard markup. This helper is what turns that
// envelope into the tag list the editor toasts.
describe('strippedTagsFrom', () => {
  const warning = (removedTags: string[], field = 'content.html') => ({
    code: 'UNSUPPORTED_HTML_TAGS_REMOVED',
    field,
    removedTags,
  });

  it('returns the removed tags from a single warning', () => {
    expect(strippedTagsFrom({ data: {}, warnings: [warning(['table', 'tr'])] })).toEqual(['table', 'tr']);
  });

  it('merges, de-duplicates and sorts tags across several fields', () => {
    const body = {
      data: {},
      warnings: [
        warning(['p', 'ul'], 'content.rows[].cells[]'),
        warning(['h3', 'p'], 'content.columns[].label'),
      ],
    };
    expect(strippedTagsFrom(body)).toEqual(['h3', 'p', 'ul']);
  });

  it('returns nothing for a clean write', () => {
    expect(strippedTagsFrom({ data: { id: 'blk-1' }, warnings: [] })).toEqual([]);
  });

  // An older API build (or any endpoint that never opted in) answers without a
  // `warnings` key. Callers wire this in unconditionally, so it must not throw
  // or invent a warning.
  it('returns nothing when the response has no warnings key at all', () => {
    expect(strippedTagsFrom({ data: { id: 'blk-1' } })).toEqual([]);
  });

  it('returns nothing for null, non-object and malformed bodies', () => {
    expect(strippedTagsFrom(null)).toEqual([]);
    expect(strippedTagsFrom(undefined)).toEqual([]);
    expect(strippedTagsFrom('nope')).toEqual([]);
    expect(strippedTagsFrom({ warnings: 'nope' })).toEqual([]);
    expect(strippedTagsFrom({ warnings: [null, 42, { code: 'OTHER_CODE', removedTags: ['x'] }] })).toEqual([]);
  });

  it('ignores a warning of a different code, and non-string or empty tag entries', () => {
    const body = {
      warnings: [
        { code: 'SOMETHING_ELSE', field: 'x', removedTags: ['ignored'] },
        { code: 'UNSUPPORTED_HTML_TAGS_REMOVED', field: 'content.html', removedTags: ['table', '', 7, null] },
      ],
    };
    expect(strippedTagsFrom(body)).toEqual(['table']);
  });
});
