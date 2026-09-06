import { describe, it, expect } from 'vitest';

import {
  emptyStateCopy,
  emptyStateKind,
  isBreached,
  isVisibleActivityEntry,
  priorityLabel,
  statusLabel,
  ticketRef,
  visibleActivityCount,
} from './ticketCopy';

describe('statusLabel', () => {
  it('prefers the tenant custom status name', () => {
    expect(statusLabel({ status: 'open', statusName: 'Awaiting parts' })).toBe('Awaiting parts');
  });

  it('falls back to a readable label when the custom name is blank', () => {
    expect(statusLabel({ status: 'on_hold', statusName: '   ' })).toBe('On hold');
    expect(statusLabel({ status: 'on_hold', statusName: null })).toBe('On hold');
  });
});

describe('ticketRef', () => {
  it('uses the internal number when present', () => {
    expect(ticketRef({ internalNumber: '1041' })).toBe('#1041');
  });

  it('does not double-prefix a number that already carries a #', () => {
    expect(ticketRef({ internalNumber: '#1041' })).toBe('#1041');
  });

  it('preserves a non-numeric internal reference verbatim', () => {
    expect(ticketRef({ internalNumber: 'TKT-1041' })).toBe('#TKT-1041');
  });

  it('returns null when the ticket has no internal number, so callers hide the reference', () => {
    // Web precedent: the queue renders nothing when internalNumber is null
    // rather than inventing a reference. A production ticket always has one
    // because the service allocates it on create; only hand-inserted rows
    // (fixtures, the App Review tenant's seed) lack it. No fallback also
    // closes the review-tenant regression where every seeded id started
    // `11110000-...` and an id-derived fallback showed three different
    // tickets as the same "#11110000".
    expect(ticketRef({ internalNumber: null })).toBeNull();
    expect(ticketRef({ internalNumber: '   ' })).toBeNull();
  });
});

describe('isBreached', () => {
  it('is true only when a breach timestamp exists', () => {
    expect(isBreached({ slaBreachedAt: '2026-08-18T00:00:00Z' })).toBe(true);
    expect(isBreached({ slaBreachedAt: null })).toBe(false);
  });
});

describe('priorityLabel', () => {
  it('capitalises for display', () => {
    expect(priorityLabel('urgent')).toBe('Urgent');
    expect(priorityLabel('low')).toBe('Low');
  });
});

describe('emptyStateCopy', () => {
  it('distinguishes "none assigned to you" from "queue is empty"', () => {
    expect(emptyStateCopy('open', 'me').title).toBe('Nothing assigned to you');
    expect(emptyStateCopy('open', 'all').title).toBe('No open tickets');
  });

  it('varies by queue as well as assignee', () => {
    expect(emptyStateCopy('closed', 'me').title).toBe('Nothing closed by you');
    expect(emptyStateCopy('closed', 'all').title).toBe('No closed tickets');
  });
});

describe('emptyStateKind', () => {
  it('shows nothing while the first load is still running', () => {
    expect(emptyStateKind(true, null)).toBe('none');
    // Even with a stale error on screen, a load in progress owns the viewport.
    expect(emptyStateKind(true, 'Network request failed')).toBe('none');
  });

  it('shows the empty state only when the queue was actually read', () => {
    expect(emptyStateKind(false, null)).toBe('empty');
  });

  it('never narrates an empty queue after a failed fetch', () => {
    // The #3753 regression: `tickets` is empty because the request REJECTED,
    // and the old gate rendered "The open queue is clear." right under the
    // error line.
    expect(emptyStateKind(false, 'Network request failed')).toBe('error');
  });
});

describe('isVisibleActivityEntry', () => {
  it('renders a system entry that has content', () => {
    expect(isVisibleActivityEntry({ commentType: 'status_change', content: 'Status changed to Open' })).toBe(
      true
    );
  });

  it('skips a system entry with blank content — it carries no information', () => {
    // Live-tenant regression: a system row rendered with NO text on the left,
    // only the "10w ago" timestamp on the right, because `c.content` was
    // interpolated unguarded. Unlike a person's comment (which has an author
    // chip and can legitimately be attachment-only), a system row has
    // nothing else to anchor an empty one — so it should be skipped, not
    // rendered blank.
    expect(isVisibleActivityEntry({ commentType: 'status_change', content: '' })).toBe(false);
    expect(isVisibleActivityEntry({ commentType: 'time_entry', content: '   ' })).toBe(false);
  });

  it('always renders a person comment, even with empty content', () => {
    // Person comments can be legitimately attachment-only, and the render
    // path has its own placeholder/attachment handling — that decision is
    // not this function's job.
    expect(isVisibleActivityEntry({ commentType: undefined, content: '' })).toBe(true);
    expect(isVisibleActivityEntry({ commentType: 'comment', content: '' })).toBe(true);
  });
});

describe('visibleActivityCount', () => {
  it('counts every row the feed actually renders, system rows included', () => {
    const comments = [
      { commentType: 'status_change' as const, content: 'Status changed to Open' },
      { commentType: 'assignment' as const, content: 'Assigned to Dana' },
      { commentType: 'comment' as const, content: 'Looking into it' },
    ];
    expect(visibleActivityCount(comments)).toBe(3);
  });

  it('does not count a system row that will be skipped as blank', () => {
    // The live-tenant regression: the header read "ACTIVITY (1)" over FIVE
    // visible rows (4 system + 1 comment) because the count only tallied
    // non-system comments while the list below also rendered the system
    // rows. The header count must track what's on screen, not a different
    // subset of it.
    const comments = [
      { commentType: 'status_change' as const, content: 'Status changed to Open' },
      { commentType: 'assignment' as const, content: '' }, // skipped by isVisibleActivityEntry
      { commentType: 'comment' as const, content: 'Looking into it' },
    ];
    expect(visibleActivityCount(comments)).toBe(2);
  });
});
