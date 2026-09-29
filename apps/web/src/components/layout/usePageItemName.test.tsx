import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { usePageItemName } from './usePageItemName';
import { useRecentsStore } from '../../stores/recentsStore';

const path = '/organizations/1ad7f8ed-06c8-4ced-9cc7-332a33722123';

beforeEach(() => {
  localStorage.clear();
  useRecentsStore.getState().hydrate(null);
  window.history.pushState({}, '', path);
  document.title = 'Organization | Breeze RMM';
});

describe('usePageItemName', () => {
  it('prefixes the tab title with the item name and restores it on unmount', () => {
    const { unmount } = renderHook(() => usePageItemName('Acme Dental'));
    expect(document.title).toBe('Acme Dental · Organization | Breeze RMM');
    unmount();
    expect(document.title).toBe('Organization | Breeze RMM');
  });

  it('names the current page in recents', () => {
    const s = useRecentsStore.getState();
    s.hydrate('u1');
    s.recordPage({ path, title: 'Organization' });
    renderHook(() => usePageItemName('Acme Dental'));
    expect(useRecentsStore.getState().pages[0].name).toBe('Acme Dental');
  });

  it('does nothing until the item has a name', () => {
    const { rerender } = renderHook(({ name }) => usePageItemName(name), {
      initialProps: { name: undefined as string | undefined },
    });
    expect(document.title).toBe('Organization | Breeze RMM');
    rerender({ name: 'Acme Dental' });
    expect(document.title).toBe('Acme Dental · Organization | Breeze RMM');
    rerender({ name: 'Acme Dental Group' });
    expect(document.title).toBe('Acme Dental Group · Organization | Breeze RMM');
  });
});
