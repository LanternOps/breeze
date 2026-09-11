import { useEffect } from 'react';
import { useAuthStore } from '../../stores/auth';
import { useRecentsStore } from '../../stores/recentsStore';

// Layout.astro renders "<page title> | Breeze RMM"; keep only the page part.
const TITLE_SUFFIX = /\s*\|[^|]*$/;

export function currentPageEntry(): { path: string; title: string } {
  return {
    path: `${window.location.pathname}${window.location.search}`,
    title: document.title.replace(TITLE_SUFFIX, '').trim(),
  };
}

/**
 * Keeps the recents store bound to the signed-in user and records every
 * page visit (initial load + each Astro view-transition swap). Mounted once
 * by `GlobalShortcuts` in DashboardLayout; device detail pages are skipped
 * by the store because they are tracked as recent DEVICES instead.
 */
export function useRecentsRecorder(): void {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const hydrate = useRecentsStore((s) => s.hydrate);
  const recordPage = useRecentsStore((s) => s.recordPage);

  useEffect(() => {
    hydrate(userId);
  }, [hydrate, userId]);

  useEffect(() => {
    if (!userId) return;
    const record = () => recordPage(currentPageEntry());
    // Re-runs when the user arrives after mount, so the landing page after
    // sign-in is not lost.
    record();
    document.addEventListener('astro:page-load', record);
    return () => document.removeEventListener('astro:page-load', record);
  }, [recordPage, userId]);
}
