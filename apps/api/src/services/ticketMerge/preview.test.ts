/**
 * #8972 W1 Task 1.5: the pure parts of the preview and execute — survivor
 * suggestion (D5), notify default (D6), the link plan both share, and the
 * merge note. The SQL halves are covered by ticketMerge.integration.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({ db: {} }));

import { suggestSurvivor } from './preview';
import { mergeNoteContent, requestersDiffer } from './execute';
import { planLinkRepoint, type PlanLink } from './repoint';
import { TICKET_LINK_LIMIT } from '../ticketLinkService';

describe('suggestSurvivor (D5: the older ticket)', () => {
  it('suggests the older ticket whichever side it is on', () => {
    const older = { id: 'b', createdAt: new Date('2026-01-01') };
    const newer = { id: 'a', createdAt: new Date('2026-02-01') };
    expect(suggestSurvivor(newer, older)).toBe('b');
    expect(suggestSurvivor(older, newer)).toBe('b');
  });
  it('breaks a tie on the lower id', () => {
    const t = new Date('2026-01-01');
    expect(suggestSurvivor({ id: 'b', createdAt: t }, { id: 'a', createdAt: t })).toBe('a');
  });
});

describe('requestersDiffer (D6 default for notifyRequester)', () => {
  const none = { requesterContactId: null, submittedBy: null, submitterEmail: null };
  it('differs on different contacts, portal logins or emails', () => {
    expect(requestersDiffer({ ...none, requesterContactId: 'c1' }, { ...none, requesterContactId: 'c2' })).toBe(true);
    expect(requestersDiffer({ ...none, submittedBy: 'p1' }, { ...none, submittedBy: 'p2' })).toBe(true);
    expect(requestersDiffer({ ...none, submitterEmail: 'a@x.test' }, { ...none, submitterEmail: 'b@x.test' })).toBe(true);
  });
  it('the same requester (email case-insensitive) does not differ', () => {
    expect(requestersDiffer({ ...none, submitterEmail: 'A@X.test' }, { ...none, submitterEmail: 'a@x.test' })).toBe(false);
    expect(requestersDiffer({ ...none, requesterContactId: 'c1' }, { ...none, requesterContactId: 'c1' })).toBe(false);
  });
  it('an unknown requester on either side never counts as different', () => {
    expect(requestersDiffer(none, { ...none, submittedBy: 'p1' })).toBe(false);
  });
});

describe('planLinkRepoint (§3.3, shared by merge and preview)', () => {
  const L = (id: string, s: string, t: string, linkType: PlanLink['linkType']): PlanLink => ({ id, sourceTicketId: s, targetTicketId: t, linkType });

  it('drops the link between the pair and keeps a plain one', () => {
    const plan = planLinkRepoint([L('l1', 'src', 'dst', 'caused_by'), L('l2', 'x', 'src', 'resolves')], 'src', 'dst');
    expect(plan.dropped).toEqual([{ linkId: 'l1', linkType: 'caused_by', otherTicketId: 'dst', reason: 'between_pair' }]);
    expect(plan.moves).toEqual([{ id: 'l2', sourceTicketId: 'x', targetTicketId: 'dst' }]);
  });

  it('re-canonicalises related (source < target)', () => {
    // 'aaa' < 'src' but 'dst' > 'aaa': aaa→src becomes aaa→dst; zzz→… keeps order.
    const plan = planLinkRepoint([L('l1', 'src', 'zzz', 'related')], 'src', 'dst');
    expect(plan.moves).toEqual([{ id: 'l1', sourceTicketId: 'dst', targetTicketId: 'zzz' }]);
    const plan2 = planLinkRepoint([L('l1', 'a', 'src', 'related')], 'src', '0dst');
    expect(plan2.moves).toEqual([{ id: 'l1', sourceTicketId: '0dst', targetTicketId: 'a' }]);
  });

  it('drops a pair-uniqueness collision', () => {
    const plan = planLinkRepoint([L('d', 'x', 'dst', 'caused_by'), L('s', 'x', 'src', 'caused_by')], 'src', 'dst');
    expect(plan.dropped.map((d) => [d.linkId, d.reason])).toEqual([['s', 'pair_unique']]);
  });

  it('duplicate_of: follows the survivor when allowed, dropped when the survivor is itself a duplicate', () => {
    expect(planLinkRepoint([L('l', 'z', 'src', 'duplicate_of')], 'src', 'dst').moves)
      .toEqual([{ id: 'l', sourceTicketId: 'z', targetTicketId: 'dst' }]);
    const plan = planLinkRepoint([L('d', 'dst', 'q', 'duplicate_of'), L('l', 'z', 'src', 'duplicate_of')], 'src', 'dst');
    expect(plan.dropped.map((d) => [d.linkId, d.reason])).toEqual([['l', 'canonical_duplicate']]);
  });

  it('drops a link that would close a cycle through the merged pair', () => {
    // dst caused_by x already; src is caused by... x caused_by src would become x caused_by dst → cycle.
    const plan = planLinkRepoint([L('a', 'dst', 'x', 'caused_by'), L('b', 'x', 'src', 'caused_by')], 'src', 'dst');
    expect(plan.dropped.map((d) => [d.linkId, d.reason])).toEqual([['b', 'cycle']]);
  });

  it('drops past TICKET_LINK_LIMIT on the survivor', () => {
    const full = Array.from({ length: TICKET_LINK_LIMIT }, (_, i) => L(`f${i}`, 'dst', `t${i}`, 'resolves'));
    const plan = planLinkRepoint([...full, L('s', 'src', 'new', 'resolves')], 'src', 'dst');
    expect(plan.dropped.map((d) => [d.linkId, d.reason])).toEqual([['s', 'limit']]);
  });

  it('records each source link\'s direction', () => {
    const plan = planLinkRepoint([L('o', 'src', 'x', 'caused_by'), L('i', 'y', 'src', 'caused_by')], 'src', 'dst');
    expect([...plan.directions]).toEqual([['o', 'outgoing'], ['i', 'incoming']]);
  });
});

describe('mergeNoteContent', () => {
  it('carries subject, description, intake answers and dropped links', () => {
    const text = mergeNoteContent('T-2026-0001', { subject: 'Printer', description: 'Floor 3', customFields: { floor: '3', vip: true, empty: '' } }, ['related T-9 (dropped: x)']);
    expect(text).toBe('Merged T-2026-0001: Printer\n\nFloor 3\n\nIntake answers:\n- floor: 3\n- vip: true\n\nLinks dropped by the merge:\n- related T-9 (dropped: x)');
  });
});
