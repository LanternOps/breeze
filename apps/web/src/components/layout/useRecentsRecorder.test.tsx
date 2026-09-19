import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authState = vi.hoisted(() => ({ user: null as { id: string } | null }));
vi.mock('../../stores/auth', () => ({
  useAuthStore: (selector: (s: typeof authState) => unknown) => selector(authState),
}));

import { currentPageEntry, useRecentsRecorder } from './useRecentsRecorder';
import { useRecentsStore } from '../../stores/recentsStore';

function goTo(path: string, title: string) {
  window.history.pushState({}, '', path);
  document.title = `${title} | Breeze RMM`;
}

beforeEach(() => {
  localStorage.clear();
  useRecentsStore.getState().hydrate(null);
  authState.user = null;
  goTo('/alerts', 'Alerts');
});

describe('useRecentsRecorder', () => {
  it('strips the product suffix from the document title', () => {
    expect(currentPageEntry()).toEqual({ path: '/alerts', title: 'Alerts' });
    document.title = 'Dashboard';
    expect(currentPageEntry().title).toBe('Dashboard');
  });

  it('records nothing while signed out', () => {
    renderHook(() => useRecentsRecorder());
    expect(useRecentsStore.getState().userId).toBeNull();
    expect(useRecentsStore.getState().pages).toEqual([]);
  });

  it('hydrates for the user and records the current page on mount', () => {
    authState.user = { id: 'u1' };
    renderHook(() => useRecentsRecorder());
    expect(useRecentsStore.getState().userId).toBe('u1');
    expect(useRecentsStore.getState().pages).toEqual([
      expect.objectContaining({ path: '/alerts', title: 'Alerts' }),
    ]);
  });

  it('records each Astro page swap, keeping the query string', () => {
    authState.user = { id: 'u1' };
    renderHook(() => useRecentsRecorder());
    goTo('/scripts?tab=library', 'Scripts');
    act(() => { document.dispatchEvent(new Event('astro:page-load')); });
    expect(useRecentsStore.getState().pages.map((p) => p.path)).toEqual(['/scripts?tab=library', '/alerts']);
  });

  it('skips device detail pages (tracked as recent devices instead)', () => {
    authState.user = { id: 'u1' };
    goTo('/devices/0f1c8a2e-1111-4bbb-8ccc-123456789abc', 'Device Details');
    renderHook(() => useRecentsRecorder());
    expect(useRecentsStore.getState().pages).toEqual([]);
  });

  it('records the landing page when the user arrives after mount', () => {
    const { rerender } = renderHook(() => useRecentsRecorder());
    expect(useRecentsStore.getState().pages).toEqual([]);
    authState.user = { id: 'u1' };
    rerender();
    expect(useRecentsStore.getState().pages.map((p) => p.path)).toEqual(['/alerts']);
  });

  it('stops listening on unmount', () => {
    authState.user = { id: 'u1' };
    const { unmount } = renderHook(() => useRecentsRecorder());
    unmount();
    goTo('/patches', 'Patches');
    act(() => { document.dispatchEvent(new Event('astro:page-load')); });
    expect(useRecentsStore.getState().pages.map((p) => p.path)).toEqual(['/alerts']);
  });
});
