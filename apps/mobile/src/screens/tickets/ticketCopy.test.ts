import { describe, it, expect } from 'vitest';

import {
  emptyStateCopy,
  emptyStateKind,
  isBreached,
  priorityLabel,
  statusLabel,
  ticketRef,
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
    expect(ticketRef({ internalNumber: '1041', id: 'abcdef01-1111' })).toBe('#1041');
  });

  it('does not double-prefix a number that already carries a #', () => {
    expect(ticketRef({ internalNumber: '#1041', id: 'abcdef01-1111' })).toBe('#1041');
  });

  it('preserves a non-numeric internal reference verbatim', () => {
    expect(ticketRef({ internalNumber: 'TKT-1041', id: 'abcdef01' })).toBe('#TKT-1041');
  });

  it('falls back to a short id when the tenant has no internal number', () => {
    expect(ticketRef({ internalNumber: null, id: 'abcdef0123456789' })).toBe('#abcdef01');
    expect(ticketRef({ internalNumber: '   ', id: 'abcdef0123456789' })).toBe('#abcdef01');
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
