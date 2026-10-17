import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_RECENT_DEVICES,
  MAX_RECENT_PAGES,
  isRecordablePagePath,
  recentsStorageKey,
  selectRecentEntries,
  useRecentsStore,
} from './recentsStore';

const device = (id: string, name = `host-${id}`) => ({ id, name, orgId: 'org-1' });

beforeEach(() => {
  localStorage.clear();
  useRecentsStore.getState().hydrate(null);
});

describe('recentsStore', () => {
  it('records nothing until hydrated for a user', () => {
    useRecentsStore.getState().recordDevice(device('a'));
    useRecentsStore.getState().recordPage({ path: '/alerts', title: 'Alerts' });
    expect(useRecentsStore.getState().devices).toEqual([]);
    expect(useRecentsStore.getState().pages).toEqual([]);
    expect(localStorage.length).toBe(0);
  });

  it('keeps the most recently opened device first and dedupes by id', () => {
    const s = useRecentsStore.getState();
    s.hydrate('u1');
    s.recordDevice(device('a'));
    s.recordDevice(device('b'));
    s.recordDevice(device('a', 'renamed-a'));
    expect(useRecentsStore.getState().devices.map((d) => d.id)).toEqual(['a', 'b']);
    expect(useRecentsStore.getState().devices[0].name).toBe('renamed-a');
  });

  it(`caps devices at ${MAX_RECENT_DEVICES} and pages at ${MAX_RECENT_PAGES}`, () => {
    const s = useRecentsStore.getState();
    s.hydrate('u1');
    for (let i = 0; i < MAX_RECENT_DEVICES + 3; i++) s.recordDevice(device(String(i)));
    for (let i = 0; i < MAX_RECENT_PAGES + 3; i++) s.recordPage({ path: `/p/${i}`, title: `P${i}` });
    expect(useRecentsStore.getState().devices).toHaveLength(MAX_RECENT_DEVICES);
    expect(useRecentsStore.getState().devices[0].id).toBe(String(MAX_RECENT_DEVICES + 2));
    expect(useRecentsStore.getState().pages).toHaveLength(MAX_RECENT_PAGES);
    expect(useRecentsStore.getState().pages[0].path).toBe(`/p/${MAX_RECENT_PAGES + 2}`);
  });

  it('dedupes pages by path, refreshing the title', () => {
    const s = useRecentsStore.getState();
    s.hydrate('u1');
    s.recordPage({ path: '/alerts', title: 'Alerts' });
    s.recordPage({ path: '/scripts', title: 'Scripts' });
    s.recordPage({ path: '/alerts', title: 'Alerts (2)' });
    expect(useRecentsStore.getState().pages.map((p) => p.path)).toEqual(['/alerts', '/scripts']);
    expect(useRecentsStore.getState().pages[0].title).toBe('Alerts (2)');
  });

  it('persists per user and swaps lists when the user changes', () => {
    const s = useRecentsStore.getState();
    s.hydrate('u1');
    s.recordDevice(device('a'));
    expect(localStorage.getItem(recentsStorageKey('u1'))).toContain('"a"');

    s.hydrate('u2');
    expect(useRecentsStore.getState().devices).toEqual([]);
    useRecentsStore.getState().recordDevice(device('z'));

    useRecentsStore.getState().hydrate('u1');
    expect(useRecentsStore.getState().devices.map((d) => d.id)).toEqual(['a']);
    expect(localStorage.getItem(recentsStorageKey('u2'))).toContain('"z"');
  });

  it('empties the in-memory lists on logout (hydrate(null)) without touching storage', () => {
    const s = useRecentsStore.getState();
    s.hydrate('u1');
    s.recordDevice(device('a'));
    s.hydrate(null);
    expect(useRecentsStore.getState().devices).toEqual([]);
    expect(localStorage.getItem(recentsStorageKey('u1'))).toContain('"a"');
  });

  it('survives corrupt storage', () => {
    localStorage.setItem(recentsStorageKey('u1'), '{not json');
    useRecentsStore.getState().hydrate('u1');
    expect(useRecentsStore.getState().devices).toEqual([]);
    expect(useRecentsStore.getState().pages).toEqual([]);
  });

  it('drops malformed entries when hydrating', () => {
    localStorage.setItem(
      recentsStorageKey('u1'),
      JSON.stringify({ devices: [{ id: 'ok', name: 'ok' }, { name: 'no-id' }, 'junk'], pages: [{ path: '/x', title: 'X' }, { title: 'no-path' }] }),
    );
    useRecentsStore.getState().hydrate('u1');
    expect(useRecentsStore.getState().devices.map((d) => d.id)).toEqual(['ok']);
    expect(useRecentsStore.getState().pages.map((p) => p.path)).toEqual(['/x']);
  });

  it('removes a device that no longer exists', () => {
    const s = useRecentsStore.getState();
    s.hydrate('u1');
    s.recordDevice(device('a'));
    s.recordDevice(device('b'));
    useRecentsStore.getState().forgetDevice('a');
    expect(useRecentsStore.getState().devices.map((d) => d.id)).toEqual(['b']);
  });
});

describe('isRecordablePagePath', () => {
  it.each([
    ['/', true],
    ['/alerts', true],
    ['/settings/organizations/abc', true],
    ['/devices', true],
    ['/devices/groups', true],
    ['/devices/0f1c8a2e-1111-4bbb-8ccc-123456789abc', false], // covered by recent devices
    ['/login', false],
    ['/auth/callback', false],
    ['/logout', false],
  ])('%s -> %s', (path, expected) => {
    expect(isRecordablePagePath(path)).toBe(expected);
  });
});

describe('recentsStore — page item names', () => {
  const quote = '/billing/quotes/188ea8ed-5451-4157-87cc-a65efa4536d9';

  it('names an already-recorded page and persists the name', () => {
    const s = useRecentsStore.getState();
    s.hydrate('u1');
    s.recordPage({ path: quote, title: 'Quote' });
    s.namePage(quote, 'Q-0042 Acme firewall refresh');
    expect(useRecentsStore.getState().pages[0]).toEqual(
      expect.objectContaining({ path: quote, title: 'Quote', name: 'Q-0042 Acme firewall refresh' }),
    );
    const persisted = JSON.parse(localStorage.getItem(recentsStorageKey('u1'))!);
    expect(persisted.pages[0].name).toBe('Q-0042 Acme firewall refresh');
    s.hydrate(null);
    s.hydrate('u1');
    expect(useRecentsStore.getState().pages[0].name).toBe('Q-0042 Acme firewall refresh');
  });

  it('keeps the name when the same page is visited again', () => {
    const s = useRecentsStore.getState();
    s.hydrate('u1');
    s.recordPage({ path: quote, title: 'Quote' });
    s.namePage(quote, 'Q-0042');
    s.recordPage({ path: '/alerts', title: 'Alerts' });
    s.recordPage({ path: quote, title: 'Quote' });
    expect(useRecentsStore.getState().pages[0]).toEqual(expect.objectContaining({ path: quote, name: 'Q-0042' }));
  });

  it('applies a name that arrives before the visit is recorded', () => {
    const s = useRecentsStore.getState();
    s.hydrate('u1');
    s.namePage(quote, 'Q-0042');
    expect(useRecentsStore.getState().pages).toEqual([]);
    s.recordPage({ path: quote, title: 'Quote' });
    expect(useRecentsStore.getState().pages[0].name).toBe('Q-0042');
  });

  it('ignores blank names', () => {
    const s = useRecentsStore.getState();
    s.hydrate('u1');
    s.recordPage({ path: quote, title: 'Quote' });
    s.namePage(quote, '   ');
    expect(useRecentsStore.getState().pages[0].name).toBeUndefined();
  });
});

const dev = (id: string, name: string, openedAt: number) => ({ id, name, openedAt });
const page = (path: string, name: string | undefined, visitedAt: number) => ({ path, title: 'T', name, visitedAt });

describe('recents caps', () => {
  it('raises both caps to 10', () => {
    expect(MAX_RECENT_DEVICES).toBe(10);
    expect(MAX_RECENT_PAGES).toBe(10);
  });
});

describe('selectRecentEntries', () => {
  it('merges devices and named pages newest first with a kind per path', () => {
    const r = selectRecentEntries(
      {
        devices: [dev('d1', 'LAPTOP-01', 3000)],
        pages: [
          page('/organizations/o1', 'Acme Dental', 4000),
          page('/tickets/t1', 'T-0042 Printer', 2000),
          page('/alerts/a1', 'CPU high', 1000),
          page('/settings/sites/s1', 'Main office', 500),
          page('/scripts/x1', 'Reboot', 400),
        ],
      },
      '/',
    );
    expect(r.map((e) => e.href)).toEqual([
      '/organizations/o1',
      '/devices/d1',
      '/tickets/t1',
      '/alerts/a1',
      '/settings/sites/s1',
      '/scripts/x1',
    ]);
    expect(r.map((e) => e.kind)).toEqual(['org', 'device', 'ticket', 'alert', 'site', 'page']);
    expect(r[0]).toEqual({ kind: 'org', href: '/organizations/o1', label: 'Acme Dental', at: 4000 });
  });

  it('never lists a page without an item name (hub and list pages)', () => {
    const r = selectRecentEntries(
      { devices: [], pages: [{ path: '/devices', title: 'Devices', visitedAt: 9000 }, page('/tickets/t1', 'T-1', 1)] },
      '/',
    );
    expect(r.map((e) => e.href)).toEqual(['/tickets/t1']);
  });

  it('treats a blank name as unnamed', () => {
    expect(selectRecentEntries({ devices: [], pages: [page('/tickets/t1', '   ', 1)] }, '/')).toEqual([]);
  });

  it('excludes the open page by pathname and keeps the query on other hrefs', () => {
    const r = selectRecentEntries(
      { devices: [], pages: [page('/tickets/t1?tab=notes', 'T-1', 2), page('/tickets/t2?tab=notes', 'T-2', 1)] },
      '/tickets/t1',
    );
    expect(r.map((e) => e.href)).toEqual(['/tickets/t2?tab=notes']);
  });

  it('only a single id segment makes a record kind', () => {
    const r = selectRecentEntries(
      { devices: [], pages: [page('/alerts/monitors/m1', 'M', 2), page('/organizations/o1/x', 'X', 1)] },
      '/',
    );
    expect(r.map((e) => e.kind)).toEqual(['page', 'page']);
  });

  it('de-duplicates by href, keeping the newest', () => {
    const r = selectRecentEntries(
      { devices: [], pages: [page('/tickets/t1', 'old', 1), page('/tickets/t1', 'new', 2)] },
      '/',
    );
    expect(r).toHaveLength(1);
    expect(r[0].label).toBe('new');
  });

  it('caps at 10 by default and honours limit', () => {
    const devices = Array.from({ length: 12 }, (_, i) => dev(`d${i}`, `n${i}`, i));
    const r = selectRecentEntries({ devices, pages: [] }, '/');
    expect(r).toHaveLength(10);
    expect(r[0].href).toBe('/devices/d11');
    expect(selectRecentEntries({ devices, pages: [] }, '/', 8)).toHaveLength(8);
  });

  it('returns [] for an empty store', () => {
    expect(selectRecentEntries({ devices: [], pages: [] }, '/')).toEqual([]);
  });
});
