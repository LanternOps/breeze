/**
 * #8747: a trashed counterpart's subject is manager-only. The list keeps the
 * number and the deleted flag for everyone (the link still counts toward the
 * cap/duplicate/cycle rules, so it must stay visible and removable).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: {}, withSystemDbAccessContext: vi.fn(), runOutsideDbContext: vi.fn() }));

import { redactTrashedSubjects, type TicketLinkView } from './ticketLinkService';

const view = (deleted: boolean, id = 'l1'): TicketLinkView => ({
  id, direction: 'outgoing', linkType: 'related', label: 'related',
  other: { id: 't2', ticketNumber: 'T-2', subject: 'Secret subject', status: 'open', ticketType: 'incident', deleted },
  createdAt: '2026-10-13T00:00:00.000Z',
});

describe('redactTrashedSubjects', () => {
  it('hides the subject of a trashed counterpart from a non-manager, keeping number and flag', () => {
    const [out] = redactTrashedSubjects([view(true)], false);
    expect(out!.other.subject).toBeNull();
    expect(out!.other.ticketNumber).toBe('T-2');
    expect(out!.other.deleted).toBe(true);
    expect(JSON.stringify(out)).not.toContain('Secret subject');
  });

  it('keeps the subject for a manager', () => {
    expect(redactTrashedSubjects([view(true)], true)[0]!.other.subject).toBe('Secret subject');
  });

  it('never touches a live counterpart', () => {
    expect(redactTrashedSubjects([view(false)], false)[0]!.other.subject).toBe('Secret subject');
  });
});
