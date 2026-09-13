import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_RECENT_DEVICES,
  MAX_RECENT_PAGES,
  isRecordablePagePath,
  recentsStorageKey,
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
