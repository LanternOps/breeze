import { describe, expect, it } from 'vitest';

import type { WispActivityItem } from '../../services/wisp';
import {
  EMPTY_ACTIVITY,
  WISP_ENTITY_KINDS,
  activityGroups,
  activityLoadMoreCursor,
  activityPageFailed,
  activityPageLoaded,
  briefSectionsFromNotification,
  homeSectionsFromPayload,
  linkKindLabel,
  linkTarget,
  linksForDisplay,
  mergeActivityPages,
  normalizeBriefSections,
  normalizeLink,
  type WispThreadLink,
} from './wispHomeSections';

const item = (at: string, title = 't', kind = 'k'): WispActivityItem =>
  ({ at, kind, orgId: null, title, detail: null, href: null, costCents: null }) as unknown as WispActivityItem;

const link = (
  over: Partial<WispThreadLink> & { kind?: WispThreadLink['ref']['kind']; refId?: string } = {},
): WispThreadLink => ({
  id: over.id ?? 'l1',
  ref: { kind: over.kind ?? 'ticket', id: over.refId ?? 't1', orgId: null },
  label: over.label ?? 'Label',
  status: null,
  href: '',
  addedBy: over.addedBy ?? 'user',
  createdAt: over.createdAt ?? '2026-10-01T00:00:00Z',
});

describe('timezone pin', () => {
  it('runs in America/New_York', () => {
    expect(new Date('2026-08-01T12:00:00Z').getTimezoneOffset()).toBe(240);
  });
});

describe('normalizeBriefSections', () => {
  it('keeps valid sections and drops junk', () => {
    const out = normalizeBriefSections([
      { heading: ' Overnight ', lines: ['a', '  ', 3, ' b '] },
      { heading: '', lines: ['x'] },
      { heading: 'Empty', lines: ['', '  '] },
      { heading: 'NoLines' },
      null,
      'str',
    ]);
    expect(out).toEqual([{ heading: 'Overnight', lines: ['a', ' b '] }]);
  });
  it('non-array is empty', () => {
    expect(normalizeBriefSections('x')).toEqual([]);
    expect(normalizeBriefSections(null)).toEqual([]);
    expect(normalizeBriefSections({})).toEqual([]);
  });
  it('caps sections at 12 and lines at 20', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      heading: `h${i}`,
      lines: Array.from({ length: 25 }, (_, j) => `l${j}`),
    }));
    const out = normalizeBriefSections(many);
    expect(out).toHaveLength(12);
    expect(out[0].lines).toHaveLength(20);
  });
});

describe('briefSectionsFromNotification', () => {
  const s = [{ heading: 'H', lines: ['L'] }];
  it('reads briefSections', () => {
    expect(briefSectionsFromNotification({ briefSections: s })).toEqual(s);
  });
  it('falls back to brief.sections', () => {
    expect(briefSectionsFromNotification({ brief: { sections: s } })).toEqual(s);
  });
  it('prefers briefSections over brief.sections', () => {
    const other = [{ heading: 'Z', lines: ['Z'] }];
    expect(briefSectionsFromNotification({ briefSections: s, brief: { sections: other } })).toEqual(s);
  });
  it('falls back when briefSections is not an array', () => {
    expect(briefSectionsFromNotification({ briefSections: 'x', brief: { sections: s } })).toEqual(s);
  });
  it('tolerates missing brief, null, string and other junk', () => {
    expect(briefSectionsFromNotification({})).toEqual([]);
    expect(briefSectionsFromNotification({ brief: null })).toEqual([]);
    expect(briefSectionsFromNotification({ brief: 'x' })).toEqual([]);
    expect(briefSectionsFromNotification(null)).toEqual([]);
    expect(briefSectionsFromNotification(undefined)).toEqual([]);
    expect(briefSectionsFromNotification('metadata')).toEqual([]);
    expect(briefSectionsFromNotification(5)).toEqual([]);
  });
});

describe('normalizeLink', () => {
  const good = {
    id: 'l1',
    ref: { kind: 'ticket', id: 't1', orgId: 'o1' },
    label: 'Printer',
    status: 'open',
    href: '/tickets/t1',
    addedBy: 'wisp',
    createdAt: '2026-10-01T00:00:00Z',
  };
  it('accepts a full link', () => {
    expect(normalizeLink(good)).toEqual(good);
  });
  it('applies defaults', () => {
    expect(
      normalizeLink({ id: 'l', ref: { kind: 'site', id: 's', orgId: 5 }, label: 'S', status: 3, addedBy: 'WISP' }),
    ).toEqual({
      id: 'l',
      ref: { kind: 'site', id: 's', orgId: null },
      label: 'S',
      status: null,
      href: '',
      addedBy: 'user',
      createdAt: '',
    });
  });
  it('rejects unknown kind and missing fields', () => {
    expect(normalizeLink({ ...good, ref: { kind: 'widget', id: 'x', orgId: null } })).toBeNull();
    expect(normalizeLink({ ...good, id: '' })).toBeNull();
    expect(normalizeLink({ ...good, label: '' })).toBeNull();
    expect(normalizeLink({ ...good, ref: { kind: 'ticket', id: '' } })).toBeNull();
    expect(normalizeLink({ ...good, ref: null })).toBeNull();
    expect(normalizeLink(null)).toBeNull();
    expect(normalizeLink('x')).toBeNull();
  });
});

describe('linksForDisplay', () => {
  it('puts user-added first, newest first, without mutating', () => {
    const input = [
      link({ id: 'w-new', addedBy: 'wisp', refId: 'a', createdAt: '2026-10-05T00:00:00Z' }),
      link({ id: 'u-old', addedBy: 'user', refId: 'b', createdAt: '2026-10-01T00:00:00Z' }),
      link({ id: 'u-new', addedBy: 'user', refId: 'c', createdAt: '2026-10-03T00:00:00Z' }),
      link({ id: 'u-bad', addedBy: 'user', refId: 'd', createdAt: 'nope' }),
    ];
    const snapshot = input.map((l) => l.id);
    const out = linksForDisplay(input);
    expect(out.map((l) => l.id)).toEqual(['u-new', 'u-old', 'u-bad', 'w-new']);
    expect(input.map((l) => l.id)).toEqual(snapshot);
    expect(out).not.toBe(input);
  });
  it('dedupes by kind:id keeping the first after sorting', () => {
    const out = linksForDisplay([
      link({ id: 'w', addedBy: 'wisp', refId: 'same' }),
      link({ id: 'u', addedBy: 'user', refId: 'same' }),
      link({ id: 'dev', kind: 'device', refId: 'same' }),
    ]);
    expect(out.map((l) => l.id)).toEqual(['u', 'dev']);
  });
  it('is stable for equal dates', () => {
    const out = linksForDisplay([link({ id: 'a', refId: '1' }), link({ id: 'b', refId: '2' })]);
    expect(out.map((l) => l.id)).toEqual(['a', 'b']);
  });
});

describe('linkKindLabel', () => {
  it('labels every kind', () => {
    expect(WISP_ENTITY_KINDS.map(linkKindLabel)).toEqual([
      'Ticket', 'Quote', 'Invoice', 'Contract', 'Device', 'Organization', 'Site', 'Alert', 'Run', 'Task', 'User',
    ]);
  });
});

describe('linkTarget', () => {
  it('opens tickets only', () => {
    expect(linkTarget(link({ kind: 'ticket', refId: 't9' }))).toEqual({ screen: 'ticket', ticketId: 't9' });
    expect(linkTarget(link({ kind: 'ticket', refId: '' }))).toBeNull();
    for (const k of WISP_ENTITY_KINDS.filter((x) => x !== 'ticket')) {
      expect(linkTarget(link({ kind: k }))).toBeNull();
    }
  });
});

describe('activityGroups', () => {
  const now = new Date(2026, 9, 24, 15, 0, 0); // Sat Oct 24 2026 local

  it('buckets by local day, not UTC day', () => {
    const late = new Date(2026, 9, 23, 23, 30).toISOString(); // 2026-10-24T03:30Z
    const early = new Date(2026, 9, 24, 0, 30).toISOString(); // 2026-10-24T04:30Z
    expect(late.slice(0, 10)).toBe(early.slice(0, 10));
    const groups = activityGroups([item(late, 'late'), item(early, 'early')], now);
    expect(groups.map((g) => [g.key, g.title])).toEqual([
      ['2026-10-24', 'Today'],
      ['2026-10-23', 'Yesterday'],
    ]);
    expect(groups[0].items[0].title).toBe('early');
    expect(groups[1].items[0].title).toBe('late');
  });

  it('Yesterday survives a DST fall-back change', () => {
    const n = new Date(2026, 10, 2, 12, 0); // Nov 2
    const y = new Date(2026, 10, 1, 12, 0); // Nov 1 (DST ended 2am)
    const g = activityGroups([item(y.toISOString())], n);
    expect(g[0].title).toBe('Yesterday');
    expect(g[0].key).toBe('2026-11-01');
  });

  it('Yesterday survives a month boundary', () => {
    const g = activityGroups([item(new Date(2026, 9, 31, 9).toISOString())], new Date(2026, 10, 1, 9));
    expect(g[0].title).toBe('Yesterday');
  });

  it('older days use a fixed-format short date', () => {
    const g = activityGroups([item(new Date(2026, 9, 20, 9).toISOString())], now);
    expect(g[0]).toMatchObject({ key: '2026-10-20', title: 'Tue, Oct 20' });
  });

  it('orders days and items newest first; unparseable go last as Earlier', () => {
    const g = activityGroups(
      [
        item('garbage', 'bad'),
        item(new Date(2026, 9, 20, 9).toISOString(), 'old'),
        item(new Date(2026, 9, 24, 8).toISOString(), 'a'),
        item(new Date(2026, 9, 24, 10).toISOString(), 'b'),
      ],
      now,
    );
    expect(g.map((x) => x.key)).toEqual(['2026-10-24', '2026-10-20', 'unknown']);
    expect(g[0].items.map((i) => i.title)).toEqual(['b', 'a']);
    expect(g[2]).toMatchObject({ title: 'Earlier' });
  });

  it('empty input gives no groups', () => {
    expect(activityGroups([], now)).toEqual([]);
  });
});

describe('mergeActivityPages', () => {
  it('appends and dedupes by at|kind|title, first wins', () => {
    const a = item('2026-10-01T00:00:00Z', 'x', 'k1');
    const b = item('2026-10-02T00:00:00Z', 'y', 'k1');
    const dup = { ...a, detail: 'later' };
    const out = mergeActivityPages([a], [dup, b]);
    expect(out).toHaveLength(2);
    expect(out[0].detail).toBeNull();
    expect(out[1]).toBe(b);
  });
  it('same at+title with different kind is kept', () => {
    expect(mergeActivityPages([item('x', 't', 'a')], [item('x', 't', 'b')])).toHaveLength(2);
  });
});

describe('activity paging state', () => {
  const page1 = [item('2026-10-24T12:00:00Z', 'a'), item('2026-10-24T11:00:00Z', 'b')];
  const page2 = [item('2026-10-24T10:00:00Z', 'c')];

  it('a first page replaces the list and records the cursor', () => {
    const s = activityPageLoaded({ ...EMPTY_ACTIVITY, items: page2, loading: true }, null, {
      items: page1,
      nextCursor: 'c1',
    });
    expect(s).toEqual({ items: page1, nextCursor: 'c1', loading: false, error: null });
  });

  it('a cursor page appends (de-duplicated) and advances the cursor', () => {
    const s = activityPageLoaded({ items: page1, nextCursor: 'c1', loading: true, error: null }, 'c1', {
      items: [page1[1]!, ...page2],
      nextCursor: null,
    });
    expect(s.items.map((i) => i.title)).toEqual(['a', 'b', 'c']);
    expect(s.nextCursor).toBeNull();
  });

  it('a failed page keeps what is shown and offers a retry', () => {
    const s = activityPageFailed({ items: page1, nextCursor: 'c1', loading: true, error: null }, 500);
    expect(s).toEqual({ items: page1, nextCursor: 'c1', loading: false, error: 'Could not load activity.' });
  });

  it('a 404 is "no activity here", never a retry that cannot succeed', () => {
    const s = activityPageFailed({ items: [], nextCursor: null, loading: true, error: null }, 404);
    expect(s).toEqual({ items: [], nextCursor: null, loading: false, error: null });
  });

  it('retry after a failed FIRST page asks for the first page; after a failed later page, the same cursor', () => {
    expect(activityLoadMoreCursor({ items: [], nextCursor: null, loading: false, error: 'x' })).toBeNull();
    expect(activityLoadMoreCursor({ items: page1, nextCursor: 'c1', loading: false, error: 'x' })).toBe('c1');
    expect(activityLoadMoreCursor({ items: page1, nextCursor: 'c2', loading: false, error: null })).toBe('c2');
  });
});

describe('homeSectionsFromPayload', () => {
  const raw = {
    id: 'l1',
    ref: { kind: 'ticket', id: 't1', orgId: 'o1' },
    label: 'Printer down',
    status: 'open',
    href: '/tickets/t1',
    addedBy: 'user',
    createdAt: '2026-10-20T10:00:00Z',
  };

  it('reads the w00 contract shape (brief.sections, links)', () => {
    const out = homeSectionsFromPayload({
      brief: { sentAt: '2026-10-24T11:00:00Z', sections: [{ heading: 'Overnight', lines: ['2 alerts'] }] },
      links: [raw, { id: 'bad' }],
    });
    expect(out.brief).toEqual({
      sentAt: '2026-10-24T11:00:00Z',
      sections: [{ heading: 'Overnight', lines: ['2 alerts'] }],
    });
    expect(out.links.map((l) => l.id)).toEqual(['l1']);
  });

  it('tolerates the landed W06 metadata key (brief.briefSections)', () => {
    const out = homeSectionsFromPayload({
      brief: { sentAt: '2026-10-24T11:00:00Z', briefSections: [{ heading: 'Today', lines: ['1 approval'] }] },
      links: [],
    });
    expect(out.brief?.sections).toEqual([{ heading: 'Today', lines: ['1 approval'] }]);
  });

  it('a null brief, a brief with no usable sections, or missing links degrade to empty', () => {
    expect(homeSectionsFromPayload({ brief: null })).toEqual({ brief: null, links: [] });
    expect(homeSectionsFromPayload({ brief: { sentAt: 'x', sections: [] } }).brief).toBeNull();
    expect(homeSectionsFromPayload({ links: 'nope' }).links).toEqual([]);
  });

  it('a non-object body is empty, never a throw', () => {
    expect(homeSectionsFromPayload(null)).toEqual({ brief: null, links: [] });
    expect(homeSectionsFromPayload('x')).toEqual({ brief: null, links: [] });
  });

  it('orders links for display (user-added first)', () => {
    const fromWisp = {
      ...raw,
      id: 'l2',
      ref: { kind: 'device', id: 'd1', orgId: 'o1' },
      addedBy: 'wisp',
      createdAt: '2026-10-24T10:00:00Z',
    };
    expect(homeSectionsFromPayload({ links: [fromWisp, raw] }).links.map((l) => l.id)).toEqual(['l1', 'l2']);
  });
});
